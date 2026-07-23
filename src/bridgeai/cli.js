/**
 * `mockflow-bridge bridgeai ...` — BridgeAI provider & model selection.
 *
 *   bridgeai                 show configured providers, active provider + model
 *   bridgeai provider        pick the active provider (from those with a key set)
 *   bridgeai provider <id>   set it directly
 *   bridgeai model           pick a model for the active provider (tool-capable)
 *   bridgeai model <id>      set it directly
 *
 * These are namespaced under `bridgeai` because provider/model only apply to this
 * agent. Selection is saved (bridge-provider / bridge-model.json) and read back by
 * the adapter — see src/bridgeai/index.js.
 */

const ui = require('../ui');
const providers = require('./providers');
const models = require('./models');

const paint = ui.out;

async function run(argv) {
	argv = argv || [];
	const sub = (argv[0] || '').toLowerCase();
	if (!sub || sub === 'status' || sub === 'show') return status();
	if (sub === 'provider' || sub === 'providers') return providerCmd(argv.slice(1));
	if (sub === 'model' || sub === 'models') return modelCmd(argv.slice(1));
	console.error(paint.yellow('Unknown: ') + 'mockflow-bridge bridgeai ' + argv.join(' '));
	console.error('  Try: ' + paint.teal('mockflow-bridge bridgeai') + paint.dim('  |  provider [id]  |  model [id]'));
	process.exitCode = 1;
}

/* ------------------------------------------------------------- status - */

function status() {
	const env = process.env;
	const active = providers.active(env);
	console.log(paint.bold('BridgeAI') + paint.dim('  (OpenAI-compatible agent)'));
	console.log('');
	providers.all().forEach(function (p) {
		const has = !!env[p.keyEnv];
		const isActive = active && p.id === active.id;
		const mark = has ? (isActive ? paint.green('●') : paint.dim('○')) : paint.dim('·');
		const model = has ? models.resolveModel(p, { env: env }).model : null;
		const tail = has
			? paint.dim(model || '(no model set)') + (isActive ? paint.green('   active') : '')
			: paint.dim('set ' + p.keyEnv + ' to enable');
		console.log('  ' + mark + ' ' + pad(p.id, 11) + ' ' + pad(p.label, 24) + tail);
	});
	console.log('');
	if (!active) {
		console.log('  ' + paint.yellow('No provider configured') + paint.dim(' — set one of the keys above.'));
		return;
	}
	console.log('  ' + paint.dim('Change provider:') + ' ' + paint.teal('mockflow-bridge bridgeai provider <id>'));
	console.log('  ' + paint.dim('Change model:   ') + ' ' + paint.teal('mockflow-bridge bridgeai model'));
}

/* ----------------------------------------------------------- provider - */

async function providerCmd(args) {
	const cfg = providers.configured(process.env);
	if (!cfg.length) {
		console.error(paint.yellow('✗') + ' No provider has a key set. Set one of: '
			+ providers.all().map(function (p) { return p.keyEnv; }).join(', '));
		process.exitCode = 1;
		return;
	}
	if (args[0]) return setProvider(args[0]);
	if (!process.stdin.isTTY) {
		console.error('No terminal to ask in. Use: mockflow-bridge bridgeai provider <id>');
		process.exitCode = 1;
		return;
	}
	const cur = providers.active(process.env);
	const chosen = await pick('Which provider should BridgeAI use?',
		cfg.map(function (p) { return { id: p.id, label: p.label, note: models.resolveModel(p, { env: process.env }).model || '' }; }),
		cur ? cur.id : null, false);
	if (chosen) setProvider(chosen.id);
}

