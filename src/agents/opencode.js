/**
 * opencode adapter.
 *
 * Event names and payload fields below are taken from the installed binary's own
 * OpenAPI document (`opencode serve` then GET /doc), not from prose docs, which
 * describe `--format json` only as "raw JSON events".
 *
 * The whole per-turn setup rides ONE env var: OPENCODE_CONFIG_CONTENT carries
 * the MCP server, the persona (as an agent definition) and the tool allowlist,
 * so the bridge never writes to the user's own opencode config and two turns can
 * differ freely.
 */

const fs = require('fs');
const config = require('../config');
const { spawnCli, spawnCliSync } = require('./spawnPortable');

const BIN = 'opencode';

/** Bridge MCP endpoint, including the token the daemon minted. */
function mcpUrl() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	return 'http://127.0.0.1:' + config.PORT + '/mcp/' + token;
}

/**
 * Our allowlist is written in Claude's vocabulary (the orchestrator builds it
 * from the catalog). Translate it to opencode tool ids: MCP tools are exposed
 * as `<server>_<tool>`, built-ins have their own lowercase names. Everything
 * else is denied by the leading wildcard, so a tool we did not ask for cannot
 * run just because it exists.
 */
function toolMap(allowedTools) {
	const tools = { '*': false };
	String(allowedTools || '').split(',').forEach(function(raw) {
		const t = raw.trim();
		if (!t) return;
		if (t.indexOf('mcp__mockflow__') === 0) {
			const rest = t.slice('mcp__mockflow__'.length);
			tools['mockflow_' + rest] = true;   // rest may itself be '*'
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

	capabilities: {
		// session.next.text.delta carries incremental text, appended verbatim
		// (Claude emits whole blocks instead - see textChunks).
		streamsPartialText: true,
		textChunks: 'delta',
		// session.next.tool.input.started names the tool before it runs.
		announcesToolsEarly: true,
		restrictTools: 'per-run',
		resume: 'by-id',
		systemPrompt: 'config',
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
	 * config file. Fallback only: a catalog that carries `agentWiring.opencode`
	 * wins - see src/catalog.js.
	 */
	mcpAddHint(endpoint) {
		return {
			title: 'Add to opencode  (~/.config/opencode/opencode.json):',
			lines: [
				'"mcp": { "mockflow": { "type": "remote", "enabled": true,',
				'                       "url": "' + endpoint + '" } }'
			]
		};
	},

	buildArgs(turn) {
		// One inline config per turn: MCP server, persona, tool allowlist. Nothing
		// is written to the user's own config file.
		const cfg = {
			mcp: {
				mockflow: { type: 'remote', url: mcpUrl(), enabled: true }
			},
			agent: {
				mfbridge: {
					description: 'MockFlow Bridge turn',
					mode: 'primary',
					prompt: turn.systemPrompt || '',
					tools: toolMap(turn.allowedTools),
					// Nothing on this path should touch the user's files or shell;
					// reading is granted through the tool map above when asked for.
					permission: { edit: 'deny', bash: 'deny' }
				}
			}
		};

		const args = ['run', '--format', 'json', '--agent', 'mfbridge'];
		if (turn.resume) args.push('-s', turn.resume);
		// Prompt last: `run` takes it as a positional.
		args.push(turn.prompt);

		return {
			args: args,
			env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) }
		};
	},

	spawn(args, opts) {
		return spawnCli(BIN, args, opts);
	},

	/**
	 * Tool ids arrive in opencode's vocabulary, so the allowlist is translated the
	 * same way buildArgs translates it, and the answer stays consistent with what
	 * the agent was actually permitted to run.
	 */
	isRunnableTool(toolName, allowedTools) {
		const name = String(toolName || '');
		if (!name) return false;
		const map = toolMap(allowedTools);
		if (map[name] === true) return true;
		for (const key in map) {
			if (map[key] !== true) continue;
			if (key.slice(-1) === '*' && name.indexOf(key.slice(0, -1)) === 0) return true;
		}
		return false;
	},

	/**
	 * One JSON line to normalized events. Payload fields live under `properties`
	 * in the documented schema; read them defensively so a flatter shape also
	 * works.
	 */
	parseLine(line) {
		let evt;
		try { evt = JSON.parse(line); } catch (e) { return []; }
		const type = evt && evt.type;
		if (!type) return [];
		const p = (evt.properties && typeof evt.properties === 'object') ? evt.properties : evt;
		const out = [];

		if (p.sessionID) out.push({ type: 'session', id: p.sessionID });

		switch (type) {
			case 'session.next.text.delta':
				if (p.delta) out.push({ type: 'text', text: p.delta });
				break;
			case 'session.next.tool.input.started':
				if (p.callID) out.push({ type: 'tool-start', id: p.callID, name: p.name });
				break;
			case 'session.next.tool.called':
				if (p.callID) out.push({ type: 'tool-start', id: p.callID, name: p.tool || p.name });
				break;
			case 'session.next.tool.success':
				if (p.callID) out.push({ type: 'tool-end', id: p.callID, ok: true });
				break;
			case 'session.next.tool.failed':
				if (p.callID) out.push({ type: 'tool-end', id: p.callID, ok: false });
				break;
		}
		return out;
	}
};
