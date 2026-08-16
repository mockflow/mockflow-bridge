/**
 * Local agent registry.
 *
 * The bridge runs Mida / Concept Builder / component AI turns on a CLI agent
 * installed on the user's machine. Which CLI that is should be a detail: the
 * orchestration in agentManager.js talks to the contract below and never to a
 * specific tool's flags.
 *
 * ADDING AN AGENT
 * ---------------
 * Drop a module in this folder and add it to AGENTS. Nothing else in the bridge,
 * the editor tab or the MockFlow server changes. The module must export:
 *
 *   id, label
 *   capabilities   { streamsPartialText, announcesToolsEarly, restrictTools,
 *                    resume, systemPrompt, systemPromptPerTurn, extraDirs }
 *                  systemPromptPerTurn:false says the CLI reads the system prompt
 *                    only when a session is CREATED, so a resumed turn keeps the
 *                    first one for good. Say so and agentManager carries a turn's
 *                    own instructions in the message instead - do NOT assume the
 *                    flag or config key works on resume just because it is accepted
 *                    there; Codex accepts it and silently ignores it.
 *   detect()       -> { available, version }
 *   installHint()  -> what to tell the user when it is missing
 *   mcpAddHint(endpoint) -> { title, lines[] } shown at startup: how to point
 *                    this CLI at the bridge by hand. Optional, and only a
 *                    fallback - a catalog `agentWiring.<id>` overrides it
 *                    (src/catalog.js), so vendor syntax changes need no publish.
 *   buildArgs(turn)-> { args, env }   turn: { prompt, systemPrompt, allowedTools,
 *                                             resume, extraDirs[], partialMessages,
 *                                             mockflowTools[] - every board tool the
 *                                             catalog defines, for a CLI that cannot
 *                                             expand mcp__mockflow__* itself }
 *   spawn(args, opts) -> ChildProcess
 *   isRunnableTool(name, allowedTools, mockflowTools) -> boolean
 *   parseLine(line) -> [ {type:'session',id} | {type:'text',text}
 *                      | {type:'tool-start',id,name} | {type:'tool-end',id,ok} ]
 *   authFailureHint(text) -> string|null   Optional. A CLI that answers a turn
 *                    with a "sign in first" line instead of failing it can
 *                    recognise that text here; the orchestrator then surfaces the
 *                    returned message as the turn's error rather than as a reply.
 *
 * Capabilities are how the orchestrator adapts: it must never branch on `id`.
 * An agent that cannot restrict tools, resume a session or stream partial text
 * still works - agentManager falls back to prompt-level restriction, a fresh
 * session, or a single final chunk.
 *
 * WHAT AN ADAPTER MUST GET RIGHT vs WHAT MAY DEGRADE
 * --------------------------------------------------
 * Turn success is judged against the MCP calls the bridge itself served
 * (boardHub.noteToolServed / agentManager._mcpCounter), NOT against parseLine.
 * That splits the contract into two tiers:
 *
 *   load-bearing  detect(), buildArgs() (launch + MCP wiring + allowlist) and
 *                 spawn(). If these are right, turns draw and are verified,
 *                 whatever happens to the output stream.
 *   best-effort   parseLine()/parseStderr() feed the UX: streamed replies,
 *                 timeline rows, the model label, the resume session id. A
 *                 vendor changing its output format degrades these (held
 *                 replies, missing rows, fresh sessions) and is DETECTED -
 *                 agents/runtimeHealth.js counts lines-seen vs events-parsed
 *                 per live turn, flags a blind parser in the activity log, the
 *                 dashboard and the next boot's banner - but it no longer
 *                 fails the turn or fakes a success.
 *
 * The stream plumbing itself (buffering, stderr scanning, the stats) lives
 * once in agents/turnRunner.js; adapters only translate one line to events.
 * When a vendor DOES drift, the fix is usually one of three one-file edits:
 * parseLine (output shape), buildArgs (flag/config key - also updatable
 * without a publish via the catalog's agentWiring override, src/catalog.js),
 * or testedVersion + fixtures after re-verifying live.
 *
 * SELECTION
 * ---------
 * --agent <id> / MFBRIDGE_AGENT  ->  saved choice  ->  the only one installed
 * ->  ask once in the terminal when several are installed (never when there is
 * no TTY, where the first installed one wins and the choice is logged).
 */

const fs = require('fs');
const config = require('../config');

// Only CLIs whose every flow has been exercised end to end against a real board
// belong here. An adapter written from a vendor's documentation looks finished
// and is not: the first opencode one parsed an event schema that CLI never
// emits and exposed no board tools at all, and nothing said so until a live
// turn ran. Add a new one only after chat, a resumed turn and a component turn
// have each been seen drawing on a real board (test/fake-*.js).
// (The MCP-served cross-check now catches the draws-nothing case at runtime
// and a blind parser only degrades the UX - but that lowers the cost of a
// mistake, not the bar for listing: the live battery still runs first.)
const AGENTS = [
	require('./claude'),
	require('./codex'),
	require('./opencode'),
	// Universal tier (see ./universal.js): any MCP-capable CLI from an
	// orca-sized config - launch command + prompt flag - judged by the MCP
	// calls the bridge serves rather than by a per-vendor output parser.
	// Registered AFTER the full adapters so auto-select prefers the premium
	// tier, and labelled "(basic)" / "(experimental)" so every picker and
	// hint shows the tier honestly next to the well-tested entries.
	require('./universal').gemini,
	require('./universal').cursor,
	// BridgeAI (our own OpenAI-compatible agent) is LAST and only "available" when
	// a provider key is set, so it never disturbs the CLI agents' auto-select.
	require('../bridgeai')
];

function byId(id) {
	if (!id) return null;
	for (let i = 0; i < AGENTS.length; i++) {
		if (AGENTS[i].id === id) return AGENTS[i];
	}
	return null;
}

/** Every agent with its detection result, in registry (preference) order. */
function detectAll() {
	return AGENTS.map(function(a) {
		const d = a.detect() || {};
		return { agent: a, id: a.id, label: a.label, available: !!d.available, version: d.version || '' };
	});
}

function installed() {
	return detectAll().filter(function(r) { return r.available; });
}

function loadPreference() {
	try { return fs.readFileSync(config.AGENT_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function savePreference(id) {
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.AGENT_FILE, String(id || ''));
	} catch (e) {}
}

/**
 * Pick the agent for this run. `explicit` is the --agent flag or MFBRIDGE_AGENT.
 * Returns { agent, reason, choices } - agent is null when nothing is installed,
 * which is not fatal: the bridge still draws for external MCP clients, only the
 * in-editor local chat is unavailable.
 */
function resolve(explicit) {
	const found = installed();

	if (explicit) {
		const wanted = byId(explicit);
		if (!wanted) return { agent: null, reason: 'unknown-agent', choices: found };
		return { agent: wanted, reason: 'explicit', choices: found };
	}

	const saved = loadPreference();
	if (saved) {
		const savedAgent = found.filter(function(r) { return r.id === saved; })[0];
		if (savedAgent) return { agent: savedAgent.agent, reason: 'saved', choices: found };
	}

	if (found.length === 0) return { agent: null, reason: 'none-installed', choices: found };
	if (found.length === 1) return { agent: found[0].agent, reason: 'only-one', choices: found };
	return { agent: null, reason: 'ambiguous', choices: found };
}

module.exports = { AGENTS, byId, detectAll, installed, resolve, loadPreference, savePreference };
