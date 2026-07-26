/**
 * MockFlow Bridge - election rules: holding a component choice to the USER's words.
 *
 * Some components may only be chosen when the request itself asks for them. The
 * clearest case is a clickable prototype: "create some UI" is a static wireframe,
 * and only the user's own interactive wording ("prototype", "interactive",
 * "clickable") turns it into a prototype. Every catalog and every engine prompt
 * has said so in prose for a while, and the choice still came back wrong - prose
 * is only as good as the model reading it, and this one is read while the model
 * is deciding what would be most impressive to build.
 *
 * So the rule is also DATA, and it is enforced. A catalog entry declares:
 *
 *   mcpRequiresUserWords:    ['prototype', 'interactive', ...]
 *   mcpRequiresFallbackTool: 'render_wireframelite'
 *
 * and every point where a component is ELECTED runs the choice past this module
 * (mcpEndpoint: declare_render, a direct render_* call, and each plan_board item).
 * An entry without the fields - or a catalog that predates them - passes through
 * untouched, so this is inert for every other component.
 *
 * JUDGED AGAINST THE USER'S OWN TEXT, never the agent's paraphrase of it: an
 * agent restating "create some UI" as "an interactive multi-screen app experience"
 * would otherwise satisfy the rule with words the user never said. When no user
 * text is known for the turn (a plan batch, a component fill, an external MCP
 * client with no chat turn behind it) there is nothing to judge against, and the
 * choice stands.
 */

/**
 * The floor: the same rules the catalog carries, for a catalog that does not
 * carry them yet.
 *
 * The catalog is fetched from MockFlow at startup and cached, so a bridge can
 * easily be running against a copy that is older than this engine - and that is
 * exactly how this bug reached users the first time (the deployed catalog was
 * months behind the repo, and nobody could see it from the bridge side). The
 * catalog ALWAYS wins where it speaks; this only fills a silence, and every use
 * of it is logged so the stale catalog is visible rather than papered over.
 * Delete an entry here once the served catalog carries the fields.
 */
const FLOOR = {
	render_prototypelite: {
		words: [
			'prototype', 'prototypes', 'prototyping',
			'interactive', 'interactivity', 'interactively',
			'clickable', 'click through', 'clickthrough',
			'navigable', 'tappable', 'tap through',
			'demo the flow', 'try the flow', 'walk through the flow',
			'working demo', 'click around'
		],
		fallback: 'render_wireframelite'
	}
};

function entryFor(registry, toolName) {
	if (!registry || !toolName) return null;
	for (var i = 0; i < registry.length; i++) {
		if (registry[i].mcpToolName === toolName) return registry[i];
	}
	return null;
}

/**
 * The rule for one tool: the catalog's own, or the engine floor when the catalog
 * says nothing. Returns null when this tool may be chosen freely.
 */
function rulesFor(registry, toolName) {
	const entry = entryFor(registry, toolName);
	if (!entry) return null;
	var words = entry.mcpRequiresUserWords;
	var fallback = entry.mcpRequiresFallbackTool;
	var source = 'catalog';
	if (!Array.isArray(words) || !words.length) {
		const floor = FLOOR[toolName];
		if (!floor) return null;
		words = floor.words;
		fallback = floor.fallback;
		source = 'engine';
	}
	// A correction has to have somewhere to go. Naming a fallback this catalog
	// does not serve would refuse the work and offer nothing in its place, so the
	// choice stands instead.
	if (!fallback || !entryFor(registry, fallback)) return null;
	return { words: words, fallback: fallback, source: source };
}

/** Words to compare on: lower case, punctuation flattened, space delimited. */
function _norm(text) {
	return ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/**
 * The first of `words` the text uses, or null. Word-wise, so "prototype" does not
 * match inside another word, and punctuation-insensitive, so "click-through",
 * "click through" and "Clickthrough," are all the one word the catalog lists.
 */
function mentions(text, words) {
	const hay = _norm(text);
	if (hay === '  ') return null;
	for (var i = 0; i < (words || []).length; i++) {
		const w = _norm(words[i]);
		if (w !== '  ' && hay.indexOf(w) !== -1) return words[i];
	}
	return null;
}

/**
 * Hold one elected tool to the user's words.
 *
 * @param {any[]}  registry  the loaded catalog
 * @param {string} toolName  the tool the agent elected
 * @param {string} userText  the user's OWN message for this turn ('' when unknown)
 * @returns {{tool:string, held:boolean, from?:string, words?:string[], matched?:string, source?:string}}
 *          `tool` is what should actually be used: unchanged unless `held`.
 */
function hold(registry, toolName, userText) {
	const rule = rulesFor(registry, toolName);
	if (!rule) return { tool: toolName, held: false };
	// Nothing of the user's to judge against: not a chat turn, a plan batch running
	// from briefs, or a component the user themselves opened. The choice stands.
	if (!String(userText || '').trim()) return { tool: toolName, held: false };
	const matched = mentions(userText, rule.words);
	if (matched) return { tool: toolName, held: false, matched: matched };
	return {
		tool: rule.fallback,
		held: true,
		from: toolName,
		words: rule.words,
		source: rule.source
	};
}

/** "prototype", "interactive" or "clickable" - the first few, for a message. */
function wordsPhrase(words, max) {
	const some = (words || []).slice(0, max || 3).map(function(w) { return '"' + w + '"'; });
	if (!some.length) return '';
	if (some.length === 1) return some[0];
	return some.slice(0, -1).join(', ') + ' or ' + some[some.length - 1];
}

module.exports = {
	hold: hold,
	rulesFor: rulesFor,
	mentions: mentions,
	wordsPhrase: wordsPhrase
};
