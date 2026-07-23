/**
 * Codex CLI adapter.
 *
 * Event envelope confirmed against `codex exec --json` on 0.145.0:
 *   {"type":"thread.started","thread_id":"019f89..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi!"}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * The whole per-turn setup rides `-c key=value` overrides, so the bridge never
 * writes to the user's ~/.codex/config.toml. Values are parsed as TOML and fall
 * back to a literal string when that fails, which is what makes a multi-line
 * persona safe to pass.
 */

const fs = require('fs');
const config = require('../config');
const { spawnCli, spawnCliSync } = require('./spawnPortable');

const BIN = 'codex';

function mcpUrl() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	return 'http://127.0.0.1:' + config.PORT + '/mcp/' + token;
}

/**
 * Our allowlist is written in Claude's vocabulary. Codex filters per MCP server
 * with `enabled_tools`, which names tools as the server exposes them, so the
 * mcp__mockflow__ prefix is stripped. A wildcard means "no filter" - the server
 * only exposes MockFlow tools anyway.
 */
function mockflowToolFilter(allowedTools) {
	const names = [];
	let wildcard = false;
	String(allowedTools || '').split(',').forEach(function(raw) {
		const t = raw.trim();
		if (t.indexOf('mcp__mockflow__') !== 0) return;
		const rest = t.slice('mcp__mockflow__'.length);
		if (rest === '*' || rest === '') wildcard = true;
		else names.push(rest);
	});
	return wildcard ? null : names;
}

let _available = null;
let _foreign = null;

/**
 * `-c mcp_servers.<name>.enabled=false` for every MCP server the USER has
 * configured, so a bridge turn sees only the bridge's own tools.
 *
 * Codex loads ~/.codex/config.toml on top of our `-c` overrides (they merge, they
 * do not replace), so a user who also runs another MockFlow MCP - the desktop
 * app, say - offers the agent a second set of identically-shaped render tools.
 * The agent then draws into that one instead: the turn reports success, and the
 * board the user is actually looking at never changes. Their model, provider and
 * auth settings are deliberately left alone; only foreign tools are removed.
 *
 * Read once per bridge process. A server added to the user's config afterwards
 * is picked up on the next restart.
 */
function foreignServerFlags() {
	if (_foreign === null) {
		_foreign = [];
		try {
			const r = spawnCliSync(BIN, ['mcp', 'list', '--json'], { encoding: 'utf8' });
			if (r.status === 0 && r.stdout) {
				const list = JSON.parse(r.stdout);
				if (Array.isArray(list)) {
					list.forEach(function(s) {
						if (s && s.name && s.name !== 'mockflow') _foreign.push(String(s.name));
					});
				}
			}
		} catch (e) {
			// Older codex without `mcp list --json`: nothing to disable, and the turn
			// still works - it just shares the toolbox with whatever else is configured.
		}
	}
	const args = [];
	_foreign.forEach(function(name) {
		// Dotted config paths need a quoted segment for anything but a bare word.
		const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
		args.push('-c', 'mcp_servers.' + key + '.enabled=false');
	});
	return args;
}

