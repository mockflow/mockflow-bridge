/**
 * MockFlow Bridge - board hub.
 *
 * Owns the WebSocket side of the bridge: live editor tabs connect here
 * (ws://127.0.0.1:<port>/board), pair once with a short code, register the
 * board they show, and then execute tool frames the bridge pushes at them
 * (draw via showResults, serialize the board for reads, run layout).
 *
 * Wire protocol (JSON frames):
 *   tab -> bridge:  {t:'hello', token?}         first frame after connect
 *                   {t:'pair', code}            answer to pair-required
 *                   {t:'register', projectid, title, focused, visible, url, compturn?}
 *                        compturn: reconnecting mid-turn, still waiting on this
 *                        component-AI turn
 *                   {t:'state', focused, visible, projectid, title}
 *                   {t:'result', id, ok, data?, error?}
 *                   {t:'plan-cancel'}           stop the running plan generation
 *   bridge -> tab:  {t:'pair-required'}
 *                   {t:'paired', token}
 *                   {t:'ready'}                 authenticated, please register
 *                   {t:'registered'}
 *                   {t:'tool', id, toolName, gdata}
 *                   {t:'toolhtml', id, toolName, mcpType, args, fromconvert?, fillTurnId?}
 *                        fillTurnId: fill the component of that component-AI turn
 *                        in place instead of drawing a new one
 *                   {t:'read', id, what}
 *                   {t:'layout', id, boardTitle}
 *                   {t:'snapshot', id}              reset the layout batch boundary
 *                   {t:'plan-pick', id, boardTitle, items}   user selects plan items
 *                   {t:'plan-start', boardTitle, total, items}  generation began
 *                   {t:'plan-step', step}       timeline row (same shape as ai-step)
 *                   {t:'plan-progress', done, total}   one planned item landed
 *                   {t:'plan-done', ok, error?} generation turn ended
 *                   {t:'error', message}
 *
 * Security model: bind localhost only, Origin allow-list, and a one-time
 * pairing code printed on the daemon console. The bridge never holds MockFlow
 * credentials - every draw happens inside the already-authenticated tab.
 */

const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const config = require('./config');

class BoardHub {
	constructor(opts) {
		this.log = (opts && opts.log) || function() {};
		this.tabs = new Map();      // ws -> tab info
		this.pending = new Map();   // request id -> {resolve, reject, timer}
		this.queues = new Map();    // projectid -> tail promise (per-board serialization)
		this.captures = new Map();  // projectid -> {turnId, send} (component-AI fill-in-place)
		this.convertContext = new Map(); // projectid -> fromconvert eid (Convert AI turns)
		this.plans = new Map();     // projectid -> {boardTitle, remaining, expires} (plan_board batches)
		this.pendingPicks = new Map(); // projectid -> {promise, decided, boardTitle, items} (plan selection)
		this.imageChoices = new Map(); // projectid -> true|false (this turn's "generate images" answer)
		this.imageAsks = new Map();    // projectid -> in-flight ask promise (one question per turn)
		this.turnSurfaces = new Map(); // projectid -> 'mida' | a Concept Builder cid (where to ask)
		this.turnModes = new Map();    // projectid -> 'create' | 'modify' (imagery rules differ)
		this.turnPhases = new Map();   // projectid -> 'declare' | 'compose' (decide-then-draw)
		this.turnRequests = new Map(); // projectid -> the user's OWN words for this turn
		this.selectedProjectId = null;
		this.nextId = 1;

		// One pairing code per daemon run, printed on the console. A tab that
		// presents it gets a durable token (persisted, survives restarts).
		this.pairingCode = String(100000 + Math.floor(Math.random() * 900000));
		this.tokens = this._loadTokens();
	}

	// ---- wiring --------------------------------------------------------------

	/** Attach the WS server to an existing http.Server on path /board. */
	attach(httpServer) {
		const self = this;
		this.wss = new WebSocketServer({ noServer: true });

		httpServer.on('upgrade', function(req, socket, head) {
			var url = req.url || '';
			if (url.split('?')[0] !== '/board') {
				socket.destroy();
				return;
			}
			if (!self._originAllowed(req.headers.origin)) {
				self.log('Rejected WS from disallowed origin: ' + req.headers.origin);
				socket.destroy();
				return;
			}
			self.wss.handleUpgrade(req, socket, head, function(ws) {
				self._onConnection(ws, req);
			});
		});

		// Heartbeat: drop tabs that stopped answering pings (closed laptop etc.)
		//
		// TWO missed pings, not one. A browser answers pings by itself, but a tab that
		// the browser has frozen (backgrounded - which is exactly where a user leaves a
		// board while waiting out a minutes-long generation) can miss one round. On a
		// single strike that terminated a perfectly good board mid-turn, and the editor
		// treated the drop as the end of the local run.
		this.heartbeat = setInterval(function() {
			self.wss.clients.forEach(function(ws) {
				ws.missedPings = (ws.missedPings || 0) + (ws.isAlive === false ? 1 : 0);
				if (ws.isAlive === false && ws.missedPings >= 2) return ws.terminate();
				if (ws.isAlive !== false) ws.missedPings = 0;
				ws.isAlive = false;
				try { ws.ping(); } catch (e) {}
			});
		}, 30000);
	}

	stop() {
		clearInterval(this.heartbeat);
		if (this.wss) this.wss.close();
	}

	_originAllowed(origin) {
		if (config.DEV) return true; // dev mode: local test pages (file:// sends "null")
		if (!origin) return false;
		return config.ALLOWED_ORIGINS.indexOf(origin) !== -1;
	}

	// ---- connection lifecycle ------------------------------------------------

	_onConnection(ws, req) {
		const self = this;
		ws.isAlive = true;
		ws.on('pong', function() { ws.isAlive = true; });

		const tab = {
			id: 'tab_' + (this.nextId++),
			origin: req.headers.origin || null,
			// This tab's own socket. Board targeting resolves by projectid, which picks
			// the FIRST tab showing a board - so with the same board open in two tabs, a
			// turn started in one could be answered into the other. Anything belonging to
			// a specific turn is delivered here while it is open.
			ws: ws,
			paired: false,
			registered: false,
			projectid: null,
			title: null,
			focused: false,
			visible: true,
			url: null
		};
		this.tabs.set(ws, tab);

		ws.on('message', function(raw) {
			var msg;
			try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
			if (!msg || typeof msg.t !== 'string') return;
			try {
				self._onFrame(ws, tab, msg);
			} catch (err) {
				self.log('Frame error from ' + tab.id + ':', err && err.message);
			}
		});

		ws.on('close', function() {
			self.tabs.delete(ws);
			if (tab.registered) {
				self.log('Board disconnected: "' + (tab.title || tab.projectid) + '"');
			}
			// Files the user attached during this board's session were saved on
			// their machine for follow-up questions; the session is over now.
			if (self.onTabGone) self.onTabGone(tab);
			self._reapCompGenIfGone(tab);
		});
	}

