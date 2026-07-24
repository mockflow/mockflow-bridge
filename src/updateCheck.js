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
const https = require('https');
const config = require('./config');

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
	return [
		paint.bold('Update available') + ': ' + config.ENGINE_VERSION + ' → ' + paint.green(cache.latest),
		paint.dim('  npm i -g ' + config.PKG_NAME)
	];
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

	// The registry serves scoped names unencoded; /latest is the abbreviated doc.
	const url = 'https://registry.npmjs.org/' + config.PKG_NAME + '/latest';
	let done = false;
	let req;
	const finish = function () { if (done) return; done = true; try { req.destroy(); } catch (e) {} };

	try {
		req = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { accept: 'application/json' } }, function (res) {
			if (res.statusCode !== 200) { res.resume(); return finish(); }
			let body = '';
			res.setEncoding('utf8');
			res.on('data', function (c) { body += c; if (body.length > 1e6) finish(); });
			res.on('end', function () {
				try {
					const v = JSON.parse(body).version;
					if (v) { writeCache(String(v)); tell(); }
				} catch (e) {}
				finish();
			});
		});
		req.on('timeout', finish);
		req.on('error', finish);
		// Do not let a pending check hold the process open on its own.
		if (req.unref) req.unref();
	} catch (e) { finish(); }
}

/** { current, latest } when an update is available, else null. For the dashboard. */
function available() {
	if (disabled()) return null;
	const cache = readCache();
	if (!cache || !cache.latest) return null;
	if (!behind(config.ENGINE_VERSION, cache.latest)) return null;
	return { current: config.ENGINE_VERSION, latest: cache.latest };
}

module.exports = { notice, refresh, behind, available };
