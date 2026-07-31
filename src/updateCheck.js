/**
 * "You are behind" check against the published @mockflow/mockflow-bridge.
 *
 * Follows the update-notifier pattern so it never slows or blocks startup:
 *
 *   - notice() reads a latest-version CACHED by a PREVIOUS run and, when the
 *     running version is older, returns the lines for a one-off box. It does no
 *     network I/O, so it is instant and works offline.
 *   - refresh(onUpdate) is fired and forgotten after the banner: one short-timeout
 *     HTTPS GET to the npm registry that rewrites the cache. Every failure
 *     (offline, timeout, non-200, bad JSON) is swallowed - a version check must
 *     never be why the bridge did not start.
 *
 * refresh() calls onUpdate({current, latest}) as soon as it knows we are behind -
 * from the fetch it just made, or straight from a still-fresh cache. Without that
 * callback the notice would always be one start behind a new publish (the run that
 * fetches it prints nothing), which in practice reads as "the check never works".
 * The daemon lives for hours, so it surfaces the result in the session that found
 * it: a strip in the dashboard, a box under the banner.
 *
 * Opt out with MFBRIDGE_NO_UPDATE_CHECK=1 (also honours NO_UPDATE_NOTIFIER and CI).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');
const { spawnCli } = require('./agents/spawnPortable');

// Every few hours, not once a day: a day-long cache means a fresh publish stays
// invisible across several restarts, which is indistinguishable from a broken check.
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

function disabled() {
	return !!(process.env.MFBRIDGE_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI);
}

/** First dotted number in a version string -> [major, minor, patch], or null. */
function parse(v) {
	const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** True when `current` is strictly older than `latest`; false if either is junk. */
function behind(current, latest) {
	const a = parse(current), b = parse(latest);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		const x = a[i] || 0, y = b[i] || 0;
		if (x < y) return true;
		if (x > y) return false;
	}
	return false;
}

function readCache() {
	try { return JSON.parse(fs.readFileSync(config.UPDATE_CACHE_FILE, 'utf8')); }
	catch (e) { return null; }
}

function writeCache(latest) {
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.UPDATE_CACHE_FILE, JSON.stringify({ latest: latest, checkedAt: Date.now() }));
	} catch (e) {}
}

/**
 * Lines for the "update available" box, or null when up to date or no cache yet.
 * Pure read of the cache a previous run left - safe during the synchronous
 * startup print.
 */
function notice(paint) {
	if (disabled()) return null;
	const cache = readCache();
	if (!cache || !cache.latest) return null;
	if (!behind(config.ENGINE_VERSION, cache.latest)) return null;
	// The command for THIS copy, so a root-owned install is told to use sudo rather
	// than being handed a line that fails with EACCES.
	const info = installInfo();
	const lines = [
		paint.bold('Update available') + ': ' + config.ENGINE_VERSION + ' → ' + paint.green(cache.latest),
		paint.dim('  ' + userCommand(info))
	];
	if (info.selfUpdate) lines.push(paint.dim('  or start with --auto-update to install it here'));
	return lines;
}

/**
 * Ask the registry for the published version, ignoring the cache, and write it
 * there on success. `done(err, version)` fires exactly once. Never throws.
 *
 * `hold` keeps the socket referenced: the background watcher must not be a
 * reason the process stays alive, but `mockflow-bridge update` has nothing else
 * to wait on, and an unref'd request would let node exit before the answer.
 */
function fetchLatest(done, hold) {
	// The registry serves scoped names unencoded; /latest is the abbreviated doc.
	const url = 'https://registry.npmjs.org/' + config.PKG_NAME + '/latest';
	let settled = false;
	let req;
	const finish = function (err, v) {
		if (settled) return;
		settled = true;
		try { req.destroy(); } catch (e) {}
		if (done) done(err || null, v || '');
	};
	const fail = function () { finish(new Error('Could not reach the npm registry.')); };

	try {
		req = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { accept: 'application/json' } }, function (res) {
			if (res.statusCode !== 200) { res.resume(); return fail(); }
			let body = '';
			res.setEncoding('utf8');
			res.on('data', function (c) { body += c; if (body.length > 1e6) fail(); });
			res.on('end', function () {
				var v = '';
				try { v = JSON.parse(body).version; } catch (e) {}
				if (!v) return fail();
				writeCache(String(v));
				finish(null, String(v));
			});
		});
		req.on('timeout', fail);
		req.on('error', fail);
		// Do not let a pending check hold the process open on its own.
		if (!hold && req.unref) req.unref();
	} catch (e) { fail(); }
}

/**
 * Refresh the cache in the background when it is missing or stale, then hand any
 * "you are behind" verdict to `onUpdate` ({ current, latest }). Fire and forget -
 * never awaited, never throws, the callback is optional.
 */
function refresh(onUpdate) {
	if (disabled()) return;
	const tell = function () {
		if (typeof onUpdate !== 'function') return;
		const info = available();
		if (info) { try { onUpdate(info); } catch (e) {} }
	};
	const cache = readCache();
	if (cache && cache.checkedAt && (Date.now() - cache.checkedAt) < CHECK_INTERVAL_MS) {
		// Cache is still fresh, so skip the network - but a fresh cache can already
		// say we are behind, and the caller has not been told yet.
		return tell();
	}
	fetchLatest(function (err) { if (!err) tell(); });
}

/* ------------------------------------------------------- self-update --- */