	/**
	 * A board tab went away while a component-AI turn may still be running for it.
	 *
	 * The turn is NOT cancelled straight away: the editor keeps a component turn alive
	 * across a dropped socket precisely so a blip (a frozen background tab that missed
	 * a heartbeat, a brief network stall) does not throw away a minutes-long local
	 * generation - the result lands on the reconnected socket and still fills the
	 * component. So wait out the editor's reconnect backoff first, and only if no tab
	 * for that board has come back is the turn really orphaned: kill the agent and drop
	 * its capture, instead of generating for a board nobody is listening to.
	 */
	/**
	 * Deliver a frame that belongs to one turn.
	 *
	 * The turn's OWN socket wins while it is open: board targeting resolves by
	 * projectid and returns the first tab showing that board, so with the same board
	 * open twice a turn started in one tab would otherwise be answered into the other -
	 * which has no such turn waiting, and rejects it.
	 *
	 * Only once that socket has gone does the board's current socket take over, so a
	 * turn still survives a reconnect (the editor keeps waiting on it across one).
	 */
	_sendToBoard(projectid, turnWs, frame) {
		if (turnWs && turnWs.readyState === 1) return this._send(turnWs, frame);
		if (projectid) {
			for (const [sock, t] of this.tabs.entries()) {
				if (t.registered && t.projectid === projectid) return this._send(sock, frame);
			}
		}
		return this._send(turnWs, frame);
	}

	_reapCompGenIfGone(tab) {
		const key = tab.projectid || null;
		if (!key || !tab.registered) return;
		const self = this;
		// Longer than the editor's maximum reconnect delay (30s), so a tab that is
		// coming back is never reaped a moment before it arrives.
		setTimeout(function() {
			for (const t of self.tabs.values()) {
				if (t.registered && t.projectid === key) return;  // it came back
			}
			const hadTurn = self.hasCapture(key);
			self.clearCapture(key);
			if (self.onCompGenCancel) self.onCompGenCancel(tab);
			if (hadTurn)
				self.log('Board "' + (tab.title || key) + '" did not come back - dropped its component AI turn.');
		}, 45000);
	}

	_onFrame(ws, tab, msg) {
		switch (msg.t) {
			case 'hello':
				if (msg.token && this.tokens.indexOf(msg.token) !== -1) {
					tab.paired = true;
					this._send(ws, { t: 'ready' });
				} else {
					this._send(ws, { t: 'pair-required' });
				}
				return;

			case 'pair':
				if (String(msg.code).replace(/\D/g, '') === this.pairingCode) {
					tab.paired = true;
					var token = crypto.randomUUID();
					this.tokens.push(token);
					this._saveTokens();
					this._send(ws, { t: 'paired', token: token });
					this.log('Tab paired (' + (tab.origin || 'unknown origin') + ')');
				} else {
					this._send(ws, { t: 'error', message: 'Wrong pairing code' });
				}
				return;

			case 'register':
				if (!tab.paired) return this._send(ws, { t: 'pair-required' });
				// Plan flag from the editor's authenticated session (MF_UserSession).
				// Basic (free) plan gates workspace file reading, concurrent boards and
				// connected sources; anything else gets the full bridge.
				tab.isBasic = !!msg.isBasic;
				// Concurrent boards are a Pro feature: a basic user drives one live board
				// at a time. A second, DIFFERENT board is refused (with an upgrade nudge)
				// instead of registering; another tab of the same board re-registers freely.
				if (tab.isBasic && this._otherBoardCount(ws, msg.projectid || null) > 0) {
					this.log('Refused concurrent board for basic plan: "' + (msg.title || msg.projectid) + '"');
					return this._send(ws, {
						t: 'gate', feature: 'concurrent-boards',
						message: 'Your plan connects one board to the local agent at a time. '
							+ 'Close the other connected board, or upgrade to drive several boards at once.'
					});
				}
				tab.registered = true;
				tab.projectid = msg.projectid || null;
				tab.title = msg.title || null;
				tab.focused = !!msg.focused;
				tab.visible = msg.visible !== false;
				tab.url = msg.url || null;
				this._send(ws, { t: 'registered', agentInfo: this._agentInfoFor(tab) });
				// A tab that reconnects mid-turn says which component-AI turn it is still
				// waiting on (msg.compturn). Usually the turn is alive and its result lands
				// on this new socket - but if the reconnect took longer than the reap
				// window, the agent is already gone and nothing would ever answer: tell the
				// tab now so it falls back to MockFlow AI, instead of holding its loader
				// until its own timeout.
				if (msg.compturn && !(this.isCompGenRunning && this.isCompGenRunning(tab))) {
					this.log('Board "' + (tab.title || tab.projectid) + '" reconnected waiting on a component AI '
						+ 'turn that is no longer running - telling it to fall back.');
					this.clearCapture(tab.projectid);
					this._send(ws, { t: 'compgen-done', id: msg.compturn, ok: false, fallback: true,
						error: 'The connection to the local agent dropped for too long and its turn was lost.' });
				}
				this.log('Board connected: "' + (tab.title || tab.projectid) + '"'
					+ (tab.focused ? ' (focused)' : '') + (tab.isBasic ? ' [basic plan]' : ''));
				return;

			case 'state':
				if (!tab.registered) return;
				if (msg.projectid !== undefined) tab.projectid = msg.projectid;
				if (msg.title !== undefined) tab.title = msg.title;
				if (msg.focused !== undefined) tab.focused = !!msg.focused;
				if (msg.visible !== undefined) tab.visible = !!msg.visible;
				return;

			case 'result': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.ok) p.resolve(msg.data);
				else {
					// The tab's reason a draw failed used to go ONLY to the agent, so
					// diagnosing "it failed in the local agent" meant reading the agent's
					// own transcript. It is the single most useful line there is here.
					this.log('Tab reported a failed draw: ' + (msg.error || 'no reason given'));
					p.reject(new Error(msg.error || 'Tab reported failure'));
				}
				return;
			}

			case 'chat': {
				// Mida/CB "Local agent" turn from this tab (Mode B). Delegated to
				// the agent manager the daemon wired in via this.onChat.
				if (!tab.registered) return;
				const self = this;
				if (this.onChat) {
					this.onChat(tab, msg, function(frame) { self._send(ws, frame); });
				} else {
					this._send(ws, { t: 'chat-done', id: msg.id, ok: false, error: 'Local agent chat is not enabled on this bridge.' });
				}
				return;
			}

