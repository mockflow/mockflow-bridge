/**
 * opencode adapter.
 *
 * Everything below was established by running `opencode run --format json` and
 * reading what came back, NOT from the CLI's OpenAPI document. The first version
 * of this file was written from `opencode serve`'s doc and matched nothing the
 * `run` command emits, so the bridge saw no text and no tool calls at all. If
 * you change anything here, run a live turn and look at the events.
 *
 * The whole per-turn setup rides ONE env var: OPENCODE_CONFIG_CONTENT carries
 * the MCP server, the persona (as an agent definition) and the tool allowlist,
 * so the bridge never writes to the user's own opencode config and two turns can
 * differ freely.
 *
 * Three things opencode does differently from the other adapters:
 *
 * 1. The MCP server is reached over STDIO (`mockflow-bridge stdio`), not over
 *    the HTTP endpoint. A `type: "remote"` server pointed at the bridge's own
 *    URL is rejected before a socket is even opened ("server unavailable
 *    key=mockflow type=remote status=failed"), so the shim is the way in.
 * 2. The tool allowlist needs EXACT tool names. `{"mockflow_*": true}` is not a
 *    pattern opencode honours, so with the `{"*": false}` default it exposed no
 *    board tools at all.
 * 3. opencode takes its working directory from the PWD env var, not from the
 *    process's actual cwd. Without PWD the turn runs wherever the daemon was
 *    started - reading that project's files and ignoring the workspace.
 */

const path = require('path');
const config = require('../config');
const { spawnCli, spawnCliSync } = require('./spawnPortable');

const BIN = 'opencode';

/** The bridge's own CLI, as an MCP server opencode can launch over stdio. */
function stdioServer() {
	const bin = path.join(__dirname, '..', '..', 'bin', 'mockflow-bridge.js');
	return {
		type: 'local',
		command: [process.execPath, bin, 'stdio'],
		// The shim finds the daemon through the port file, but an explicit port
		// keeps a non-default MFBRIDGE_PORT working too.
		environment: { MFBRIDGE_PORT: String(config.PORT) },
		enabled: true
	};
}

/**
 * Our allowlist is written in Claude's vocabulary (the orchestrator builds it
 * from the catalog). Translate it to opencode tool ids: MCP tools are exposed
 * as `<server>_<tool>`, built-ins have their own lowercase names. Everything
 * else is denied by the leading wildcard, so a tool we did not ask for cannot
 * run just because it exists.
 *
 * `mcp__mockflow__*` has to be expanded here: opencode matches these keys
 * literally, so a wildcard entry would leave every board tool denied. The names
 * come from the catalog, via turn.mockflowTools.
 */
function toolMap(allowedTools, mockflowTools) {
	const tools = { '*': false };
	String(allowedTools || '').split(',').forEach(function(raw) {
		const t = raw.trim();
		if (!t) return;
		if (t.indexOf('mcp__mockflow__') === 0) {
			const rest = t.slice('mcp__mockflow__'.length);
			if (rest === '*' || rest === '') {
				(mockflowTools || []).forEach(function(name) { tools['mockflow_' + name] = true; });
			} else {
				tools['mockflow_' + rest] = true;
			}
			return;
		}
		if (t === 'Read') tools['read'] = true;
		else if (t === 'Grep') tools['grep'] = true;
		else if (t === 'Glob') tools['glob'] = true;
		else if (t === 'WebSearch' || t === 'WebFetch') tools['webfetch'] = true;
		else if (t === 'Write') tools['write'] = true;
		else if (t === 'Edit') tools['edit'] = true;
		else if (t === 'Bash') tools['bash'] = true;
	});
	return tools;
}

let _available = null;

