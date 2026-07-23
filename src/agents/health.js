/**
 * Startup health checks for the agent adapters.
 *
 * Two independent guards, both run at boot so a problem surfaces in the terminal
 * instead of as a blank or wrong board mid-turn (see the AGENT-COMPARISON notes
 * on how each adapter is pinned to its CLI's current output):
 *
 *   1. Version floor - each adapter records the CLI version its flags and parser
 *      were last verified against (testedVersion). detect() already fetches the
 *      installed version; here we compare. A newer CLI is not necessarily broken,
 *      but it is the single thing most likely to have moved a flag or an event
 *      field, so the user is told turns MAY misbehave and to re-verify.
 *
 *   2. Parser canary - each adapter ships a committed fixture of the exact CLI
 *      output lines it knows how to read (selfTest), each tagged with the
 *      normalized events it must still produce. If an edit to parseLine /
 *      parseStderr - or a config-schema drift the adapter injects - stops
 *      producing them, that is caught here, not by a turn that silently draws
 *      nothing.
 *
 * The two are complementary: the canary catches OUR regressions (a bad parser
 * edit); the version floor flags THEIR drift (a CLI that outgrew the fixture).
 *
 *   3. Capability probe - the version floor only says "you are off the tested
 *      number"; the probe says WHAT that costs. It runs the CLI's own `--help`
 *      once and checks that the flags each turn depends on are still there,
 *      split into critical (generation produces nothing - e.g. claude's
 *      --mcp-config or --output-format) and optional (a feature is lost but the
 *      board still draws - e.g. --add-dir for attachments). Needles are matched
 *      against real --help output, never guessed. Its blind spot is honest and
 *      recorded per adapter: config-KEY wiring (codex's `-c mcp_servers...`,
 *      opencode's injected schema) is not in --help, so only a live turn catches
 *      a renamed key.
 *
 * None of the three replaces running a live turn against a real board - see
 * test/fake-*.js. They are boot-time tripwires, cheapest first.
 */

const { spawnCliSync } = require('./spawnPortable');

/** First dotted number in a `--version` string: "codex-cli 0.145.0" -> [0,145,0]. */
function parseVersion(raw) {
	const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw || ''));
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function compare(a, b) {
	for (let i = 0; i < 3; i++) {
		const x = a[i] || 0, y = b[i] || 0;
		if (x < y) return -1;
		if (x > y) return 1;
	}
	return 0;
}

/**
 * Installed vs last-tested for one agent. `detected` is its detect() result.
 * `known` is false when either version cannot be read - a floor we cannot judge
 * is silent rather than a false alarm.
 */
function versionStatus(agent, detected) {
	const tested = agent.testedVersion || '';
	const installedRaw = (detected && detected.version) || '';
	const iv = parseVersion(installedRaw);
	const tv = parseVersion(tested);
	if (!iv || !tv) return { known: false, tested: tested, installed: installedRaw.trim(), newer: false };
	return { known: true, tested: tv.join('.'), installed: iv.join('.'), newer: compare(iv, tv) > 0 };
}

function typesOf(events) {
	return (events || []).map(function (e) { return e && e.type; });
}

function sameSeq(got, expect) {
	if (got.length !== expect.length) return false;
	for (let i = 0; i < expect.length; i++) if (got[i] !== expect[i]) return false;
	return true;
}

/**
 * Replay an agent's committed fixtures through its own parser. Returns
 * { ok, failures[] }. A fixture line lists the normalized event *types* it must
 * produce, in order (values like ids and text are not asserted - only the shape
 * the orchestrator depends on). A `stderr` fixture asserts the single event type
 * parseStderr yields (or null for a line it must ignore). An optional `check()`
 * returns an error string for anything the adapter wants to self-verify beyond
 * parsing - opencode uses it to prove its injected allowlist still exposes the
 * board tools.
 */
