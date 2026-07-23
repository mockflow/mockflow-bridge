/**
 * BridgeAI adapter — one agent, many OpenAI-compatible providers (providers/).
 *
 * Unlike the CLI adapters, BridgeAI has no external binary: it spawns our own
 * `bridgeai-run` subcommand, which runs the OpenAI chat-completions tool-loop
 * against the configured provider and emits the normalized JSONL event contract.
 *
 * detect() is gated on a CONFIGURED provider (a key is set), so an un-set-up
 * BridgeAI never enters agent selection — the CLI agents' auto-select stays
 * untouched. Registered LAST in src/agents/index.js for the same reason.
 */

const path = require('path');
const providers = require('./providers');
const models = require('./models');
const toolmap = require('./tools');

const BIN = path.join(__dirname, '..', '..', 'bin', 'mockflow-bridge.js');

module.exports = {
	id: 'bridgeai',
	label: 'BridgeAI',

	capabilities: {
		streamsPartialText: true,   // SSE text deltas
		textChunks: 'delta',        // token-level, append verbatim
		announcesToolsEarly: true,  // tool_call id+name announced mid-stream
		restrictTools: 'per-run',   // only allowed tools are put in `tools`
		resume: 'by-id',            // transcript kept on disk per session id
		systemPrompt: 'config',     // system message in messages[]
		extraDirs: false            // attachments read + inlined directly
	},

	/** Available when at least one provider has its key set (gated on config). */
	detect: function () {
		const p = providers.active(process.env);
		if (!p) return { available: false, version: '' };
		const m = models.resolveModel(p, { env: process.env });
		return { available: true, version: p.label + (m.model ? ' · ' + m.model : ' · (no model set)') };
	},

	installHint: function () {
		return 'BridgeAI needs an OpenAI-compatible provider key. Set one of: '
			+ providers.all().map(function (p) { return p.keyEnv; }).join(', ')
			+ ', then pick a model with `mockflow-bridge bridgeai model`.';
	},

	/** One turn -> the runner, carried as a single env blob. env merges over process.env. */
	buildArgs: function (turn) {
		const p = providers.active(process.env);
		const model = p ? models.resolveModel(p, { env: process.env }).model : null;
		const spec = {
			provider: p ? p.id : null,
			model: model,
			prompt: turn.prompt,
			systemPrompt: turn.systemPrompt,
			allowedTools: turn.allowedTools,
			mockflowTools: turn.mockflowTools,
			attachments: turn.attachments || [],
			resume: turn.resume || null
		};
		return { args: [], env: { BRIDGEAI_TURN: JSON.stringify(spec) } };
	},

	spawn: function (args, opts) {
		return require('child_process').spawn(
			process.execPath, [BIN, 'bridgeai-run'].concat(args || []), opts);
	},

	isRunnableTool: function (name, allowedTools, mockflowTools) {
		return toolmap.isAllowed(name, allowedTools, mockflowTools);
	},

	/** The runner already emits normalized events; parseLine is a pass-through. */
	parseLine: function (line) {
		try { const e = JSON.parse(line); return (e && e.type) ? [e] : []; }
		catch (e) { return []; }
	},

	// Committed fixtures for the startup canary (agents/health.js): the runner
	// emits exactly these shapes, so this locks the contract our own code depends on.
	selfTest: {
		lines: [
			{ line: '{"type":"session","id":"bai_1"}', expect: ['session'] },
			{ line: '{"type":"model","id":"anthropic/claude-sonnet-5"}', expect: ['model'] },
			{ line: '{"type":"text","text":"hi"}', expect: ['text'] },
			{ line: '{"type":"tool-start","id":"call_1","name":"render_flowchart"}', expect: ['tool-start'] },
			{ line: '{"type":"tool-end","id":"call_1","ok":true}', expect: ['tool-end'] }
		]
	}
};