module.exports = {
	id: 'codex',
	label: 'Codex',

	// The CLI version the `-c` config keys and the event envelope below were
	// confirmed against (see the file header). agents/health.js warns at startup
	// when the installed codex is newer. Bump after re-running test/fake-*.js.
	testedVersion: '0.145.0',

	// Flags a turn depends on, checked against `codex exec --help` at startup
	// (agents/health.js). Needles verified present in 0.145.0 - not guessed.
	capabilityProbe: {
		bin: BIN,
		help: ['exec', '--help'],
		requires: [
			{ needle: '--json', critical: true, label: 'JSON event stream (the bridge cannot read a turn without it)' },
			{ needle: '--config', critical: true, label: 'the -c config transport (all MCP and sandbox wiring rides it)' },
			{ needle: '--skip-git-repo-check', critical: true, label: 'the git-repo bypass (every turn passes it; its removal errors the run)' },
			{ needle: 'resume', critical: false, label: 'session memory (exec resume)' }
		],
		// These ride `-c key=value`, not flags, so --help cannot confirm them. Only a
		// live turn catches a renamed key - and a broken one draws into the wrong
		// place while reporting success (see the file header).
		blindSpots: [
			'mcp_servers.mockflow.url', 'sandbox_mode="read-only"',
			'mcp_servers.mockflow.default_tools_approval_mode', 'features.apps'
		]
	},

	capabilities: {
		// item.completed carries a whole agent message; there is no token-level
		// delta on this stream, so a reply lands in one piece.
		streamsPartialText: false,
		textChunks: 'block',
		// item.started fires when an item begins, which for a tool call is before
		// its result exists - early enough for the timeline row.
		announcesToolsEarly: true,
		restrictTools: 'per-run',
		resume: 'by-id',
		systemPrompt: 'config',
		// Nothing to add: the read-only sandbox already lets a turn READ anywhere
		// (it only blocks writes), so attachment folders need no extra grant.
		// `--add-dir` would be wrong anyway - it makes a directory WRITABLE.
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
		return 'Codex is not installed on this machine. Install it with: '
			+ 'npm i -g @openai/codex, sign in once with `codex login`, then try again.';
	},

	/**
	 * How to point this CLI at the bridge when the user drives it themselves in a
	 * terminal. (In-editor turns need none of this - buildArgs passes the MCP
	 * server per run.) `--url` is Codex's streamable-HTTP form. Fallback only: a
	 * catalog that carries `agentWiring.codex` wins - see src/catalog.js.
	 */
	mcpAddHint(endpoint) {
		return {
			title: 'Add to Codex:',
			lines: ['codex mcp add mockflow --url ' + endpoint]
		};
	},

	buildArgs(turn) {
		// `exec resume <id>` is a subcommand, not a flag, so the shape differs
		// between a first turn and a continued one.
		const args = turn.resume
			? ['exec', 'resume', String(turn.resume), '--json']
			: ['exec', '--json'];

		// EVERY setting below rides `-c`, on purpose. `exec` and `exec resume` do
		// not accept the same flags - `--sandbox` and `--add-dir` exist only on a
		// fresh exec, so a flag here would work on the first message of a chat and
		// kill every later one with "unexpected argument '--sandbox'". `-c` and
		// `--skip-git-repo-check` are valid on both, and `sandbox_mode` is the
		// config key `--sandbox` sets.
		args.push('--skip-git-repo-check');
		args.push('-c', 'approval_policy="never"');
		// Read-only: a turn should draw on the board, not edit the user's machine.
		args.push('-c', 'sandbox_mode="read-only"');
		args.push('-c', 'mcp_servers.mockflow.url="' + mcpUrl() + '"');
		// Codex asks the user before running an MCP tool, and in `exec` there is
		// nobody to ask: the call comes back "user cancelled MCP tool call" and the
		// turn ends having drawn nothing. Pre-approve this one server - it is the
		// only one configured for this run, it draws on the board the user is
		// looking at, and the user asked for exactly that.
		// (Modes are auto|prompt|writes|approve; only `approve` skips the prompt.)
		args.push('-c', 'mcp_servers.mockflow.default_tools_approval_mode="approve"');
		// ...and nobody else's tools, so the agent cannot draw into another app.
		//
		// Codex ships its own "apps" connectors (server `codex_apps`), which include
		// a hosted MockFlow IdeaBoard app exposing render tools of the same shape as
		// the bridge's. The agent happily picks that one instead, the call succeeds
		// against MockFlow's cloud, the turn reports "updated" - and the board in
		// front of the user never changes. A local bridge turn must act on the local
		// board, so the connectors are off for the turns we spawn.
		// (`codex features list` names this one `apps`; it is on by default.)
		args.push('-c', 'features.apps=false');
		foreignServerFlags().forEach(function(a) { args.push(a); });

		const only = mockflowToolFilter(turn.allowedTools);
		if (only && only.length) {
			args.push('-c', 'mcp_servers.mockflow.enabled_tools='
				+ JSON.stringify(only));
		}
		if (turn.systemPrompt) {
			// Deliberately unquoted: a multi-line persona will not parse as TOML, and
			// Codex then takes the raw string as a literal, which is what we want.
			args.push('-c', 'developer_instructions=' + turn.systemPrompt);
		}
		// turn.extraDirs is deliberately ignored (capabilities.extraDirs = false):
		// read-only already permits reading them, and --add-dir is resume-hostile.

		args.push(turn.prompt);
		return { args: args, env: {} };
	},

	spawn(args, opts) {
		return spawnCli(BIN, args, opts);
	},

	isRunnableTool(toolName, allowedTools) {
		const name = String(toolName || '');
		if (!name) return false;
		const only = mockflowToolFilter(allowedTools);
		// No filter means every MockFlow tool is fair game; anything else the agent
		// reaches for is its own built-in and does not belong on the board timeline.
		const bare = name.replace(/^mockflow[._-]?/, '');
		if (only === null) return true;
		return only.indexOf(bare) !== -1 || only.indexOf(name) !== -1;
	},

	/**
	 * One JSONL line to normalized events.
	 *
	 * Tool items: the envelope is confirmed, but the exact field carrying an MCP
	 * tool's name is not (the capture run called no tools), so the name is read
	 * from the plausible carriers and the item id doubles as the call id. An
	 * unknown shape degrades to a row labelled by item type rather than breaking
	 * the turn.
	 */
	parseLine(line) {
		let evt;
		try { evt = JSON.parse(line); } catch (e) { return []; }
		const out = [];

		if (evt.type === 'thread.started' && evt.thread_id) {
			out.push({ type: 'session', id: evt.thread_id });
			return out;
		}

		const item = evt.item;
		if (!item || (evt.type !== 'item.started' && evt.type !== 'item.completed')) return out;

		const itemType = String(item.type || '');
		const isTool = itemType.indexOf('tool') !== -1 || itemType.indexOf('command') !== -1;

		if (itemType === 'agent_message') {
			if (evt.type === 'item.completed' && item.text) out.push({ type: 'text', text: item.text });
			return out;
		}

		if (isTool) {
			const name = item.tool || item.name || item.tool_name || itemType;
			if (evt.type === 'item.started') {
				out.push({ type: 'tool-start', id: item.id, name: name });
			} else {
				const status = String(item.status || '');
				const failed = (status === 'failed' || status === 'error' || item.error);
				out.push({ type: 'tool-start', id: item.id, name: name });
				out.push({ type: 'tool-end', id: item.id, ok: !failed });
			}
		}
		return out;
	},

	/**
	 * Committed fixtures for the startup canary (agents/health.js). The thread and
	 * agent_message shapes are confirmed (file header); the two tool fixtures
	 * encode the *assumed* tool-item shape the parser reads (the capture run called
	 * no tools), so the canary also documents that assumption - if a codex update
	 * moves it, boot flags the mismatch instead of a tool row silently vanishing.
	 */
	selfTest: {
		lines: [
			{ line: '{"type":"thread.started","thread_id":"thr_1"}',
				expect: ['session'] },
			{ line: '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi!"}}',
				expect: ['text'] },
			{ line: '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","tool":"render_wireframelite"}}',
				expect: ['tool-start'] },
			{ line: '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","tool":"render_wireframelite","status":"completed"}}',
				expect: ['tool-start', 'tool-end'] }
		]
	}
};
