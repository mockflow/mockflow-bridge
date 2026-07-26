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
	+ 'ONE component always wins over a plan: when a single render tool covers the request, '
	+ 'call that tool. Whether a many-part request (many screens, scenes or steps) is one '
	+ 'component or several is decided by the tools themselves, never assumed: a tool whose '
	+ 'own description says it wires the parts into one artifact is one call however many '
	+ 'parts there are, while a tool that describes itself as one part is one call PER part, '
	+ 'so a request covering many of them is a plan. Only when a request needs '
	+ 'SEVERAL DIFFERENT components (a plan, workspace, dashboard or kit), call plan_board with '
	+ 'the component list (each item carrying a self-contained brief) and stop - the user '
	+ 'confirms the list on the board and the chosen items are generated and arranged '
	+ 'automatically, without you. After calling plan_board just tell the user to review the '
	+ 'list and click Generate Board. '
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
		this.imageProcs = new Map();   // key -> child process (image re-render turns)
		// A chat turn in its decide-then-draw form: the declare step's context,
		// kept so the drawing step can continue the SAME tab turn (same id, same
		// bubble) once the user has answered.
		this.chatPhases = new Map();   // key -> { tab, frame, sendToTab, hub, declared, phase1Done, composeReady }
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
	_toolsForComptype(comptype, includeHtml, mode) {
		if (!comptype || !this.registry) return [];
		var out = [];
		for (var i = 0; i < this.registry.length; i++) {
			var e = this.registry[i];
			if (!e.mcpToolName) continue;
			// An entry can restrict itself to certain turn modes (`fillModes`), for a tool
			// that only makes sense against something already on the board - editing the
			// element a user picked in a running prototype is a modify and nothing else,
			// while creating that prototype is a whole-document job for MockFlow AI.
			if (Array.isArray(e.fillModes) && (!mode || e.fillModes.indexOf(mode) === -1)) continue;
			// HTML-conversion tools (render_wireframelite / render_prototypelite) normally
			// DRAW on the board, so returning them for a fill mode would arm a capture
			// that is never consumed and end in a double generation (local draw + server
			// fallback). Draw-new modes (includeHtml, e.g. create-similar) want exactly
			// that draw, so they opt in.
			// `clientHtmlFillsInPlace` is the exception: the component behind that tool
			// can adopt the converted HTML as its own content (its sendGenText takes the
			// paintObjects), so the tab routes the conversion into the edited component
			// instead of drawing a new one (boardHub.drawHtml honours the capture for
			// these). Without it, a component whose ONLY local tool is an HTML tool has
			// no local Generate/Modify at all and every turn falls back to MockFlow AI.
			if (e.clientIsHtmlConversion && !includeHtml && !e.clientHtmlFillsInPlace) continue;
			var match = e.clientComp === comptype
				|| e.fillsComptype === comptype
				|| (Array.isArray(e.fillsComptypes) && e.fillsComptypes.indexOf(comptype) !== -1);
			if (match) out.push(e.mcpToolName);
		}
		return out;
	}

	/** True if any of these tools fills its component from converted HTML
	 *  (catalog `clientHtmlFillsInPlace` flag). Such a fill turn goes through
	 *  boardHub.drawHtml, not captureOrDraw, so the capture has to say so. */
	_toolFillsFromHtml(toolNames) {
		if (!this.registry || !toolNames || !toolNames.length) return false;
		for (var i = 0; i < this.registry.length; i++) {
			var e = this.registry[i];
			if (e.clientHtmlFillsInPlace && toolNames.indexOf(e.mcpToolName) !== -1) return true;
		}
		return false;
	}

	/** True if any of these tools answers with a whole HTML document
	 *  (catalog `clientIsHtmlConversion`), which takes minutes to write. */
	_toolsAreHtml(toolNames) {
		if (!this.registry || !toolNames || !toolNames.length) return false;
		for (var i = 0; i < this.registry.length; i++) {
			var e = this.registry[i];
			if (e.clientIsHtmlConversion && toolNames.indexOf(e.mcpToolName) !== -1) return true;
		}
		return false;
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
		// The empty scratch dir a turn runs in when files are off: no --workspace was
		// given, OR the connected user's plan does not include file reading (see
		// _effectiveWorkspace). Always available so a basic-plan turn has somewhere to run.
		var scratch = path.join(os.tmpdir(), 'mockflow-bridge-scratch');
		try { fs.mkdirSync(scratch, { recursive: true }); } catch (e) {}
		this.scratchDir = scratch;

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
		return scratch;
	}

	/**
	 * The folder a turn from this tab actually runs in. Workspace file reading is a
	 * Pro feature: a basic-plan tab (tab.isBasic, set from the editor's register
	 * frame) runs in the scratch dir even when the bridge was started with
	 * --workspace, so a free user's local agent can read nothing. Everything else
	 * about the turn is unchanged.
	 */
	_effectiveWorkspace(tab) {
		return (tab && tab.isBasic) ? this.scratchDir : this.workspace;
	}

	/** Whether this tab's turns may read the workspace folder (false for basic plan). */
	_workspaceEnabled(tab) {
		return this.hasWorkspace && !(tab && tab.isBasic);
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

	/**
	 * Decide how a turn's prompt reaches the agent, returning { prompt, stdin, file }.
	 *
	 * spawnPortable wraps every Windows spawn in `cmd.exe /d /s /c "<line>"`, which caps the
	 * command line at ~8191 chars and treats the prompt's newlines as command terminators. A
	 * large or multi-line prompt (a multi-board plan, pasted meeting notes) is truncated there -
	 * and because `-p <prompt>` comes before `--mcp-config` in the argv, the dropped tail is
	 * exactly the flags that give the agent its board tools, so it launches tool-less and
	 * silently draws nothing. The multi-board plan prompt always carries newlines, which is why
	 * single-component generation (a short single line) worked while every board plan failed.
	 *
	 * Preferred fix: stage the prompt in a file and leave `-p` a short directive that tells the
	 * agent to read it with its own read tool. Only the (short) directive rides the command line,
	 * so neither length nor newlines can break it - and unlike stdin it does not depend on the
	 * pipe surviving the cmd.exe wrapper (which, in practice, it does not). When the agent has no
	 * read tool but can read stdin, fall back to that.
	 *
	 * macOS/Linux spawn the CLI directly (ARG_MAX is hundreds of KB), so the prompt stays inline
	 * and unchanged. Set MFBRIDGE_FORCE_STDIN_PROMPT=1 to exercise the off-command-line path off
	 * Windows (it selects file delivery when the agent supports it, else stdin).
	 */
	_deliverPrompt(rawPrompt, key) {
		const text = String(rawPrompt == null ? '' : rawPrompt);
		const force = process.env.MFBRIDGE_FORCE_STDIN_PROMPT === '1';
		const risky = process.platform === 'win32' || force;
		const caps = (this.agent && this.agent.capabilities) || {};
		if (!risky) return { prompt: text, stdin: null, file: null };
		// Short single-line prompts (the everyday chat turn) fit comfortably on the cmd.exe
		// line with no newline to break it; leave them inline.
		if (!force && text.length < 6000 && text.indexOf('\n') === -1) return { prompt: text, stdin: null, file: null };

		// Preferred: hand the prompt over as a file the agent reads with its own tool.
		if (caps.promptFileTool) {
			try {
				const dir = path.join(config.HOME_DIR, 'bridge-prompts');
				fs.mkdirSync(dir, { recursive: true });
				const safe = String(key || 'turn').replace(/[^\w.-]/g, '_');
				const p = path.join(dir, 'prompt-' + safe + '.txt');
				fs.writeFileSync(p, text, 'utf8');
				return {
					// Single line, no newline: safe inline on the cmd.exe command line. The path
					// may contain spaces but rides `-p` as one quoted argv arg, which is fine.
					prompt: 'Your entire task is written in a file - read it with the ' + caps.promptFileTool
						+ ' tool first, then carry out its instructions exactly, producing every listed item in order '
						+ 'using the mockflow tools without asking for confirmation. The file is at this exact path: ' + p,
					stdin: null,
					file: { path: p, dir: dir, tool: caps.promptFileTool }
				};
			} catch (e) {
				this.log('Could not stage prompt file, falling back: ' + (e && e.message));
			}
		}

		// Fallback: stdin, for an agent that reads it but has no read tool.
		if (caps.acceptsStdinPrompt) {
			return {
				prompt: 'Carry out the task described on standard input exactly. If it lists items to create or '
					+ 'render, produce every one of them, in order, using the mockflow tools, and do not ask for confirmation.',
				stdin: text,
				file: null
			};
		}
		return { prompt: text, stdin: null, file: null };
	}

	/**
	 * Fold a file-delivery into a buildArgs turn: the agent needs its read tool on the
	 * allowlist and read access to the folder the staged prompt lives in. No-op for the
	 * inline and stdin paths. Returns the same turn object for chaining.
	 */
	_applyDelivery(turn, delivery) {
		if (delivery && delivery.file) {
			if (delivery.file.tool) {
				turn.allowedTools = turn.allowedTools
					? (turn.allowedTools + ',' + delivery.file.tool) : delivery.file.tool;
			}
			const dirs = (turn.extraDirs || []).slice();
			if (delivery.file.dir && dirs.indexOf(delivery.file.dir) === -1) dirs.push(delivery.file.dir);
			turn.extraDirs = dirs;
		}
		return turn;
	}

	/**
	 * spawn(), writing the prompt to stdin first when _deliverPrompt routed it there,
	 * and cleaning up a staged prompt file once the turn exits.
	 */
	/**
	 * The environment every agent turn is spawned with.
	 *
	 * MCP_TOOL_TIMEOUT / MCP_TIMEOUT are read by the CLIs that support them and
	 * ignored by the rest, so they are set for all: see AGENT_TOOL_TIMEOUT_MS for
	 * why the agent must never be the one to give up on a call first. An adapter's
	 * own env (spec.env) wins, since it knows its CLI better than this does.
	 */
	_turnEnv(spec) {
		return Object.assign({}, process.env, {
			MCP_TOOL_TIMEOUT: String(config.AGENT_TOOL_TIMEOUT_MS),
			MCP_TIMEOUT: String(config.AGENT_TOOL_TIMEOUT_MS)
		}, (spec && spec.env) || {});
	}

	_spawnWithPrompt(spec, delivery, opts) {
		const self = this;
		const spawnOpts = Object.assign({}, opts);
		const viaStdin = delivery && delivery.stdin != null;
		if (viaStdin) spawnOpts.stdio = ['pipe', 'pipe', 'pipe'];
		const proc = this.agent.spawn(spec.args, spawnOpts);
		if (viaStdin && proc.stdin) {
			try { proc.stdin.write(delivery.stdin); proc.stdin.end(); }
			catch (e) { this.log('Could not write prompt to agent stdin: ' + (e && e.message)); }
		}
		if (delivery && delivery.file && delivery.file.path) {
			const p = delivery.file.path;
			proc.on('close', function() { try { fs.unlinkSync(p); } catch (e) {} });
		}
		return proc;
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

	/**
	 * The catalog entry for a component whose whole content is a generated asset
	 * (image / video / audio / 3D). Deliberately a lookup of its own rather than
	 * the tool-selection fields: naming the comptype there would make a
	 * component-AI turn choose that tool, which cannot fill a component in place.
	 */
	_mediaComptypeEntry(comptype) {
		if (!comptype || !this.registry) return null;
		for (var i = 0; i < this.registry.length; i++) {
			if (this.registry[i].mediaComptype === comptype) return this.registry[i];
		}
		return null;
	}

	_allowedTools() {
		var tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'mcp__mockflow__*'];
		if (process.env.MFBRIDGE_ALLOW_WRITE === '1') tools.push('Write', 'Edit', 'Bash');
		return tools.join(',');
	}

	/**
	 * Open a turn's image state on the hub and return the sentence the agent needs
	 * about it.
	 *
	 * A local agent cannot generate imagery; MockFlow can, in the user's tab, on
	 * their AI credits. `withImages` is what the tab already knows of the user's
	 * choice - a component's own "with images" setting, or a choice they stated in
	 * chat. When it says nothing, the agent renders without imagery (the safe,
	 * free default) and the mcpEndpoint gate asks the user the moment an
	 * image-capable component is actually reached, then has the agent render it
	 * again with slots. Either way no tool names appear here: the catalog decides
	 * which components have image slots.
	 */
	_openImageTurn(hub, tab, frame, askable) {
		var choice = (frame && (frame.withImages === true || frame.withImages === false))
			? frame.withImages : undefined;
		// A turn that CANNOT be interrupted (component AI: the edited component is
		// waiting on this one turn to fill it) never leaves the answer open - an
		// unstated choice means no imagery, not a question. Those surfaces all have
		// somewhere to state it: the component's own "with images" setting, or the
		// prompt box's checkbox.
		if (choice === undefined && askable === false) choice = false;
		// Working from something already on the board is not composing something new,
		// and the imagery rules below have to know which this is. An EDIT, a CONVERSION
		// and a NEW SCREEN FROM A REFERENCE all arrive carrying that thing's existing
		// pictures, so "no images" from the user means "add no new ones" - it has never
		// meant "delete the ones that are already there".
		const mode = (frame && frame.mode) || '';
		// A CREATE can be built from board content too - converting wireframes into a
		// prototype hands the agent those wireframes, images and all - and the mode alone
		// cannot tell. The editor says so with fromExisting; the modes below are the cases
		// that are always true by definition.
		const fromExisting = (frame && frame.fromExisting === true)
			|| mode === 'modifyai' || mode === 'convertai' || mode === 'createsimilar';
		const turnMode = fromExisting ? 'modify' : 'create';
		hub.setImageChoice(tab.projectid, choice, (frame && frame.surface) || 'mida', turnMode);
		if (choice === true && fromExisting) {
			return ' Every picture already in what you were given STAYS: copy each image reference across '
				+ 'exactly as it is, and never swap a real picture for a placeholder. On top of that the user '
				+ 'has agreed to new imagery, so where the change genuinely calls for a NEW picture, add a slot '
				+ 'in exactly the form that render tool documents, with a prompt describing it (no text, letters '
				+ 'or numbers in it). New images are generated in the user\'s browser after your call - never '
				+ 'output a URL or wait for one.';
		}
		if (choice === false && fromExisting) {
			return ' Add NO new imagery. Every picture already in what you were given STAYS: copy each image '
				+ 'reference across exactly as it is, and never drop one or swap a real picture for a placeholder.';
		}
		if (choice === true) {
			// The slot form belongs to the TOOL, not to this sentence: component data
			// takes a token, a document takes the attribute its own markup documents.
			// Naming one form here made the agent write it into every tool, so an HTML
			// render came back with the token sitting in src= and no pictures at all.
			return ' The user asked for AI-generated images in what you draw: where a render tool documents '
				+ 'image slots, fill them in exactly the form THAT tool documents, with a prompt describing '
				+ 'the picture (no text, letters or numbers in it). The images are generated in the user\'s '
				+ 'browser after your call - never output a URL or wait for one.';
		}
		if (choice === false) {
			return ' Generate NO imagery in what you draw: leave every image slot out and carry the design '
				+ 'with colour, type and shapes instead.';
		}
		return (fromExisting ? ' Every picture already in what you were given stays: copy each image reference '
				+ 'across exactly as it is.' : '')
			+ ' Render without image slots. If a render tool answers that the user is being asked about '
			+ 'images, your turn is over and the component is drawn for you once they answer: say so briefly '
			+ 'and stop, do not call anything else.';
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

		// Decide-then-draw. The FIRST step of a chat turn runs with no render
		// tools, so the agent can only say what it means to draw - which is what
		// lets the imagery question be answered BEFORE the component is composed,
		// instead of composing it once, asking, and composing it again. The second
		// step is this same method re-entered with the tools available; the tab
		// never sees two turns, because no chat-done is sent in between.
		const declarePhase = frame.__phase !== 'compose';
		hub.setTurnPhase(tab.projectid, declarePhase ? 'declare' : 'compose');
		if (declarePhase) {
			this.chatPhases.set(key, {
				tab: tab, frame: frame, sendToTab: sendToTab, hub: hub,
				declared: false, phase1Done: false, composeReady: false
			});
		}

		// The folder this turn runs in. A basic-plan tab gets the scratch dir even
		// when --workspace is set (workspace file reading is a Pro feature).
		const ws = this._effectiveWorkspace(tab);

		// When no workspace is set the agent can read no files. If the user asks
		// about their local files, answer helpfully instead of failing silently.
		// BUT a file attached in Mida this turn IS given to the agent (saved locally,
		// path in the prompt) - so skip this "no file access" line when there is an
		// attachment, or the agent (notably Codex, which does not take extraDirs)
		// parrots "restart with --workspace" and refuses to read the file it was handed.
		var systemPrompt = PERSONA + RESEARCH_GUIDANCE + this._openImageTurn(hub, tab, frame);
		// The drawing step of a decide-then-draw turn: the choice was already made (and
		// the user answered the imagery question about THAT choice), so it is stated
		// rather than left to be made a second time from the bare request.
		if (!declarePhase && frame.__declared) {
			systemPrompt += (frame.__declared === 'plan')
				? ' You already decided this turn needs SEVERAL DIFFERENT components: call plan_board now '
					+ 'with the component list and stop, and draw nothing yourself.'
				: ' You already decided this turn draws ' + frame.__declared + ': call that tool now, and no '
					+ 'other render tool, unless it answers with an error telling you otherwise.';
		}
		if (declarePhase) {
			systemPrompt = PERSONA
				+ ' RIGHT NOW you are in the deciding step of this turn, and you have NO drawing tools: '
				+ 'they appear in the next step. Your ONLY job here is to call declare_render once, saying '
				+ 'which render_* tool the request needs - "plan" when no single component covers it and it '
				+ 'needs several different ones, or "none" when nothing is being drawn, in which '
				+ 'case simply answer the user as usual. When you do name a tool, write NO reply text at '
				+ 'all: the drawing step follows immediately and speaks to the user itself.';
		}
		if (!this._workspaceEnabled(tab) && !frame.attachment) {
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
		const delivery = this._deliverPrompt(turnText, key);
		const spec = this.agent.buildArgs(this._applyDelivery({
			cwd: ws,
			projectid: tab.projectid,
			prompt: delivery.prompt,
			systemPrompt: systemPrompt,
			allowedTools: allowedTools,
			mockflowTools: this._mockflowToolNames(),
			extraDirs: attachDir ? [attachDir] : [],
			// The saved attachment file(s). Agents that grant folder access read
			// them via the in-prompt path plus extraDirs; one whose file tools are
			// confined to the workspace (opencode) attaches them to the message
			// instead. Empty when nothing was attached.
			attachments: attachmentPaths,
			// The deciding step is ephemeral - it must NOT resume the user's
			// conversation, or the drawing step inherits an exchange whose last
			// instruction was "you have no drawing tools, write nothing".
			resume: (canResume && !declarePhase) ? session.sessionId : null,
			partialMessages: true
		}, delivery));

		this.log('Local agent turn for board "' + (tab.title || key) + '"'
			+ (session.sessionId ? ' (resumed session)' : ' (new session)')
			+ ', workspace: ' + ws + (tab && tab.isBasic ? ' (basic plan - files off)' : ''));

		var proc;
		try {
			proc = this._spawnWithPrompt(spec, delivery, {
				env: this._turnEnv(spec),
				cwd: ws
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
		// Both steps of a decide-then-draw turn report into the SAME tab turn, and the
		// drawing step is a fresh process whose counter starts at 0 again - so the phase
		// goes in the id, or its first tool row lands on top of the deciding step's row.
		const stepIdBase = 'la_' + turnId + (declarePhase ? '_d' : '_c');
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
			var id = toolId || (stepIdBase + stepCounter);
			if (openSteps[id]) return;
			var stepId = stepIdBase + (stepCounter++);
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
					// ...and it must not BECOME the conversation either: the id it
					// reports is thrown away, so the drawing step and every later turn
					// continue the real one.
					if (!declarePhase && !session.sessionId) session.sessionId = ev.id;
				} else if (ev.type === 'model') {
					self._noteModel(ev.id, hub);
				} else if (ev.type === 'text') {
					// Agents differ in what a text event carries: whole blocks (joined
					// with a blank line) or incremental deltas (appended verbatim).
					replyText += (self.agent.capabilities.textChunks === 'delta')
						? ev.text
						: (replyText ? '\n\n' : '') + ev.text;
					// The deciding step does not speak: it either names a component, and then the
					// drawing step answers the user, or it says "none" and becomes the answer
					// itself. Its text is held until that is known, so a preamble written just
					// before declare_render never lands in the bubble the drawing step will fill.
					var phSoFar = declarePhase ? self.chatPhases.get(key) : null;
					var holdText = declarePhase && !(phSoFar && phSoFar.declaredNone);
					// Only agents that really stream get to update the bubble mid-turn.
					// A non-streaming agent emits its preamble ("I'll draw that now") as a
					// finished message and then goes quiet for many seconds while it writes
					// the tool call: pushing that text out ends the tab's thinking state, so
					// the turn looks finished and then jumps back to life when the drawing
					// starts. Holding it keeps one honest "working" state until there is
					// something to show. finish() flushes whatever was held.
					if (!holdText && self.agent.capabilities.streamsPartialText) {
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
			// A CLI with no valid credentials answers the turn with a short
			// "sign in first" line instead of failing it. Turn that into a real
			// error so the board shows how to fix it, not the cryptic line as Mida.
			if (ok && !error && self.agent.authFailureHint) {
				var hint = self.agent.authFailureHint(replyText || stderrTail);
				if (hint) { ok = false; error = hint; replyText = ''; }
			}
			session.busy = false;
			session.proc = null;
			hub.selectedProjectId = prevSelected;
			const handingOver = !!(self.chatPhases.get(key) || {}).declared && ok;
			// The image answer belonged to THIS turn. Clearing it means the next
			// turn - including one from an agent outside the editor - asks again
			// rather than inheriting permission to spend credits. The two steps of
			// one decide-then-draw turn are NOT two turns, so the handover keeps it.
			if (!handingOver) hub.setImageChoice(tab.projectid, undefined);
			// Close any dangling step rows so the timeline never spins forever.
			for (var k in openSteps) {
				sendToTab({ t: 'chat-step', id: turnId, step: { stepId: openSteps[k].stepId, phase: 'end', ok: false, elapsedMs: Date.now() - openSteps[k].started } });
			}
			// The text a non-streaming agent produced was held back (see handleLine):
			// deliver it as one delta first, so a tab that renders the bubble from
			// deltas gets it whether or not it also reads chat-done.text.
			// ...as is text the deciding step held back. Not when this step is handing the
			// turn over though: the drawing step speaks, and the held preamble is dropped.
			if (replyText && !handingOver
				&& (declarePhase || !self.agent.capabilities.streamsPartialText)) {
				sendToTab({ t: 'chat-delta', id: turnId, text: replyText });
			}
			// The deciding step named a component, so this turn is only half over:
			// hold the tab's turn open and let the drawing step continue it.
			const ph = self.chatPhases.get(key);
			if (ph && !ph.declared && !ph.declaredNone && ok && !String(replyText || '').trim()) {
				self.log('[declare] deciding step said nothing - drawing the old way instead');
				ph.declared = true;
				ph.composeReady = true;
			}
			if (ph && ph.declared && ok) {
				ph.phase1Done = true;
				self.log('[declare] deciding step finished, waiting to draw');
				if (ph.composeReady) self._runComposePhase(key);
				return;
			}
			if (ph) self.chatPhases.delete(key);
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
		// A turn waiting between its deciding and drawing steps has no process to
		// kill, and its tab turn is deliberately still open - close it here or the
		// chat waits for a draw that is never coming.
		const ph = this.chatPhases.get(boardKey);
		if (ph) {
			this.chatPhases.delete(boardKey);
			try { ph.sendToTab({ t: 'chat-done', id: ph.frame.id, ok: true, text: '' }); } catch (e) {}
		}
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
		const tools = (isConvert || isGenerate) ? (isGenerate ? this._toolsForComptype(comptype, true, mode) : [])
			: this._toolsForComptype(comptype, isSimilar, mode);
		const wantsResearch = !isConvert && this._toolWantsResearch(tools);

		if (!prompt) {
			return sendToTab({ t: 'compgen-done', id: turnId, ok: false, fallback: true, error: 'Empty prompt' });
		}
		if (!isConvert && !isGenerate && tools.length === 0) {
			// A media component (picture, clip, sound, 3D model) has no local tool by
			// design: the asset can only be made by MockFlow AI. The turn falls back
			// to it like any other, but the user is told why, because unlike every
			// other local generation this one spends their credits.
			const media = this._mediaComptypeEntry(comptype);
			// Say it out loud: from the editor this looks like "the local agent was
			// ignored and MockFlow AI ran instead", and the catalog reason (no entry
			// names this comptype, or its only tool is HTML without
			// clientHtmlFillsInPlace) is invisible from that side.
			this.log('Component AI turn (' + mode + ') for ' + (comptype || 'unknown component')
				+ ' has no local tool in the catalog' + (media ? ' (media component)' : '')
				+ ' - falling back to MockFlow AI.');
			return sendToTab({
				t: 'compgen-done', id: turnId, ok: false, fallback: true,
				error: 'No local tool for component ' + comptype,
				notice: media
					? ('A ' + String(media.mcpToolName).replace(/^render_/, '') + ' can only be generated by '
						+ 'MockFlow AI, so this one runs there and uses your AI credits.')
					: null
			});
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
		// htmlFill: this fill runs through an HTML-conversion tool, so the draw lands
		// in boardHub.drawHtml rather than captureOrDraw - the capture carries the flag
		// so drawHtml knows this one is a fill and not an unrelated agent's draw.
		const isFill = !isConvert && !isSimilar && !isGenerate;
		// tab.ws pins the result to the tab that started this turn: resolving by board
		// alone picks the first tab showing it, which is a different tab when the user
		// has the same board open twice - and that one has no turn waiting.
		if (isFill) hub.setCapture(tab.projectid, turnId, sendToTab,
			{ html: this._toolFillsFromHtml(tools), ws: tab.ws });
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

		// This turn can be running INSIDE a chat turn: modify_component is a tool call
		// the tab answers by running this. Opening this turn's image state overwrites
		// the outer turn's, so put back what was there when this one ends (finish()).
		const outerTurn = hub.captureTurnState(tab.projectid);

		// Whether this component may carry AI-generated imagery. QuickSettings and
		// the prompt box state it before the turn (a component's own "with images"
		// setting), and this turn is filling a component that is waiting on it - so
		// it is never paused to ask; unstated means no imagery.
		systemPrompt += this._openImageTurn(hub, tab, frame, false);
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

		const ws = this._effectiveWorkspace(tab);
		const delivery = this._deliverPrompt(prompt, key);
		const spec = this.agent.buildArgs(this._applyDelivery({
			cwd: ws,
			projectid: tab.projectid,
			prompt: delivery.prompt,
			systemPrompt: systemPrompt,
			allowedTools: allowed,
			mockflowTools: this._mockflowToolNames(),
			// Announce the render tool the moment the model STARTS writing it, instead of
			// when the whole call is written. For a tool whose argument is a document that
			// is minutes of silence, and the last thing on screen stays whatever ran before
			// it - so the turn looks stuck on that. (The plan turn uses it for this reason.)
			partialMessages: true
		}, delivery));

		this.log('Component AI turn (' + mode + ') for "' + (tab.title || key) + '"'
			+ (tools.length ? ' via ' + tools.join('/') : '') + ', workspace: ' + ws);
		// A tool whose whole answer is a document (a wireframe, a prototype) is written in
		// ONE tool call, and nothing reaches the timeline until that call is complete - so
		// several silent minutes are normal here and look exactly like a hang. Say so once.
		if (this._toolFillsFromHtml(tools) || this._toolsAreHtml(tools))
			this.log('  (' + tools.join('/') + ' writes the whole document in one call - '
				+ 'expect a few minutes with no visible steps)');
		// What the CLI was actually asked to do. Every "it behaved differently than
		// when I ran it by hand" bug so far came down to a flag the turn did or did
		// not carry, and there is no other way to see the spawned command line.
		if (config.DEBUG) this.log('[debug] ' + this.agent.id + ' argv: ' + JSON.stringify(spec.args));

		var proc;
		try {
			proc = this._spawnWithPrompt(spec, delivery, {
				env: this._turnEnv(spec),
				cwd: ws
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
		// File-delivered prompts (Windows large-prompt path): the agent's first tool call
		// is the read that fetches the prompt, not component data. Skip it so it neither
		// opens a stray timeline row nor trips toolCalled and suppresses the fallback.
		var deliveryTool = (delivery.file && delivery.file.tool) || null;
		var skipIds = {};
		var pendingDeliveryRead = !!deliveryTool;

		// ---- liveness in the Activity log ------------------------------------------
		// Writing a document-sized tool argument takes minutes during which the agent
		// produces no EVENTS, only stream deltas - so the feed's last line stays whatever
		// ran before it and the turn reads as hung. This says, every 30s, that it is alive,
		// what it is doing, and how much has come back, which is the difference between
		// "still writing, 34KB so far" and a genuinely stuck process.
		var turnStart = Date.now();
		var streamBytes = 0;
		var lastOutputAt = Date.now();
		var doing = 'thinking';
		var ticker = setInterval(function() {
			var secs = Math.round((Date.now() - turnStart) / 1000);
			var quiet = Math.round((Date.now() - lastOutputAt) / 1000);
			self.log('  … ' + doing + ' (' + (secs >= 60 ? Math.floor(secs / 60) + 'm' + (secs % 60) + 's' : secs + 's')
				+ (streamBytes ? ', ' + Math.round(streamBytes / 1024) + 'KB received' : '')
				+ (quiet >= 60 ? ', nothing for ' + Math.round(quiet / 60) + 'm' : '') + ')');
		}, 30000);
		if (ticker.unref) ticker.unref();

		function handleLine(line) {
			var events = self.agent.parseLine(line);
			for (var e = 0; e < events.length; e++) {
				var ev = events[e];
				if (ev.type === 'model') {
					self._noteModel(ev.id, hub);
				} else if (ev.type === 'tool-start') {
					if (pendingDeliveryRead && ev.name === deliveryTool) {
						pendingDeliveryRead = false;
						if (ev.id) skipIds[ev.id] = true;
						continue;
					}
					toolCalled = true;
					// Idempotent per tool id: an agent that announces a tool before it
					// runs (and again when the call is complete) must not open two rows.
					if (ev.id && openSteps[ev.id]) continue;
					var stepId = 'cg_' + turnId + '_' + (stepCounter++);
					openSteps[ev.id || stepId] = { stepId: stepId, started: Date.now() };
					var label = String(ev.name || 'tool').replace(/^mcp__mockflow__|^mockflow[_.]/, '')
							.replace(/^render_/, 'Generating ').replace(/_/g, ' ');
					// With partial messages this fires as the model STARTS writing the call,
					// so from here on the wait belongs to that tool, not to "thinking".
					doing = 'writing the ' + String(ev.name || 'tool').replace(/^mcp__mockflow__/, '') + ' call';
					self.log('  ' + doing + '…');
					sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: stepId, phase: 'start', tool: ev.name, label: label, detail: '' } });
				} else if (ev.type === 'tool-end') {
					if (ev.id && skipIds[ev.id]) { delete skipIds[ev.id]; continue; }
					var open = openSteps[ev.id];
					if (open) {
						delete openSteps[ev.id];
						var took = Math.round((Date.now() - open.started) / 1000);
						self.log('  ' + (ev.ok === false ? 'failed' : 'done') + ' after ' + took + 's');
						sendToTab({ t: 'compgen-step', id: turnId, step: { stepId: open.stepId, phase: 'end', ok: ev.ok, elapsedMs: Date.now() - open.started } });
					}
					doing = 'thinking';
				}
			}
		}

		proc.stdout.on('data', function(chunk) {
			// Volume, not events: while a document-sized tool argument streams in this is
			// the only thing that moves, and it is what makes the heartbeat meaningful.
			streamBytes += chunk.length;
			lastOutputAt = Date.now();
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
			clearInterval(ticker);
			// One closing line with what the turn actually cost, so a slow component is
			// something you can see rather than something you have to time by hand.
			var totalSecs = Math.round((Date.now() - turnStart) / 1000);
			self.log('Component AI turn ' + (ok ? 'finished' : 'ended') + ' in '
				+ (totalSecs >= 60 ? Math.floor(totalSecs / 60) + 'm' + (totalSecs % 60) + 's' : totalSecs + 's')
				+ (streamBytes ? ' (' + Math.round(streamBytes / 1024) + 'KB from the agent)' : '')
				+ (fallback ? ' - falling back to MockFlow AI' : '')
				+ (error ? ': ' + error : ''));
			self.compgenProcs.delete(key);
			// A still-armed capture (create/modify) means the agent never produced
			// the data - drop it and let the client fall back to the server.
			var stillArmed = hub.hasCapture(tab.projectid);
			hub.clearCapture(tab.projectid);
			if (tab.projectid) hub.convertContext.delete(tab.projectid);
			hub.selectedProjectId = prevSelected;
			// This turn's image answer dies with the turn (see the chat path) - but
			// this turn may be one a chat turn is waiting on, and that one's answer,
			// surface and mode outlive it. Restoring covers both: an outer turn gets
			// its own state back, a standalone turn is left with none.
			hub.restoreTurnState(outerTurn);
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
	 * The user answered (or there was nothing to ask): run the drawing step of a
	 * chat turn that already declared what it is making. Called via the hub, and
	 * safe to call before the deciding step's process has exited - whichever
	 * happens second starts the draw.
	 */
	resumeCompose(projectid) {
		const key = this._chatPhaseKey(projectid);
		const ph = key && this.chatPhases.get(key);
		if (!ph) return;
		ph.composeReady = true;
		if (ph.phase1Done) this._runComposePhase(key);
	}

	/** The agent named a component in the deciding step (hub.noteDeclared). */
	noteDeclared(projectid, tool) {
		const key = this._chatPhaseKey(projectid);
		const ph = key && this.chatPhases.get(key);
		if (!ph) return;
		if (tool === 'none') {
			// Nothing is being drawn, so this step answers the user itself: its held text
			// is released and the turn is NOT held open for a drawing step.
			ph.declaredNone = true;
			return;
		}
		ph.declared = true;
		// WHAT was decided, not just that something was: the drawing step is a fresh
		// process with none of the deciding step's conversation, so without this it
		// picks the component again from the bare request and can land somewhere else
		// than the choice the user was just asked about.
		if (tool) ph.declaredTool = tool;
	}

	_chatPhaseKey(projectid) {
		var key = null;
		this.chatPhases.forEach(function(v, k) {
			if (!key && (v.tab.projectid === projectid || k === projectid)) key = k;
		});
		return key;
	}

	/** Re-enter handleChat with the render tools available, same tab turn. */
	_runComposePhase(key) {
		const ph = this.chatPhases.get(key);
		if (!ph) return;
		this.chatPhases.delete(key);
		const frame = Object.assign({}, ph.frame, { __phase: 'compose' });
		// The answer the user just gave travels into the drawing step, so it is
		// composed the right way first time and nothing asks again.
		const known = ph.hub.getImageChoice(ph.tab.projectid);
		if (known === true || known === false) frame.withImages = known;
		if (ph.declaredTool) frame.__declared = ph.declaredTool;
		this.log('[declare] drawing step starting'
			+ ((known === true || known === false) ? ' (images ' + (known ? 'on' : 'off') + ')' : ''));
		try { this.handleChat(ph.tab, frame, ph.sendToTab, ph.hub); }
		catch (e) {
			this.log('[declare] drawing step failed to start: ' + (e && e.message));
			ph.sendToTab({ t: 'chat-done', id: ph.frame.id, ok: false, error: 'The drawing step could not start.' });
		}
	}

	/**
	 * Re-render one component WITH image slots, after the user answered the
	 * "generate images?" question.
	 *
	 * The turn that drew it ended at the question (nothing waits on a user), so
	 * this is a fresh one - and it needs no conversation memory, because the agent
	 * is handed back the exact call it made. It renders the same component again
	 * with the slots filled in, and the tab generates the pictures into them.
	 *
	 * Fired by boardHub.requestImageRerender, which has already recorded the
	 * user's yes, so this render passes the image gate instead of asking again.
	 * Drives the same Mida loader the plan continuation drives.
	 */
	handleImageRerender(tab, req, hub, sendToTab) {
		const self = this;
		const key = tab.projectid || tab.id;
		const tool = req && req.toolName;
		const label = (req && req.label) || 'component';
		const send = sendToTab || function() {};
		if (!tool) return;

		const fail = function(reason) {
			self.log('[images] re-render skipped: ' + reason);
			send({ t: 'plan-done', ok: false, error: reason });
		};
		if (!this.detect()) return fail(this.agent.label + ' is not installed, so the images could not be added.');
		if (this.imageProcs.has(key)) return fail('That board is already adding images.');

		var argsJson = '';
		try { argsJson = JSON.stringify(req.args || {}); } catch (e) { argsJson = ''; }
		if (!argsJson) return fail('The component data could not be read back.');

		const prevSelected = hub.selectedProjectId;
		if (tab.projectid) hub.selectedProjectId = tab.projectid;

		const prompt = 'You rendered this ' + label + ' on the user\'s MockFlow board without imagery, and '
			+ 'they have now asked for AI-generated images in it. Compose it AGAIN, this time with the '
			+ 'pictures as part of the composition, and call ' + tool + ' ONCE with the result.\n\n'
			+ 'This is the call you made without them, as the record of what it is about:\n' + argsJson;

		// Deliberately NOT "keep the layout and add images". Asked that way, the
		// agent squeezes tiles into a canvas it already sized for text, and the only
		// room to take is from the text boxes - which the board then auto-shrinks
		// into unreadably small type. Keep the CONTENT, re-do the composition.
		const systemPrompt = 'You compose a ' + label + ' again, now that the user wants AI-generated '
			+ 'imagery in it. Keep everything it is ABOUT - the same subject, the same words, the same '
			+ 'palette and fonts - but lay it out afresh with the pictures composed in as real elements, '
			+ 'the way you would have if you had been making it with imagery from the start. Give the '
			+ 'pictures their own room: enlarge the canvas if you need to, and never shrink the type or '
			+ 'squeeze a text box to fit one in. Call ' + tool + ' exactly once with the finished result. '
			+ (req.guidance || '')
			+ ' Each slot is a prompt token: put "mfimg::" followed by a plain description of the picture '
			+ '(no text, letters or numbers in it) where the image asset belongs. The pictures are generated '
			+ 'in the user\'s browser after your call, so never output a URL, never wait for one, do not chat '
			+ 'and do not output any text. A call that comes back with an error drew nothing: read the error, '
			+ 'fix what it names, and call the tool again (up to three tries).';

		const ws = this._effectiveWorkspace(tab);
		const delivery = this._deliverPrompt(prompt, key);
		const spec = this.agent.buildArgs(this._applyDelivery({
			cwd: ws,
			projectid: tab.projectid,
			prompt: delivery.prompt,
			systemPrompt: systemPrompt,
			allowedTools: 'mcp__mockflow__' + tool,
			mockflowTools: this._mockflowToolNames(),
			partialMessages: false
		}, delivery));

		this.log('[images] re-rendering ' + tool + ' with image slots for "' + (tab.title || key) + '"');
		send({ t: 'plan-start', total: 1, label: 'Adding images…', items: [{ name: label, tool: tool }] });

		var proc;
		try {
			proc = this._spawnWithPrompt(spec, delivery, {
				env: this._turnEnv(spec),
				cwd: ws
			});
		} catch (err) {
			hub.selectedProjectId = prevSelected;
			return fail('Could not launch the local agent: ' + err.message);
		}
		this.imageProcs.set(key, proc);

		var stderrTail = '';
		proc.stderr.on('data', function(d) { stderrTail = (stderrTail + d.toString()).slice(-2000); });
		// The agent's own output is not needed here: the draw happens through the
		// MCP loopback, and the tab reports its own progress while it generates.
		proc.stdout.on('data', function() {});

		const done = function(ok, error) {
			self.imageProcs.delete(key);
			hub.selectedProjectId = prevSelected;
			// This answer belonged to this piece of work, like every other turn.
			hub.setImageChoice(tab.projectid, undefined);
			send({ t: 'plan-done', ok: ok, error: error || null, doneText: ok ? 'Images added.' : null });
		};
		proc.on('error', function(err) { done(false, 'Local agent error: ' + (err && err.message)); });
		proc.on('close', function(code) {
			if (code === 0) return done(true, null);
			done(false, 'The local agent stopped before adding the images'
				+ (lastErrorLine(stderrTail, 160) ? ' (' + lastErrorLine(stderrTail, 160) + ')' : '') + '.');
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

		// The picker already asked about imagery for the whole batch, so this turn
		// starts with the answer in hand. askable:false is the important half - a
		// batch must NEVER stop to ask, because ending the turn mid-plan abandons
		// every item after the one that asked (and with them the auto-arrange).
		systemPrompt += this._openImageTurn(hub, tab, { surface: 'mida', withImages: !!plan.withImages }, false);

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
		const ws = this._effectiveWorkspace(tab);
		const delivery = this._deliverPrompt(prompt, key);
		const spec = this.agent.buildArgs(this._applyDelivery({
			cwd: ws,
			projectid: tab.projectid,
			prompt: delivery.prompt,
			systemPrompt: systemPrompt,
			allowedTools: allowed,
			mockflowTools: this._mockflowToolNames(),
			partialMessages: true
		}, delivery));

		this.log('[plan] generate starting: ' + items.length + ' item(s) for "' + (tab.title || key) + '" ['
			+ items.map(function(it) { return it.tool; }).join(', ') + ']'
			+ (delivery.file ? ' (prompt via file)' : delivery.stdin != null ? ' (prompt via stdin)' : ''));

		var proc;
		try {
			proc = this._spawnWithPrompt(spec, delivery, {
				env: this._turnEnv(spec),
				cwd: ws
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
		// When the prompt was delivered as a file (Windows large-plan path), the agent's
		// first tool call is the read that fetches it - not a rendered item. Skip that one
		// call so it neither steals item[0]'s timeline row nor counts toward stepCounter.
		var deliveryTool = (delivery.file && delivery.file.tool) || null;
		var skipIds = {};
		var pendingDeliveryRead = !!deliveryTool;

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
					if (pendingDeliveryRead && ev.name === deliveryTool) {
						pendingDeliveryRead = false;
						if (ev.id) skipIds[ev.id] = true;
						continue;
					}
					startStep(ev.id, ev.name);
				} else if (ev.type === 'tool-end') {
					if (ev.id && skipIds[ev.id]) { delete skipIds[ev.id]; continue; }
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
			// This batch's image answer dies with it (see the chat path).
			hub.setImageChoice(tab.projectid, undefined);
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
			if (code === 0 && stepCounter === 0) {
				// Exited cleanly but rendered nothing: the agent ran without ever calling a
				// board tool. On Windows this is the tell-tale of a plan prompt that overflowed
				// the cmd.exe command line and dropped --mcp-config. Report it instead of the
				// phantom success the exit code alone would imply.
				done('finished without drawing anything', false,
					'The agent finished but none of the ' + items.length + ' planned components were drawn. '
					+ 'If this is Windows with a large board plan, the plan may have exceeded the command-line '
					+ 'limit - try fewer or smaller items, or update the bridge.');
			} else if (code === 0) {
				done('finished', true, null);
			} else {
				done('exited ' + code, false, 'The local agent stopped before finishing the board'
					+ (lastErrorLine(stderrTail, 160) ? ' (' + lastErrorLine(stderrTail, 160) + ')' : '') + '.');
			}
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
