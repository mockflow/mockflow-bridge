/**
 * Cursor CLI adapter (cursor-agent).
 *
 * Flags and event shapes are from Cursor's CLI reference:
 *   -p/--print, --output-format stream-json, --resume [chatId], --trust,
 *   --approve-mcps, --sandbox <enabled|disabled>
 *   events: {type:'system',subtype:'init',session_id,...}
 *           {type:'assistant',message:{content:[...]},session_id}
 *           {type:'tool_call',subtype:'started'|'completed',call_id,tool_call,...}
 *           {type:'result',subtype:'success',...}
 *
 * Two deliberate differences from the other adapters, both forced by the CLI:
 *
 * 1. MCP is configured by FILE, not by flag. Cursor reads `.cursor/mcp.json`
 *    from the working directory (project scope) before the user's global one, so
 *    the server is written into the directory the turn runs in and merged with
 *    whatever is already there. Nothing the user configured is overwritten.
 * 2. There is no per-run tool allowlist. The turn's system prompt already names
 *    the one tool a component turn may call, which is the documented fallback
 *    for `restrictTools: 'none'`.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Installed as `cursor-agent`; the docs' examples call it `agent`. Try both so
// either install layout works.
const CANDIDATES = ['cursor-agent', 'agent'];

let _available = null;
let _binary = null;

function binary() {
	if (_binary) return _binary;
	module.exports.detect();
	return _binary || CANDIDATES[0];
}

function mcpUrl() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	return 'http://127.0.0.1:' + config.PORT + '/mcp/' + token;
}

/**
 * Put the bridge's MCP server in `<cwd>/.cursor/mcp.json`, preserving any other
 * server already defined there. Returns quietly on failure: a turn without the
 * board tools still runs and says something useful, which beats refusing to start.
 */
function writeProjectMcpConfig(cwd) {
	try {
		const dir = path.join(cwd, '.cursor');
		const file = path.join(dir, 'mcp.json');
		let existing = {};
		try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {}
		const servers = existing.mcpServers || {};
		servers.mockflow = { url: mcpUrl() };
		existing.mcpServers = servers;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(existing, null, '\t'));
	} catch (e) {}
}

module.exports = {
	id: 'cursor',
	label: 'Cursor CLI',

	capabilities: {
		// Assistant messages arrive per segment. --stream-partial-output would give
		// deltas, but the docs warn its buffering flushes repeat text, so this
		// trades a little liveness for a reply that is never duplicated.
		streamsPartialText: true,
		textChunks: 'block',
		// tool_call/started fires before the call runs.
		announcesToolsEarly: true,
		// No per-run allowlist exists; the system prompt names the tool instead.
		restrictTools: 'none',
		resume: 'by-id',
		systemPrompt: 'prompt-prefix',
		extraDirs: false
	},

	detect() {
		if (_available !== null) return _available;
		for (let i = 0; i < CANDIDATES.length; i++) {
			try {
				const r = spawnSync(CANDIDATES[i], ['--version'], { encoding: 'utf8' });
				if (r.status === 0) {
					_binary = CANDIDATES[i];
					_available = { available: true, version: (r.stdout || '').trim() };
					return _available;
				}
			} catch (e) {}
		}
		_available = { available: false, version: '' };
		return _available;
	},

	installHint() {
		return 'Cursor CLI is not installed on this machine. Install it from '
			+ 'https://cursor.com/cli, sign in once with `cursor-agent login`, then try again.';
	},

	buildArgs(turn) {
		// Written into the directory this turn runs in, so the user's global Cursor
		// config is never touched.
		writeProjectMcpConfig(turn.cwd || process.cwd());

		const args = ['--print', '--output-format', 'stream-json'];
		// Headless reliability: trust the workspace and accept the MCP server we
		// just configured, otherwise the run stops on a prompt nobody can answer.
		args.push('--trust', '--approve-mcps');
		// Shell stays sandboxed unless the operator opted into write mode.
		args.push('--sandbox', process.env.MFBRIDGE_ALLOW_WRITE === '1' ? 'disabled' : 'enabled');
		if (turn.resume) args.push('--resume', turn.resume);

		// No system-prompt flag exists, so the persona leads the prompt.
		const text = turn.systemPrompt
			? turn.systemPrompt + '\n\n' + turn.prompt
			: turn.prompt;
		args.push(text);

		return { args: args, env: {} };
	},

	spawn(args, opts) {
		return spawn(binary(), args, opts || {});
	},

	/**
	 * Without a per-run allowlist the agent can reach for any of its own tools, so
	 * this keeps the board timeline to the tools the turn was actually about: the
	 * MockFlow ones, plus whatever the caller explicitly allowed.
	 */
	isRunnableTool(toolName, allowedTools) {
		const name = String(toolName || '');
		if (!name) return false;
		if (name.indexOf('mockflow') !== -1) return true;
		const allowed = String(allowedTools || '').split(',');
		for (let i = 0; i < allowed.length; i++) {
			const a = allowed[i].trim();
			if (!a) continue;
			if (a.toLowerCase() === name.toLowerCase()) return true;
			if (a.slice(-1) === '*' && name.indexOf(a.slice(0, -1)) === 0) return true;
		}
		return false;
	},

	/** One stream-json line to normalized events. */
	parseLine(line) {
		let evt;
		try { evt = JSON.parse(line); } catch (e) { return []; }
		const out = [];
		if (!evt || !evt.type) return out;

		if (evt.session_id) out.push({ type: 'session', id: evt.session_id });

		if (evt.type === 'assistant') {
			const content = (evt.message && evt.message.content) || [];
			const blocks = Array.isArray(content) ? content : [content];
			for (let i = 0; i < blocks.length; i++) {
				const b = blocks[i];
				if (typeof b === 'string') { if (b) out.push({ type: 'text', text: b }); }
				else if (b && b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
			}
			return out;
		}

		if (evt.type === 'tool_call') {
			// The call object is keyed by tool kind (readToolCall, writeToolCall,
			// function, ...), so the name is wherever that wrapper puts it.
			const call = evt.tool_call || {};
			let name = call.name || call.tool || '';
			let result = call.result;
			if (!name) {
				for (const key in call) {
					const inner = call[key];
					if (inner && typeof inner === 'object') {
						name = inner.name || inner.tool || key.replace(/ToolCall$/, '');
						if (result === undefined) result = inner.result;
						break;
					}
				}
			}
			if (evt.subtype === 'started') {
				out.push({ type: 'tool-start', id: evt.call_id, name: name || 'tool' });
			} else if (evt.subtype === 'completed') {
				const failed = !!(result && (result.error || result.success === false
					|| result.is_error || String(result.status || '') === 'failed'));
				out.push({ type: 'tool-end', id: evt.call_id, ok: !failed });
			}
		}
		return out;
	}
};
