#!/usr/bin/env node
/**
 * Offline tests for the turn-verdict machinery: the shared stream loop
 * (agents/turnRunner) and the runtime parser-health rules
 * (agents/runtimeHealth). No CLI, no daemon, no board - safe for CI.
 *
 *   node test/turn-verdicts.js
 */

// Point the health store at a scratch file BEFORE the module loads, so these
// tests never touch the user's real ~/.mockflow state.
const os = require('os');
const path = require('path');
process.env.MFBRIDGE_RUNTIME_HEALTH_FILE =
	path.join(os.tmpdir(), 'mfbridge-test-runtime-' + process.pid + '.json');

const { EventEmitter } = require('events');
const { watchTurn } = require('../src/agents/turnRunner');
const runtimeHealth = require('../src/agents/runtimeHealth');

let failed = 0;
function check(name, cond) {
	if (cond) { console.log('✓ ' + name); }
	else { failed++; console.log('✗ ' + name); }
}

function fakeProc() {
	const p = new EventEmitter();
	p.stdout = new EventEmitter();
	p.stderr = new EventEmitter();
	return p;
}

/* ---- turnRunner: line buffering across chunk boundaries ---------------- */
(function () {
	const agent = {
		parseLine: function (line) {
			const e = JSON.parse(line);
			return e.t === 'tool' ? [{ type: 'tool-start', id: e.id, name: e.name }]
				: e.t === 'text' ? [{ type: 'text', text: e.x }] : [];
		},
		parseStderr: function (line) {
			const m = /model=(\S+)/.exec(line);
			return m ? { type: 'model', id: m[1] } : null;
		}
	};
	const proc = fakeProc();
	const seen = [];
	let model = null;
	let bytes = 0;
	const stats = watchTurn(agent, proc, {
		onEvent: function (ev) { seen.push(ev.type); },
		onModel: function (id) { model = id; },
		onChunk: function (len) { bytes += len; }
	});
	// One JSON line split across two chunks, then a second whole line.
	proc.stdout.emit('data', Buffer.from('{"t":"text","x":"he'));
	proc.stdout.emit('data', Buffer.from('llo"}\n{"t":"tool","id":"a","name":"render_x"}\nnot json\n'));
	proc.stderr.emit('data', Buffer.from('INFO model=claude-x agent=y\ntrailing'));

	check('runner: split line reassembled and parsed', seen[0] === 'text');
	check('runner: second line parsed', seen[1] === 'tool-start');
	check('runner: stdout lines counted (unparseable included)', stats.stdoutLines === 3);
	check('runner: parsed events counted', stats.parsedEvents === 2 && stats.toolStarts === 1 && stats.textEvents === 1);
	check('runner: a line the parser cannot read costs nothing', stats.parseErrors === 1);
	check('runner: model scanned from stderr', model === 'claude-x');
	check('runner: stderr tail kept', stats.stderrTail.indexOf('trailing') !== -1);
	check('runner: chunk volume reported', bytes > 0);
})();

/* ---- turnRunner: a throwing parser cannot kill the turn ---------------- */
(function () {
	const agent = { parseLine: function () { throw new Error('boom'); } };
	const proc = fakeProc();
	const stats = watchTurn(agent, proc, {});
	proc.stdout.emit('data', Buffer.from('a\nb\n'));
	check('runner: throwing parseLine is contained', stats.parseErrors === 2 && stats.parsedEvents === 0);
})();

/* ---- runtimeHealth.assessTurn rules ------------------------------------ */
(function () {
	const a = runtimeHealth.assessTurn;
	check('assess: healthy turn is not blind',
		!a({ stdoutLines: 20, parsedEvents: 15, toolStarts: 2 }, 3).blind);
	check('assess: plenty of lines, zero events = blind',
		a({ stdoutLines: 20, parsedEvents: 0 }, 0).blind);
	check('assess: blind + served MCP calls = confirmed in one turn',
		a({ stdoutLines: 20, parsedEvents: 0 }, 4).blindConfirmed);
	check('assess: blind without MCP is not yet confirmed',
		!a({ stdoutLines: 20, parsedEvents: 0 }, 0).blindConfirmed);
	check('assess: a tiny turn is never judged',
		!a({ stdoutLines: 2, parsedEvents: 0 }, 0).blind);
	check('assess: text parses but tool events gone while calls served = toolBlind',
		a({ stdoutLines: 20, parsedEvents: 5, toolStarts: 0 }, 3).toolBlind);
	check('assess: no served calls means toolBlind cannot trip',
		!a({ stdoutLines: 20, parsedEvents: 5, toolStarts: 0 }, 0).toolBlind);
})();

