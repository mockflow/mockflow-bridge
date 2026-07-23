/**
 * MockFlow Bridge - command line surface.
 *
 * Everything except `start` (which lives in daemon.js) is implemented here:
 * help, status, agent selection and reset. Kept out of bin/ so the executable
 * stays a thin dispatcher.
 */

const fs = require('fs');
const config = require('./config');
const ui = require('./ui');
const registry = require('./agents');
const picker = require('./agentPicker');

const paint = ui.out;

/* ------------------------------------------------------------------ help - */

function help() {
	console.log(paint.bold('MockFlow Bridge') + ' ' + paint.dim('v' + config.ENGINE_VERSION));
	console.log('');
	console.log(paint.bold('Commands:'));
	line('mockflow-bridge', 'start the bridge daemon (leave it running)');
	line('mockflow-bridge status', 'is the daemon running, which boards are connected');
	line('mockflow-bridge agent', 'show / change which local agent CLI answers');
	line('mockflow-bridge reset', 'clear saved bridge state and start clean');
	line('mockflow-bridge stdio', 'stdio MCP shim for clients that cannot use HTTP');
	line('mockflow-bridge help', 'this help  (also -h, --help)');
	console.log('');
	console.log(paint.bold('Start options:'));
	line('--workspace <path>', 'let the agent read one folder');
	line('--agent <id>', 'run this start on a specific agent CLI');
	console.log('');
	console.log(paint.bold('Agent commands:'));
	line('mockflow-bridge agent', 'list installed agents and which one is in use');
	line('mockflow-bridge agent <id>', 'switch to that agent and remember it');
	line('mockflow-bridge agent pick', 'choose from a list in the terminal');
	line('mockflow-bridge agent clear', 'forget the saved choice (ask again next start)');
	console.log('');
	console.log(paint.bold('BridgeAI commands:') + paint.dim('  (the built-in OpenAI-compatible agent)'));
	line('mockflow-bridge bridgeai', 'show configured providers, active provider + model');
	line('mockflow-bridge bridgeai provider [id]', 'pick / set the provider (OpenRouter, Azure, Bedrock)');
	line('mockflow-bridge bridgeai model [id]', 'pick / set the model for the active provider');
	console.log('');
	console.log(paint.bold('Reset commands:'));
	line('mockflow-bridge reset', 'forget agent choice, attachments, catalog cache, debug dumps');
	line('mockflow-bridge reset --all', 'the above plus MCP token and paired boards');
	line('mockflow-bridge reset --yes', 'skip the confirmation prompt');
	console.log('');
	console.log(paint.bold('Environment:'));
	line('MFBRIDGE_PORT', 'port (default ' + config.PORT + ')');
	line('MFBRIDGE_AGENT', 'local agent CLI to run turns on (same as --agent)');
	line('MFBRIDGE_CATALOG_URL', 'catalog endpoint override');
	line('MFBRIDGE_ALLOWED_ORIGINS', 'extra comma-separated WS origins');
	line('MFBRIDGE_DEBUG=1', 'trace what each render generates');
	line('MFBRIDGE_DEV=1', 'dev mode (allow any WS origin, e.g. file:// test pages)');
	console.log('');
	console.log('  ' + paint.dim('Saved state lives in ' + ui.shortenPath(config.HOME_DIR)));
}

function line(left, right) {
	console.log('  ' + paint.teal(pad(left, 28)) + ' ' + right);
}

function pad(s, w) {
	return s.length >= w ? s : s + new Array(w - s.length + 1).join(' ');
}

/* ---------------------------------------------------------------- status - */

