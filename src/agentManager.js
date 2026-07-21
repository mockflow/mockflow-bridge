/**
 * MockFlow Bridge - agent manager (Mode B: Mida/CB "local agent" chat).
 *
 * When the editor's chat (Ask Mida / Concept Builder) has the Local agent
 * toggle on, chat turns arrive over the board socket as {t:'chat'} frames.
 * This manager runs the turn on the user's OWN agent - headless Claude Code
 * spawned on this machine - with the bridge's render tools injected via MCP,
 * and streams events back to the tab:
 *
 *   {t:'chat-delta', id, text}   full accumulated reply text so far
 *   {t:'chat-step',  id, step}   tool timeline row (same shape as ai-step)
 *   {t:'chat-done',  id, ok, text?, error?}
 *
 * Ported from MockFlow-AgentBoard's claudeCodeAdapter (stream-json parsing,
 * session resume). Design rules from the spec ("Local codebase access"):
 *   - workspace: agent runs in --workspace <path> (or MFBRIDGE_WORKSPACE);
 *     without one it runs in an empty scratch dir so it can read nothing.
 *   - read-only default: Read/Grep/Glob plus the bridge MCP tools only.
 *     No Write/Edit/Bash unless MFBRIDGE_ALLOW_WRITE=1.
 *   - one turn at a time per board; session id kept per board for multi-turn
 *     memory and low latency.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const PERSONA =
	'You are Mida, MockFlow\'s AI assistant, chatting inside the user\'s live IdeaBoard. '
	+ 'When a visual (diagram, chart, kanban, plan, mindmap, table...) would help, draw it '
	+ 'on the board with the mockflow render tools - the user watches it appear instantly. '
	+ 'When a request needs SEVERAL visualizations (a plan, workspace, dashboard, or a '
	+ 'multi-screen app), call plan_board with the component list (each item carrying a '
	+ 'self-contained brief) and stop - the user confirms the list on the board and the '
	+ 'chosen items are generated and arranged automatically, without you. After calling '
	+ 'plan_board just tell the user to review the list and click Generate Board. '
	+ 'Your text replies show in a small chat bubble: keep them short, friendly and plain. '
	+ 'Never output URLs, file paths or markdown links, and never tell the user to open '
	+ 'anything - what you draw is already on their board. Never use em dashes or en '
	+ 'dashes in replies; use commas or periods instead.';

/**
 * How to invoke the `claude` CLI portably. On Windows it is installed as a
 * .cmd shim which spawn() refuses to execute directly (EINVAL since the
 * CVE-2024-27980 hardening), so the call is routed through cmd.exe with
 * cross-spawn style argument escaping. Everywhere else it is a plain spawn.
 * Returns { file, args, opts } to splat into spawn/spawnSync.
 */
function claudeSpawnSpec(args) {
	if (process.platform !== 'win32') return { file: 'claude', args: args, opts: {} };
	const line = ['claude'].concat(args.map(escapeCmdArgument)).join(' ');
	return {
		file: 'cmd.exe',
		args: ['/d', '/s', '/c', '"' + line + '"'],
		opts: { windowsVerbatimArguments: true }
	};
}

/** cmd.exe argument escaping (same rules as the cross-spawn package):
 *  backslash-double quotes, quote the whole arg, caret-escape metachars. */
