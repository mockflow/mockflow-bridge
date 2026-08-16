/**
 * Runtime parser health, per agent.
 *
 * The boot-time checks in agents/health.js catch a bad parser edit (canary)
 * and a CLI that outgrew its tested version (floor). What neither can catch
 * is the thing that actually breaks in the field: the installed CLI changed
 * its OUTPUT FORMAT, so a live turn's stdout parses to nothing while the
 * turn itself still works. Since turn success is cross-checked against the
 * MCP calls the bridge served (the vendor-stable channel), a blind parser no
 * longer fails the product - but somebody has to be told the narration died,
 * or it silently rots.
 *
 * Detection is arithmetic on numbers every turn already produces
 * (agents/turnRunner.js stats + the hub's served-call counter):
 *
 *   parser blind      the CLI wrote plenty of stdout, the parser understood
 *                     none of it. Definitive in one turn when MCP calls
 *                     prove the agent was really working; needs two
 *                     consecutive such turns otherwise (one weird turn is
 *                     not a diagnosis).
 *   tool events blind the parser still reads SOMETHING (text, session) but
 *                     produced no tool-start while the bridge demonstrably
 *                     served tool calls - the sneakier partial drift. Two
 *                     consecutive turns to flag.
 *
 * Flags are persisted (per agent + CLI version) so the NEXT boot's banner
 * can say "output format not recognized since <date> on <version>" without
 * waiting for another turn to fail, and clear themselves the moment a turn
 * parses normally again (or the installed version changes - a fixed CLI
 * deserves a fresh look).
 */

const fs = require('fs');
const config = require('../config');

// Overridable so the offline tests never touch the user's real ~/.mockflow.
const FILE = process.env.MFBRIDGE_RUNTIME_HEALTH_FILE
	|| require('path').join(config.HOME_DIR, 'bridge-agent-runtime.json');

/** A turn too small to judge: a two-line "not logged in" answer says nothing
 *  about the parser. */
const MIN_LINES = 3;

let _state = null;

function _load() {
	if (_state) return _state;
	try { _state = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
	catch (e) { _state = {}; }
	return _state;
}

function _save() {
	try {
		fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
		// Temp-file + rename, same pattern as the adapters' config writes: a
		// half-written JSON file must never be what the next boot reads. Windows
		// rename onto an existing file can fail, so fall back to a plain write.
		const tmp = FILE + '.' + process.pid + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(_state, null, '\t'));
		try { fs.renameSync(tmp, FILE); }
		catch (e) { fs.writeFileSync(FILE, JSON.stringify(_state, null, '\t')); try { fs.unlinkSync(tmp); } catch (e2) {} }
	} catch (e) {}
}

/**
 * Judge one finished turn's stats. Pure - no state - so it is unit-testable
 * and callers can act on the verdict of THIS turn (synthesize a reply, keep a
 * failure honest) before the streak bookkeeping runs.
 *
 * stats: { stdoutLines, parsedEvents, toolStarts } (agents/turnRunner.js)
 * mcpServed: MCP tool calls the bridge served during this turn.
 */
function assessTurn(stats, mcpServed) {
	stats = stats || {};
	const lines = stats.stdoutLines || 0;
	const events = stats.parsedEvents || 0;
	const blind = lines >= MIN_LINES && events === 0;
	return {
		blind: blind,
		// Definitive on its own: the agent demonstrably worked (it called our
		// tools) while its whole output stream parsed to nothing.
		blindConfirmed: blind && mcpServed > 0,
		toolBlind: !blind && events > 0 && (stats.toolStarts || 0) === 0 && mcpServed > 0
	};
}

/**
 * Record one finished turn and update the agent's flags. Returns
 * { parserBlind, toolEventsBlind, changed } - `changed` is true when a flag
 * just tripped or cleared, so the caller can log it once instead of per turn.
 *
 * `expectParse` false marks a lane that deliberately does not read stdout
 * fully (or a turn with nothing to prove); it still clears flags on a healthy
 * parse but never trips one.
 */
function noteTurn(agentId, version, stats, mcpServed, expectParse) {
	const state = _load();
	const now = Date.now();
	let rec = state[agentId];
	if (!rec || rec.version !== String(version || '')) {
		// New CLI version (or first sight): old flags describe an output format
		// that may no longer be installed. Start clean and let the next turns speak.
		rec = state[agentId] = {
			version: String(version || ''), parserBlind: false, toolEventsBlind: false,
			since: 0, blindStreak: 0, toolBlindStreak: 0, turns: 0, lastTurnAt: 0
		};
	}
	rec.turns++;
	rec.lastTurnAt = now;

	const verdict = assessTurn(stats, mcpServed);
	const before = rec.parserBlind + ':' + rec.toolEventsBlind;

	if (verdict.blind && expectParse !== false) {
		rec.blindStreak++;
		if (verdict.blindConfirmed || rec.blindStreak >= 2) {
			if (!rec.parserBlind) rec.since = now;
			rec.parserBlind = true;
		}
	} else if ((stats && stats.parsedEvents > 0) || !verdict.blind) {
		// Any turn the parser read normally clears the alarm - including a short
		// one below MIN_LINES, which parsed fine as far as it went.
		if ((stats && stats.parsedEvents > 0)) { rec.parserBlind = false; rec.blindStreak = 0; }
	}

	if (verdict.toolBlind && expectParse !== false) {
		rec.toolBlindStreak++;
		if (rec.toolBlindStreak >= 2) {
			if (!rec.toolEventsBlind) rec.since = rec.since || now;
			rec.toolEventsBlind = true;
		}
	} else if (stats && (stats.toolStarts || 0) > 0) {
		rec.toolEventsBlind = false; rec.toolBlindStreak = 0;
	}

	const changed = before !== (rec.parserBlind + ':' + rec.toolEventsBlind);
	_save();
	return { parserBlind: rec.parserBlind, toolEventsBlind: rec.toolEventsBlind, changed: changed };
}

/** The persisted flags for one agent, or null when it has never been flagged. */
function status(agentId) {
	const rec = _load()[agentId];
	if (!rec || (!rec.parserBlind && !rec.toolEventsBlind)) return null;
	return rec;
}

/**
 * Banner/dashboard entries in the same list agents/health.problems() feeds,
 * kind 'runtime'. Empty when the agent has no live flags.
 */
function problems(agent) {
	if (!agent) return [];
	const rec = status(agent.id);
	if (!rec) return [];
	return [{
		id: agent.id, label: agent.label, kind: 'runtime',
		parserBlind: !!rec.parserBlind, toolEventsBlind: !!rec.toolEventsBlind,
		version: rec.version, since: rec.since || 0
	}];
}

/** Drop everything (tests). */
function _reset() { _state = {}; try { fs.unlinkSync(FILE); } catch (e) {} }

module.exports = { assessTurn, noteTurn, status, problems, _reset, MIN_LINES: MIN_LINES, FILE: FILE };
