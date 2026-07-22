/**
 * Claude Code adapter.
 *
 * Everything specific to the `claude` CLI lives here: how to detect it, how to
 * turn one turn into a command line, and how to read its stream-json output.
 * agentManager owns the orchestration around this (sessions, attachments,
 * capture arming, timeline bookkeeping, fallback) and knows none of these flags.
 *
 * This is the reference implementation of the adapter contract - see
 * src/agents/index.js for the contract itself.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { spawnCli, spawnCliSync } = require('./spawnPortable');

const BIN = 'claude';

/** The bridge's MCP endpoint, as a config file this CLI can be pointed at. */
function mcpConfigPath() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	const cfg = {
		mcpServers: {
			mockflow: { type: 'http', url: 'http://127.0.0.1:' + config.PORT + '/mcp/' + token }
		}
	};
	const p = path.join(config.HOME_DIR, 'bridge-agent-mcp.json');
	fs.mkdirSync(config.HOME_DIR, { recursive: true });
	fs.writeFileSync(p, JSON.stringify(cfg, null, '\t'));
	return p;
}

let _available = null;

module.exports = {
	id: 'claude',
	label: 'Claude Code',

	/**
	 * What the orchestrator may rely on. Anything false here has a documented
	 * fallback in agentManager, so a weaker CLI degrades instead of breaking.
	 */
	capabilities: {
		streamsPartialText: true,   // text arrives incrementally
		textChunks: 'block',        // whole blocks, joined with a blank line
		announcesToolsEarly: true,  // a tool is named before it runs
		restrictTools: 'per-run',   // an allowlist can be passed per turn
		resume: 'by-id',            // sessions resume by an id we captured
		systemPrompt: 'flag',       // per-turn instructions ride a flag
		extraDirs: true             // extra readable directories per turn
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
		return 'Claude Code is not installed on this machine. Install it with: '
			+ 'npm i -g @anthropic-ai/claude-code, sign in once with `claude`, then try again.';
	},

	/**
	 * How to point this CLI at the bridge when the user drives it themselves in a
	 * terminal. (In-editor turns need none of this - agentManager passes the MCP
	 * config per run.) Fallback only: a catalog that carries `agentWiring.claude`
	 * wins, so a syntax change ships without an npm publish - see src/catalog.js.
	 */
	mcpAddHint(endpoint) {
		return {
			title: 'Add to Claude Code:',
			lines: ['claude mcp add --transport http -s user mockflow ' + endpoint]
		};
	},

	/**
	 * One turn as a command line.
	 * turn: { prompt, systemPrompt, allowedTools, resume, extraDirs[], partialMessages }
	 * Returns { args, env } - env is empty here, other CLIs use it to carry config.
	 */
	buildArgs(turn) {
		const args = [
			'-p', turn.prompt,
			'--output-format', 'stream-json',
			'--verbose'
		];
		// Announces each tool as it starts, so the board shows "Drawing ..." while the
		// agent is still writing the call instead of after it.
		if (turn.partialMessages) args.push('--include-partial-messages');
		args.push('--mcp-config', mcpConfigPath());
		if (turn.allowedTools) args.push('--allowedTools', turn.allowedTools);
		if (turn.systemPrompt) args.push('--append-system-prompt', turn.systemPrompt);
		// Attachments live outside the workspace (and there may be no workspace at
		// all), so the agent needs those folders added to its readable set.
		(turn.extraDirs || []).forEach(function(dir) { if (dir) args.push('--add-dir', dir); });
		if (turn.resume) args.push('--resume', turn.resume);
		return { args: args, env: {} };
	},

	spawn(args, opts) {
		return spawnCli(BIN, args, opts);
	},

	/**
	 * Whether a tool the agent reached for is one this turn is allowed to run,
	 * read off the same allowlist buildArgs was given. Keeps denied tools out of
	 * the board's timeline, where they would only ever resolve as red failures.
	 */
	isRunnableTool(toolName, allowedTools) {
		const name = String(toolName || '');
		if (!name) return false;
		const allowed = String(allowedTools || '').split(',');
		for (let i = 0; i < allowed.length; i++) {
			const a = allowed[i].trim();
			if (!a) continue;
			if (a === name) return true;
			if (a.slice(-1) === '*' && name.indexOf(a.slice(0, -1)) === 0) return true;
		}
		return false;
	},

	/**
	 * One line of stream-json to normalized events:
	 *   { type: 'session',   id }
	 *   { type: 'text',      text }        one assistant text block
	 *   { type: 'tool-start', id, name }
	 *   { type: 'tool-end',   id, ok }
	 * Unknown lines produce nothing. The caller decides what to do with each -
	 * the chat turn streams text, the component turn ignores it, and so on.
	 */
	parseLine(line) {
		let evt;
		try { evt = JSON.parse(line); } catch (e) { return []; }
		const out = [];

		if (evt.session_id) out.push({ type: 'session', id: evt.session_id });

		// Partial stream: content_block_start names the tool as soon as the model
		// starts calling it. Without it the row only appears once the whole tool_use
		// block is written, which for the HTML tools means a long silent gap.
		if (evt.type === 'stream_event') {
			const sev = evt.event || {};
			if (sev.type === 'content_block_start' && sev.content_block
				&& sev.content_block.type === 'tool_use') {
				out.push({ type: 'tool-start', id: sev.content_block.id, name: sev.content_block.name });
			}
			return out;
		}

		if (evt.type === 'assistant') {
			const content = (evt.message && evt.message.content) || [];
			for (let i = 0; i < content.length; i++) {
				const block = content[i];
				if (block.type === 'text' && block.text) {
					out.push({ type: 'text', text: block.text });
				} else if (block.type === 'tool_use') {
					out.push({ type: 'tool-start', id: block.id, name: block.name });
				}
			}
		} else if (evt.type === 'user') {
			const ucontent = (evt.message && evt.message.content) || [];
			for (let j = 0; j < ucontent.length; j++) {
				const ublock = ucontent[j];
				if (ublock.type === 'tool_result') {
					out.push({ type: 'tool-end', id: ublock.tool_use_id, ok: !ublock.is_error });
				}
			}
		}
		return out;
	}
};
