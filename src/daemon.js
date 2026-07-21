/**
 * MockFlow Bridge - daemon.
 *
 * One long-running localhost process with two faces:
 *   POST /mcp    JSON-RPC MCP endpoint for agents (Claude Code, Cursor, ...)
 *   WS   /board  live editor tabs (pairing + tool execution), see boardHub.js
 *   GET  /status health + connected boards
 *
 * Binds 127.0.0.1 ONLY. Never expose beyond the machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const ui = require('./ui');
const catalogLoader = require('./catalog');
const BoardHub = require('./boardHub');
const McpEndpoint = require('./mcpEndpoint');

async function start(opts) {
	const loaded = await catalogLoader.load();
	const hub = new BoardHub({ log: log });
	const mcp = new McpEndpoint({
		registry: loaded.registry,
		catalogSource: loaded.source,
		hub: hub,
		log: log
	});

	// Mode B: Mida/CB "Local agent" chat turns run on the user's own headless
	// Claude Code, spawned by the agent manager.
	const AgentManager = require('./agentManager');
	const agents = new AgentManager({ log: log, workspace: opts && opts.workspace, registry: loaded.registry });
	hub.onChat = function(tab, frame, sendToTab) {
		agents.handleChat(tab, frame, sendToTab, hub);
	};
	hub.onChatCancel = function(tab) { agents.cancel(tab); };
	// Component QuickSettings AI (Generate / Modify / Convert) run on the same agent.
	hub.onCompGen = function(tab, frame, sendToTab) {
		agents.handleCompGen(tab, frame, sendToTab, hub);
	};
	hub.onCompGenCancel = function(tab) { agents.cancelCompGen(tab); };
	// plan_board continuation: the user clicked Generate Board in their tab -
	// render the chosen items on a fresh headless turn (briefs are self-contained).
	hub.onPlanGenerate = function(tab, plan) { agents.handlePlanGenerate(tab, plan, hub); };

	// Reported to the editor tab on connect so Mida can educate the user honestly
	// (only offer "brainstorm your files" when a workspace is actually set).
	hub.agentInfo = {
		hasLocalAgent: agents.detect(),
		hasWorkspace: !!agents.hasWorkspace,
		workspaceName: agents.hasWorkspace ? path.basename(agents.workspace) : null,
		port: config.PORT
	};

	const server = http.createServer(function(req, res) {
		const url = (req.url || '').split('?')[0];

		if (req.method === 'OPTIONS') {
			cors(res);
			res.writeHead(204);
			return res.end();
		}

		if (req.method === 'GET' && (url === '/' || url === '/status' || url === '/mcp')) {
			cors(res);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({
				status: 'ok',
				server: 'MockFlow Bridge',
				version: config.ENGINE_VERSION,
				catalog: loaded.source,
				tools: loaded.registry.length,
				boards: hub.listBoards()
			}));
		}

		if (req.method === 'POST' && url === '/mcp') {
			var body = '';
			req.on('data', function(c) {
				body += c;
				if (body.length > 16 * 1024 * 1024) req.destroy();
			});
			req.on('end', async function() {
				var rpc;
				try { rpc = JSON.parse(body); } catch (e) {
					return sendRpc(res, null, null, { code: -32700, message: 'Parse error' });
				}
				const id = rpc && rpc.id;
				try {
					const result = await mcp.handle(rpc && rpc.method, (rpc && rpc.params) || {});
					sendRpc(res, id, result, null);
				} catch (err) {
					sendRpc(res, id, null, { code: -32603, message: String((err && err.message) || err) });
				}
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	hub.attach(server);

	function listenOnce() {
		return new Promise(function(resolve, reject) {
			function onError(err) { server.removeListener('error', onError); reject(err); }
			server.once('error', onError);
			server.listen(config.PORT, config.HOST, function() {
				server.removeListener('error', onError);
				resolve();
			});
		});
	}

	try {
		await listenOnce();
	} catch (err) {
		if (err && err.code === 'EADDRINUSE') {
			// Port busy: if an older MockFlow Bridge is holding it, stop it and take
			// over automatically (so users never have to kill it by hand). Never
			// touch an unrelated program that happens to use the port.
			const wasOurs = await freePortIfOurs(config.PORT);
			if (!wasOurs) {
				throw new Error('Port ' + config.PORT + ' is in use by another program (not a MockFlow '
					+ 'Bridge). Free it, or run with MFBRIDGE_PORT set to a different port.');
			}
			try {
				await listenOnce();
			} catch (e2) {
				throw new Error('Port ' + config.PORT + ' is still busy just after stopping the old '
					+ 'bridge. Please run the command again.');
			}
		} else {
			throw err;
		}
	}

	writePortFile(config.PORT);

	const endpoint = 'http://' + config.HOST + ':' + config.PORT;
	const paint = ui.err;
	console.error('');
	console.error(ui.banner(config.ENGINE_VERSION, paint));
	console.error('');
	console.error(ui.infoBox([
		['MCP endpoint', endpoint + '/mcp'],
		['Board socket', 'ws://' + config.HOST + ':' + config.PORT + '/board'],
		['Catalog', loaded.source + ' (' + loaded.registry.length + ' tools)'],
		['Local agent', agents.detect()
			? paint.green('✓') + ' Claude Code found'
			: paint.yellow('✗ Claude Code not found - Mida local chat unavailable')],
		['Workspace', agents.hasWorkspace
			? ui.shortenPath(agents.workspace)
			: paint.dim('off - add --workspace <path> to let Mida read one folder')],
		// Debug tracing (auto-on against a local MockFlow): every render_* call prints
		// what the agent generated plus the conversion diagnostics. See src/debug.js.
		['Debug', config.DEBUG
			? paint.green('on') + ' - render output + diagnostics printed, dumps in '
				+ ui.shortenPath(config.DEBUG_DIR)
			: paint.dim('off - set MFBRIDGE_DEBUG=1 to trace what each render generates')]
	], paint));
	console.error('');
	console.error(ui.pairingLine(hub.pairingCode.slice(0, 3) + '-' + hub.pairingCode.slice(3),
		'enter this in the MockFlow editor when it asks', paint));
	console.error('');
	if (agents.hasWorkspace) {
		console.error(ui.noticeBox('✓ File access is ON', [
			'Mida can read: ' + paint.bold(ui.shortenPath(agents.workspace)),
			'',
			paint.dim('Files are never uploaded - Mida reads the workspace locally and only what it'),
			paint.dim('draws is sent to MockFlow. Try: "read this repo and draw its architecture".')
		], paint.green, paint));
	} else {
		console.error(ui.noticeBox('⚠ File access is OFF', [
			'Mida cannot read any files on this computer. To let it read one',
			'folder (e.g. a repo to brainstorm or diagram), restart with:',
			'',
			'  ' + paint.teal('npx mockflow-bridge --workspace <path-to-folder>'),
			'',
			paint.dim('Files are only read locally. Nothing is ever uploaded to MockFlow.')
		], paint.yellow, paint));
	}
	console.error('');
	console.error('  ' + paint.bold('Add to Claude Code:'));
	console.error('    ' + paint.teal('claude mcp add --transport http -s user mockflow ' + endpoint + '/mcp'));
	console.error('  ' + paint.dim('Or for stdio-only clients:  command: npx mockflow-bridge stdio'));
	console.error('');

	function shutdown() {
		log('Shutting down');
		hub.stop();
		server.close();
		removePortFile();
		process.exit(0);
	}
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	return { server: server, hub: hub, mcp: mcp };
}

/**
 * If a MockFlow Bridge is already listening on `port`, stop it and return true.
 * Returns false (without touching anything) if the port is held by some other
 * program - we verify identity via GET /status before killing.
 */