/* ---- runtimeHealth.noteTurn: flags, streaks, clearing, version reset --- */
(function () {
	runtimeHealth._reset();
	const blind = { stdoutLines: 30, parsedEvents: 0, toolStarts: 0 };
	const healthy = { stdoutLines: 30, parsedEvents: 20, toolStarts: 3 };

	// One blind turn WITH served calls flags immediately.
	let r = runtimeHealth.noteTurn('x', '1.0.0', blind, 5, true);
	check('note: blind+served flags in one turn', r.parserBlind && r.changed);
	check('note: status() reports the flag', !!runtimeHealth.status('x'));

	// A healthy turn clears it.
	r = runtimeHealth.noteTurn('x', '1.0.0', healthy, 5, true);
	check('note: healthy turn clears the flag', !r.parserBlind && r.changed);
	check('note: status() is quiet again', runtimeHealth.status('x') === null);

	// Without served calls it takes two consecutive blind turns.
	r = runtimeHealth.noteTurn('x', '1.0.0', blind, 0, true);
	check('note: one unconfirmed blind turn does not flag', !r.parserBlind);
	r = runtimeHealth.noteTurn('x', '1.0.0', blind, 0, true);
	check('note: two consecutive blind turns flag', r.parserBlind);

	// A new CLI version starts clean.
	r = runtimeHealth.noteTurn('x', '2.0.0', healthy, 0, true);
	check('note: version change resets the record', !r.parserBlind && runtimeHealth.status('x') === null);

	// Tool-blind needs two consecutive turns.
	const toolBlind = { stdoutLines: 30, parsedEvents: 10, toolStarts: 0 };
	runtimeHealth.noteTurn('y', '1.0', toolBlind, 3, true);
	r = runtimeHealth.noteTurn('y', '1.0', toolBlind, 3, true);
	check('note: toolBlind flags after two turns', r.toolEventsBlind);
	r = runtimeHealth.noteTurn('y', '1.0', healthy, 3, true);
	check('note: tool events seen again clears toolBlind', !r.toolEventsBlind);

	// A lane that does not expect parsing never trips a flag.
	runtimeHealth._reset();
	runtimeHealth.noteTurn('z', '1.0', blind, 5, false);
	runtimeHealth.noteTurn('z', '1.0', blind, 5, false);
	check('note: expectParse=false never flags', runtimeHealth.status('z') === null);

	// problems() feeds the boot banner in the health.problems shape.
	runtimeHealth._reset();
	runtimeHealth.noteTurn('claude', '9.9.9', blind, 5, true);
	const probs = runtimeHealth.problems({ id: 'claude', label: 'Claude Code' });
	check('problems: one runtime entry with the label', probs.length === 1
		&& probs[0].kind === 'runtime' && probs[0].label === 'Claude Code' && probs[0].parserBlind);

	runtimeHealth._reset();
})();

/* ---- universal tier: adapter built from orca-sized config -------------- */
(function () {
	const { makeUniversalAgent } = require('../src/agents/universal');
	const a = makeUniversalAgent({
		id: 'u', label: 'U (basic)', bin: 'u-cli',
		promptFlag: '-p', baseArgs: ['--flag'], extraDirsFlag: '--dir',
		noiseLine: function (t) { return /^Loading/.test(t); },
		install: 'x', wire: function (e) { return { title: 't', lines: ['wire ' + e] }; }
	});

	check('universal: parserless capability set', a.capabilities.parserless === true);
	check('universal: no resume, per-turn system prompt',
		a.capabilities.resume === 'none' && a.capabilities.systemPromptPerTurn === true);

	const spec = a.buildArgs({
		prompt: 'draw it', systemPrompt: 'You are Mida.',
		extraDirs: ['/tmp/att'], allowedTools: 'ignored', resume: 'ignored'
	});
	check('universal: base args first', spec.args[0] === '--flag');
	check('universal: extra dirs via flag', spec.args.indexOf('--dir') !== -1
		&& spec.args[spec.args.indexOf('--dir') + 1] === '/tmp/att');
	const p = spec.args[spec.args.indexOf('-p') + 1];
	check('universal: system prompt merged into the prompt',
		p.indexOf('You are Mida.') === 0 && p.indexOf('draw it') !== -1);

	check('universal: plain line is reply text',
		a.parseLine('The board is done.')[0].type === 'text');
	check('universal: JSON telemetry dropped', a.parseLine('{"a":1}').length === 0);
	check('universal: ANSI stripped',
		a.parseLine('\x1b[32mhello\x1b[0m')[0].text.indexOf('\x1b') === -1);
	check('universal: noise lines dropped', a.parseLine('Loading model...').length === 0);

	// Registry order: full adapters stay ahead of the universal tier, so
	// auto-select prefers well-tested entries.
	const registry = require('../src/agents');
	const ids = registry.AGENTS.map(function (x) { return x.id; });
	check('universal: registered after full adapters, before bridgeai',
		ids.indexOf('gemini') > ids.indexOf('opencode') && ids.indexOf('gemini') < ids.indexOf('bridgeai'));
	check('universal: tier is labelled in the picker text',
		/basic|experimental/i.test(registry.byId('gemini').label)
		&& /basic|experimental/i.test(registry.byId('cursor').label));
})();

if (failed) {
	console.error('\n' + failed + ' check(s) failed.');
	process.exit(1);
}
console.log('\nAll turn-verdict checks passed.');
