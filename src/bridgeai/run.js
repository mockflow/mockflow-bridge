/**
 * BridgeAI runner — the `mockflow-bridge bridgeai-run` subcommand.
 *
 * One turn: read the turn spec (BRIDGEAI_TURN env), connect to the bridge's MCP
 * endpoint for the board tools, run the OpenAI chat-completions tool-loop against
 * the configured provider, and emit the normalized JSONL event contract on stdout
 * for the agent manager's parseLine: session / model / text / tool-start / tool-end.
 *
 * Full Claude-Code parity: streaming text, live tool announcements, JSON tool
 * calls executed via MCP, image + text attachments, per-provider system prompt,
 * and multi-turn resume (session.js).
 */

const providers = require('./providers');
const models = require('./models');
const session = require('./session');
const attachments = require('./attachments');
const toolmap = require('./tools');
const client = require('./client');
const mcpmod = require('./mcp');

const MAX_STEPS = 24;   // tool-call rounds before we stop (runaway guard)

function emit(evt) { process.stdout.write(JSON.stringify(evt) + '\n'); }
function fail(msg) { process.stderr.write(String(msg) + '\n'); }

async function main() {
	let turn;
	try { turn = JSON.parse(process.env.BRIDGEAI_TURN || '{}'); }
	catch (e) { fail('BridgeAI: bad turn spec'); process.exitCode = 1; return; }

	const preset = providers.get(turn.provider);
	if (!preset) { fail('BridgeAI: unknown provider "' + turn.provider + '"'); process.exitCode = 1; return; }
	const key = process.env[preset.keyEnv];
	if (!key) { fail('BridgeAI: ' + preset.keyEnv + ' not set'); process.exitCode = 1; return; }
	const resolved = preset.resolveBaseURL(process.env);
	if (!resolved.url) { fail('BridgeAI: ' + (resolved.missing || 'base URL') + ' not set'); process.exitCode = 1; return; }
	if (!turn.model) { fail('BridgeAI: no model selected — run `mockflow-bridge model`'); process.exitCode = 1; return; }

	const ac = new AbortController();
	process.on('SIGTERM', function () { ac.abort(); });
	process.on('SIGINT', function () { ac.abort(); });

	const mcp = new mcpmod.McpClient(ac.signal);
	const llm = new client.Client(preset, key, resolved.url, turn.model, ac.signal);

	// Session id up front, so the manager can hand it back as `resume` next turn.
	const sid = turn.resume || session.newId();
	emit({ type: 'session', id: sid });
	emit({ type: 'model', id: turn.model });

	try {
		const init = await mcp.initialize();
		const mcpTools = await mcp.listTools();
		const tools = toolmap.toOpenAITools(mcpTools, turn.allowedTools, turn.mockflowTools);

		// System = the manager's persona + the MCP server's own tool-usage instructions
		// (the render_* rules Claude Code would otherwise absorb automatically).
		const sys = [turn.systemPrompt || '', (init && init.instructions) || ''].filter(Boolean).join('\n\n');

		const messages = session.load(turn.resume);
		if (!messages.length && sys) messages.push({ role: 'system', content: sys });

		const parts = attachments.toContentParts(turn.attachments);
		if (parts.length) {
			messages.push({ role: 'user', content: [{ type: 'text', text: turn.prompt || '' }].concat(parts) });
		} else {
			messages.push({ role: 'user', content: turn.prompt || '' });
		}

		for (let step = 0; step < MAX_STEPS; step++) {
			const body = tools.length ? { messages: messages, tools: tools } : { messages: messages };
			const res = await llm.chat(body, {
				onText: function (t) { emit({ type: 'text', text: t }); },
				onToolStart: function (tc) { emit({ type: 'tool-start', id: tc.id, name: tc.name }); }
			});

			// Record the assistant turn verbatim (content + any tool calls).
			const assistant = { role: 'assistant', content: res.content || '' };
			if (res.toolCalls.length) {
				assistant.tool_calls = res.toolCalls.map(function (tc) {
					return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '{}' } };
				});
			}
			messages.push(assistant);

			if (!res.toolCalls.length) break;   // no tools -> turn complete

			for (let j = 0; j < res.toolCalls.length; j++) {
				const tc = res.toolCalls[j];
				let args = {};
				try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch (e) { args = {}; }
				let result;
				try { result = await mcp.callTool(tc.name, args); }
				catch (e) { result = { text: 'Tool error: ' + (e && e.message), isError: true }; }
				emit({ type: 'tool-end', id: tc.id, ok: !result.isError });
				messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text || '' });
			}
		}

		session.save(sid, messages);
	} catch (e) {
		if (ac.signal.aborted) return;                 // cancelled — the manager killed us
		fail('BridgeAI turn failed: ' + (e && e.message));
		emit({ type: 'text', text: 'Sorry — the model request failed: ' + (e && e.message) });
		process.exitCode = 1;
	}
}

module.exports = { main: main };