/** An npm install that has to fetch and unpack a package; generous, but bounded. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const ROOT = path.join(__dirname, '..');

function canWrite(p) {
	try { fs.accessSync(p, fs.constants.W_OK); return true; }
	catch (e) { return false; }
}

/**
 * How this copy is installed, and whether THIS process may replace it.
 *
 *   kind 'global' - an ordinary `npm i -g`, the only kind we ever install over.
 *   kind 'source' - a git clone or an `npm link`ed one. Overwriting a developer's
 *                   working copy with the published tarball would throw away
 *                   their changes, so it is never offered.
 *   kind 'npx'    - run straight from the npx cache, which already fetches the
 *                   latest on every run. There is nothing to update.
 *
 * `writable` is checked on the package directory AND its parent, because npm
 * removes and recreates the directory rather than writing inside it. A global
 * install owned by root (the usual result of `sudo npm i -g`) is therefore not
 * writable by a bridge running as the user, and self-update is refused: see
 * command(), which then says to run it with sudo by hand. Nothing here ever
 * ESCALATES on its own - a daemon has nobody to answer a password prompt, and a
 * version check is no reason to run install scripts as root.
 */
function installInfo() {
	var linked = false;
	try { linked = fs.lstatSync(ROOT).isSymbolicLink(); } catch (e) {}
	const isClone = fs.existsSync(path.join(ROOT, '.git'));
	const inNpx = /[\\/]_npx[\\/]/.test(ROOT);
	const kind = (isClone || linked) ? 'source' : (inNpx ? 'npx' : 'global');
	const writable = kind === 'global' && canWrite(ROOT) && canWrite(path.dirname(ROOT));
	return {
		kind: kind,
		dir: ROOT,
		writable: writable,
		// The one case where pressing a button can actually replace this copy.
		selfUpdate: kind === 'global' && writable,
		// A global install this process cannot write: the user can still update it,
		// with sudo, by hand.
		needsSudo: kind === 'global' && !writable
	};
}

/** The command a user would run to update this particular copy, sudo included. */
function command(info) {
	const i = info || installInfo();
	if (i.kind === 'source') return 'git pull';
	return (i.needsSudo ? 'sudo ' : '') + 'npm i -g ' + config.PKG_NAME;
}

/**
 * What to TELL the user to run. Same as command(), except an ordinary global
 * install this process could replace is pointed at `mockflow-bridge update`,
 * which is shorter to remember and does the version check itself. The npm line
 * stays the answer wherever that command would only refuse (sudo, checkout, npx).
 */
function userCommand(info) {
	const i = info || installInfo();
	return i.selfUpdate ? 'mockflow-bridge update' : command(i);
}

/** The version on disk right now, re-read (npm has just replaced package.json). */
function installedVersion() {
	try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; }
	catch (e) { return ''; }
}

/**
 * Install the published version over this one. `onLine` receives npm's output a
 * line at a time (for the Activity feed); `done(err, version)` fires once.
 *
 * Refused outright unless installInfo().selfUpdate - a source checkout must not
 * be overwritten, and a root-owned install cannot be, so pretending to try would
 * only produce a confusing EACCES.
 */
function install(onLine, done) {
	const info = installInfo();
	const finish = function (err, v) { if (done) { done(err, v); done = null; } };
	if (!info.selfUpdate) {
		return finish(new Error(info.kind === 'source'
			? 'This is a source checkout, not an npm install - update it with git.'
			: info.kind === 'npx'
				? 'This copy runs from the npx cache, which already fetches the latest version.'
				: 'This install belongs to another user (' + info.dir + '), so it cannot be replaced '
					+ 'from here. Update it by hand with: ' + command(info)));
	}

	const say = function (s) {
		String(s).split('\n').forEach(function (l) {
			const t = l.replace(/\s+$/, '');
			if (t && onLine) { try { onLine(t); } catch (e) {} }
		});
	};

	var proc;
	try {
		proc = spawnCli('npm', ['install', '-g', '--no-fund', '--no-audit', config.PKG_NAME + '@latest'],
			{ stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		return finish(new Error('Could not run npm: ' + (e && e.message)));
	}

	var tail = '';
	if (proc.stdout) proc.stdout.on('data', function (d) { say(d.toString()); });
	if (proc.stderr) proc.stderr.on('data', function (d) {
		const s = d.toString();
		tail = (tail + s).slice(-2000);
		say(s);
	});
	const timer = setTimeout(function () {
		try { proc.kill('SIGTERM'); } catch (e) {}
		finish(new Error('npm took longer than ' + Math.round(INSTALL_TIMEOUT_MS / 60000) + ' minutes and was stopped.'));
	}, INSTALL_TIMEOUT_MS);

	proc.on('error', function (err) { clearTimeout(timer); finish(new Error('Could not run npm: ' + err.message)); });
	proc.on('close', function (code) {
		clearTimeout(timer);
		if (code !== 0) {
			const why = tail.split('\n').filter(function (l) { return l.trim(); }).pop() || ('npm exited ' + code);
			return finish(new Error(why.slice(0, 300)));
		}
		const v = installedVersion();
		// npm can exit 0 having installed somewhere else entirely (a different prefix
		// than the one this copy lives in), and then a "success" that changes nothing
		// would send the bridge into a restart loop under --auto-update.
		if (v && v === config.ENGINE_VERSION) {
			return finish(new Error('npm reported success but ' + info.dir + ' is still v' + v
				+ '. It may have installed to a different npm prefix; update it by hand with: '
				+ command(info)));
		}
		finish(null, v);
	});
}

/** { current, latest } when an update is available, else null. For the dashboard. */
function available() {
	if (disabled()) return null;
	const cache = readCache();
	if (!cache || !cache.latest) return null;
	if (!behind(config.ENGINE_VERSION, cache.latest)) return null;
	return { current: config.ENGINE_VERSION, latest: cache.latest };
}

module.exports = { notice, refresh, behind, available, installInfo, command, userCommand, install, fetchLatest };
