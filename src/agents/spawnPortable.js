/**
 * Portable CLI spawning, shared by every adapter.
 *
 * On Windows these CLIs are installed as `.cmd` shims, which spawn() refuses to
 * execute directly (EINVAL since the CVE-2024-27980 hardening), so the call is
 * routed through cmd.exe with cross-spawn style argument escaping. Everywhere
 * else it is a plain spawn.
 *
 * Detection goes through the same path on purpose: a bare spawnSync of a .cmd
 * throws, adapters swallow that in a catch, and the user is then told the CLI is
 * not installed when it is.
 *
 * The same wrong answer has a second cause, and it is the common one on macOS
 * and Linux: the CLI is installed somewhere the DAEMON's PATH does not list.
 * Claude Code's and Cursor's native installers drop their binary in
 * ~/.local/bin, opencode in ~/.bun/bin - directories a login shell adds in an rc
 * file and a bridge started from a GUI launcher, a service, an editor or an
 * older terminal session simply does not have. detect() then spawns `claude`,
 * gets ENOENT and reports "not installed" for a CLI sitting on disk. So every
 * spawn from here runs with those install directories APPENDED to PATH (see
 * agentBinDirs) - appended, never prepended, so a PATH the user did set still
 * decides which copy runs.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** cmd.exe argument escaping (same rules as the cross-spawn package):
 *  backslash-double quotes, quote the whole arg, caret-escape metachars. */