module.exports = {
	id: 'opencode',
	label: 'opencode',

	// The CLI version this adapter's injected config schema, arg ordering and
	// stderr log format were last verified against on a real board. agents/health.js
	// warns at startup when the installed opencode is newer - this adapter leans on
	// the widest, softest surface of the three. Bump after re-running test/fake-*.js.
	testedVersion: '1.18.4',

	// Flags a turn depends on, checked against `opencode run --help` at startup
	// (agents/health.js). Needles verified present in 1.18.4 - not guessed. If the
	// `run` subcommand itself is gone the help call fails and that is flagged too.
	capabilityProbe: {
		bin: BIN,
		help: ['run', '--help'],
		requires: [
			{ needle: '--format', critical: true, label: 'json event output' },
			{ needle: '--agent', critical: true, label: 'the per-turn agent definition (carries the MCP server and tool allowlist)' },
			{ needle: '--print-logs', critical: false, label: 'the model label (read from stderr)' },
			{ needle: '--session', critical: false, label: 'session memory' },
			{ needle: '--file', critical: false, label: 'attachments' }
		],
		// The MCP server, permissions and tool allowlist ride the
		// OPENCODE_CONFIG_CONTENT env schema, which --help does not describe. Only a
		// live turn catches a schema drift - and a denied board tool draws nothing.
		blindSpots: ['OPENCODE_CONFIG_CONTENT: mcp / agent / permission / tools schema']
	},

	capabilities: {
		// `run --format json` emits a whole assistant message as one `text` event.
		// There is no token-level delta on this stream, so a reply lands in one
		// piece and agentManager holds it until the turn ends.
		streamsPartialText: false,
		textChunks: 'block',
		// A tool is reported once, already carrying its result, so its timeline row
		// opens and closes as the drawing lands rather than while it is written.
		announcesToolsEarly: false,
		restrictTools: 'per-run',
		resume: 'by-id',
		systemPrompt: 'config',
		// No --add-dir equivalent, and its read tool refuses paths outside the
		// working directory. Attachments still work, but through `-f` (see
		// buildArgs), not by granting a directory.
		extraDirs: false
	},

	detect() {
		if (_available !== null) return _available;
		try {
			const r = spawnCliSync(BIN, ['--version'], { encoding: 'utf8' });
			_available = { available: r.status === 0, version: (r.stdout || '').trim() };
		} catch (e) {
			_available = { available: false, version: '' };
		}
		return _available;
	},

	installHint() {
		return 'opencode is not installed on this machine. Install it from https://opencode.ai, '
			+ 'sign in once with `opencode`, then try again.';
	},

	/**
	 * How to point this CLI at the bridge when the user drives it themselves in a
	 * terminal. opencode has no `mcp add` command - servers are declared in its
	 * config file - and it reaches the bridge through the stdio shim, because a
	 * remote server pointed at the HTTP endpoint fails to connect. Fallback only:
	 * a catalog that carries `agentWiring.opencode` wins - see src/catalog.js.
	 */
	mcpAddHint() {
		return {
			title: 'Add to opencode  (~/.config/opencode/opencode.json):',
			lines: [
				'"mcp": { "mockflow": { "type": "local", "enabled": true,',
				'         "command": ["npx", "-y", "@mockflow/mockflow-bridge", "stdio"] } }'
			]
		};
	},

	buildArgs(turn) {
		// One inline config per turn: MCP server, persona, tool allowlist. Nothing
		// is written to the user's own config file.
		const cfg = {
			mcp: { mockflow: stdioServer() },
			agent: {
				mfbridge: {
					description: 'MockFlow Bridge turn',
					mode: 'primary',
					prompt: turn.systemPrompt || '',
					tools: toolMap(turn.allowedTools, turn.mockflowTools),
					// Nothing on this path should touch the user's files or shell;
					// reading is granted through the tool map above when asked for.
					permission: { edit: 'deny', bash: 'deny' }
				}
			}
		};

		// --print-logs puts opencode's own logs on stderr, the only place the model
		// for this turn appears (the JSON stream carries tokens and cost but no
		// model). parseStderr picks it out.
		const args = ['run', '--format', 'json', '--print-logs', '--agent', 'mfbridge'];
		if (turn.resume) args.push('-s', turn.resume);

		// Prompt is the positional, and it MUST come before any `-f`: opencode's
		// -f takes one or more values greedily, so a prompt after it is swallowed
		// as another filename ("File not found: <the prompt text>"). Attachments
		// go through -f because opencode's read tool refuses paths outside the
		// working directory - this is how it reads a file the user attached in Mida.
		args.push(turn.prompt);
		(turn.attachments || []).forEach(function(p) { if (p) args.push('-f=' + p); });

		return {
			args: args,
			env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) }
		};
	},

	/**
	 * PWD, not cwd, is what opencode treats as the project directory: it loads
	 * config from there, snapshots it, and confines its file tools to it. Left as
	 * the daemon's own PWD, a turn would run inside whatever directory the user
	 * happened to start the bridge in.
	 */
	spawn(args, opts) {
		const o = Object.assign({}, opts);
		if (o.cwd) o.env = Object.assign({}, o.env || process.env, { PWD: o.cwd });
		return spawnCli(BIN, args, o);
	},

	/**
	 * Tool ids arrive in opencode's vocabulary, so the allowlist is translated the
	 * same way buildArgs translates it, and the answer stays consistent with what
	 * the agent was actually permitted to run.
	 */
	isRunnableTool(toolName, allowedTools, mockflowTools) {
		const name = String(toolName || '');
		if (!name) return false;
		const map = toolMap(allowedTools, mockflowTools);
		if (map[name] === true) return true;
		// A board tool the turn asked for by wildcard, when the catalog list was
		// not passed through: the server prefix is proof enough of whose tool it is.
		return name.indexOf('mockflow_') === 0
			&& String(allowedTools || '').indexOf('mcp__mockflow__*') !== -1;
	},

	/**
	 * The model for this turn, read from a --print-logs stderr line. opencode logs
	 * a `stream` line per agent; the one that matters is our own agent, tagged
	 * `agent=mfbridge` - the other (`agent=title`, `small=true`) is the throwaway
	 * title generator and names a different, smaller model. Returns { type:'model',
	 * id } or null.
	 */
	parseStderr(line) {
		if (line.indexOf('agent=mfbridge') === -1) return null;
		const m = /modelID=(\S+)/.exec(line);
		return m ? { type: 'model', id: m[1] } : null;
	},

	/**
	 * One JSON line to normalized events. Shapes confirmed from a live
	 * `opencode run --format json`:
	 *
	 *   {"type":"step_start","sessionID":"ses_…","part":{…}}
	 *   {"type":"text","sessionID":"ses_…","part":{"type":"text","text":"…"}}
	 *   {"type":"tool_use","sessionID":"ses_…","part":{"type":"tool","tool":"read",
	 *      "callID":"read_0","state":{"status":"completed"|"error", …}}}
	 *   {"type":"step_finish","sessionID":"ses_…","part":{…}}
	 *
	 * A tool arrives once, already finished, so start and end are emitted
	 * together - the same shape Codex produces.
	 */
	parseLine(line) {
		let evt;
		try { evt = JSON.parse(line); } catch (e) { return []; }
		if (!evt || typeof evt.type !== 'string') return [];
		const part = evt.part || {};
		const out = [];

		if (evt.sessionID) out.push({ type: 'session', id: evt.sessionID });

		if (evt.type === 'text') {
			if (part.text) out.push({ type: 'text', text: part.text });
			return out;
		}

		if (evt.type === 'tool_use' && part.tool) {
			const id = part.callID || part.id || part.tool;
			const status = String((part.state && part.state.status) || '');
			out.push({ type: 'tool-start', id: id, name: part.tool });
			if (status && status !== 'running' && status !== 'pending') {
				out.push({ type: 'tool-end', id: id, ok: status !== 'error' && status !== 'failed' });
			}
		}
		return out;
	},

	/**
	 * Committed fixtures for the startup canary (agents/health.js). Beyond the
	 * event and stderr shapes, `check` re-derives the injected tool allowlist and
	 * asserts it still exposes at least one `mockflow_*` board tool - the silent
	 * failure this adapter is most exposed to (a prefix or `{"*":false}`-default
	 * drift denies every board tool and the turn draws nothing without an error).
	 */
	selfTest: {
		lines: [
			{ line: '{"type":"step_start","sessionID":"ses_1","part":{}}',
				expect: ['session'] },
			{ line: '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"Hello"}}',
				expect: ['session', 'text'] },
			{ line: '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","callID":"read_0","state":{"status":"completed"}}}',
				expect: ['session', 'tool-start', 'tool-end'] }
		],
		stderr: [
			{ line: 'INFO service=session agent=mfbridge sessionID=ses_1 modelID=anthropic/claude-opus-4-8 provider=anthropic',
				expect: 'model' },
			// The throwaway title generator names a different, smaller model and must
			// be ignored - if this stops being filtered the board mislabels the model.
			{ line: 'INFO service=session agent=title small=true modelID=anthropic/claude-haiku',
				expect: null }
		],
		check: function () {
			const map = toolMap('mcp__mockflow__*', ['render_wireframelite', 'render_prototypelite']);
			const exposesBoard = Object.keys(map).some(function (k) {
				return k.indexOf('mockflow_') === 0 && map[k] === true;
			});
			return exposesBoard ? '' : 'injected allowlist exposes no mockflow_* board tools';
		}
	}
};