async function status() {
	const endpoint = 'http://127.0.0.1:' + config.PORT + '/status';
	var data;
	try {
		const resp = await fetch(endpoint);
		data = await resp.json();
	} catch (e) {
		console.log(paint.yellow('●') + ' ' + paint.bold('MockFlow Bridge') + ' is NOT running. Start it with: '
			+ paint.teal('npx @mockflow/mockflow-bridge'));
		console.log('  ' + paint.dim('all commands') + ' : ' + paint.teal('mockflow-bridge help'));
		process.exitCode = 1;
		return;
	}
	console.log(paint.green('●') + ' ' + paint.bold('MockFlow Bridge') + ' is running on port ' + config.PORT);
	console.log('  ' + paint.dim('version') + ' : ' + data.version);
	console.log('  ' + paint.dim('catalog') + ' : ' + data.catalog + ' (' + data.tools + ' tools)');
	const active = data.agentLabel || (currentAgent() || {}).label;
	console.log('  ' + paint.dim('agent') + '   : '
		+ (active ? active + (data.agentAvailable === false ? paint.yellow(' (not installed)') : '')
			: paint.yellow('none installed'))
		+ (data.model ? paint.dim(' · ' + data.model) : '')
		+ paint.dim('  (change: mockflow-bridge agent <id>)'));
	console.log('  ' + paint.dim('files') + '   : ' + (data.workspace
		? ui.shortenPath(data.workspace)
		: paint.dim('off - restart with --workspace <path>')));
	if (data.boards && data.boards.length) {
		console.log('  ' + paint.dim('boards') + '  :');
		data.boards.forEach(function(b) {
			console.log('    ' + paint.green('✓') + ' "' + (b.title || b.projectid) + '"'
				+ (b.focused ? paint.teal(' (focused)') : ''));
		});
	} else {
		console.log('  ' + paint.dim('boards') + '  : none connected - open a board and switch on "Connect local agent"');
	}
	console.log('  ' + paint.dim('help') + '    : ' + paint.teal('mockflow-bridge help'));
}

/* ----------------------------------------------------------------- agent - */

/**
 * `agent` (list) | `agent <id>` (switch) | `agent pick` | `agent clear`.
 *
 * A switch is written to the same saved-preference file the daemon reads, so a
 * running bridge picks it up on its next start - which is why every path that
 * changes something says whether a restart is needed.
 */
async function agent(argv) {
	const sub = (argv[0] || '').toLowerCase();
	const all = registry.detectAll();
	const found = all.filter(function(r) { return r.available; });
	const saved = registry.loadPreference();

	if (!sub || sub === 'list' || sub === 'ls') return listAgents(all, saved);

	if (sub === 'clear' || sub === 'reset' || sub === 'forget') {
		registry.savePreference('');
		try { fs.unlinkSync(config.AGENT_FILE); } catch (e) {}
		console.log(paint.green('✓') + ' Saved agent choice cleared.');
		console.log('  ' + paint.dim(found.length > 1
			? 'The next start will ask which agent to use.'
			: 'The next start will use whichever agent is installed.'));
		return;
	}

	if (sub === 'pick' || sub === 'choose' || sub === 'select') {
		if (!found.length) return noAgents(all);
		if (!process.stdin.isTTY) {
			console.error('No terminal to ask in. Use: mockflow-bridge agent <id>');
			process.exitCode = 1;
			return;
		}
		const chosen = await picker.ask(found, saved || (found[0] && found[0].id));
		registry.savePreference(chosen.id);
		await announceSwitch(chosen);
		return;
	}

	// `agent <id>`
	const wanted = registry.byId(sub);
	if (!wanted) {
		console.error(paint.yellow('Unknown agent "' + argv[0] + '".') + ' Known agents: '
			+ registry.AGENTS.map(function(a) { return a.id; }).join(', ') + '.');
		console.error('Run ' + paint.teal('mockflow-bridge agent') + ' to see which are installed.');
		process.exitCode = 1;
		return;
	}
	const row = all.filter(function(r) { return r.id === wanted.id; })[0];
	if (!row.available) {
		const hint = wanted.installHint && wanted.installHint();
		console.error(paint.yellow('✗') + ' ' + (hint || row.label + ' is not installed on this machine.'));
		process.exitCode = 1;
		return;
	}
	registry.savePreference(wanted.id);
	await announceSwitch(row);
}