function escapeCmdArgument(arg) {
	arg = String(arg).replace(/(\\*)"/g, '$1$1\\"');
	arg = arg.replace(/(\\*)$/, '$1$1');
	arg = '"' + arg + '"';
	return arg.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}

/** How to invoke `command` with `args` on this platform. */
function spawnSpec(command, args) {
	args = args || [];
	if (process.platform !== 'win32') return { file: command, args: args, opts: {} };
	// cmd.exe resolves the .cmd/.exe extension itself via PATHEXT, so the bare
	// command name is still what goes on the line.
	const line = [command].concat(args.map(escapeCmdArgument)).join(' ');
	return {
		file: 'cmd.exe',
		args: ['/d', '/s', '/c', '"' + line + '"'],
		opts: { windowsVerbatimArguments: true }
	};
}

/**
 * Where the agent CLIs put themselves, for the PATH a daemon may not have.
 *
 * Only well-known INSTALLER destinations belong here - the point is to find a
 * CLI the user really installed, never to run something that happens to share
 * the name from a directory nobody chose. MFBRIDGE_AGENT_PATH is the escape
 * hatch for an install none of these cover, and is searched first.
 */
function candidateBinDirs() {
	const dirs = [];
	let home = '';
	try { home = os.homedir() || ''; } catch (e) {}

	if (process.env.MFBRIDGE_AGENT_PATH) {
		String(process.env.MFBRIDGE_AGENT_PATH).split(path.delimiter).forEach(function(d) {
			if (d) dirs.push(d);
		});
	}

	// Next to the node running this bridge: a CLI installed with the same
	// `npm i -g` lands here, which is what an nvm/volta node makes of a global.
	try { dirs.push(path.dirname(process.execPath)); } catch (e) {}

	if (home) {
		dirs.push(path.join(home, '.local', 'bin'));      // Claude Code + Cursor native installers
		dirs.push(path.join(home, '.claude', 'local'));   // older Claude Code local install
		dirs.push(path.join(home, '.bun', 'bin'));        // bun installs (opencode)
		dirs.push(path.join(home, '.opencode', 'bin'));
		dirs.push(path.join(home, '.deno', 'bin'));
		dirs.push(path.join(home, '.cargo', 'bin'));
		dirs.push(path.join(home, '.volta', 'bin'));
		dirs.push(path.join(home, '.npm-global', 'bin'));
	}

	if (process.platform === 'win32') {
		// %APPDATA%\npm is where npm puts a global .cmd shim; the rest are the
		// package managers people actually install these CLIs with. The native
		// installers (Claude Code, Cursor) use %USERPROFILE%\.local\bin, already
		// added above.
		if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
		if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
		if (process.env.ProgramData) dirs.push(path.join(process.env.ProgramData, 'chocolatey', 'bin'));
		if (home) dirs.push(path.join(home, 'scoop', 'shims'));
	} else {
		dirs.push('/opt/homebrew/bin');
		dirs.push('/usr/local/bin');
		dirs.push('/home/linuxbrew/.linuxbrew/bin');
	}

	return dirs;
}

let _binDirs = null;

/** candidateBinDirs(), de-duplicated and reduced to the ones that exist. */
function agentBinDirs() {
	if (_binDirs) return _binDirs;
	const seen = Object.create(null);
	_binDirs = candidateBinDirs().filter(function(d) {
		const key = process.platform === 'win32' ? String(d).toLowerCase() : d;
		if (seen[key]) return false;
		seen[key] = true;
		try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
	});
	return _binDirs;
}

/**
 * Every key in `env` that names the search path, first one first.
 *
 * Windows env vars are case-insensitive, but a plain object copied out of
 * process.env is not: `Object.assign({}, process.env)` yields whatever casing
 * Windows used (usually `Path`), and a caller merging its own `PATH` on top of
 * that produces an object with BOTH - two entries in the environment block the
 * child then picks between by rules nobody should depend on. So the copy keeps
 * one key and folds the rest into it.
 */
function pathKeys(env) {
	return Object.keys(env || {}).filter(function(k) { return k.toUpperCase() === 'PATH'; });
}

/**
 * `env` with the install directories appended to its PATH. Returns a copy; the
 * original (often process.env) is never mutated. Directories already on PATH
 * are left where they are, so nothing changes which copy of a CLI wins.
 */
function withAgentPath(env) {
	const base = env || process.env;
	const keys = pathKeys(base);
	const key = keys[0] || 'PATH';
	const norm = function(d) { return process.platform === 'win32' ? String(d).toLowerCase() : d; };

	// Duplicate PATH spellings are merged in the order they appear, so nothing a
	// caller put on the path is dropped by the de-duplication below.
	const parts = [];
	const have = Object.create(null);
	keys.forEach(function(k) {
		String(base[k] || '').split(path.delimiter).forEach(function(d) {
			if (!d || have[norm(d)]) return;
			have[norm(d)] = true;
			parts.push(d);
		});
	});

	const add = agentBinDirs().filter(function(d) { return !have[norm(d)]; });
	if (!add.length && keys.length < 2) return env;

	const out = Object.assign({}, base);
	keys.slice(1).forEach(function(k) { delete out[k]; });
	out[key] = parts.concat(add).join(path.delimiter);
	return out;
}

/**
 * spawn(), portably.
 *
 * stdin is closed by default. No adapter ever writes to it - the prompt rides
 * the command line - and a CLI that finds an open pipe there can decide to wait
 * for more input: `codex exec` prints "Reading additional input from stdin..."
 * and never finishes, which looks like the agent thinking forever. An adapter
 * that really needs stdin can pass its own `stdio`.
 */
function spawnCli(command, args, opts) {
	const spec = spawnSpec(command, args);
	const merged = Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}, spec.opts);
	merged.env = withAgentPath(merged.env);
	return spawn(spec.file, spec.args, merged);
}

/** spawnSync(), portably - used by the adapters' detect(). */
function spawnCliSync(command, args, opts) {
	const spec = spawnSpec(command, args);
	const merged = Object.assign({}, opts || {}, spec.opts);
	merged.env = withAgentPath(merged.env);
	return spawnSync(spec.file, spec.args, merged);
}

module.exports = {
	escapeCmdArgument: escapeCmdArgument,
	spawnSpec: spawnSpec,
	spawnCli: spawnCli,
	spawnCliSync: spawnCliSync,
	agentBinDirs: agentBinDirs,
	withAgentPath: withAgentPath
};
