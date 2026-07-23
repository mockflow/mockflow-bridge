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
 *                    resume, systemPrompt, extraDirs }
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
 *
 * Capabilities are how the orchestrator adapts: it must never branch on `id`.
 * An agent that cannot restrict tools, resume a session or stream partial text
 * still works - agentManager falls back to prompt-level restriction, a fresh
 * session, or a single final chunk.
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
const AGENTS = [
	require('./claude'),
	require('./codex'),
	require('./opencode'),
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
