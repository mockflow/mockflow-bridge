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
 */

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
	return spawn(spec.file, spec.args, merged);
}

/** spawnSync(), portably - used by the adapters' detect(). */
function spawnCliSync(command, args, opts) {
	const spec = spawnSpec(command, args);
	return spawnSync(spec.file, spec.args, Object.assign({}, opts || {}, spec.opts));
}

module.exports = {
	escapeCmdArgument: escapeCmdArgument,
	spawnSpec: spawnSpec,
	spawnCli: spawnCli,
	spawnCliSync: spawnCliSync
};
