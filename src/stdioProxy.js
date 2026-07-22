/**
 * MockFlow Bridge - stdio shim.
 *
 * Some MCP clients only speak stdio. This shim reads newline-delimited
 * JSON-RPC from stdin and proxies each message to the running daemon's
 * POST /mcp endpoint, writing responses to stdout. The daemon must already be
 * running (npx mockflow-bridge) - the shim does not own the board socket, it
 * is deliberately a dumb pipe so every client shares one daemon and one set
 * of connected boards.
 */

const fs = require('fs');
const readline = require('readline');
const config = require('./config');

function discoverPort() {
	if (process.env.MFBRIDGE_PORT) return parseInt(process.env.MFBRIDGE_PORT, 10);
	try {
		return parseInt(fs.readFileSync(config.PORT_FILE, 'utf8').trim(), 10);
	} catch (e) {
		return config.PORT;
	}
}

/** The daemon's MCP token, written to ~/.mockflow on its first run. Both live on
 *  this machine under the same user, so reading the file is the whole handshake. */
function discoverToken() {
	if (process.env.MFBRIDGE_MCP_TOKEN) return process.env.MFBRIDGE_MCP_TOKEN.trim();
	try {
		return fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim();
	} catch (e) {
		return '';
	}
}

function start() {
	const port = discoverPort();
	const token = discoverToken();
	const endpoint = 'http://127.0.0.1:' + port + '/mcp/' + token;

	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	var inFlight = 0;
	var stdinClosed = false;

	function maybeExit() {
		if (stdinClosed && inFlight === 0) process.exit(0);
	}

	rl.on('line', async function(line) {
		line = line.trim();
		if (!line) return;

		var msg;
		try { msg = JSON.parse(line); } catch (e) { return; }
		const isNotification = msg.id === undefined || msg.id === null;

		inFlight++;
		try {
			const resp = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: line
			});
			const text = await resp.text();
			if (!isNotification) process.stdout.write(text.trim() + '\n');
		} catch (err) {
			if (!isNotification) {
				process.stdout.write(JSON.stringify({
					jsonrpc: '2.0',
					id: msg.id,
					error: {
						code: -32603,
						message: 'MockFlow Bridge daemon is not running. Start it in a terminal with: npx mockflow-bridge'
					}
				}) + '\n');
			}
		} finally {
			inFlight--;
			maybeExit();
		}
	});

	rl.on('close', function() {
		stdinClosed = true;
		maybeExit();
	});
}

module.exports = { start: start };