function setProvider(id) {
	const p = providers.get(id);
	if (!p) {
		console.error(paint.yellow('Unknown provider "' + id + '".') + ' Known: '
			+ providers.all().map(function (x) { return x.id; }).join(', '));
		process.exitCode = 1;
		return;
	}
	if (!process.env[p.keyEnv]) {
		console.error(paint.yellow('✗') + ' ' + p.label + ': set ' + p.keyEnv + ' first.');
		process.exitCode = 1;
		return;
	}
	providers.saveProvider(p.id);
	const m = models.resolveModel(p, { env: process.env });
	console.log(paint.green('✓') + ' Provider set to ' + paint.bold(p.label)
		+ (m.model ? paint.dim(' · ' + m.model)
			: paint.yellow(' — no model set; run `mockflow-bridge bridgeai model`')));
}

/* -------------------------------------------------------------- model - */

async function modelCmd(args) {
	const p = providers.active(process.env);
	if (!p) {
		console.error(paint.yellow('✗') + ' No active provider. Set a key or run `mockflow-bridge bridgeai provider`.');
		process.exitCode = 1;
		return;
	}
	if (args[0]) return setModel(p, args[0]);
	if (!process.stdin.isTTY) {
		console.error('No terminal to ask in. Use: mockflow-bridge bridgeai model <id>');
		process.exitCode = 1;
		return;
	}
	return pickModel(p);
}

function setModel(p, id) {
	models.saveModel(p.id, id);
	console.log(paint.green('✓') + ' ' + p.label + ' will use ' + paint.bold(id) + '.');
}

async function pickModel(p) {
	const key = process.env[p.keyEnv];
	const base = p.resolveBaseURL(process.env);
	const cur = models.resolveModel(p, { env: process.env }).model;

	if (p.listModels && key && base.url) {
		console.error(paint.dim('Fetching models from ' + p.label + '…'));
		const list = await models.fetchModels(p, key, base.url);
		if (list && list.length) {
			const cap = models.pickable(list).slice(0, 40);
			const chosen = await pick('Model for ' + p.label + paint.dim(' (tool-capable)') + ':',
				cap.map(function (m) { return { id: m.id, label: m.id }; }), cur, true);
			if (chosen) setModel(p, chosen.id);
			return;
		}
		console.error(paint.yellow('Could not list models') + paint.dim(' — type an id.'));
	}
	// Not listable (Azure) or the fetch failed: type it.
	const label = p.id === 'azure' ? 'deployment name' : 'model id';
	const typed = await prompt(p.label + ' ' + label + (cur ? ' [' + cur + ']' : '') + ': ');
	if (typed) setModel(p, typed);
	else if (cur) console.log(paint.dim('Kept ' + cur + '.'));
}

/* ------------------------------------------------------ small helpers - */

function pad(s, n) { s = String(s || ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

/**
 * Numbered picker on stderr (stdin for the answer). Returns the chosen item, or
 * — when allowFreeText — a { id, label } built from whatever was typed.
 */
function pick(title, items, current, allowFreeText) {
	const perr = ui.err;
	console.error('');
	console.error(perr.bold(title));
	items.forEach(function (it, i) {
		console.error('  ' + perr.teal(String(i + 1)) + '. ' + it.label
			+ (it.note ? perr.dim('  ' + it.note) : '')
			+ (it.id === current ? perr.green('  (current)') : ''));
	});
	if (allowFreeText) console.error(perr.dim('  …or type any id'));
	let dflt = 0;
	for (let i = 0; i < items.length; i++) { if (items[i].id === current) { dflt = i; break; } }
	return new Promise(function (resolve) {
		const readline = require('readline');
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		rl.question('  Choice [' + (dflt + 1) + ']: ', function (answer) {
			rl.close();
			const raw = String(answer).trim();
			if (!raw) return resolve(items[dflt] || null);
			const n = parseInt(raw, 10);
			if (!isNaN(n) && n >= 1 && n <= items.length) return resolve(items[n - 1]);
			if (allowFreeText) return resolve({ id: raw, label: raw });
			resolve(items[dflt] || null);
		});
	});
}

function prompt(q) {
	return new Promise(function (resolve) {
		const readline = require('readline');
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		rl.question('  ' + q, function (answer) { rl.close(); resolve(String(answer).trim()); });
	});
}

module.exports = { run: run };
