/**
 * MockFlow Bridge - daemon.
 *
 * One long-running localhost process with two faces:
 *   POST /mcp/<token>  JSON-RPC MCP endpoint for agents (Claude Code, Cursor, ...)
 *                     token-gated: the endpoint has no other auth and browsers
 *                     can reach localhost, so the secret is the door
 *   WS   /board  live editor tabs (pairing + tool execution), see boardHub.js
 *   GET  /status health + connected boards
 *
 * Binds 127.0.0.1 ONLY. Never expose beyond the machine.
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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
	// Which CLI runs local turns. Resolved before anything starts so the startup
	// box can report it, and so an ambiguous setup is settled by the user once
	// rather than guessed on every turn.
	const agentRegistry = require('./agents');
	const picked = await resolveAgent(agentRegistry, opts && opts.agent);
	const agents = new AgentManager({
		log: log,
		workspace: opts && opts.workspace,
		registry: loaded.registry,
		agent: picked.agent
	});
	hub.onChat = function(tab, frame, sendToTab) {
		agents.handleChat(tab, frame, sendToTab, hub);
	};
	hub.onChatCancel = function(tab) { agents.cancel(tab); };
	// Attachments are session-scoped: they live on disk while the board tab is
	// open (so follow-up questions about the same file work) and go when it closes.
	hub.onTabGone = function(tab) { agents.clearAttachments(tab.projectid || tab.id); };
	// Component QuickSettings AI (Generate / Modify / Convert) run on the same agent.
	hub.onCompGen = function(tab, frame, sendToTab) {
		agents.handleCompGen(tab, frame, sendToTab, hub);
	};
	hub.onCompGenCancel = function(tab) { agents.cancelCompGen(tab); };
	// plan_board continuation: the user clicked Generate Board in their tab -
	// render the chosen items on a fresh headless turn (briefs are self-contained).
	hub.onPlanGenerate = function(tab, plan, sendToTab) { agents.handlePlanGenerate(tab, plan, hub, sendToTab); };
	hub.onPlanCancel = function(tab) { agents.cancelPlanGenerate(tab); };

	// Reported to the editor tab on connect so Mida can educate the user honestly
	// (only offer "brainstorm your files" when a workspace is actually set).
	hub.agentInfo = {
		hasLocalAgent: agents.detect(),
		// Which agent is answering, so the editor can say so instead of assuming.
		agentId: picked.agent ? picked.agent.id : null,
		agentName: picked.agent ? picked.agent.label : null,
		agents: picked.choices.map(function(c) { return { id: c.id, label: c.label }; }),
		hasWorkspace: !!agents.hasWorkspace,
		workspaceName: agents.hasWorkspace ? path.basename(agents.workspace) : null,
		port: config.PORT,
		// Dev setup (catalog points at a local MockFlow, or MFBRIDGE_DEBUG=1). The
		// tab mirrors it to turn on its own console tracing, so bridge-side and
		// browser-side logs are on together without anyone setting a flag by hand.
		debug: config.DEBUG
	};

	// Secret path segment for the MCP endpoint. Local HTTP has no other
	// authentication, and browsers can POST cross-origin to localhost, so without
	// this any page the user visits could drive the board tools and read their
	// connected sources through them. Persisted so the agent's saved MCP config
	// keeps working across restarts.
	const mcpToken = loadOrCreateMcpToken();

	const server = http.createServer(function(req, res) {
		const url = (req.url || '').split('?')[0];

		if (req.method === 'OPTIONS') {
			// Preflight is answered for the status route only. /mcp is not a browser
			// endpoint and must not be reachable cross-origin.
			if (url === '/' || url === '/status') {
				cors(res);
				res.writeHead(204);
				return res.end();
			}
			res.writeHead(404);
			return res.end();
		}

		if (req.method === 'GET' && (url === '/' || url === '/status')) {
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

		// MCP clients are local processes, so this route deliberately sends NO CORS
		// headers: a browser must not be able to read its responses even if it
		// somehow learns the token.
		if (req.method === 'POST' && url === '/mcp/' + mcpToken) {
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
		['MCP endpoint', endpoint + '/mcp/' + mcpToken],
		['Board socket', 'ws://' + config.HOST + ':' + config.PORT + '/board'],
		['Catalog', loaded.source + ' (' + loaded.registry.length + ' tools)'],
		['Local agent', agents.detect()
			? paint.green('✓') + ' ' + picked.agent.label + ' (' + describeAgents(picked.choices) + ')'
			: paint.yellow('✗ no supported agent CLI found - Mida local chat unavailable')],
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
	console.error('    ' + paint.teal('claude mcp add --transport http -s user mockflow ' + endpoint + '/mcp/' + mcpToken));
	console.error('  ' + paint.dim('Or for stdio-only clients:  command: npx mockflow-bridge stdio'));
	console.error('');

	function shutdown() {
		log('Shutting down');
		agents.clearAllAttachments();
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

/**
 * Decide which local agent CLI to run turns on.
 *
 * An explicit choice (flag or env) wins, then a previously saved one, then the
 * only installed CLI. Only a genuinely ambiguous setup - several installed and
 * nothing chosen yet - asks, and the answer is remembered. A non-interactive
 * start never blocks: it takes the first installed agent and says so.
 */
async function resolveAgent(registry, explicit) {
	const picked = registry.resolve(explicit);

	if (picked.reason === 'unknown-agent') {
		const known = registry.AGENTS.map(function(a) { return a.id; }).join(', ');
		throw new Error('Unknown agent "' + explicit + '". Known agents: ' + known + '.');
	}
	if (picked.reason !== 'ambiguous') return picked;

	if (!process.stdin.isTTY) {
		const first = picked.choices[0];
		log('Several agent CLIs installed and no choice saved; using ' + first.label
			+ '. Set --agent or MFBRIDGE_AGENT to pick another.');
		return { agent: first.agent, reason: 'auto', choices: picked.choices };
	}

	const chosen = await askWhichAgent(picked.choices);
	registry.savePreference(chosen.id);
	return { agent: chosen.agent, reason: 'asked', choices: picked.choices };
}

/** One-time terminal picker. Any invalid answer falls through to the first. */
function askWhichAgent(choices) {
	const paint = ui.err;
	console.error('');
	console.error(paint.bold('Which agent should MockFlow run local turns on?'));
	choices.forEach(function(c, i) {
		console.error('  ' + paint.teal(String(i + 1)) + '. ' + c.label + (c.version ? paint.dim(' ' + c.version) : ''));
	});
	console.error(paint.dim('  (remembered for next time - change it with --agent)'));
	return new Promise(function(resolve) {
		const readline = require('readline');
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		rl.question('  Choice [1]: ', function(answer) {
			rl.close();
			const idx = parseInt(String(answer).trim(), 10) - 1;
			resolve(choices[idx] || choices[0]);
		});
	});
}

function describeAgents(choices) {
	if (!choices.length) return 'none installed';
	if (choices.length === 1) return 'the only one installed';
	return choices.map(function(c) { return c.label; }).join(', ') + ' installed';
}

/** Read the persisted MCP token, creating one on first run. */
function loadOrCreateMcpToken() {
	try {
		const existing = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim();
		if (existing) return existing;
	} catch (e) {}
	const token = crypto.randomBytes(24).toString('hex');
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.MCP_TOKEN_FILE, token, { mode: 0o600 });
	} catch (e) {}
	return token;
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