function listAgents(all, saved) {
	const found = all.filter(function(r) { return r.available; });
	if (!found.length) return noAgents(all);
	const active = currentAgent();
	console.log(paint.bold('Local agents') + paint.dim('  (the CLI that answers Mida chat and component AI)'));
	console.log('');
	all.forEach(function(r) {
		const inUse = active && r.id === active.id;
		const mark = r.available ? (inUse ? paint.green('●') : paint.dim('○')) : paint.dim('·');
		console.log('  ' + mark + ' ' + pad(r.id, 12) + ' ' + pad(r.label, 22)
			+ (r.available
				? paint.dim(r.version || 'installed') + (inUse ? paint.green('   in use') : '')
				: paint.dim('not installed')));
	});
	console.log('');
	if (process.env.MFBRIDGE_AGENT) {
		console.log('  ' + paint.dim('MFBRIDGE_AGENT=' + process.env.MFBRIDGE_AGENT
			+ ' is set - it overrides the saved choice.'));
	} else if (saved) {
		console.log('  ' + paint.dim('Saved choice: ' + saved));
	} else {
		console.log('  ' + paint.dim('No saved choice yet'
			+ (found.length > 1 ? ' - the next start will ask.' : '.')));
	}
	console.log('  ' + paint.dim('Change it:') + ' ' + paint.teal('mockflow-bridge agent <id>')
		+ paint.dim('  or  ') + paint.teal('mockflow-bridge agent pick'));
	console.log('  ' + paint.dim('Just for one run:') + ' ' + paint.teal('mockflow-bridge --agent <id>'));
}

function noAgents(all) {
	console.log(paint.yellow('✗') + ' No supported agent CLI found - in-editor chat (Mida) is unavailable.');
	console.log('  ' + paint.dim('The bridge still works for external MCP clients.'));
	console.log('');
	console.log('  ' + paint.bold('Install one of:'));
	all.forEach(function(r) {
		const hint = r.agent.installHint && r.agent.installHint();
		console.log('    ' + pad(r.label, 22) + paint.dim(hint || ''));
	});
}

/** The agent that would answer right now, resolving flag/env, saved, only-one. */
function currentAgent() {
	const picked = registry.resolve(process.env.MFBRIDGE_AGENT || '');
	if (picked.agent) return picked.agent;
	// Ambiguous (several installed, nothing saved): the daemon would ask, and
	// without an answer the first installed one wins.
	return picked.choices.length ? picked.choices[0].agent : null;
}

async function announceSwitch(row) {
	console.log(paint.green('✓') + ' Local agent set to ' + paint.bold(row.label)
		+ (row.version ? paint.dim(' ' + row.version) : '') + '.');
	// A bridge that is already running would otherwise keep answering on the old
	// CLI until restarted, which is exactly the surprise this avoids.
	const live = await switchRunningBridge(row.id);
	if (live === 'ok') {
		console.log('  ' + paint.green('The running bridge switched over too') + paint.dim(' - no restart,'
			+ ' no re-pairing. Open chats start a fresh session.'));
	} else if (live === 'not-running') {
		console.log('  ' + paint.dim('Takes effect when you start the bridge.'));
	} else {
		console.log('  ' + paint.yellow('The running bridge could not be switched') + paint.dim(' (' + live
			+ ') - restart it to pick this up.'));
	}
	if (process.env.MFBRIDGE_AGENT && process.env.MFBRIDGE_AGENT !== row.id) {
		console.log('  ' + paint.yellow('⚠') + ' MFBRIDGE_AGENT=' + process.env.MFBRIDGE_AGENT
			+ ' is set and overrides this on the next start.');
	}
}

/**
 * Ask a running bridge to swap agents in place. Returns 'ok', 'not-running',
 * or a short reason. The route is token-gated (the token file is readable only
 * by this user), so a web page cannot flip the user's agent.
 */
async function switchRunningBridge(id) {
	var token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	if (!token) return 'not-running';
	try {
		const controller = new AbortController();
		const timer = setTimeout(function() { controller.abort(); }, 2000);
		const resp = await fetch('http://127.0.0.1:' + config.PORT + '/agent/' + token, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent: id }),
			signal: controller.signal
		});
		clearTimeout(timer);
		const data = await resp.json();
		return data && data.ok ? 'ok' : (data && data.error) || 'refused';
	} catch (e) {
		return 'not-running';
	}
}