function escapeCmdArgument(arg) {
	arg = String(arg).replace(/(\\*)"/g, '$1$1\\"');
	arg = arg.replace(/(\\*)$/, '$1$1');
	arg = '"' + arg + '"';
	return arg.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}

/** Stop an agent process. On Windows the process is a cmd.exe wrapper, so a
 *  plain kill would orphan the real agent - use taskkill on the whole tree. */
function killProcTree(proc) {
	if (!proc) return;
	if (process.platform === 'win32') {
		try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
	} else {
		try { proc.kill('SIGTERM'); } catch (e) {}
	}
}

class AgentManager {
	constructor(opts) {
		this.log = (opts && opts.log) || function() {};
		this.workspace = this._resolveWorkspace(opts && opts.workspace);
		this.registry = (opts && opts.registry) || null; // catalog, for comptype->tool
		this.sessions = new Map();    // projectid -> { sessionId, proc, busy }
		this.compgenProcs = new Map(); // key -> child process (component-AI turns)
		this.planProcs = new Map();    // key -> child process (plan_board continuation turns)
		this.available = null;        // cached `claude` detection
	}

	/**
	 * The render_* MCP tool(s) that can fill a given component type, as an array.
	 * Purely registry-driven (no component-specific code). An entry fills a comptype
	 * when any of these registry fields names it:
	 *   - clientComp        the usual 1:1 tool<->component mapping
	 *   - fillsComptype     a single comptype for tools whose clientComp is null
	 *                       (polymorphic frames: DiagramFrame -> flowchart + cloud)
	 *   - fillsComptypes[]  several comptypes one tool can fill (render_chart fills
	 *                       any of the 8 chart components via its componentType arg)
	 * Returns [] when nothing local can produce this component.
	 */
	_toolsForComptype(comptype, includeHtml) {
		if (!comptype || !this.registry) return [];
		var out = [];
		for (var i = 0; i < this.registry.length; i++) {
			var e = this.registry[i];
			if (!e.mcpToolName) continue;
			// HTML-conversion tools (render_wireframelite / render_prototypelite) always
			// DRAW on the board (boardHub.drawHtml bypasses the capture), so they can
			// never fill a component in place. For fill modes, returning them would arm
			// a capture that is never consumed and end in a double generation (local
			// draw + server fallback). Draw-new modes (includeHtml, e.g. create-similar)
			// want exactly that draw, so they opt in.
			if (e.clientIsHtmlConversion && !includeHtml) continue;
			var match = e.clientComp === comptype
				|| e.fillsComptype === comptype
				|| (Array.isArray(e.fillsComptypes) && e.fillsComptypes.indexOf(comptype) !== -1);
			if (match) out.push(e.mcpToolName);
		}
		return out;
	}

	/** True if any of these tools is a real-world/current-data component
	 *  (catalog `webResearch` flag). */
	_toolWantsResearch(toolNames) {
		if (!this.registry || !toolNames || !toolNames.length) return false;
		for (var i = 0; i < this.registry.length; i++) {
			if (this.registry[i].webResearch && toolNames.indexOf(this.registry[i].mcpToolName) !== -1) return true;
		}
		return false;
	}

	_resolveWorkspace(cliWorkspace) {
		var explicit = cliWorkspace || process.env.MFBRIDGE_WORKSPACE || null;
		if (explicit) {
			var w = path.resolve(explicit);
			if (fs.existsSync(w)) { this.hasWorkspace = true; return w; }
			this.log && this.log('Workspace not found: ' + w + ' - files stay disabled.');
		}
		// Files are OFF by default: the agent runs in an empty scratch dir and can
		// read nothing. Opt in explicitly with --workspace <path> (or
		// MFBRIDGE_WORKSPACE) to let Mida read that one folder. Nothing is ever
		// uploaded either way - only what the agent draws is sent to MockFlow.
		this.hasWorkspace = false;
		var scratch = path.join(os.tmpdir(), 'mockflow-bridge-scratch');
		try { fs.mkdirSync(scratch, { recursive: true }); } catch (e) {}
		return scratch;
	}

	detect() {
		if (this.available !== null) return this.available;
		try {
			const spec = claudeSpawnSpec(['--version']);
			const r = spawnSync(spec.file, spec.args, Object.assign({ encoding: 'utf8' }, spec.opts));
			this.available = r.status === 0;
		} catch (e) {
			this.available = false;
		}
		return this.available;
	}

	_mcpConfigPath() {
		const cfg = {
			mcpServers: {
				mockflow: { type: 'http', url: 'http://127.0.0.1:' + config.PORT + '/mcp' }
			}
		};
		const p = path.join(config.HOME_DIR, 'bridge-agent-mcp.json');
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(p, JSON.stringify(cfg, null, '\t'));
		return p;
	}

	_allowedTools() {
		var tools = ['Read', 'Grep', 'Glob', 'mcp__mockflow__*'];
		if (process.env.MFBRIDGE_ALLOW_WRITE === '1') tools.push('Write', 'Edit', 'Bash');
		return tools.join(',');
	}

	/**
	 * Run one chat turn for a tab. `sendToTab(frame)` delivers frames back.
	 * `hub` is used to pin render targeting to the chatting board for the
	 * duration of the turn.
	 */
	handleChat(tab, frame, sendToTab, hub) {
		const self = this;
		const turnId = frame.id;
		const text = String(frame.text || '').trim();
		const key = tab.projectid || tab.id;

		if (!text) {
			return sendToTab({ t: 'chat-done', id: turnId, ok: false, error: 'Empty message' });
		}
		if (!this.detect()) {
			return sendToTab({
				t: 'chat-done', id: turnId, ok: false,
				error: 'Claude Code is not installed on this machine. Install it with: npm i -g @anthropic-ai/claude-code, sign in once with `claude`, then try again.'
			});
		}

		var session = this.sessions.get(key);
		if (session && session.busy) {
			return sendToTab({ t: 'chat-done', id: turnId, ok: false, error: 'The local agent is still working on the previous message.' });
		}
		if (!session) {
			session = { sessionId: null, proc: null, busy: false };
			this.sessions.set(key, session);
		}
		session.busy = true;

		// Pin render targeting to the chatting board for this turn, so the
		// agent's tool calls land on the board the message came from even if
		// the user tabs away while it thinks.
		const prevSelected = hub.selectedProjectId;
		if (tab.projectid) hub.selectedProjectId = tab.projectid;

		// When no workspace is set the agent can read no files. If the user asks
		// about their local files, answer helpfully instead of failing silently.
		var systemPrompt = PERSONA;
		if (!this.hasWorkspace) {
			systemPrompt += ' You currently have no access to the user\'s files (no workspace is set). '
				+ 'If they ask you to read their local files, code, repo, docs or transcripts, briefly tell '
				+ 'them to restart the bridge with --workspace <path> to enable it, and reassure them their '
				+ 'files are never uploaded: only what you draw is sent to MockFlow, and the reading and '
				+ 'thinking happen on their own machine.';
		}

		const args = [
			'-p', text,
			'--output-format', 'stream-json',
			'--verbose',
			'--mcp-config', this._mcpConfigPath(),
			'--allowedTools', this._allowedTools(),
			'--append-system-prompt', systemPrompt
		];
		if (session.sessionId) args.push('--resume', session.sessionId);

		this.log('Local agent turn for board "' + (tab.title || key) + '"'
			+ (session.sessionId ? ' (resumed session)' : ' (new session)')
			+ ', workspace: ' + this.workspace);

		var proc;
		try {
			const spec = claudeSpawnSpec(args);
			proc = spawn(spec.file, spec.args, Object.assign({ env: process.env, cwd: this.workspace }, spec.opts));
		} catch (err) {
			session.busy = false;
			hub.selectedProjectId = prevSelected;
			return sendToTab({ t: 'chat-done', id: turnId, ok: false, error: 'Could not launch the local agent: ' + err.message });
		}
		session.proc = proc;

		var replyText = '';
		var openSteps = {};
		var stepCounter = 0;
		var buf = '';

		function handleLine(line) {
			var evt;
			try { evt = JSON.parse(line); } catch (e) { return; }

			if (evt.session_id && !session.sessionId) session.sessionId = evt.session_id;

			if (evt.type === 'assistant') {
				var content = (evt.message && evt.message.content) || [];
				for (var i = 0; i < content.length; i++) {
					var block = content[i];
					if (block.type === 'text' && block.text) {
						replyText += (replyText ? '\n\n' : '') + block.text;
						sendToTab({ t: 'chat-delta', id: turnId, text: replyText });
					} else if (block.type === 'tool_use') {
						var stepId = 'la_' + turnId + '_' + (stepCounter++);
						openSteps[block.id || stepId] = { stepId: stepId, started: Date.now() };
						var label = String(block.name || 'tool').replace(/^mcp__mockflow__/, '').replace(/^render_/, 'Drawing ').replace(/_/g, ' ');
						sendToTab({
							t: 'chat-step', id: turnId,
							step: { stepId: stepId, phase: 'start', tool: block.name, label: label, detail: '' }
						});
					}
				}
			} else if (evt.type === 'user') {
				var ucontent = (evt.message && evt.message.content) || [];
				for (var j = 0; j < ucontent.length; j++) {
					var ublock = ucontent[j];
					if (ublock.type === 'tool_result') {
						var open = openSteps[ublock.tool_use_id];
						if (open) {
							delete openSteps[ublock.tool_use_id];
							sendToTab({
								t: 'chat-step', id: turnId,
								step: { stepId: open.stepId, phase: 'end', ok: !ublock.is_error, elapsedMs: Date.now() - open.started }
							});
						}
					}
				}
			}
		}

		proc.stdout.on('data', function(chunk) {
			buf += chunk.toString();
			var nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				var line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) handleLine(line);
			}
		});

		var stderrTail = '';
		proc.stderr.on('data', function(d) {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
		});

		function finish(ok, error) {
			if (!session.busy) return;
			session.busy = false;
			session.proc = null;
			hub.selectedProjectId = prevSelected;
			// Close any dangling step rows so the timeline never spins forever.
			for (var k in openSteps) {
				sendToTab({ t: 'chat-step', id: turnId, step: { stepId: openSteps[k].stepId, phase: 'end', ok: false, elapsedMs: Date.now() - openSteps[k].started } });
			}
			sendToTab({ t: 'chat-done', id: turnId, ok: ok, text: replyText, error: error });
		}

		proc.on('error', function(err) {
			self.log('Agent process error: ' + err.message);
			finish(false, 'Local agent error: ' + err.message);
		});

		proc.on('close', function(code) {
			if (code !== 0 && !replyText) {
				self.log('Agent exited ' + code + ': ' + stderrTail);
				finish(false, 'The local agent exited unexpectedly'
					+ (stderrTail ? ' (' + stderrTail.split('\n').pop().slice(0, 200) + ')' : '') + '.');
			} else {
				finish(true, null);
			}
		});
	}

	cancel(tab) {
		const key = tab.projectid || tab.id;
		const session = this.sessions.get(key);
		if (session && session.proc) killProcTree(session.proc);
	}

	/**
	 * Run one component QuickSettings AI turn on the user's own agent.
	 *
	 * frame: { id, comptype, mode:'createai'|'modifyai'|'convertai', prompt }
	 * The prompt is self-contained (Modify/Convert already embed the current
	 * component data). Create/Modify FILL the edited component in place: a capture
	 * is armed so the agent's render_<tool> call is routed back to the tab instead
	 * of drawing a new component. Convert draws the new component normally.
	 *
	 * On any case the bridge cannot handle (no tool for the type, agent missing,
	 * agent produced nothing), it replies { fallback:true } so the client re-runs
	 * the normal server generation and the turn is never lost.
	 */
	handleCompGen(tab, frame, sendToTab, hub) {
		const self = this;
		const turnId = frame.id;
		const comptype = String(frame.comptype || '');
		const mode = String(frame.mode || 'createai');
		const prompt = String(frame.prompt || '').trim();
		const key = tab.projectid || tab.id;

		const isConvert = (mode === 'convertai');
		// Create-similar: a draw-new turn like Convert (no capture - the agent's render
		// tool call draws a NEW sibling component), but restricted to the edited
		// component's own tool. The prompt is self-contained: the reference design
		// travels inside it (built client-side as localAgentPrompt).
		const isSimilar = (mode === 'createsimilar');
		const tools = isConvert ? [] : this._toolsForComptype(comptype, isSimilar);
		const wantsResearch = !isConvert && this._toolWantsResearch(tools);

		if (!prompt) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'Empty prompt' });
		}
		if (!isConvert && tools.length === 0) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'No local tool for component ' + comptype });
		}
		if (!this.detect()) {
			return sendToTab({
				t: 'compgen-done', id: turnId, ok: false, fallback: true,
				error: 'Claude Code is not installed, so component AI cannot run on the local agent.'
			});
		}
		if (this.compgenProcs.has(key) || hub.hasCapture(tab.projectid)) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, error: 'A component is already generating on this board. Please wait.' });
		}

		// Pin render targeting to the requesting board for the whole turn.
		const prevSelected = hub.selectedProjectId;
		if (tab.projectid) hub.selectedProjectId = tab.projectid;

		// Create/Modify fill the component in place: arm the capture so the agent's
		// render_<tool> call routes back to this tab instead of drawing new.
		// Convert and create-similar draw a NEW component, so no capture.
		if (!isConvert && !isSimilar) hub.setCapture(tab.projectid, turnId, sendToTab);
		// Convert draws a NEW component; tag it with its source so the client connects
		// and positions it relative to the source (parity with server convert).
		if (isConvert && frame.fromconvert && tab.projectid) hub.convertContext.set(tab.projectid, frame.fromconvert);

		var systemPrompt, allowed;
		if (isConvert) {
			systemPrompt = 'You convert a MockFlow component into the different component the user asked for. '
				+ 'Draw that component on the board with the correct mockflow render tool, using the data provided. '
				+ 'Call exactly one render tool. Do not chat, do not output any text, and never output a URL or a link.';
			allowed = 'mcp__mockflow__*';
		} else if (isSimilar) {
			systemPrompt = 'You create ONE NEW screen belonging to the same app as the reference screen embedded in '
				+ 'the prompt. Reuse the reference design system faithfully (brand, colours, fonts, and every '
				+ 'persistent chrome region) while generating fresh content for the requested screen, and give the '
				+ 'new screen a short title. Call the ' + tools[0] + ' tool exactly once with complete data. Do not '
				+ 'draw anything else, do not call any other tool, do not chat, do not output any text, and never '
				+ 'output a URL or a link.';
			allowed = 'mcp__mockflow__' + tools[0];
		} else {
			// If a tool has a component-type argument (e.g. render_chart's componentType),
			// it must be pinned to the component being edited. Stated generically so no
			// tool-specific code is needed.
			var typeHint = ' The component being edited is of type "' + comptype + '"; if the tool takes a '
				+ 'componentType or type argument, set it to exactly that so the right component is filled.';
			if (tools.length === 1) {
			var toolLabel = tools[0].replace(/^render_/, '');
			systemPrompt = 'You generate the data for a single MockFlow ' + toolLabel + ' component the user is editing '
				+ 'in place. Call the ' + tools[0] + ' tool exactly once with complete, well-formed data for the request.'
				+ typeHint + ' The result fills the component the user is editing - do not draw anything else, do not call '
				+ 'any other tool, do not chat, do not output any text, and never output a URL or a link.';
			allowed = 'mcp__mockflow__' + tools[0];
		} else {
			systemPrompt = 'You generate the data for a single MockFlow component the user is editing in place. '
				+ 'Choose the ONE tool from [' + tools.join(', ') + '] that best fits the request and call it exactly '
				+ 'once with complete, well-formed data.' + typeHint + ' The result fills the component the user is editing '
				+ '- do not draw anything else, do not call any other tool, do not chat, do not output any text, and never output a URL or a link.';
			allowed = tools.map(function(t) { return 'mcp__mockflow__' + t; }).join(',');
			}
		}

		// Real-world/current-data components: let the agent web-research first, but
		// ALWAYS fall back to its own knowledge if search is off/unavailable/empty -
		// it must never skip generating the component.
		if (wantsResearch) {
			allowed += ',WebSearch,WebFetch';
			systemPrompt += ' If the request depends on real-world, current, or factual data '
				+ '(live statistics, prices, dates, real places, market figures), first use WebSearch/WebFetch '
				+ 'to get accurate up-to-date information. If web search is unavailable, errors, or returns nothing '
				+ 'useful, do NOT stop - generate the component from your own knowledge instead. Always finish by '
				+ 'calling the render tool with complete data.';
		}

		const args = [
			'-p', prompt,
			'--output-format', 'stream-json',
			'--verbose',
			'--mcp-config', this._mcpConfigPath(),
			'--allowedTools', allowed,
			'--append-system-prompt', systemPrompt
		];

		this.log('Component AI turn (' + mode + ') for "' + (tab.title || key) + '"'
			+ (tools.length ? ' via ' + tools.join('/') : '') + ', workspace: ' + this.workspace);

		var proc;
		try {
			const spec = claudeSpawnSpec(args);
			proc = spawn(spec.file, spec.args, Object.assign({ env: process.env, cwd: this.workspace }, spec.opts));
		} catch (err) {
			hub.clearCapture(tab.projectid);
			hub.selectedProjectId = prevSelected;
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'Could not launch the local agent: ' + err.message });
		}
		this.compgenProcs.set(key, proc);

		var openSteps = {};
		var stepCounter = 0;
		var buf = '';
		var toolCalled = false;

		function handleLine(line) {
			var evt;
			try { evt = JSON.parse(line); } catch (e) { return; }

			if (evt.type === 'assistant') {
				var content = (evt.message && evt.message.content) || [];
				for (var i = 0; i < content.length; i++) {
					var block = content[i];
					if (block.type === 'tool_use') {
						toolCalled = true;
						var stepId = 'cg_' + turnId + '_' + (stepCounter++);
						openSteps[block.id || stepId] = { stepId: stepId, started: Date.now() };
						var label = String(block.name || 'tool').replace(/^mcp__mockflow__/, '').replace(/^render_/, 'Generating ').replace(/_/g, ' ');
						sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: stepId, phase: 'start', tool: block.name, label: label, detail: '' } });
					}
				}
			} else if (evt.type === 'user') {
				var ucontent = (evt.message && evt.message.content) || [];
				for (var j = 0; j < ucontent.length; j++) {
					var ublock = ucontent[j];
					if (ublock.type === 'tool_result') {
						var open = openSteps[ublock.tool_use_id];
						if (open) {
							delete openSteps[ublock.tool_use_id];
							sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: open.stepId, phase: 'end', ok: !ublock.is_error, elapsedMs: Date.now() - open.started } });
						}
					}
				}
			}
		}

		proc.stdout.on('data', function(chunk) {
			buf += chunk.toString();
			var nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				var line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) handleLine(line);
			}
		});

		var stderrTail = '';
		proc.stderr.on('data', function(d) { stderrTail = (stderrTail + d.toString()).slice(-2000); });

		var finished = false;
		function finish(ok, error, fallback) {
			if (finished) return;
			finished = true;
			self.compgenProcs.delete(key);
			// A still-armed capture (create/modify) means the agent never produced
			// the data - drop it and let the client fall back to the server.
			var stillArmed = hub.hasCapture(tab.projectid);
			hub.clearCapture(tab.projectid);
			if (tab.projectid) hub.convertContext.delete(tab.projectid);
			hub.selectedProjectId = prevSelected;
			for (var k in openSteps) {
				sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: openSteps[k].stepId, phase: 'end', ok: false, elapsedMs: Date.now() - openSteps[k].started } });
			}
			if (!isConvert && stillArmed && ok) {
				return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'The local agent did not produce component data.' });
			}
			sendToTab({ t: 'compgen-done', id: turnId, ok: ok, error: error, fallback: fallback });
		}

		proc.on('error', function(err) {
			self.log('Component AI process error: ' + err.message);
			finish(false, 'Local agent error: ' + err.message, true);
		});

		proc.on('close', function(code) {
			if (code !== 0 && !toolCalled) {
				self.log('Component AI exited ' + code + ': ' + stderrTail);
				finish(false, 'The local agent exited unexpectedly'
					+ (stderrTail ? ' (' + stderrTail.split('\n').pop().slice(0, 200) + ')' : '') + '.', true);
			} else {
				finish(true, null, false);
			}
		});
	}

	/**
	 * Run the plan_board continuation: the user clicked Generate Board, so
	 * render the chosen items. Fired by boardHub.onPlanGenerate AFTER the
	 * auto-arrange plan was armed - the proposing agent's turn ended at the
	 * proposal, so a fresh headless turn does the rendering, driven entirely
	 * by the plan's self-contained briefs (no conversation context needed).
	 * Draws flow through the normal MCP loopback, get counted by the armed
	 * plan, and the board arranges itself after the last item.
	 */
	handlePlanGenerate(tab, plan, hub) {
		const self = this;
		const key = tab.projectid || tab.id;
		const items = (plan && plan.items) || [];
		if (!items.length) return;
		if (!this.detect()) {
			this.log('Plan generate skipped: Claude Code is not installed.');
			hub.clearPlan(tab.projectid);
			return;
		}
		if (this.planProcs.has(key)) {
			this.log('Plan generate already running for "' + (tab.title || key) + '" - ignored.');
			return;
		}

		const prevSelected = hub.selectedProjectId;
		if (tab.projectid) hub.selectedProjectId = tab.projectid;

		// Only the tools the plan actually uses.
		const toolSet = {};
		for (var i = 0; i < items.length; i++) toolSet['mcp__mockflow__' + items[i].tool] = true;
		const allowed = Object.keys(toolSet).join(',');

		const lines = items.map(function(it, i) {
			return (i + 1) + '. ' + (it.name || 'Item') + ' [tool: ' + it.tool + ']: ' + (it.brief || '');
		});
		const prompt = 'The user confirmed this board plan - render it now.\n'
			+ 'Board: "' + (plan.boardTitle || 'Board') + '"\nItems (render in this order):\n' + lines.join('\n');

		const systemPrompt = 'You render the items of a board plan the user just confirmed on their live '
			+ 'MockFlow board. Call each item\'s listed render tool exactly once, in order, with complete, '
			+ 'well-formed data built from its brief. If several items are wireframe screens of one app, keep '
			+ 'ONE shared design system and pass the SAME viewportWidth on every screen. The board arranges '
			+ 'itself after the last item - do not call plan_board or layout_board, do not draw anything beyond '
			+ 'the plan, do not chat, and never output a URL or a link.';

		const args = [
			'-p', prompt,
			'--output-format', 'stream-json',
			'--verbose',
			'--mcp-config', this._mcpConfigPath(),
			'--allowedTools', allowed,
			'--append-system-prompt', systemPrompt
		];

		this.log('Plan generate: ' + items.length + ' items for "' + (tab.title || key) + '"');

		var proc;
		try {
			const spec = claudeSpawnSpec(args);
			proc = spawn(spec.file, spec.args, Object.assign({ env: process.env, cwd: this.workspace }, spec.opts));
		} catch (err) {
			this.log('Plan generate launch failed: ' + err.message);
			hub.clearPlan(tab.projectid);
			hub.selectedProjectId = prevSelected;
			return;
		}
		this.planProcs.set(key, proc);

		// Drain stdout (stream-json) so the pipe never blocks the child.
		proc.stdout.on('data', function() {});
		var stderrTail = '';
		proc.stderr.on('data', function(d) { stderrTail = (stderrTail + d.toString()).slice(-2000); });

		// Backstop: a hung continuation never pins the board's plan forever.
		const killer = setTimeout(function() { killProcTree(proc); }, config.PLAN_TIMEOUT_MS);

		const done = function(what) {
			clearTimeout(killer);
			self.planProcs.delete(key);
			hub.selectedProjectId = prevSelected;
			// Leftover plan count means the agent died mid-batch - drop it so the
			// stale plan never re-arranges a later, unrelated batch.
			hub.clearPlan(tab.projectid);
			self.log('Plan generate ' + what + ' for "' + (tab.title || key) + '"'
				+ (what !== 'finished' && stderrTail ? ' (' + stderrTail.split('\n').pop().slice(0, 200) + ')' : ''));
		};
		proc.on('error', function() { done('failed to run'); });
		proc.on('close', function(code) { done(code === 0 ? 'finished' : 'exited ' + code); });
	}

	cancelCompGen(tab) {
		const key = tab.projectid || tab.id;
		const proc = this.compgenProcs.get(key);
		if (proc) killProcTree(proc);
	}
}

module.exports = AgentManager;
