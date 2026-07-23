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
 * The CLI itself is pluggable: everything agent-specific (flags, output parsing,
 * detection) lives in src/agents/<id>.js, and this file talks only to that
 * contract. Design rules from the spec ("Local codebase access"):
 *   - workspace: agent runs in --workspace <path> (or MFBRIDGE_WORKSPACE);
 *     without one it runs in an empty scratch dir so it can read nothing.
 *   - read-only default: Read/Grep/Glob plus the bridge MCP tools only.
 *     No Write/Edit/Bash unless MFBRIDGE_ALLOW_WRITE=1.
 *   - one turn at a time per board; session id kept per board for multi-turn
 *     memory and low latency.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const agents = require('./agents');

const PERSONA =
	'You are Mida, MockFlow\'s AI assistant, chatting inside the user\'s live IdeaBoard. '
	+ 'When a visual (diagram, chart, kanban, plan, mindmap, table...) would help, draw it '
	+ 'on the board with the mockflow render tools - the user watches it appear instantly. '
	+ 'When a request needs SEVERAL visualizations (a plan, workspace, dashboard, or a '
	+ 'multi-screen app), call plan_board with the component list (each item carrying a '
	+ 'self-contained brief) and stop - the user confirms the list on the board and the '
	+ 'chosen items are generated and arranged automatically, without you. After calling '
	+ 'plan_board just tell the user to review the list and click Generate Board. '
	+ 'When the user asks to change, refine, add to or fix something that is already on the '
	+ 'board, call modify_component with that component id (read_board lists the ids and labels) '
	+ 'instead of rendering it again - a second render duplicates it rather than replacing it. '
	+ 'Your text replies show in a small chat bubble: keep them short, friendly and plain. '
	+ 'Never output URLs, file paths or markdown links, and never tell the user to open '
	+ 'anything - what you draw is already on their board. Never use em dashes or en '
	+ 'dashes in replies; use commas or periods instead. '
	+ 'If a render tool answers with an error saying which arguments it expects, nothing was '
	+ 'drawn: fix those arguments and call it again instead of reporting failure to the user. '
	+ 'You have no way to prompt the user mid-turn: any tool that would ask them a '
	+ 'question, request permission, or wait for input is unavailable and will fail. '
	+ 'When you need something from the user, end your reply with the question and stop.';

/**
 * Web-research guidance for turns that may draw real-world/current-data
 * components (the catalog's `webResearch` flag). Appended to the turn's system
 * prompt wherever WebSearch/WebFetch are allowed.
 *
 * The fallback half is the important half: search can be off, blocked by policy,
 * or return nothing, and the turn must still draw. Without it a search-less setup
 * silently stops generating.
 *
 * Search runs in the user's own Claude Code on their machine, billed to their own
 * Claude plan - it never reaches MockFlow and costs no MockFlow AI credits.
 * Content grounding itself (never invent names/figures) is NOT stated here: it
 * lives in the catalog tool descriptions, so every agent gets it, not just this one.
 */
const RESEARCH_GUIDANCE =
	' If the request depends on real-world, current, or factual data (live statistics, '
	+ 'prices, dates, real places, market figures), first use WebSearch/WebFetch to get '
	+ 'accurate up-to-date information. If web search is unavailable, errors, or returns '
	+ 'nothing useful, do NOT stop - generate from your own knowledge instead and keep '
	+ 'unknown specifics as neutral placeholders rather than inventing them.';

/**
 * Human label for a tool's timeline row. "lite" is an internal product suffix,
 * not something to show a user: render_wireframelite reads as "Drawing wireframe".
 */
function toolStepLabel(toolName) {
	// Each CLI prefixes MCP tools its own way: mcp__mockflow__render_flowchart
	// (Claude Code), mockflow_render_flowchart (opencode), bare (Codex).
	return String(toolName || 'tool').replace(/^mcp__mockflow__|^mockflow[_.]/, '')
		.replace(/^render_/, 'Drawing ').replace(/_/g, ' ').replace(/lite$/, '');
}

/**
 * The most useful line of an agent's stderr, for the "it exited unexpectedly"
 * message. Agents colorize and pad their errors, so the literal last line is
 * often blank or an escape sequence - which is how a real cause (an agent CLI
 * failing to open its own log file, say) reaches the user as "( )".
 */