function runCanary(agent) {
	const st = agent.selfTest || {};
	const failures = [];

	(st.lines || []).forEach(function (f, i) {
		let got;
		try { got = agent.parseLine(f.line); }
		catch (e) { failures.push('parseLine fixture #' + i + ' threw: ' + e.message); return; }
		const types = typesOf(got);
		if (!sameSeq(types, f.expect)) {
			failures.push('parseLine fixture #' + i + ' expected ['
				+ f.expect.join(',') + '] got [' + types.join(',') + ']');
		}
	});

	(st.stderr || []).forEach(function (f, i) {
		let got;
		try { got = agent.parseStderr ? agent.parseStderr(f.line) : null; }
		catch (e) { failures.push('parseStderr fixture #' + i + ' threw: ' + e.message); return; }
		const type = (got && got.type) || null;
		if (type !== f.expect) {
			failures.push('parseStderr fixture #' + i + ' expected ' + f.expect + ' got ' + type);
		}
	});

	if (typeof st.check === 'function') {
		let err = '';
		try { err = st.check(); } catch (e) { err = e.message; }
		if (err) failures.push(err);
	}

	return { ok: failures.length === 0, failures: failures };
}

/**
 * Run the installed CLI's `--help` and check the flags each turn depends on are
 * still present. Returns null when the adapter declares no probe. `helpFailed`
 * means the help invocation itself changed (a critical signal - the subcommand
 * shape moved). Otherwise missing flags are split critical vs optional by the
 * adapter's own classification.
 */
function runProbe(agent) {
	const cp = agent.capabilityProbe;
	if (!cp) return null;

	let text = '', ok = false;
	try {
		const r = spawnCliSync(cp.bin, cp.help, { encoding: 'utf8' });
		text = String(r.stdout || '') + '\n' + String(r.stderr || '');
		ok = r.status === 0 && text.trim().length > 0;
	} catch (e) { ok = false; }

	if (!ok) {
		return { ok: false, helpFailed: true, missingCritical: [], missingOptional: [], blindSpots: cp.blindSpots || [] };
	}

	const missingCritical = [], missingOptional = [];
	(cp.requires || []).forEach(function (req) {
		if (text.indexOf(req.needle) === -1) {
			(req.critical ? missingCritical : missingOptional).push({ needle: req.needle, label: req.label });
		}
	});
	return {
		ok: missingCritical.length === 0 && missingOptional.length === 0,
		helpFailed: false,
		missingCritical: missingCritical,
		missingOptional: missingOptional,
		blindSpots: cp.blindSpots || []
	};
}

/**
 * One agent's canary + (when installed) version-floor and capability probe.
 * The probe and version floor need the CLI on disk, so they only run when the
 * agent is installed; the parser canary is offline and always runs.
 */
function checkOne(agent) {
	const detected = agent.detect() || {};
	return {
		id: agent.id,
		label: agent.label,
		installed: !!detected.available,
		canary: runCanary(agent),
		version: detected.available ? versionStatus(agent, detected) : null,
		probe: detected.available ? runProbe(agent) : null
	};
}

/** Every registered agent, checked. Used by the offline canary tool (test/). */
function checkAll(registry) {
	return registry.AGENTS.map(checkOne);
}

/**
 * The subset of a checkAll() report worth telling the user about: any canary
 * failure (a parser regression - loud, should never ship) and any installed CLI
 * newer than its tested floor (drift - the board may misbehave). Empty when all
 * is well, so the caller prints nothing.
 */
function problems(report) {
	const out = [];
	report.forEach(function (r) {
		if (r.canary && !r.canary.ok) {
			out.push({ id: r.id, label: r.label, kind: 'canary', failures: r.canary.failures });
		}
		if (r.probe && (r.probe.helpFailed || r.probe.missingCritical.length || r.probe.missingOptional.length)) {
			out.push({
				id: r.id, label: r.label, kind: 'capability',
				helpFailed: r.probe.helpFailed,
				critical: r.probe.missingCritical,
				degraded: r.probe.missingOptional
			});
		}
		if (r.installed && r.version && r.version.known && r.version.newer) {
			out.push({
				id: r.id, label: r.label, kind: 'version',
				installed: r.version.installed, tested: r.version.tested
			});
		}
	});
	return out;
}

module.exports = { parseVersion, versionStatus, runCanary, runProbe, checkOne, checkAll, problems };