async function freePortIfOurs(port) {
	var isOurs = false;
	try {
		const controller = new AbortController();
		const timer = setTimeout(function() { controller.abort(); }, 1500);
		const resp = await fetch('http://127.0.0.1:' + port + '/status', { signal: controller.signal });
		clearTimeout(timer);
		const data = await resp.json();
		isOurs = !!(data && data.server === 'MockFlow Bridge');
	} catch (e) {
		// Nothing answered, or it is not our HTTP server - leave it alone.
	}
	if (!isOurs) return false;
	log('An older MockFlow Bridge is running on port ' + port + '; stopping it and taking over.');
	await killByPort(port);
	await new Promise(function(r) { setTimeout(r, 800); }); // let the OS release the port
	return true;
}

/** Kill whatever process is listening on `port` (used only after freePortIfOurs
 *  confirmed it is our own bridge). */
function killByPort(port) {
	return new Promise(function(resolve) {
		var cmd, args;
		if (process.platform === 'win32') {
			cmd = 'cmd';
			args = ['/c', 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :' + port + ' ^| findstr LISTENING\') do taskkill /F /PID %a'];
		} else {
			cmd = 'sh';
			args = ['-c', 'lsof -ti tcp:' + port + ' | xargs kill 2>/dev/null || true'];
		}
		try {
			const child = require('child_process').spawn(cmd, args, { stdio: 'ignore' });
			child.on('close', function() { resolve(); });
			child.on('error', function() { resolve(); });
		} catch (e) { resolve(); }
	});
}

function cors(res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers',
		'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
}

function sendRpc(res, id, result, error) {
	cors(res);
	res.writeHead(200, { 'Content-Type': 'application/json' });
	const msg = { jsonrpc: '2.0', id: id == null ? null : id };
	if (error) msg.error = error; else msg.result = result;
	res.end(JSON.stringify(msg));
}

function writePortFile(port) {
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.PORT_FILE, String(port));
	} catch (e) {
		log('Could not write port file:', e && e.message);
	}
}

function removePortFile() {
	try { fs.unlinkSync(config.PORT_FILE); } catch (e) {}
}

module.exports = { start: start };
