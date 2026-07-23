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

	// The CLI version this adapter's flags and parser were last verified against
	// on a real board. detect() reads the installed version; agents/health.js
	// warns at startup when it is newer. Bump this after re-running test/fake-*.js.
	testedVersion: '2.1.216',

	// Flags a turn depends on, checked against `claude --help` at startup
	// (agents/health.js). Needles verified present in 2.1.216 - not guessed.
	// Critical = generation produces nothing; optional = a feature is lost.
	capabilityProbe: {
		bin: BIN,
		help: ['--help'],
		requires: [
			{ needle: '--output-format', critical: true, label: 'stream-json output (the bridge cannot read a turn without it)' },
			{ needle: '--mcp-config', critical: true, label: 'MCP wiring (without it the agent has no board tools)' },
			{ needle: '--print', critical: true, label: 'headless prompt mode (-p)' },
			{ needle: '--allowedTools', critical: false, label: 'per-turn tool allowlist' },
			{ needle: '--append-system-prompt', critical: false, label: 'persona / system prompt' },
			{ needle: '--add-dir', critical: false, label: 'attachments & workspace file reading' },
			{ needle: '--resume', critical: false, label: 'multi-turn session memory' },
			{ needle: '--include-partial-messages', critical: false, label: 'live drawing progress' }
		]
	},

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
	 * When Claude Code has no valid credentials it does not fail the turn: it
	 * answers with a short line like "Not logged in - Please run /login", which
	 * the board would otherwise show as Mida's reply. Recognise that so the
	 * orchestrator can surface a real "sign in first" message instead.
	 *
	 * Gated on a short reply so a genuine drawing answer that happens to mention
	 * a "/login" screen is never mistaken for the failure. Returns the message to
	 * show, or null when the text is a normal reply.
	 */
	authFailureHint(text) {
		const t = String(text || '').trim();
		if (!t || t.length > 200) return null;
		if (/please run\s*\/login/i.test(t) || /\bnot logged in\b/i.test(t)
			|| /\binvalid api key\b/i.test(t)) {
			return 'Claude Code is not signed in. Open a terminal, run `claude`, sign in once, '
				+ 'then start the bridge again with `mockflow-bridge`.';
		}
		return null;
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

		// The model that actually answered, so the editor can show it. The `system`
		// init event and every `assistant` event carry it; the manager keeps the
		// first it sees for the turn.
		if (evt.model) out.push({ type: 'model', id: evt.model });
		else if (evt.message && evt.message.model) out.push({ type: 'model', id: evt.message.model });

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
	},

	/**
	 * Committed fixtures for the startup canary (agents/health.js). Each line is a
	 * real stream-json shape; `expect` is the normalized events it must still
	 * produce, in order. If a parseLine edit stops honouring one of these, boot
	 * fails loudly instead of a turn drawing nothing.
	 */
	selfTest: {
		lines: [
			{ line: '{"type":"system","subtype":"init","session_id":"sess_abc","model":"claude-opus-4-8"}',
				expect: ['session', 'model'] },
			{ line: '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Hello"}]}}',
				expect: ['model', 'text'] },
			{ line: '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu_1","name":"mcp__mockflow__render_wireframelite"}]}}',
				expect: ['model', 'tool-start'] },
			{ line: '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_1","name":"mcp__mockflow__render_wireframelite"}}}',
				expect: ['tool-start'] },
			{ line: '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":false}]}}',
				expect: ['tool-end'] }
		]
	}
};