function lastErrorLine(stderrTail, max) {
	const lines = String(stderrTail || '')
		.replace(/\x1b\[[0-9;]*m/g, '')
		.split('\n')
		.map(function(l) { return l.trim(); })
		.filter(Boolean);
	return lines.length ? lines[lines.length - 1].slice(0, max || 200) : '';
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
		// The CLI this bridge runs turns on. Resolved by the daemon (flag, saved
		// preference, or the only one installed); falls back to the first
		// registered agent so nothing here has to null-check on every turn.
		this.agent = (opts && opts.agent) || agents.AGENTS[0];
		this.workspace = this._resolveWorkspace(opts && opts.workspace);
		this.registry = (opts && opts.registry) || null; // catalog, for comptype->tool
		this.sessions = new Map();    // projectid -> { sessionId, proc, busy }
		this.attachDirs = new Map();  // key -> folder holding this session's attachments
		this.compgenProcs = new Map(); // key -> child process (component-AI turns)
		this.planProcs = new Map();    // key -> child process (plan_board continuation turns)
		this.available = null;        // cached detection for the selected agent
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

	/**
	 * Write one attached file into this board session's folder and return its
	 * absolute path. Files stay for the session so follow-up questions ("now
	 * summarise section 3") work without re-attaching, and are removed by
	 * clearAttachments when the tab disconnects or the bridge exits.
	 *
	 * The name is sanitized and the path re-checked against the session folder:
	 * the name comes from a browser, and a crafted one must not be able to write
	 * outside it.
	 */
	_saveAttachment(key, attachment) {
		const dir = path.join(config.ATTACHMENTS_DIR, String(key).replace(/[^\w.-]/g, '_'));
		fs.mkdirSync(dir, { recursive: true });
		this.attachDirs.set(key, dir);

		const safeName = path.basename(String(attachment.name || 'attachment')).replace(/[^\w.\- ]/g, '_') || 'attachment';
		const target = path.join(dir, safeName);
		if (path.relative(dir, target).startsWith('..')) throw new Error('Invalid file name');

		// Ceiling on what a frame may write to the user's disk. Generous, because
		// nothing is uploaded here and the agent reads big files incrementally
		// rather than swallowing them whole - this is a guard against a runaway or
		// hostile frame, not a limit on useful documents.
		const bytes = Buffer.from(String(attachment.data || ''), 'base64');
		if (bytes.length > config.MAX_ATTACHMENT_BYTES) {
			throw new Error('That file is ' + Math.round(bytes.length / (1024 * 1024)) + 'MB, over the '
				+ Math.round(config.MAX_ATTACHMENT_BYTES / (1024 * 1024)) + 'MB limit for attachments.');
		}
		fs.writeFileSync(target, bytes);
		this.log('Saved attachment for board "' + key + '": ' + target);
		return target;
	}

	/** How the agent is told about the file it can now read. */
	_attachmentPrompt(filePath, kind) {
		let head = 'The user attached a file. It is saved on this machine at: ' + filePath
			+ '\nRead it before answering - do not ask the user to paste its contents.';
		// Large files: read in parts and work from a condensed understanding, rather
		// than trying to hold the whole thing or giving up on it.
		try {
			const mb = fs.statSync(filePath).size / (1024 * 1024);
			if (mb >= 2) {
				head += '\nIt is a large file (' + mb.toFixed(1) + 'MB): read it in sections, keep a running'
					+ ' summary of what matters for the request, and work from that rather than from the raw text.';
			}
		} catch (e) {}
		if (kind === 'whiteboard') {
			return head + '\nIt is a photo of a whiteboard or a hand-drawn sketch. Transcribe what is actually'
				+ ' written and drawn on it, keeping the author\'s own wording and grouping, then render that'
				+ ' on the board. Do not invent items that are not in the photo.';
		}
		if (kind === 'image') {
			return head + '\nIt is an image. Base your answer on what it actually shows.';
		}
		return head;
	}

	/** Drop a board session's attachments (tab disconnected, or bridge exiting). */
	clearAttachments(key) {
		const dir = this.attachDirs.get(key);
		if (!dir) return;
		this.attachDirs.delete(key);
		try { fs.rmSync(dir, { recursive: true, force: true }); }
		catch (e) { this.log('Could not remove attachments for "' + key + '":', e && e.message); }
	}

	clearAllAttachments() {
		const keys = Array.from(this.attachDirs.keys());
		for (const k of keys) this.clearAttachments(k);
	}

	/**
	 * Whether a tool the agent reached for is one this turn is allowed to run.
	 * Driven by the turn's own --allowedTools string, so it stays correct as that
	 * list changes and needs no list of tool names of its own.
	 */
	_isRunnableTool(toolName, allowedTools) {
		return this.agent.isRunnableTool(toolName, allowedTools, this._mockflowToolNames());
	}

	detect() {
		if (this.available !== null) return this.available;
		this.available = !!(this.agent.detect() || {}).available;
		return this.available;
	}

	/**
	 * Swap the CLI that answers from here on (`mockflow-bridge agent <id>` against
	 * a running bridge). Sessions are dropped because a resume id belongs to the
	 * agent that issued it - the next turn on each board starts fresh instead of
	 * handing one CLI's session id to another. In-flight turns finish on the agent
	 * that started them.
	 */
	setAgent(agent) {
		if (!agent || agent === this.agent) return false;
		this.agent = agent;
		this.available = null;
		this.sessions.forEach(function(session) { session.sessionId = null; });
		this.log('Agent switched to ' + agent.label + ' - board sessions reset.');
		return true;
	}

	/** What to tell the user when the selected agent is not installed. */
	missingHint() {
		return this.agent.installHint();
	}

	/**
	 * Tools a chat turn may use. WebSearch/WebFetch are always allowed here,
	 * unlike the component path which gates them on the catalog's `webResearch`
	 * flag: a chat turn cannot know up front which render tool the agent will
	 * choose, so the gate has nothing to test. RESEARCH_GUIDANCE keeps the
	 * agent from searching on requests that do not need it.
	 *
	 * An install without web search is unaffected: --allowedTools is a permission
	 * allowlist, so naming a tool the agent does not have simply never matches.
	 */
	/**
	 * "render_gantt takes: columns, settings." for the tools a turn may call.
	 *
	 * Purely registry-driven (the catalog carries each tool's input schema), so it
	 * stays right as tools change. Agents do get the schema over MCP, but not all
	 * of them read it before writing the call - naming the top-level arguments in
	 * the instructions costs a line and saves a rejected first attempt.
	 */
	_toolArgHint(tools) {
		if (!this.registry || !tools || !tools.length) return '';
		const parts = [];
		for (var i = 0; i < tools.length && i < 4; i++) {
			const entry = this.registry.filter(function(e) { return e.mcpToolName === tools[i]; })[0];
			const schema = entry && entry.mcpInputSchema;
			const names = schema && schema.properties ? Object.keys(schema.properties) : [];
			if (names.length) parts.push(tools[i] + ' takes: ' + names.join(', '));
		}
		return parts.length ? parts.join('. ') + '.' : '';
	}

	/**
	 * Every board tool the catalog defines, by bare MCP name. An adapter whose
	 * CLI matches allowlist entries literally (opencode) cannot expand
	 * `mcp__mockflow__*` on its own, and guessing the list in the adapter would
	 * put catalog knowledge in the wrong place.
	 */
	_mockflowToolNames() {
		if (this._toolNames) return this._toolNames;
		const names = [];
		(this.registry || []).forEach(function(e) {
			if (e && e.mcpToolName) names.push(e.mcpToolName);
		});
		// Same set the MCP endpoint serves from tools/list: catalog render tools
		// PLUS the bridge's own (read_board, modify_component, select_board...).
		// Miss those and an agent that matches the allowlist literally can only
		// draw, so "change the flowchart" duplicates it instead of editing it.
		const bridgeTools = require('./mcpEndpoint').BRIDGE_TOOL_NAMES || [];
		bridgeTools.forEach(function(n) { if (names.indexOf(n) === -1) names.push(n); });
		this._toolNames = names;
		return names;
	}

	/**
	 * Record the model that answered a turn and, once known, publish it so the
	 * editor and `status` can show which model is generating. Different agents
	 * surface it differently - Claude in its JSON stream, opencode in a
	 * --print-logs stderr line, Codex not at all - so this is fed from both the
	 * event loop and the stderr handler and just keeps the first value it gets.
	 */
	_noteModel(model, hub) {
		if (!model || model === this.currentModel) return;
		this.currentModel = model;
		this.log('Turn model: ' + model);
		if (hub && hub.agentInfo) {
			hub.agentInfo.model = model;
			if (hub.broadcast) hub.broadcast({ t: 'agent-info', agentInfo: hub.agentInfo });
		}
	}

	/**
	 * Feed one stderr line to the agent's optional stderr parser (opencode reports
	 * its model there). Returns the model id if this line carried one.
	 */
	_modelFromStderr(line) {
		if (!this.agent.parseStderr) return null;
		const ev = this.agent.parseStderr(line);
		return ev && ev.type === 'model' ? ev.id : null;
	}

	_allowedTools() {
		var tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'mcp__mockflow__*'];
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
		// Conversation memory is per SURFACE, not per board: Ask Mida and each
		// Concept Builder on the same board are separate conversations with
		// different personas, and one shared session would blend them into a
		// single history. The tab names its surface; older frames without one
		// keep the board-level key.
		const boardKey = tab.projectid || tab.id;
		const key = frame.surface ? boardKey + '::' + frame.surface : boardKey;

		if (!text) {
			return sendToTab({ t: 'chat-done', id: turnId, ok: false, error: 'Empty message' });
		}
		if (!this.detect()) {
			return sendToTab({
				t: 'chat-done', id: turnId, ok: false,
				error: this.missingHint()
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
		var systemPrompt = PERSONA + RESEARCH_GUIDANCE;
		if (!this.hasWorkspace) {
			systemPrompt += ' You currently have no access to the user\'s files (no workspace is set). '
				+ 'If they ask you to read their local files, code, repo, docs or transcripts, briefly tell '
				+ 'them to restart the bridge with --workspace <path> to enable it, and reassure them their '
				+ 'files are never uploaded: only what you draw is sent to MockFlow, and the reading and '
				+ 'thinking happen on their own machine.';
		}

		// A file the user attached in Mida. It arrived over the localhost socket
		// (never through MockFlow), so it is written to this session's own folder
		// and the agent is pointed at it. Multimodal agents read text, PDFs and
		// images natively, so nothing has to be extracted for them.
		var turnText = text;
		var attachmentPaths = [];
		if (frame.attachment) {
			try {
				const saved = this._saveAttachment(boardKey, frame.attachment);
				turnText = this._attachmentPrompt(saved, frame.attachment.kind) + '\n\n' + text;
				attachmentPaths = [saved];
			} catch (e) {
				this.log('Could not save attachment:', e && e.message);
				return sendToTab({ t: 'chat-done', id: turnId, ok: false, error: 'Could not save the attached file on this machine: ' + (e && e.message) });
			}
		}

		const allowedTools = this._allowedTools();
		// Attachments live outside the workspace (and there may be no workspace at
		// all), so the agent needs that one folder added to its readable set.
		const attachDir = this.attachDirs.get(boardKey);
		// A session id is only worth passing to an agent that can resume by id;
		// one that cannot simply starts fresh (its own turns still carry the
		// conversation because the prompt is self-contained).
		const canResume = this.agent.capabilities.resume === 'by-id';
		const spec = this.agent.buildArgs({
			cwd: this.workspace,
			prompt: turnText,
			systemPrompt: systemPrompt,
			allowedTools: allowedTools,
			mockflowTools: this._mockflowToolNames(),
			extraDirs: attachDir ? [attachDir] : [],
			// The saved attachment file(s). Agents that grant folder access read
			// them via the in-prompt path plus extraDirs; one whose file tools are
			// confined to the workspace (opencode) attaches them to the message
			// instead. Empty when nothing was attached.
			attachments: attachmentPaths,
			resume: canResume ? session.sessionId : null,
			partialMessages: true
		});

		this.log('Local agent turn for board "' + (tab.title || key) + '"'
			+ (session.sessionId ? ' (resumed session)' : ' (new session)')
			+ ', workspace: ' + this.workspace);

		var proc;
		try {
			proc = this.agent.spawn(spec.args, {
				env: Object.assign({}, process.env, spec.env || {}),
				cwd: this.workspace
			});
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

		// Open one step row for a tool the moment we learn of it. Idempotent per
		// tool_use id: the partial stream announces the tool BEFORE its input is
		// written, and the finished assistant message repeats it afterwards.
		function startStep(toolId, toolName) {
			// A tool outside this turn's allowlist is denied by the agent, so a row
			// for it would only ever resolve as a red failure. Keep those out of the
			// board's timeline: the user cares about work that can happen, not about
			// the agent probing its own toolbox.
			if (!self._isRunnableTool(toolName, allowedTools)) return;
			var id = toolId || ('la_' + turnId + '_' + stepCounter);
			if (openSteps[id]) return;
			var stepId = 'la_' + turnId + '_' + (stepCounter++);
			openSteps[id] = { stepId: stepId, started: Date.now() };
			var label = toolStepLabel(toolName);
			sendToTab({
				t: 'chat-step', id: turnId,
				step: { stepId: stepId, phase: 'start', tool: toolName, label: label, detail: '' }
			});
		}

		function handleLine(line) {
			var events = self.agent.parseLine(line);
			for (var e = 0; e < events.length; e++) {
				var ev = events[e];
				if (ev.type === 'session') {
					if (!session.sessionId) session.sessionId = ev.id;
				} else if (ev.type === 'model') {
					self._noteModel(ev.id, hub);
				} else if (ev.type === 'text') {
					// Agents differ in what a text event carries: whole blocks (joined
					// with a blank line) or incremental deltas (appended verbatim).
					replyText += (self.agent.capabilities.textChunks === 'delta')
						? ev.text
						: (replyText ? '\n\n' : '') + ev.text;
					// Only agents that really stream get to update the bubble mid-turn.
					// A non-streaming agent emits its preamble ("I'll draw that now") as a
					// finished message and then goes quiet for many seconds while it writes
					// the tool call: pushing that text out ends the tab's thinking state, so
					// the turn looks finished and then jumps back to life when the drawing
					// starts. Holding it keeps one honest "working" state until there is
					// something to show. finish() flushes whatever was held.
					if (self.agent.capabilities.streamsPartialText) {
						sendToTab({ t: 'chat-delta', id: turnId, text: replyText });
					}
				} else if (ev.type === 'tool-start') {
					startStep(ev.id, ev.name);
				} else if (ev.type === 'tool-end') {
					var open = openSteps[ev.id];
					if (open) {
						delete openSteps[ev.id];
						sendToTab({
							t: 'chat-step', id: turnId,
							step: { stepId: open.stepId, phase: 'end', ok: ev.ok, elapsedMs: Date.now() - open.started }
						});
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
		var stderrBuf = '';
		proc.stderr.on('data', function(d) {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
			// The model may ride a stderr log line (opencode). Scan complete lines.
			stderrBuf += d.toString();
			var nl;
			while ((nl = stderrBuf.indexOf('\n')) >= 0) {
				var sline = stderrBuf.slice(0, nl);
				stderrBuf = stderrBuf.slice(nl + 1);
				var m = self._modelFromStderr(sline);
				if (m) self._noteModel(m, hub);
			}
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
			// The text a non-streaming agent produced was held back (see handleLine):
			// deliver it as one delta first, so a tab that renders the bubble from
			// deltas gets it whether or not it also reads chat-done.text.
			if (!self.agent.capabilities.streamsPartialText && replyText) {
				sendToTab({ t: 'chat-delta', id: turnId, text: replyText });
			}
			sendToTab({ t: 'chat-done', id: turnId, ok: ok, text: replyText, error: error, model: self.currentModel || null });
		}

		proc.on('error', function(err) {
			self.log('Agent process error: ' + err.message);
			finish(false, 'Local agent error: ' + err.message);
		});

		proc.on('close', function(code) {
			if (code !== 0 && !replyText) {
				self.log('Agent exited ' + code + ': ' + stderrTail);
				finish(false, 'The local agent exited unexpectedly'
					+ (lastErrorLine(stderrTail) ? ' (' + lastErrorLine(stderrTail) + ')' : '') + '.');
			} else {
				finish(true, null);
			}
		});
	}

	/** Stop whatever this board is running. Sessions are per surface, so a
	 *  cancel from a tab kills every surface that belongs to that board. */
	cancel(tab) {
		const boardKey = tab.projectid || tab.id;
		const self = this;
		this.sessions.forEach(function(session, key) {
			if (key !== boardKey && key.indexOf(boardKey + '::') !== 0) return;
			if (session && session.proc) killProcTree(session.proc);
		});
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
		// One-shot prompt surfaces (AI Prompt Box): the user asked for something to
		// be drawn, so this draws a NEW component like Convert - but from a plain
		// request rather than an existing component's data. Restricted to the
		// requested component's tool when the surface named one, free choice
		// otherwise ("Any (AI decides)").
		const isGenerate = (mode === 'generate');
		const tools = (isConvert || isGenerate) ? (isGenerate ? this._toolsForComptype(comptype, true) : [])
			: this._toolsForComptype(comptype, isSimilar);
		const wantsResearch = !isConvert && this._toolWantsResearch(tools);

		if (!prompt) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'Empty prompt' });
		}
		if (!isConvert && !isGenerate && tools.length === 0) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'No local tool for component ' + comptype });
		}
		if (!this.detect()) {
			return sendToTab({
				t: 'compgen-done', id: turnId, ok: false, fallback: true,
				error: this.agent.label + ' is not installed, so component AI cannot run on the local agent.'
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
		if (!isConvert && !isSimilar && !isGenerate) hub.setCapture(tab.projectid, turnId, sendToTab);
		// Convert and prompt-box generations draw a NEW component; tag it with its
		// source so the client connects and positions it relative to that source
		// (parity with the server flow's fromconvert).
		if ((isConvert || isGenerate) && frame.fromconvert && tab.projectid) hub.convertContext.set(tab.projectid, frame.fromconvert);

		var systemPrompt, allowed;
		if (isGenerate) {
			systemPrompt = 'The user asked for something to be drawn on their MockFlow board. Choose the '
				+ (tools.length ? 'ONE tool from [' + tools.join(', ') + ']' : 'ONE mockflow render tool')
				+ ' that best fits the request and call it exactly once with complete, well-formed data. '
				+ 'Do not draw anything else, do not call any other tool, do not chat, do not output any text, '
				+ 'and never output a URL or a link.';
			allowed = tools.length
				? tools.map(function(t) { return 'mcp__mockflow__' + t; }).join(',')
				: 'mcp__mockflow__*';
		} else if (isConvert) {
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

		// "Exactly once" is about not drawing twice, not about giving up on the
		// first error. Taken literally - as a strict agent does - a call rejected
		// for malformed arguments ends the turn with nothing generated, and the
		// component falls back to the server AI even though the fix was one retry
		// away. Say what "once" means, and name the arguments the tool actually
		// wants so the first attempt is usually right.
		systemPrompt += ' A call that comes back with an error drew nothing and does not count as your one '
			+ 'call: read the error, fix the arguments it names, and call the tool again (up to three tries).';
		const argHint = this._toolArgHint(tools);
		if (argHint) systemPrompt += ' ' + argHint;

		// Real-world/current-data components: let the agent web-research first, but
		// ALWAYS fall back to its own knowledge if search is off/unavailable/empty -
		// it must never skip generating the component.
		if (wantsResearch) {
			allowed += ',WebSearch,WebFetch';
			systemPrompt += RESEARCH_GUIDANCE
				+ ' Always finish by calling the render tool with complete data.';
		}

		const spec = this.agent.buildArgs({
			cwd: this.workspace,
			prompt: prompt,
			systemPrompt: systemPrompt,
			allowedTools: allowed,
			mockflowTools: this._mockflowToolNames(),
			partialMessages: false
		});

		this.log('Component AI turn (' + mode + ') for "' + (tab.title || key) + '"'
			+ (tools.length ? ' via ' + tools.join('/') : '') + ', workspace: ' + this.workspace);
		// What the CLI was actually asked to do. Every "it behaved differently than
		// when I ran it by hand" bug so far came down to a flag the turn did or did
		// not carry, and there is no other way to see the spawned command line.
		if (config.DEBUG) this.log('[debug] ' + this.agent.id + ' argv: ' + JSON.stringify(spec.args));

		var proc;
		try {
			proc = this.agent.spawn(spec.args, {
				env: Object.assign({}, process.env, spec.env || {}),
				cwd: this.workspace
			});
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
			var events = self.agent.parseLine(line);
			for (var e = 0; e < events.length; e++) {
				var ev = events[e];
				if (ev.type === 'model') {
					self._noteModel(ev.id, hub);
				} else if (ev.type === 'tool-start') {
					toolCalled = true;
					// Idempotent per tool id: an agent that announces a tool before it
					// runs (and again when the call is complete) must not open two rows.
					if (ev.id && openSteps[ev.id]) continue;
					var stepId = 'cg_' + turnId + '_' + (stepCounter++);
					openSteps[ev.id || stepId] = { stepId: stepId, started: Date.now() };
					var label = String(ev.name || 'tool').replace(/^mcp__mockflow__|^mockflow[_.]/, '')
							.replace(/^render_/, 'Generating ').replace(/_/g, ' ');
					sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: stepId, phase: 'start', tool: ev.name, label: label, detail: '' } });
				} else if (ev.type === 'tool-end') {
					var open = openSteps[ev.id];
					if (open) {
						delete openSteps[ev.id];
						sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: open.stepId, phase: 'end', ok: ev.ok, elapsedMs: Date.now() - open.started } });
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
		var stderrBuf = '';
		proc.stderr.on('data', function(d) {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
			stderrBuf += d.toString();
			var nl;
			while ((nl = stderrBuf.indexOf('\n')) >= 0) {
				var sline = stderrBuf.slice(0, nl);
				stderrBuf = stderrBuf.slice(nl + 1);
				var mdl = self._modelFromStderr(sline);
				if (mdl) self._noteModel(mdl, hub);
			}
		});

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
					+ (lastErrorLine(stderrTail) ? ' (' + lastErrorLine(stderrTail) + ')' : '') + '.', true);
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
	 *
	 * `sendToTab` streams the generation timeline back so Mida shows the same
	 * loader the server multiboard turn shows: one step row per item while it is
	 * being generated (plan-step) plus the "Generated X of Y items…" counter the
	 * hub pushes as each draw lands (plan-progress). Without it the chat would sit
	 * silent for the whole batch - the reason the local loader looked worse.
	 */
	handlePlanGenerate(tab, plan, hub, sendToTab) {
		const self = this;
		const key = tab.projectid || tab.id;
		const items = (plan && plan.items) || [];
		const send = sendToTab || function() {};
		if (!items.length) return;
		if (!this.detect()) {
			this.log('[plan] generate skipped: ' + this.agent.label + ' is not installed.');
			hub.clearPlan(tab.projectid);
			send({ t: 'plan-done', ok: false, error: this.agent.label + ' is not installed on this machine, so the plan could not be generated locally.' });
			return;
		}
		if (this.planProcs.has(key)) {
			this.log('[plan] generate already running for "' + (tab.title || key) + '" - ignored.');
			send({ t: 'plan-done', ok: false, error: 'A board plan is already generating on this board.' });
			return;
		}

		const prevSelected = hub.selectedProjectId;
		if (tab.projectid) hub.selectedProjectId = tab.projectid;

		// Only the tools the plan actually uses.
		const toolSet = {};
		for (var i = 0; i < items.length; i++) toolSet['mcp__mockflow__' + items[i].tool] = true;
		var allowed = Object.keys(toolSet).join(',');

		const lines = items.map(function(it, i) {
			return (i + 1) + '. ' + (it.name || 'Item') + ' [tool: ' + it.tool + ']: ' + (it.brief || '');
		});
		const prompt = 'The user confirmed this board plan - render it now.\n'
			+ 'Board: "' + (plan.boardTitle || 'Board') + '"\nItems (render in this order):\n' + lines.join('\n');

		var systemPrompt = 'You render the items of a board plan the user just confirmed on their live '
			+ 'MockFlow board. Call each item\'s listed render tool exactly once, in order, with complete, '
			+ 'well-formed data built from its brief. If several items are wireframe screens of one app, keep '
			+ 'ONE shared design system and pass the SAME viewportWidth on every screen. The board arranges '
			+ 'itself after the last item - do not call plan_board or layout_board, do not draw anything beyond '
			+ 'the plan, do not chat, and never output a URL or a link.';

		// Same gate as the component path: when the plan contains a real-world /
		// current-data component (catalog `webResearch`), let the agent ground the
		// batch before drawing. Previously this path had no research affordance at
		// all, so a planned table of live figures was drawn from training data.
		if (this._toolWantsResearch(items.map(function(it) { return it.tool; }))) {
			allowed += ',WebSearch,WebFetch';
			systemPrompt += RESEARCH_GUIDANCE
				+ ' Always finish by rendering every planned item.';
		}

		// partialMessages: announces each render tool the moment the model starts
		// writing it, so the step row appears immediately instead of after thousands
		// of characters of HTML have streamed out (same reason the chat turn uses it).
		const spec = this.agent.buildArgs({
			cwd: this.workspace,
			prompt: prompt,
			systemPrompt: systemPrompt,
			allowedTools: allowed,
			mockflowTools: this._mockflowToolNames(),
			partialMessages: true
		});

		this.log('[plan] generate starting: ' + items.length + ' item(s) for "' + (tab.title || key) + '" ['
			+ items.map(function(it) { return it.tool; }).join(', ') + ']');

		var proc;
		try {
			proc = this.agent.spawn(spec.args, {
				env: Object.assign({}, process.env, spec.env || {}),
				cwd: this.workspace
			});
		} catch (err) {
			this.log('[plan] generate launch failed: ' + err.message);
			hub.clearPlan(tab.projectid);
			hub.selectedProjectId = prevSelected;
			send({ t: 'plan-done', ok: false, error: 'Could not launch the local agent: ' + err.message });
			return;
		}
		this.planProcs.set(key, proc);

		// Timeline rows for the generation turn. Same step contract as the chat turn
		// (renderTimelineStep in the tab), so the local batch renders with the same
		// spinner/check rows the server multiboard turn renders.
		var openSteps = {};
		var stepCounter = 0;
		var itemCursor = 0;
		var buf = '';

		function startStep(toolId, toolName) {
			var id = toolId || ('pl_' + key + '_' + stepCounter);
			if (openSteps[id]) return;
			var stepId = 'pl_' + key + '_' + (stepCounter++);
			// Tools fire in plan order, so the nth call names the nth item - that is
			// what puts the item name on the row, like the server's "Creating <name>".
			var item = items[itemCursor++] || null;
			openSteps[id] = { stepId: stepId, started: Date.now(), name: item && item.name };
			self.log('[plan] step start: ' + toolName + (item && item.name ? ' -> "' + item.name + '"' : ''));
			send({
				t: 'plan-step',
				step: {
					stepId: stepId, phase: 'start', tool: toolName,
					label: toolStepLabel(toolName),
					detail: String((item && item.name) || '').substring(0, 60)
				}
			});
		}

		function handleLine(line) {
			var events = self.agent.parseLine(line);
			for (var e = 0; e < events.length; e++) {
				var ev = events[e];
				if (ev.type === 'tool-start') {
					startStep(ev.id, ev.name);
				} else if (ev.type === 'tool-end') {
					var open = openSteps[ev.id];
					if (!open) continue;
					delete openSteps[ev.id];
					self.log('[plan] step end: "' + (open.name || open.stepId) + '" '
						+ (ev.ok ? 'ok' : 'FAILED') + ' in ' + (Date.now() - open.started) + 'ms');
					send({
						t: 'plan-step',
						step: { stepId: open.stepId, phase: 'end', ok: ev.ok, elapsedMs: Date.now() - open.started }
					});
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

		// Backstop: a hung continuation never pins the board's plan forever.
		const killer = setTimeout(function() {
			self.log('[plan] generate timed out after ' + config.PLAN_TIMEOUT_MS + 'ms - killing the agent');
			killProcTree(proc);
		}, config.PLAN_TIMEOUT_MS);

		const done = function(what, ok, error) {
			clearTimeout(killer);
			self.planProcs.delete(key);
			hub.selectedProjectId = prevSelected;
			// Leftover plan count means the agent died mid-batch - drop it so the
			// stale plan never re-arranges a later, unrelated batch.
			hub.clearPlan(tab.projectid);
			// Close any dangling rows so the tab's timeline never spins forever.
			for (var k in openSteps) {
				send({ t: 'plan-step', step: { stepId: openSteps[k].stepId, phase: 'end', ok: false, elapsedMs: Date.now() - openSteps[k].started } });
			}
			self.log('[plan] generate ' + what + ' for "' + (tab.title || key) + '": '
				+ stepCounter + ' of ' + items.length + ' item(s) started'
				+ (!ok && lastErrorLine(stderrTail) ? ' (' + lastErrorLine(stderrTail) + ')' : ''));
			send({ t: 'plan-done', ok: ok, error: error || null });
		};
		proc.on('error', function(err) { done('failed to run', false, 'Local agent error: ' + (err && err.message)); });
		proc.on('close', function(code) {
			if (code === 0) done('finished', true, null);
			else done('exited ' + code, false, 'The local agent stopped before finishing the board'
				+ (lastErrorLine(stderrTail, 160) ? ' (' + lastErrorLine(stderrTail, 160) + ')' : '') + '.');
		});
	}

	cancelPlanGenerate(tab) {
		const key = tab.projectid || tab.id;
		const proc = this.planProcs.get(key);
		if (proc) killProcTree(proc);
	}

	cancelCompGen(tab) {
		const key = tab.projectid || tab.id;
		const proc = this.compgenProcs.get(key);
		if (proc) killProcTree(proc);
	}
}

module.exports = AgentManager;