/* ----------------------------------------------------------------- reset - */

// What `reset` removes. `hard` entries are only touched by --all because they
// invalidate things the user set up elsewhere: the MCP token is baked into the
// agent's saved MCP config, and the board tokens are live pairings.
const RESET_ITEMS = [
	{ path: config.AGENT_FILE, label: 'saved agent choice' },
	{ path: config.CATALOG_CACHE_FILE, label: 'cached tool catalog' },
	{ path: config.DEBUG_DIR, label: 'debug dumps', dir: true },
	{ path: config.ATTACHMENTS_DIR, label: 'chat attachments', dir: true },
	{ path: config.PORT_FILE, label: 'stale port file' },
	{ path: config.MCP_TOKEN_FILE, label: 'MCP endpoint token', hard: true },
	{ path: config.TOKENS_FILE, label: 'paired boards', hard: true }
];

async function reset(argv) {
	const all = argv.indexOf('--all') !== -1;
	const yes = argv.indexOf('--yes') !== -1 || argv.indexOf('-y') !== -1;
	const items = RESET_ITEMS.filter(function(it) { return all || !it.hard; })
		.filter(function(it) { return exists(it.path); });

	if (!items.length) {
		console.log(paint.green('✓') + ' Nothing to reset - ' + ui.shortenPath(config.HOME_DIR)
			+ ' is already clean.');
		return;
	}

	console.log(paint.bold('This will delete:'));
	items.forEach(function(it) {
		console.log('  ' + paint.dim('•') + ' ' + pad(it.label, 24) + paint.dim(ui.shortenPath(it.path)));
	});
	if (all) {
		console.log('');
		console.log('  ' + paint.yellow('⚠') + ' A new MCP token is generated on the next start, so you must'
			+ ' re-run the');
		console.log('    ' + paint.dim('claude mcp add ...') + ' line it prints, and pair your boards again.');
	} else {
		console.log('');
		console.log('  ' + paint.dim('Kept: MCP token and paired boards. Add --all to clear those too.'));
	}
	console.log('');

	if (!yes) {
		if (!process.stdin.isTTY) {
			console.error('Refusing to reset without confirmation. Re-run with --yes.');
			process.exitCode = 1;
			return;
		}
		const ok = await confirm('  Delete these? [y/N]: ');
		if (!ok) {
			console.log('  Cancelled - nothing was deleted.');
			return;
		}
	}

	var failed = 0;
	items.forEach(function(it) {
		try {
			fs.rmSync(it.path, { recursive: true, force: true });
		} catch (e) {
			failed++;
			console.error('  ' + paint.yellow('✗') + ' could not delete ' + ui.shortenPath(it.path)
				+ ' - ' + (e && e.message));
		}
	});
	if (failed) {
		process.exitCode = 1;
		return;
	}
	console.log(paint.green('✓') + ' Reset done.');
	if (await isRunning()) {
		console.log('  ' + paint.yellow('A bridge is still running with the old state') + ' - stop it (Ctrl-C)'
			+ ' and start it again.');
	}
}

function exists(p) {
	try { fs.accessSync(p); return true; } catch (e) { return false; }
}

function confirm(question) {
	return new Promise(function(resolve) {
		const readline = require('readline');
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, function(answer) {
			rl.close();
			resolve(/^y(es)?$/i.test(String(answer).trim()));
		});
	});
}

async function isRunning() {
	try {
		const controller = new AbortController();
		const timer = setTimeout(function() { controller.abort(); }, 1200);
		const resp = await fetch('http://127.0.0.1:' + config.PORT + '/status', { signal: controller.signal });
		clearTimeout(timer);
		const data = await resp.json();
		return !!(data && data.server === 'MockFlow Bridge');
	} catch (e) {
		return false;
	}
}

module.exports = { help: help, status: status, agent: agent, reset: reset };