			case 'chat-cancel':
				if (tab.registered && this.onChatCancel) this.onChatCancel(tab);
				return;

			case 'compgen': {
				// A component's QuickSettings AI (Generate / Modify / Convert) run
				// on the user's own agent (Mode B). Delegated to the agent manager.
				if (!tab.registered) return;
				const self = this;
				if (this.onCompGen) {
					// Addressed to the BOARD, not to this socket. A component turn outlives a
					// dropped socket (the editor keeps waiting on it across a reconnect), and
					// its steps and its final compgen-done have to reach whichever socket the
					// board is on NOW - sending them to the socket that opened the turn would
					// drop them into a closed connection and leave the component's loader
					// spinning until its own timeout, even though the fill itself landed.
					this.onCompGen(tab, msg, function(frame) { self._sendToBoard(tab.projectid, ws, frame); }, this);
				} else {
					this._send(ws, { t: 'compgen-done', id: msg.id, ok: false, fallback: true, error: 'Component AI is not enabled on this bridge.' });
				}
				return;
			}

			case 'compgen-cancel':
				if (tab.registered && this.onCompGenCancel) this.onCompGenCancel(tab);
				return;

			case 'plan-cancel':
				// User hit the ✕ on Mida's generation loader. Kill the continuation
				// turn and drop the armed plan so a later batch is not re-arranged.
				if (!tab.registered) return;
				this.log('[plan] cancel requested by board ' + (tab.projectid || tab.id));
				this.clearPlan(tab.projectid);
				if (this.onPlanCancel) this.onPlanCancel(tab);
				this._send(ws, { t: 'plan-done', ok: false, error: 'Cancelled.' });
				return;
		}
	}

	_send(ws, frame) {
		try { ws.send(JSON.stringify(frame)); } catch (e) {}
	}

	/** Push a frame to every registered tab (e.g. the agent changed under them).
	 *  Clients that do not know the frame ignore it. */
	broadcast(frame) {
		const self = this;
		this.tabs.forEach(function(tab, ws) {
			if (tab.registered) self._send(ws, frame);
		});
	}

	// ---- plan gating ---------------------------------------------------------

	/**
	 * How many DISTINCT other boards (by projectid) are already registered besides
	 * this connection and the board it is registering. Holds a basic-plan user to
	 * one live board: another tab of the SAME board (same projectid, a reload) does
	 * not count, only a genuinely different board does.
	 */
	_otherBoardCount(selfWs, projectid) {
		var seen = {};
		this.tabs.forEach(function(t, ws) {
			if (ws === selfWs || !t.registered) return;
			var pid = t.projectid || t.id;
			if (projectid && pid === projectid) return; // same board, another tab
			seen[pid] = true;
		});
		return Object.keys(seen).length;
	}

	/**
	 * The agentInfo reported to one tab. Workspace file reading is a Pro feature,
	 * so a basic-plan tab is told files are off even when the bridge runs with
	 * --workspace - keeping Mida from advertising a capability this plan will not
	 * honor (agentManager runs the turn in the scratch dir either way).
	 */
	_agentInfoFor(tab) {
		var info = this.agentInfo || null;
		if (!info || !tab || !tab.isBasic) return info;
		var clone = Object.assign({}, info);
		// Workspace file reading is Pro-only: tell a basic tab files are off.
		clone.hasWorkspace = false;
		clone.workspaceName = null;
		// Seed the editor with the current daily generation usage so it can gate
		// (and warn as it runs low) from the first turn, like the AI-credit balance.
		clone.genUsage = this._genUsage();
		return clone;
	}

	/** True when the board a tool call targets belongs to a basic (free) plan. */
	isTargetBasic(projectid) {
		try { return !!this._targetTab(projectid || null).tab.isBasic; }
		catch (e) { return false; }
	}

	/**
	 * The basic-plan daily generation usage the editor gates on (like AI credits):
	 * { limit, used, remaining }. Null when there is no cap wired. The bridge only
	 * measures this - the editor does the prevention.
	 */
	_genUsage() {
		if (!this.genCap) return null;
		const remaining = this.genCap.remaining();
		return { limit: this.genCap.limit, used: Math.max(0, this.genCap.limit - remaining), remaining: remaining };
	}

	/** Push the current generation usage to the targeted board tab (best effort). */
	notifyGenUsage(projectid) {
		const usage = this._genUsage();
		if (!usage) return;
		try {
			const target = this._targetTab(projectid || null);
			this._send(target.ws, { t: 'gen-usage', usage: usage });
		} catch (e) {}
	}

	// ---- board targeting -----------------------------------------------------

	listBoards() {
		var out = [];
		this.tabs.forEach(function(tab) {
			if (tab.registered) {
				out.push({
					projectid: tab.projectid,
					title: tab.title,
					focused: tab.focused,
					visible: tab.visible
				});
			}
		});
		return out;
	}

	/**
	 * Resolve which tab a tool call should target:
	 * explicit projectid > select_board choice > focused tab > the only tab.
	 * Throws a user-facing error when the target is ambiguous or missing.
	 */
	_targetTab(projectid) {
		var entries = [];
		this.tabs.forEach(function(tab, ws) {
			if (tab.registered) entries.push({ ws: ws, tab: tab });
		});

		if (entries.length === 0) {
			throw new Error(
				'No MockFlow board is connected to the bridge. Ask the user to: '
				+ '1) open their board at https://app.mockflow.com, '
				+ '2) switch ON "Connect local agent" in the editor, '
				+ '3) enter the pairing code shown in the bridge terminal. Then retry.');
		}

		var want = projectid || this.selectedProjectId;
		if (want) {
			for (var i = 0; i < entries.length; i++) {
				if (entries[i].tab.projectid === want) return entries[i];
			}
			if (projectid) {
				throw new Error('Board "' + projectid + '" is not connected. Connected boards: '
					+ JSON.stringify(this.listBoards()));
			}
			// A previously selected board went away - fall through to focus rules.
			this.selectedProjectId = null;
		}

		if (entries.length === 1) return entries[0];

		var focused = entries.filter(function(e) { return e.tab.focused; });
		if (focused.length === 1) return focused[0];

		var visible = entries.filter(function(e) { return e.tab.visible; });
		if (visible.length === 1) return visible[0];

		throw new Error(
			'Several boards are connected and none is clearly active. '
			+ 'Ask the user which one to draw on, then call select_board. Connected boards: '
			+ JSON.stringify(this.listBoards()));
	}

	// ---- component-AI fill-in-place capture ---------------------------------

	/**
	 * Arm a one-shot capture for a board. While armed, the next render_* tool
	 * call that targets this board is NOT drawn as a new component; its mapped
	 * gdata is sent straight back to the tab as a {t:'compgen-data'} frame so the
	 * component the user is editing fills in place. Used by the agent manager
	 * for a component Generate/Modify turn.
	 *
	 * opts.html marks a fill whose tool is an HTML-conversion tool: that draw goes
	 * through drawHtml (the tab converts the HTML itself), so the flag is what tells
	 * drawHtml this render belongs to the armed turn.
	 */
	setCapture(projectid, turnId, send, opts) {
		if (projectid) this.captures.set(projectid, {
			turnId: turnId, send: send, html: !!(opts && opts.html),
			// The tab this turn belongs to. Its result goes back HERE, not merely to
			// "a tab showing this board" - with the board open twice those differ, and
			// the other tab has no turn waiting for it.
			ws: (opts && opts.ws) || null
		});
	}

	clearCapture(projectid) {
		if (projectid) this.captures.delete(projectid);
	}

	hasCapture(projectid) {
		return !!(projectid && this.captures.has(projectid));
	}

	/**
	 * Route a render tool result: if the target board has an armed capture,
	 * hand the gdata back to the tab for in-place fill and resolve immediately;
	 * otherwise draw it as a normal new component (per-board serialized).
	 * @returns {Promise<{captured:boolean}|any>}
	 */
	captureOrDraw(projectid, toolName, gdata, imageSlotForm, imagesAllowed) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		var cap = key ? this.captures.get(key) : null;
		if (cap) {
			this.captures.delete(key);
			// imageSlotForm travels with the data: the tab fills any image slot the
			// agent left in it before the component is filled in place.
			cap.send({ t: 'compgen-data', id: cap.turnId, gdata: gdata,
				imageSlotForm: imageSlotForm || null, imagesAllowed: !!imagesAllowed });
			return Promise.resolve({ captured: true });
		}
		// A plan selection is still in front of the user: refuse the draw instead
		// of generating past the picker (the whole point of the selection step).
		if (this.hasPendingPick(key)) {
			return Promise.reject(new Error(
				'The user has not confirmed the board plan yet - the selection is on their screen. '
				+ 'STOP: do not render anything. Generation starts automatically when the user clicks '
				+ 'Generate Board; your part ended when you proposed the plan.'));
		}
		// Convert AI: tag the drawn component with its source so the client connects
		// and positions it relative to the source (same as server convert's fromconvert).
		var conv = key ? this.convertContext.get(key) : null;
		if (conv && gdata && gdata.data) gdata.data.fromconvert = conv;
		const self = this;
		const planIndex = this._claimPlanOrder(key, toolName);
		return this.runOnBoard(projectid, { t: 'tool', toolName: toolName, gdata: gdata,
			imageSlotForm: imageSlotForm || null, imagesAllowed: !!imagesAllowed,
			planIndex: planIndex })
			.then(function(res) {
				return self._notePlannedDraw(key, planIndex).then(function(arranged) { return arranged || res; });
			}, function(err) {
				// Nothing was drawn, so the item is still owed - the agent's retry takes it.
				self._releasePlanOrder(key, planIndex);
				throw err;
			});
	}

	// ---- plan_board (plan-first multiboard pipeline) --------------------------

	/**
	 * Arm a plan_board batch: the tab resets its layout batch boundary (snapshot),
	 * then every draw on this board counts against the plan; when the last planned
	 * item lands, the batch is auto-arranged (bento + titled section) - the same
	 * end state as the MockFlow AI multiboard pipeline. One plan per board;
	 * a new plan replaces the old, an expired plan is simply forgotten.
	 *
	 * `send` (optional) is the frame sender for the tab that owns the plan. It is
	 * kept on the plan so every counted draw can push a {t:'plan-progress'} frame
	 * back - that is what drives Mida's "Generated X of Y items…" loader, the same
	 * line the server multiboard flow writes from ai-multiboard-progress.
	 *
	 * `shape` (optional) is the batch as the user confirmed it: `tools` in draw
	 * order and `images` (a boolean per item). Imagery is answered PER ITEM on the
	 * plan card, so it cannot be carried as one flag for the board - two
	 * image-capable components in one plan are two separate answers.
	 */
	armPlan(projectid, boardTitle, itemCount, send, shape) {
		const self = this;
		const target = this._targetTab(projectid || null);
		const key = target.tab.projectid || target.tab.id;
		return this.runOnBoard(projectid, { t: 'snapshot' }, config.READ_TIMEOUT_MS)
			.catch(function() {})  // an old tab without snapshot support still batches from its last layout
			.then(function() {
				self.plans.set(key, {
					boardTitle: boardTitle,
					remaining: itemCount,
					total: itemCount,
					done: 0,
					send: send || null,
					toolByItem: (shape && shape.tools) || null,
					imageByItem: (shape && shape.images) || null,
					// Which items have already had their imagery answer handed out -
					// needed only when two items share a tool and disagree about
					// pictures (see plannedImageChoice).
					claimed: {},
					expires: Date.now() + config.PLAN_TIMEOUT_MS
				});
				self.log('[plan] armed "' + boardTitle + '" on board ' + key + ': ' + itemCount + ' item(s)'
					+ (send ? '' : ' (no progress channel - tab loader will not update)'));
			});
	}

	/**
	 * plan_board selection step (parity with MockFlow AI's "Select items to
	 * generate" checklist). Fire-and-forget from the agent's point of view:
	 * the plan_board tool call ends the agent's turn immediately, the picker
	 * shows in the target tab, and the user's Generate Board click - the
	 * tab's reply to this frame - arms the auto-arrange plan and starts the
	 * generation turn via onPlanGenerate (daemon-wired to the agent manager).
	 * Skip / an ignored picker generates nothing. While the pick is pending,
	 * hasPendingPick gates draws on the board so the proposing agent cannot
	 * render past the picker. Sent DIRECTLY to the tab - not through the
	 * per-board queue - so a pending picker never blocks reads or draws.
	 */
	startPlanPick(projectid, boardTitle, items) {
		const self = this;
		const target = this._targetTab(projectid || null);
		const key = target.tab.projectid || target.tab.id;

		// A newer plan supersedes an unanswered one (the tab-side picker
		// cancels its stale UI itself).
		this.pendingPicks.delete(key);
		const pick = { decided: false };
		this.pendingPicks.set(key, pick);

		const settle = function() {
			pick.decided = true;
			if (self.pendingPicks.get(key) === pick) self.pendingPicks.delete(key);
		};

		// Progress channel for this plan: plan-start / plan-step / plan-progress /
		// plan-done all go straight to the tab that answered the picker, so Mida can
		// run the same loader the server multiboard turn runs.
		const sendToTab = function(frame) { self._send(target.ws, frame); };

		this.log('[plan] picker sent to board ' + key + ': "' + boardTitle + '" (' + items.length + ' item(s))');

		this._request(target.ws, { t: 'plan-pick', boardTitle: boardTitle, items: items },
			config.PLAN_PICK_TIMEOUT_MS)
			.then(function(res) {
				settle();
				if (res && res.cancelled) {          // user skipped the plan
					self.log('[plan] picker skipped on board ' + key);
					return;
				}
				// The picker's image answers are recorded BEFORE the generation turn
				// starts, so that turn never has to stop and ask (which would abandon
				// the items after the one that asked).
				//
				// They are answered PER ITEM on the card - one toggle per image-capable
				// row, or one shared toggle for a cohesive set of screens - so they are
				// carried per item all the way to the draw. Collapsing them to a single
				// board flag is what made ticking images on one component put images on
				// every component in the batch.
				const perItem = (res && res.itemImages) || null;
				const batchImages = !!(res && res.withImages);
				// Indices into the ORIGINAL plan, which is how itemImages is keyed. An
				// auto reply (a tab with no picker UI) confirms the whole plan.
				var chosenIdx = (res && Array.isArray(res.items))
					? res.items.filter(function(i) { return !!items[i]; })
					: items.map(function(_, i) { return i; });
				if (res && Array.isArray(res.items) && !chosenIdx.length) {
					self.log('[plan] picker returned an empty selection on board ' + key + ' - nothing generated');
					return;
				}
				var chosen = chosenIdx.map(function(i) { return items[i]; });
				const chosenImages = chosenIdx.map(function(i) {
					if (perItem && (perItem[i] === true || perItem[i] === false)) return perItem[i];
					// The card stamps a toggle on every image-capable row, so once it has
					// sent answers at all, an item with none had no toggle to answer: it
					// cannot carry imagery. Reading that as "inherit whatever another item
					// said" is what spread one ticked component's images across the batch.
					if (perItem) return false;
					// Only a tab too old to send per-item answers, or an auto reply with no
					// picker UI, falls back to one flag for everything.
					return batchImages;
				});
				self.log('[plan] confirmed on board ' + key + ': ' + chosen.length + ' of ' + items.length
					+ ' item(s) [' + chosen.map(function(it) { return it.tool; }).join(', ') + ']'
					+ (res && res.auto ? ' (auto - no picker UI in the tab)' : ''));
				// The picker's imagery answers, exactly as the tab sent them. A batch that
				// draws correctly but with the wrong pictures looks identical whether a
				// toggle never arrived, arrived off, or arrived on for the wrong item.
				self.log('[plan] imagery answers: withImages=' + (res && res.withImages)
					+ ' itemImages=' + JSON.stringify((res && res.itemImages) || null)
					+ ' -> per item [' + chosen.map(function(it, n) {
						return (it.tool || '?') + '=' + (chosenImages[n] ? 'ON' : 'off');
					}).join(', ') + ']');
				// Board-level fallback for anything the per-item cursor cannot place (and
				// for the tools/list branch, which is one description for the whole turn):
				// ON when ANY item wants imagery, so the agent is told the slot form it
				// needs. WHICH items actually keep their slots is enforced per draw.
				self.setImageChoice(key, batchImages, 'mida', 'create');
				return self.armPlan(projectid, boardTitle, chosen.length, sendToTab, {
					tools: chosen.map(function(it) { return it.tool || ''; }),
					images: chosenImages
				}).then(function() {
					// Opens Mida's generation loader before the agent turn spawns, so the
					// chat never sits silent between the click and the first draw.
					sendToTab({
						t: 'plan-start', boardTitle: boardTitle, total: chosen.length,
						items: chosen.map(function(it) { return { name: it.name || '', tool: it.tool || '' }; })
					});
					if (self.onPlanGenerate)
						self.onPlanGenerate(target.tab, {
							boardTitle: boardTitle, items: chosen,
							withImages: batchImages, itemImages: chosenImages
						}, sendToTab);
					else
						sendToTab({ t: 'plan-done', ok: false, error: 'Plan generation is not enabled on this bridge.' });
				});
			})
			.catch(function(err) {
				settle();  // picker ignored past its window: nothing generates
				self.log('[plan] picker unanswered on board ' + key + ' - nothing generated'
					+ (err && err.message ? ' (' + err.message + ')' : ''));
			});
	}

	/** True while the board's plan selection is still in front of the user. */
	hasPendingPick(key) {
		const pick = key ? this.pendingPicks.get(key) : null;
		return !!(pick && !pick.decided);
	}

	/** Drop the plan for a board (explicit layout_board call, or board went away). */
	clearPlan(projectid) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		if (key) this.plans.delete(key);
	}

	/**
	 * Count one completed draw against the board's armed plan. When the plan is
	 * fulfilled, run the layout inside the same per-board queue and resolve with
	 * {arranged, boardTitle, count} so the tool result can tell the agent the
	 * board is done. Resolves null when no plan is active (the normal case).
	 */
	/**
	 * Where this draw belongs in the plan the user confirmed, or undefined outside
	 * a plan. The tab arranges the finished batch in this order.
	 *
	 * Needed because the items of a plan are rendered several at a time, so they
	 * land in whatever order they finish - and a board whose screens are arranged
	 * by which agent was quickest reads as scrambled. Each draw takes the first
	 * item still unspoken-for that uses its tool, which is the same reasoning
	 * plannedImageChoice uses and, like it, holds whatever the finishing order.
	 */
	_claimPlanOrder(key, toolName) {
		const plan = key ? this.plans.get(key) : null;
		if (!plan || !plan.toolByItem) return undefined;
		if (!plan.ordered) plan.ordered = {};
		for (var i = 0; i < plan.toolByItem.length; i++) {
			if (plan.toolByItem[i] === toolName && !plan.ordered[i]) {
				plan.ordered[i] = true;
				return i;
			}
		}
		return undefined;
	}

	/**
	 * Give an item's place back when its draw did NOT happen (the tab refused it,
	 * the conversion failed). The agent's retry is the same planned item and must
	 * be able to claim it again - otherwise the retry counts as an unplanned draw
	 * and the plan never completes.
	 */
	_releasePlanOrder(key, planIndex) {
		if (planIndex === undefined || planIndex === null) return;
		const plan = key ? this.plans.get(key) : null;
		if (plan && plan.ordered) delete plan.ordered[planIndex];
	}

	/**
	 * The imagery answer for the draw about to happen, when a plan batch is armed.
	 *
	 * Imagery is answered per item on the plan card, so a batch holding two
	 * image-capable components holds two answers; a single board-level flag would
	 * give both whatever either one said. The draw names its TOOL, which is all
	 * there is to go on, so the answer is read from the plan's items using this
	 * tool:
	 *
	 *  - they all say the same thing (the ordinary case, including every batch
	 *    where a tool appears once): that answer, with no bookkeeping at all. Safe
	 *    to ask twice, which a retry after a failed render does.
	 *  - they disagree: each is handed out once, in plan order, so two items using
	 *    one tool with different answers get their own. A further call once they
	 *    are all spoken for (a retry) repeats the last one rather than inventing.
	 *
	 * Deliberately NOT keyed on how many draws have landed: items are rendered
	 * several at a time, so "the nth draw is the nth item" stopped being true.
	 * Returns undefined when there is no plan, which leaves the ordinary
	 * board-level choice in charge.
	 */
	plannedImageChoice(projectid, toolName) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		const plan = key ? this.plans.get(key) : null;
		if (!plan || !plan.imageByItem || !plan.toolByItem) return undefined;

		const mine = [];
		for (var i = 0; i < plan.toolByItem.length; i++) {
			if (plan.toolByItem[i] === toolName) mine.push(i);
		}
		if (!mine.length) return undefined;

		var uniform = true;
		for (var u = 1; u < mine.length; u++) {
			if (!!plan.imageByItem[mine[u]] !== !!plan.imageByItem[mine[0]]) { uniform = false; break; }
		}
		if (uniform) return !!plan.imageByItem[mine[0]];

		if (!plan.claimed) plan.claimed = {};
		for (var c = 0; c < mine.length; c++) {
			if (!plan.claimed[mine[c]]) {
				plan.claimed[mine[c]] = true;
				return !!plan.imageByItem[mine[c]];
			}
		}
		return !!plan.imageByItem[mine[mine.length - 1]];
	}

	_notePlannedDraw(key, planIndex) {
		if (!key) return Promise.resolve(null);
		const plan = this.plans.get(key);
		if (!plan) return Promise.resolve(null);
		if (Date.now() > plan.expires) {
			this.plans.delete(key);
			return Promise.resolve(null);
		}
		// A component the plan did not ask for: an agent that drew past its own item,
		// or an unrelated draw landing mid-batch. It stays on the board, but counting
		// it would finish the plan early - and the arrangement would then run while a
		// real item was still being composed, leaving that one outside the section.
		// Only when the plan knows its items by tool (_claimPlanOrder's own condition),
		// so a plan without that shape counts every draw exactly as it always did.
		if (plan.toolByItem && planIndex === undefined) {
			this.log('[plan] an unplanned draw landed on board ' + key
				+ ' - left on the board, not counted against the plan');
			return Promise.resolve(null);
		}
		plan.remaining--;
		plan.done++;
		// "Generated X of Y items…" in Mida, same line the server flow writes from
		// its ai-multiboard-progress socket event.
		this.log('[plan] progress on board ' + key + ': ' + plan.done + '/' + plan.total);
		if (plan.send) {
			try { plan.send({ t: 'plan-progress', done: plan.done, total: plan.total }); } catch (e) {}
		}
		if (plan.remaining > 0) return Promise.resolve(null);
		this.plans.delete(key);
		return this.runOnBoard(key, { t: 'layout', boardTitle: plan.boardTitle })
			.then(function(count) { return { arranged: true, boardTitle: plan.boardTitle, count: count }; })
			.catch(function() { return null; });  // layout failure never fails the draw that triggered it
	}

	/**
	 * HTML-conversion tools (render_wireframelite / render_prototypelite): the raw
	 * tool args go to the tab, which runs the HTML conversion through the MockFlow
	 * endpoints with the user's own session and draws the result itself.
	 *
	 * An armed component-AI capture is honoured ONLY when it says this turn fills
	 * from HTML (`html`, set from the catalog's clientHtmlFillsInPlace). Then the
	 * turn id travels with the frame and the tab hands the converted result to the
	 * component the user is editing instead of drawing a new one. Any other armed
	 * capture is left alone: its tool is a JSON one that comes through captureOrDraw,
	 * so an html draw during it can only be an unrelated Mode A agent, and drawing
	 * normally is correct.
	 *
	 * The capture is consumed only once the tab confirms the fill (res.filled), so a
	 * conversion that fails leaves the turn armed - the agent's retry still fills in
	 * place instead of dropping a second component on the board, and a turn that
	 * never produces anything still falls back to MockFlow AI (agentManager.finish).
	 */
	drawHtml(projectid, toolName, mcpType, args, imagesAllowed) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		const cap = key ? this.captures.get(key) : null;
		const fill = !!(cap && cap.html);
		// Same plan-selection gate as captureOrDraw: never draw past the picker. A
		// fill-in-place turn edits a component that is already on the board, so it is
		// not a draw the picker is holding back.
		if (!fill && this.hasPendingPick(key)) {
			return Promise.reject(new Error(
				'The user has not confirmed the board plan yet - the selection is on their screen. '
				+ 'STOP: do not render anything. Generation starts automatically when the user clicks '
				+ 'Generate Board; your part ended when you proposed the plan.'));
		}
		const frame = { t: 'toolhtml', toolName: toolName, mcpType: mcpType, args: args || {}, imagesAllowed: !!imagesAllowed };
		// A fill replaces a component that is already placed, so it has no place in
		// a plan's arrangement (and must not take an item's slot in it).
		const planIndex = fill ? undefined : this._claimPlanOrder(key, toolName);
		if (!fill) frame.planIndex = planIndex;
		if (fill) frame.fillTurnId = cap.turnId;
		else if (cap) {
			// A capture is armed but this tool is not one that fills from HTML, so this
			// draw belongs to something else. Worth saying: an html draw landing during a
			// component turn is how a stray second component appears on the board.
			this.log('Note: ' + toolName + ' drew while a component AI turn was armed on this board.');
		}
		// Convert AI: tag the drawn component with its source so the client connects
		// and positions it relative to the source (parity with captureOrDraw).
		const conv = key ? this.convertContext.get(key) : null;
		if (conv) frame.fromconvert = conv;
		const self = this;
		// A fill goes to the tab whose turn it is; a plain draw goes to the board.
		return this.runOnBoard(projectid, frame, config.HTML_TOOL_TIMEOUT_MS, fill ? cap.ws : null)
			.then(function(res) {
				// Filled in place: nothing new landed on the board, so this is not a
				// planned draw and must not advance a plan batch.
				if (res && res.filled) {
					self.clearCapture(key);
					return res;
				}
				return self._notePlannedDraw(key, planIndex).then(function(arranged) {
					// Keep the tab's conversion diagnostics on the result either way - the
					// arranged branch replaces the payload and would otherwise drop them.
					if (arranged && res && res.diagnostics) arranged.diagnostics = res.diagnostics;
					return arranged || res;
				});
			}, function(err) {
				self._releasePlanOrder(key, planIndex);   // see captureOrDraw
				throw err;
			});
	}

	/**
	 * Media components (render_image / video / audio / 3dmodel): the agent wrote
	 * the prompt, and the ASSET is generated by MockFlow AI inside the connected
	 * tab - the same generator that surface already uses for this output type,
	 * charged to the user's credits. The tab fires it and answers immediately;
	 * the component lands on the board when the generator is done, so nothing
	 * here waits for it.
	 */
	drawServerGen(projectid, toolName, spec) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		// Same plan-selection gate as every other draw: never generate past the picker.
		if (this.hasPendingPick(key)) {
			return Promise.reject(new Error(
				'The user has not confirmed the board plan yet - the selection is on their screen. '
				+ 'STOP: do not render anything.'));
		}
		const frame = {
			t: 'toolgen',
			toolName: toolName,
			aitype: spec.aitype,
			args: spec.args || {},
			tocomp: spec.tocomp || null,
			promptPrefix: spec.promptPrefix || '',
			extra: spec.extra || null,
			planIndex: undefined
		};
		const planIndex = this._claimPlanOrder(key, toolName);
		frame.planIndex = planIndex;
		const conv = key ? this.convertContext.get(key) : null;
		if (conv) frame.fromconvert = conv;
		const self = this;
		return this.runOnBoard(projectid, frame)
			.then(function(res) {
				return self._notePlannedDraw(key, planIndex).then(function(arranged) { return arranged || res; });
			}, function(err) {
				self._releasePlanOrder(key, planIndex);   // see captureOrDraw
				throw err;
			});
	}

	// ---- image slots ---------------------------------------------------------
	//
	// A local agent is a text model: it can author a component but not the imagery
	// inside it. MockFlow can generate that imagery, in the user's tab, against
	// their AI credits - so it is their call, every turn. The choice is asked ONCE
	// per turn, at the moment the agent actually reaches an image-capable tool
	// (the tab has no way to know the component type before then, because the
	// agent picks it), and every later tool in the same turn reuses the answer.

	/**
	 * Start a turn's image state: the answer the tab already sent (undefined when
	 * the user has not said, which is what makes the mid-turn ask happen), and the
	 * surface that turn came from, so the question is asked where the user is
	 * looking (Ask Mida, or the Concept Builder that is talking).
	 */
	setImageChoice(projectid, choice, surface, turnMode) {
		const key = projectid || null;
		if (!key) return;
		if (choice === true || choice === false) this.imageChoices.set(key, choice);
		else this.imageChoices.delete(key);
		this.imageAsks.delete(key);
		if (surface) this.turnSurfaces.set(key, surface);
		else this.turnSurfaces.delete(key);
		// Composing something new and editing something that exists need opposite
		// instructions about imagery, so the turn's kind travels with the choice.
		if (turnMode === 'modify') this.turnModes.set(key, 'modify');
		else this.turnModes.delete(key);
	}

	/**
	 * Which half of a decide-then-draw chat turn is running.
	 *
	 * 'declare' is served NO render tools, so the agent cannot compose - it can
	 * only say what it intends, which is what makes the imagery question askable
	 * before the work is done. Anything else (component AI, an external MCP
	 * client, a plan batch) is 'compose' and sees the full catalog as always.
	 */
	setTurnPhase(projectid, phase) {
		const key = projectid || null;
		if (!key) return;
		if (phase === 'declare') this.turnPhases.set(key, 'declare');
		else this.turnPhases.delete(key);
	}

	getTurnPhase(projectid) {
		const key = projectid || null;
		return (key && this.turnPhases.get(key) === 'declare') ? 'declare' : 'compose';
	}

	/**
	 * What the USER typed for the turn open on this board.
	 *
	 * Kept because some component choices are only the user's to make: a catalog
	 * entry can say it may be elected only when the request itself asks for it
	 * (electionRules), and that has to be judged against the user's own words -
	 * never the agent's paraphrase of them, which pads a plain request into
	 * whatever the agent felt like building.
	 *
	 * Deliberately EMPTY for every turn that is not a user's request in their own
	 * words (a component fill, a plan batch generating from briefs, an external MCP
	 * client): there is nothing to judge against then, so nothing is second-guessed.
	 */
	setTurnRequest(projectid, text) {
		const key = projectid || null;
		if (!key) return;
		const t = String(text || '').trim();
		if (t) this.turnRequests.set(key, t);
		else this.turnRequests.delete(key);
	}

	getTurnRequest(projectid) {
		const key = projectid || null;
		return (key && this.turnRequests.get(key)) || '';
	}

	/**
	 * The declare step is finished with (the user has answered, or there was
	 * nothing to ask): run the drawing step of the same chat turn. Wired to the
	 * agent manager by the daemon, like onPlanGenerate.
	 */
	requestCompose(projectid) {
		if (this.onCompose) this.onCompose(projectid || null);
	}

	/**
	 * The agent has named what it will draw. Recorded straight away - before the
	 * user has answered anything - so the deciding step's turn is held open for
	 * the drawing step instead of being closed when that process exits.
	 */
	noteDeclared(projectid, tool, held) {
		if (this.onDeclared) this.onDeclared(projectid || null, tool || null, !!held);
	}

	/** Which surface this board's open turn came from ('mida', or 'cb_<cid>'). */
	getTurnSurface(projectid) {
		const key = projectid || null;
		return (key && this.turnSurfaces.get(key)) || '';
	}

	/**
	 * Everything about the turn currently open on this board.
	 *
	 * A turn can run INSIDE another one: modify_component is a tool call in a chat
	 * turn, and the tab answers it by running a whole component AI turn of its own.
	 * All of this state is keyed by board alone, so the inner turn opening its own
	 * would otherwise overwrite the outer one's - and clearing it at the end would
	 * leave the outer turn with none at all. That is how a Concept Builder's image
	 * question ended up being asked in Ask Mida. Capture before, restore after.
	 */
	captureTurnState(projectid) {
		const key = projectid || null;
		if (!key) return null;
		return {
			key: key,
			choice: this.imageChoices.has(key) ? this.imageChoices.get(key) : undefined,
			surface: this.turnSurfaces.get(key) || '',
			mode: this.turnModes.get(key) || '',
			phase: this.turnPhases.get(key) || '',
			request: this.turnRequests.get(key) || ''
		};
	}

	restoreTurnState(state) {
		if (!state || !state.key) return;
		const key = state.key;
		if (state.choice === true || state.choice === false) this.imageChoices.set(key, state.choice);
		else this.imageChoices.delete(key);
		if (state.surface) this.turnSurfaces.set(key, state.surface); else this.turnSurfaces.delete(key);
		if (state.mode) this.turnModes.set(key, state.mode); else this.turnModes.delete(key);
		if (state.phase) this.turnPhases.set(key, state.phase); else this.turnPhases.delete(key);
		if (state.request) this.turnRequests.set(key, state.request); else this.turnRequests.delete(key);
	}

	/** 'modify' when this turn edits something already on the board, else 'create'. */
	getTurnMode(projectid) {
		const key = projectid || null;
		return (key && this.turnModes.get(key) === 'modify') ? 'modify' : 'create';
	}

	getImageChoice(projectid) {
		const key = projectid || null;
		if (!key) return undefined;
		return this.imageChoices.has(key) ? this.imageChoices.get(key) : undefined;
	}

	/**
	 * Ask the board tab whether this turn should include AI-generated images.
	 * Resolves to a boolean and remembers it for the rest of the turn. Concurrent
	 * tool calls share the one question.
	 *
	 * NOTHING WAITS ON THIS. The agent's tool call returns the moment the question
	 * is sent (see mcpEndpoint._imageGate), exactly like the plan picker, so the
	 * card can sit on screen as long as the user needs and no agent is blocked
	 * behind it. Anything that goes wrong - no tab, an old tab that does not know
	 * the frame, a window that finally lapses - answers "no", which is the free
	 * and safe outcome.
	 */
	askImages(projectid, info) {
		const self = this;
		var key = projectid || null;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		const known = this.getImageChoice(key);
		if (known === true || known === false) return Promise.resolve(known);

		const inflight = key ? this.imageAsks.get(key) : null;
		if (inflight) return inflight;

		var target;
		try { target = this._targetTab(projectid || null); }
		catch (e) { return Promise.resolve(false); }

		// Sent DIRECTLY to the tab, not through the per-board draw queue: the tool
		// call that triggered it is what the answer decides, so queueing it behind
		// that same board's work would deadlock.
		const ask = this._request(target.ws, {
			t: 'media-ask',
			toolName: (info && info.toolName) || '',
			label: (info && info.label) || 'this component',
			// 'slots' = optional imagery inside a component the agent already wrote;
			// 'component' = the asset IS the component, so a no creates nothing.
			kind: (info && info.kind) || 'slots',
			surface: (key && this.turnSurfaces.get(key)) || 'mida'
		}, config.PLAN_PICK_TIMEOUT_MS)
			.then(function(res) {
				const on = !!(res && res.withImages);
				self.log('[images] user chose ' + (on ? 'WITH' : 'without') + ' images for this turn');
				if (key) self.imageChoices.set(key, on);
				return on;
			})
			.catch(function(err) {
				self.log('[images] ask not answered (' + (err && err.message) + ') - continuing without images');
				if (key) self.imageChoices.set(key, false);
				return false;
			});

		if (key) this.imageAsks.set(key, ask);
		return ask;
	}

	/**
	 * The user asked for images on a component the agent already rendered without
	 * them. Nobody is waiting - that turn ended at the question - so this starts a
	 * fresh one: the agent is handed back exactly what it sent and renders it
	 * again with image slots. Wired to the agent manager by the daemon, like
	 * onPlanGenerate.
	 *
	 * `req`: { toolName, args, guidance, label }
	 */
	requestImageRerender(projectid, req) {
		var target;
		try { target = this._targetTab(projectid || null); }
		catch (e) {
			this.log('[images] cannot re-render for images: ' + (e && e.message));
			return;
		}
		const key = target.tab.projectid || target.tab.id;
		// The re-render must pass the gate instead of asking again.
		this.imageChoices.set(key, true);
		const self = this;
		const sendToTab = function(frame) { self._send(target.ws, frame); };
		if (!this.onImageRerender) {
			this.log('[images] re-render is not enabled on this bridge - the component stays without images');
			return;
		}
		this.log('[images] re-rendering ' + req.toolName + ' with image slots on board ' + key);
		this.onImageRerender(target.tab, req, sendToTab);
	}

	// ---- requests ------------------------------------------------------------

	/**
	 * Send one frame to the targeted board tab and await its {t:'result'} reply.
	 * Calls against the SAME board are serialized through a per-board promise
	 * queue so parallel agents cannot interleave placements mid-draw.
	 *
	 * turnWs pins the frame to one specific tab (the one whose turn this is) while
	 * that socket is open - see _sendToBoard. Everything else resolves by board and
	 * lands on whichever tab is showing it, which is right for a plain draw and wrong
	 * for the answer to a turn.
	 */
	runOnBoard(projectid, frame, timeoutMs, turnWs) {
		const self = this;
		const target = (turnWs && turnWs.readyState === 1)
			? { ws: turnWs, tab: this.tabs.get(turnWs) || { projectid: projectid } }
			: this._targetTab(projectid || null);
		const key = target.tab.projectid || target.tab.id;

		const tail = this.queues.get(key) || Promise.resolve();
		const run = tail.catch(function() {}).then(function() {
			return self._request(target.ws, frame, timeoutMs || config.TOOL_TIMEOUT_MS);
		});
		this.queues.set(key, run);
		// .finally() returns a NEW promise that inherits the rejection. The caller
		// catches `run`, not this one, so a tab that answers {ok:false} used to end
		// the process as an unhandled rejection - one failed draw taking the whole
		// bridge down with it. The cleanup must swallow what it re-raises.
		run.finally(function() {
			if (self.queues.get(key) === run) self.queues.delete(key);
		}).catch(function() {});
		return run;
	}

	_request(ws, frame, timeoutMs) {
		const self = this;
		return new Promise(function(resolve, reject) {
			const id = 'req_' + (self.nextId++);
			frame.id = id;
			const timer = setTimeout(function() {
				self.pending.delete(id);
				reject(new Error('The board tab did not answer in time. Is it still open?'));
			}, timeoutMs);
			self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
			self._send(ws, frame);
		});
	}

	// ---- token persistence ---------------------------------------------------

	_loadTokens() {
		try {
			const data = JSON.parse(fs.readFileSync(config.TOKENS_FILE, 'utf8'));
			if (data && Array.isArray(data.tokens)) return data.tokens;
		} catch (e) {}
		return [];
	}

	_saveTokens() {
		try {
			fs.mkdirSync(config.HOME_DIR, { recursive: true });
			fs.writeFileSync(config.TOKENS_FILE, JSON.stringify({ tokens: this.tokens }, null, '\t'));
		} catch (e) {
			this.log('Could not persist pairing tokens:', e && e.message);
		}
	}
}

module.exports = BoardHub;
