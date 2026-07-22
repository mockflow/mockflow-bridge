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

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const config = require('../config');

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

module.exports = {
	id: 'codex',
	label: 'Codex',

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
		extraDirs: true
	},

	detect() {
		if (_available !== null) return _available;
		try {
			const r = spawnSync('codex', ['--version'], { encoding: 'utf8' });
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

	buildArgs(turn) {
		// `exec resume <id>` is a subcommand, not a flag, so the shape differs
		// between a first turn and a continued one.
		const args = turn.resume
			? ['exec', 'resume', String(turn.resume), '--json']
			: ['exec', '--json'];

		// The bridge's scratch workspace is not a git repo, and nothing here needs
		// one; the sandbox stays read-only because a turn should draw on the board,
		// not edit the user's machine.
		args.push('--skip-git-repo-check', '--sandbox', 'read-only');
		args.push('-c', 'approval_policy="never"');
		args.push('-c', 'mcp_servers.mockflow.url="' + mcpUrl() + '"');

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
		(turn.extraDirs || []).forEach(function(dir) { if (dir) args.push('--add-dir', dir); });

		args.push(turn.prompt);
		return { args: args, env: {} };
	},

	spawn(args, opts) {
		return spawn('codex', args, opts || {});
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
	}
};
