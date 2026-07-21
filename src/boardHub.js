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
 *                   {t:'register', projectid, title, focused, visible, url}
 *                   {t:'state', focused, visible, projectid, title}
 *                   {t:'result', id, ok, data?, error?}
 *   bridge -> tab:  {t:'pair-required'}
 *                   {t:'paired', token}
 *                   {t:'ready'}                 authenticated, please register
 *                   {t:'registered'}
 *                   {t:'tool', id, toolName, gdata}
 *                   {t:'toolhtml', id, toolName, mcpType, args, fromconvert?}
 *                   {t:'read', id, what}
 *                   {t:'layout', id, boardTitle}
 *                   {t:'snapshot', id}              reset the layout batch boundary
 *                   {t:'plan-pick', id, boardTitle, items}   user selects plan items
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
		this.heartbeat = setInterval(function() {
			self.wss.clients.forEach(function(ws) {
				if (ws.isAlive === false) return ws.terminate();
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
		});
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
				tab.registered = true;
				tab.projectid = msg.projectid || null;
				tab.title = msg.title || null;
				tab.focused = !!msg.focused;
				tab.visible = msg.visible !== false;
				tab.url = msg.url || null;
				this._send(ws, { t: 'registered', agentInfo: this.agentInfo || null });
				this.log('Board connected: "' + (tab.title || tab.projectid) + '"'
					+ (tab.focused ? ' (focused)' : ''));
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
				else p.reject(new Error(msg.error || 'Tab reported failure'));
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
					this.onCompGen(tab, msg, function(frame) { self._send(ws, frame); }, this);
				} else {
					this._send(ws, { t: 'compgen-done', id: msg.id, ok: false, fallback: true, error: 'Component AI is not enabled on this bridge.' });
				}
				return;
			}

			case 'compgen-cancel':
				if (tab.registered && this.onCompGenCancel) this.onCompGenCancel(tab);
				return;
		}
	}

	_send(ws, frame) {
		try { ws.send(JSON.stringify(frame)); } catch (e) {}
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
	 */
	setCapture(projectid, turnId, send) {
		if (projectid) this.captures.set(projectid, { turnId: turnId, send: send });
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
	captureOrDraw(projectid, toolName, gdata) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		var cap = key ? this.captures.get(key) : null;
		if (cap) {
			this.captures.delete(key);
			cap.send({ t: 'compgen-data', id: cap.turnId, gdata: gdata });
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
		return this.runOnBoard(projectid, { t: 'tool', toolName: toolName, gdata: gdata })
			.then(function(res) {
				return self._notePlannedDraw(key).then(function(arranged) { return arranged || res; });
			});
	}

	// ---- plan_board (plan-first multiboard pipeline) --------------------------

	/**
	 * Arm a plan_board batch: the tab resets its layout batch boundary (snapshot),
	 * then every draw on this board counts against the plan; when the last planned
	 * item lands, the batch is auto-arranged (bento + titled section) - the same
	 * end state as the MockFlow AI multiboard pipeline. One plan per board;
	 * a new plan replaces the old, an expired plan is simply forgotten.
	 */
	armPlan(projectid, boardTitle, itemCount) {
		const self = this;
		const target = this._targetTab(projectid || null);
		const key = target.tab.projectid || target.tab.id;
		return this.runOnBoard(projectid, { t: 'snapshot' }, config.READ_TIMEOUT_MS)
			.catch(function() {})  // an old tab without snapshot support still batches from its last layout
			.then(function() {
				self.plans.set(key, {
					boardTitle: boardTitle,
					remaining: itemCount,
					expires: Date.now() + config.PLAN_TIMEOUT_MS
				});
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

		this._request(target.ws, { t: 'plan-pick', boardTitle: boardTitle, items: items },
			config.PLAN_PICK_TIMEOUT_MS)
			.then(function(res) {
				settle();
				if (res && res.cancelled) return;  // user skipped the plan
				var chosen = items;                // auto reply (no picker UI) -> full plan
				if (res && Array.isArray(res.items)) {
					var sel = res.items.map(function(i) { return items[i]; }).filter(Boolean);
					if (!sel.length) return;
					chosen = sel;
				}
				return self.armPlan(projectid, boardTitle, chosen.length).then(function() {
					if (self.onPlanGenerate)
						self.onPlanGenerate(target.tab, { boardTitle: boardTitle, items: chosen });
				});
			})
			.catch(function() { settle(); });  // picker ignored past its window: nothing generates
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
	_notePlannedDraw(key) {
		if (!key) return Promise.resolve(null);
		const plan = this.plans.get(key);
		if (!plan) return Promise.resolve(null);
		if (Date.now() > plan.expires) {
			this.plans.delete(key);
			return Promise.resolve(null);
		}
		plan.remaining--;
		if (plan.remaining > 0) return Promise.resolve(null);
		this.plans.delete(key);
		return this.runOnBoard(key, { t: 'layout', boardTitle: plan.boardTitle })
			.then(function(count) { return { arranged: true, boardTitle: plan.boardTitle, count: count }; })
			.catch(function() { return null; });  // layout failure never fails the draw that triggered it
	}

	/**
	 * HTML-conversion tools (render_wireframelite / render_prototypelite): the raw
	 * tool args go to the tab, which runs the HTML conversion through the MockFlow
	 * endpoints with the user's own session and draws the result itself. An armed
	 * component-AI capture is deliberately NOT consumed here: fill-in-place compgen
	 * modes never allow these tools (agentManager skips clientIsHtmlConversion
	 * types), and draw-new modes (create-similar) arm no capture - so an html draw
	 * while a capture is armed can only be an unrelated Mode A agent, and drawing
	 * normally is correct and leaves the armed turn intact.
	 */
	drawHtml(projectid, toolName, mcpType, args) {
		var key = projectid;
		if (!key) {
			try { key = this._targetTab(null).tab.projectid || null; } catch (e) { key = null; }
		}
		// Same plan-selection gate as captureOrDraw: never draw past the picker.
		if (this.hasPendingPick(key)) {
			return Promise.reject(new Error(
				'The user has not confirmed the board plan yet - the selection is on their screen. '
				+ 'STOP: do not render anything. Generation starts automatically when the user clicks '
				+ 'Generate Board; your part ended when you proposed the plan.'));
		}
		const frame = { t: 'toolhtml', toolName: toolName, mcpType: mcpType, args: args || {} };
		// Convert AI: tag the drawn component with its source so the client connects
		// and positions it relative to the source (parity with captureOrDraw).
		const conv = key ? this.convertContext.get(key) : null;
		if (conv) frame.fromconvert = conv;
		const self = this;
		return this.runOnBoard(projectid, frame, config.HTML_TOOL_TIMEOUT_MS)
			.then(function(res) {
				return self._notePlannedDraw(key).then(function(arranged) {
					// Keep the tab's conversion diagnostics on the result either way - the
					// arranged branch replaces the payload and would otherwise drop them.
					if (arranged && res && res.diagnostics) arranged.diagnostics = res.diagnostics;
					return arranged || res;
				});
			});
	}

	// ---- requests ------------------------------------------------------------

	/**
	 * Send one frame to the targeted board tab and await its {t:'result'} reply.
	 * Calls against the SAME board are serialized through a per-board promise
	 * queue so parallel agents cannot interleave placements mid-draw.
	 */
	runOnBoard(projectid, frame, timeoutMs) {
		const self = this;
		const target = this._targetTab(projectid || null);
		const key = target.tab.projectid || target.tab.id;

		const tail = this.queues.get(key) || Promise.resolve();
		const run = tail.catch(function() {}).then(function() {
			return self._request(target.ws, frame, timeoutMs || config.TOOL_TIMEOUT_MS);
		});
		this.queues.set(key, run);
		run.finally(function() {
			if (self.queues.get(key) === run) self.queues.delete(key);
		});
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
