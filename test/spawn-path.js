#!/usr/bin/env node
/**
 * Offline test for the agent PATH lookup (src/agents/spawnPortable.js).
 *
 * The bug it guards: a bridge started outside a login shell - a GUI launcher, a
 * service, an editor, an older terminal - has a PATH without the directories the
 * agent CLIs install into (~/.local/bin for Claude Code and Cursor, ~/.bun/bin
 * for opencode, %APPDATA%\npm on Windows). detect() then spawns `claude`, gets
 * ENOENT, and every picker says "not installed" for a CLI sitting on disk.
 *
 * Checked here: the install dirs are appended (never prepended, so a PATH the
 * user set still wins), process.env is not mutated, appending twice is a no-op,
 * and - simulating win32 - the copy keeps ONE PATH key whatever its casing, with
 * de-duplication done case-insensitively.
 *
 * The cmd.exe wrapping around a .cmd shim is asserted too, but only its shape:
 * only a real Windows box proves the CLI runs. No CLI, no daemon, no board.
 *
 *   node test/spawn-path.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let failed = 0;
function check(name, cond, detail) {
	if (cond) { console.log('✓ ' + name); return; }
	failed++;
	console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
}

/** Load a fresh copy of the module (it caches the resolved dir list). */
function freshModule() {
	delete require.cache[require.resolve('../src/agents/spawnPortable')];
	return require('../src/agents/spawnPortable');
}

// ---------------------------------------------------------------- this platform

const sp = freshModule();
const dirs = sp.agentBinDirs();

check('every candidate dir exists and is a directory',
	dirs.every(function (d) { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }),
	dirs.join(', '));

check('candidate dirs are absolute',
	dirs.every(function (d) { return path.isAbsolute(d); }), dirs.join(', '));

check('candidate dirs are de-duplicated',
	new Set(dirs).size === dirs.length, dirs.join(', '));

const bare = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
const widened = sp.withAgentPath(bare);
const widenedParts = String(widened.PATH).split(path.delimiter);

check('the given PATH stays in front',
	widenedParts[0] === '/usr/bin' && widenedParts[1] === '/bin', String(widened.PATH));

check('install dirs are appended',
	dirs.every(function (d) { return widenedParts.indexOf(d) > 1; }), String(widened.PATH));

check('the caller\'s env object is not mutated',
	bare.PATH === ['/usr/bin', '/bin'].join(path.delimiter));

check('process.env is not mutated',
	String(process.env.PATH).indexOf(path.delimiter + path.delimiter) === -1
	&& sp.withAgentPath(process.env) !== process.env);

const twice = sp.withAgentPath(widened);
check('widening an already-widened PATH adds nothing',
	String(twice.PATH) === String(widened.PATH), String(twice.PATH));

if (dirs.length) {
	const already = { PATH: dirs[0] };
	const out = String(sp.withAgentPath(already).PATH).split(path.delimiter);
	check('a dir already on PATH is not added twice',
		out.filter(function (d) { return d === dirs[0]; }).length === 1, out.join(path.delimiter));
}

check('an env with no PATH at all still gets the install dirs',
	dirs.length === 0 || String(sp.withAgentPath({ HOME: os.homedir() }).PATH || '').length > 0);

if (process.platform !== 'win32') {
	const spec = sp.spawnSpec('claude', ['--version']);
	check('posix spawns the command directly',
		spec.file === 'claude' && spec.args.join(' ') === '--version');
}

// ---------------------------------------------------------------- simulated win32
//
// Only the platform-dependent LOGIC is exercised here - path separators stay
// posix, because `path` follows the host. What this proves is the part that has
// no other test: which PATH key a copied Windows env is written back to, and
// that casing does not create a second one.

const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
try {
	const win = freshModule();

	const spec = win.spawnSpec('claude', ['-p', 'hello world']);
	check('win32 routes through cmd.exe (a .cmd shim cannot be spawned directly)',
		spec.file === 'cmd.exe' && spec.args[0] === '/d' && spec.args[2] === '/c'
		&& spec.args[3].indexOf('claude') !== -1 && spec.opts.windowsVerbatimArguments === true,
		JSON.stringify(spec));

	// Values avoid a drive letter on purpose: under this simulation `path` is
	// still posix, so ':' is the delimiter and 'C:\\x' would split in two.
	const lower = win.withAgentPath({ Path: 'C_Windows_system32' });
	check('win32 writes back to the env\'s own PATH spelling',
		typeof lower.Path === 'string' && lower.PATH === undefined, JSON.stringify(Object.keys(lower)));

	const both = win.withAgentPath({ Path: 'C_one', PATH: 'C_two' });
	const bothKeys = Object.keys(both).filter(function (k) { return k.toUpperCase() === 'PATH'; });
	check('win32 leaves exactly one PATH key', bothKeys.length === 1, bothKeys.join(','));
	check('win32 keeps every dir when merging duplicate PATH keys',
		String(both.Path).indexOf('C_one') !== -1 && String(both.Path).indexOf('C_two') !== -1,
		String(both.Path));

	const cased = win.withAgentPath({ Path: (win.agentBinDirs()[0] || 'C_x').toUpperCase() });
	const first = (win.agentBinDirs()[0] || '').toLowerCase();
	check('win32 de-duplicates case-insensitively',
		!first || String(cased.Path).toLowerCase().split(path.delimiter)
			.filter(function (d) { return d === first; }).length === 1,
		String(cased.Path));
} finally {
	Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
	freshModule();
}

if (failed) {
	console.error('\n' + failed + ' check(s) failed.');
	process.exit(1);
}
console.log('\nAll PATH checks passed (' + dirs.length + ' install dirs found on this machine).');
