/**
 * MockFlow Bridge - daemon.
 *
 * One long-running localhost process with two faces:
 *   POST /mcp/<token>  JSON-RPC MCP endpoint for agents (Claude Code, Codex, ...)
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
const GenerationCap = require('./generationCap');

async function start(opts) {
	const loaded = await catalogLoader.load();
	const hub = new BoardHub({ log: log });
	// Basic-plan daily generation cap. Only draws targeting a basic board are
	// metered (mcpEndpoint checks hub.isTargetBasic); Pro/trial users are not.
	const genCap = new GenerationCap({ log: log });
	// The hub reports the running count to basic tabs (register snapshot + a live
	// gen-usage frame after each draw) so the editor can warn as it runs low,
	// mirroring the AI-credits balance UI.
	hub.genCap = genCap;
	const mcp = new McpEndpoint({
		registry: loaded.registry,
		catalogSource: loaded.source,
		hub: hub,
		genCap: genCap,
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
		// The model that answered the last turn. Unknown until the first turn runs
		// (and never known for an agent that does not report it, e.g. Codex).
		model: null,
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
				// Which CLI is answering right now (it can be switched while running),
				// so `mockflow-bridge status` reports the live one, not a re-resolution.
				agent: agents.agent ? agents.agent.id : null,
				agentLabel: agents.agent ? agents.agent.label : null,
				agentAvailable: agents.detect(),
				model: agents.currentModel || null,
				workspace: agents.hasWorkspace ? agents.workspace : null,
				boards: hub.listBoards()
			}));
		}

		// Live agent switch from `mockflow-bridge agent <id>`, so changing agent does
		// not mean restarting a paired bridge. Token-gated and CORS-less for the
		// same reason as /mcp: a web page must not be able to drive it.
		if (req.method === 'POST' && url === '/agent/' + mcpToken) {
			var abody = '';
			req.on('data', function(c) {
				abody += c;
				if (abody.length > 4096) req.destroy();
			});
			req.on('end', function() {
				var wanted;
				try { wanted = (JSON.parse(abody) || {}).agent; } catch (e) {}
				const target = agentRegistry.byId(wanted);
				const isInstalled = !!agentRegistry.installed().filter(function(r) { return r.id === wanted; })[0];
				res.writeHead(200, { 'Content-Type': 'application/json' });
				if (!target) {
					return res.end(JSON.stringify({ ok: false, error: 'unknown agent "' + wanted + '"' }));
				}
				if (!isInstalled) {
					return res.end(JSON.stringify({ ok: false, error: target.label + ' is not installed' }));
				}
				agents.setAgent(target);
				hub.agentInfo.agentId = target.id;
				hub.agentInfo.agentName = target.label;
				hub.agentInfo.hasLocalAgent = agents.detect();
				hub.broadcast({ t: 'agent-info', agentInfo: hub.agentInfo });
				res.end(JSON.stringify({ ok: true, agent: target.id, label: target.label }));
			});
			return;
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
				// A JSON-RPC notification (no id, e.g. notifications/initialized) must
				// get NO response body - Streamable HTTP answers it with 202. Replying
				// `{"id":null,"result":{}}` is not a valid message and strict clients
				// drop the connection over it: Codex's rmcp transport quits with
				// "did not match any variant of untagged enum JsonRpcMessage", which
				// leaves the agent with no MockFlow tools at all.
				const isNotification = !rpc || rpc.id === undefined || rpc.id === null;
				try {
					const result = await mcp.handle(rpc && rpc.method, (rpc && rpc.params) || {});
					if (isNotification) {
						res.writeHead(202);
						return res.end();
					}
					sendRpc(res, id, result, null);
				} catch (err) {
					if (isNotification) {
						res.writeHead(202);
						return res.end();
					}
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

	// Agent health for the picked agent — computed once, used by dashboard + banner.
	const agentHealth = require('./agents/health');
	const healthProblems = picked.agent
		? agentHealth.problems([agentHealth.checkOne(picked.agent)])
		: [];
	const updateCheck = require('./updateCheck');

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

	// Full-screen dashboard in a real terminal (best for non-devs); plain banner +
	// line output only when piped, in CI, or headless. In DEBUG the dashboard stays
	// on and captures the render dumps into its scrolling Activity feed.
	const useDashboard = !!(process.stdout.isTTY && process.stderr.isTTY)
		&& !process.env.MFBRIDGE_NO_UI && !(opts && opts.noUi);
	if (useDashboard) {
		updateCheck.refresh();
		require('./dashboard').start({
			hub: hub, agents: agents, registry: agentRegistry, config: config,
			endpoint: endpoint, mcpToken: mcpToken, healthProblems: healthProblems,
			onQuit: shutdown
		});
		return { server: server, hub: hub, mcp: mcp };
	}

	console.error('');
	console.error(ui.banner(config.ENGINE_VERSION, paint));
	console.error('');
	console.error(ui.infoBox([
		['MCP endpoint', endpoint + '/mcp/' + mcpToken],
		['Board socket', 'ws://' + config.HOST + ':' + config.PORT + '/board'],
		['Catalog', loaded.source + ' (' + loaded.registry.length + ' tools)'],
		['Local agent', agents.detect()
			? paint.green('✓') + ' ' + picked.agent.label + ' ' + paint.dim('(' + describeAgents(picked.choices)
				+ (picked.choices.length > 1 ? '; change: mockflow-bridge agent' : '') + ')')
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

	if (healthProblems.length) {
		const lines = [];
		healthProblems.forEach(function (p) {
			if (p.kind === 'capability') {
				if (p.helpFailed) {
					lines.push(paint.bold(p.label + ' — could not read its --help') + '; the CLI invocation may have changed.');
				}
				(p.critical || []).forEach(function (c) {
					lines.push(paint.bold(p.label + ' — turns will draw nothing') + ': ' + c.label
						+ paint.dim(' (' + c.needle + ' missing)'));
				});
				(p.degraded || []).forEach(function (d) {
					lines.push(p.label + ': ' + d.label + ' unavailable' + paint.dim(' (' + d.needle + ' missing)'));
				});
			} else if (p.kind === 'version') {
				lines.push(paint.bold(p.label + ' ' + p.installed) + ' is newer than the tested '
					+ p.tested + '.');
				lines.push(paint.dim('  Turns may misbehave; re-run test/fake-*.js, then bump testedVersion.'));
			} else {
				lines.push(paint.bold(p.label) + ' parser canary failed:');
				p.failures.forEach(function (f) { lines.push(paint.dim('  ' + f)); });
			}
		});
		console.error(ui.noticeBox('⚠ Agent check', lines, paint.yellow, paint));
		console.error('');
	}

	// "You are behind the published version" - read from a cache a previous run left.
	const updateLines = updateCheck.notice(paint);
	if (updateLines) {
		console.error(ui.noticeBox('⬆ mockflow-bridge update', updateLines, paint.teal, paint));
		console.error('');
	}
	// Fire-and-forget: schedules one HTTPS GET on the event loop (after this
	// synchronous startup finishes) to refresh the cache for the next start.
	updateCheck.refresh();

	console.error(ui.pairingLine(hub.pairingCode,
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
			'  ' + paint.teal('mockflow-bridge --workspace <path-to-folder>'),
			'',
			paint.dim('Files are only read locally. Nothing is ever uploaded to MockFlow.')
		], paint.yellow, paint));
	}
	console.error('');
	// Wiring hint for the agent that is actually in use - telling a Codex user how
	// to configure Claude Code is noise. Only for driving the CLI directly; the
	// in-editor turns the bridge runs itself need no setup. The catalog may carry
	// the line (so vendor syntax changes ship without a publish); the adapter's own
	// mcpAddHint is the fallback.
	const wiring = catalogLoader.wiringFor(loaded.registry, picked.agent, endpoint + '/mcp/' + mcpToken);
	if (wiring) {
		console.error('  ' + paint.bold(wiring.title));
		wiring.lines.forEach(function(l) { console.error('    ' + paint.teal(l)); });
		console.error('  ' + paint.dim('Only needed to use the CLI directly - in-editor chat already works.'));
		console.error('');
	}
	console.error('  ' + paint.dim('Commands:') + '  ' + paint.teal('mockflow-bridge help')
		+ paint.dim('  ·  ') + paint.teal('status')
		+ paint.dim('  ·  ') + paint.teal('agent') + paint.dim(' (switch agent)')
		+ paint.dim('  ·  ') + paint.teal('reset'));
	console.error('');

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
		throw new Error('Unknown agent "' + explicit + '". Known agents: ' + known
			+ '. Run `mockflow-bridge agent` to see which are installed.');
	}
	if (picked.reason !== 'ambiguous') return picked;

	if (!process.stdin.isTTY) {
		const first = picked.choices[0];
		log('Several agent CLIs installed and no choice saved; using ' + first.label
			+ '. Set --agent or MFBRIDGE_AGENT to pick another.');
		return { agent: first.agent, reason: 'auto', choices: picked.choices };
	}

	const chosen = await require('./agentPicker').ask(picked.choices, null);
	registry.savePreference(chosen.id);
	return { agent: chosen.agent, reason: 'asked', choices: picked.choices };
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
