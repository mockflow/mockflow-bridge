/**
 * BridgeAI OpenAI-compatible streaming client.
 *
 * One client per (provider, key, model). Speaks the OpenAI Chat Completions
 * protocol, so it is identical for OpenRouter, Azure and Bedrock — the provider
 * preset supplies the base URL and auth-header style (providers/).
 *
 * chat() streams: text deltas and tool-call announcements are delivered through
 * handlers as they arrive; the assembled assistant message (content + tool_calls
 * + finish_reason) is returned when the turn completes.
 */

const providers = require('./providers');

function Client(preset, key, baseURL, model, signal) {
	this.preset = preset;
	this.key = key;
	this.baseURL = String(baseURL || '').replace(/\/+$/, '');
	this.model = model;
	this.signal = signal || null;
}

Client.prototype._headers = function () {
	return Object.assign(
		{ 'content-type': 'application/json', accept: 'text/event-stream' },
		providers.authHeaders(this.preset, this.key),
		this.preset.extraHeaders || {}
	);
};

/**
 * Run one streaming chat completion.
 *   body     : { messages, tools?, tool_choice? } (model + stream added here)
 *   handlers : { onText(delta), onToolStart({index,id,name}) }
 * Returns { content, toolCalls:[{id,name,arguments}], finishReason, model }.
 */
Client.prototype.chat = async function (body, handlers) {
	handlers = handlers || {};
	const req = Object.assign({ model: this.model, stream: true }, body);

	const res = await fetch(this.baseURL + '/chat/completions', {
		method: 'POST',
		headers: this._headers(),
		body: JSON.stringify(req),
		signal: this.signal
	});
	if (!res.ok || !res.body) {
		const text = await safeText(res);
		throw new Error('chat/completions ' + res.status + ': ' + text.slice(0, 500));
	}

	const state = { content: '', tools: {}, order: [], finishReason: null, model: this.model, announced: {} };
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let done = false;

	while (!done) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buf += decoder.decode(chunk.value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line || line.charAt(0) === ':') continue;      // comment / heartbeat
			if (line.indexOf('data:') !== 0) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') { done = true; break; }
			let evt;
			try { evt = JSON.parse(data); } catch (e) { continue; }
			applyChunk(state, evt, handlers);
		}
	}

	const toolCalls = state.order.map(function (i) { return state.tools[i]; });
	return { content: state.content, toolCalls: toolCalls, finishReason: state.finishReason, model: state.model };
};

function applyChunk(state, evt, handlers) {
	if (evt.model) state.model = evt.model;
	const choice = (evt.choices && evt.choices[0]) || {};
	const delta = choice.delta || {};

	if (typeof delta.content === 'string' && delta.content) {
		state.content += delta.content;
		if (handlers.onText) handlers.onText(delta.content);
	}

	const tcs = delta.tool_calls || [];
	for (let k = 0; k < tcs.length; k++) {
		const tc = tcs[k];
		const idx = (typeof tc.index === 'number') ? tc.index : k;
		if (!state.tools[idx]) { state.tools[idx] = { id: '', name: '', arguments: '' }; state.order.push(idx); }
		const slot = state.tools[idx];
		if (tc.id) slot.id = tc.id;
		if (tc.function) {
			if (tc.function.name) slot.name += tc.function.name;
			if (typeof tc.function.arguments === 'string') slot.arguments += tc.function.arguments;
		}
		// Announce as soon as we have an id + a name (announcesToolsEarly).
		if (!state.announced[idx] && slot.id && slot.name && handlers.onToolStart) {
			state.announced[idx] = true;
			handlers.onToolStart({ index: idx, id: slot.id, name: slot.name });
		}
	}

	if (choice.finish_reason) state.finishReason = choice.finish_reason;
}

async function safeText(res) { try { return await res.text(); } catch (e) { return ''; } }

module.exports = { Client: Client };
