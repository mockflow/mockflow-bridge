/**
 * Minimal MCP client over the bridge's local HTTP endpoint.
 *
 * The board render tools live on the daemon; BridgeAI reaches them exactly like
 * the CLI agents do — JSON-RPC over POST http://127.0.0.1:<PORT>/mcp/<token>.
 * Only three methods are needed: initialize, tools/list, tools/call. Requests
 * (with an id) return 200 JSON; notifications (no id) return 202 empty.
 */

const fs = require('fs');
const config = require('../config');

function endpoint() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	return 'http://127.0.0.1:' + config.PORT + '/mcp/' + token;
}

function McpClient(signal) {
	this.url = endpoint();
	this.signal = signal || null;
	this._id = 0;
}

McpClient.prototype._rpc = async function (method, params) {
	const id = ++this._id;
	const res = await fetch(this.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }),
		signal: this.signal
	});
	if (!res.ok) throw new Error('MCP ' + method + ' HTTP ' + res.status);
	const body = await res.json();
	if (body && body.error) throw new Error('MCP ' + method + ': ' + (body.error.message || 'error'));
	return body ? body.result : null;
};

McpClient.prototype._notify = async function (method, params) {
	try {
		await fetch(this.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }),
			signal: this.signal
		});
	} catch (e) { /* notifications are best-effort (202, empty) */ }
};

McpClient.prototype.initialize = async function () {
	const r = await this._rpc('initialize', {
		protocolVersion: '2025-03-26',
		capabilities: {},
		clientInfo: { name: 'bridgeai', version: config.ENGINE_VERSION }
	});
	await this._notify('notifications/initialized', {});
	return r || {};
};

McpClient.prototype.listTools = async function () {
	const r = await this._rpc('tools/list', {});
	return (r && r.tools) || [];
};

McpClient.prototype.callTool = async function (name, args) {
	const r = await this._rpc('tools/call', { name: name, arguments: args || {} });
	const content = (r && r.content) || [];
	const text = content.map(function (c) { return c && c.text ? c.text : ''; }).join('\n').trim();
	return { text: text, isError: !!(r && r.isError) };
};

module.exports = { McpClient: McpClient };
