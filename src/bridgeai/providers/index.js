/**
 * BridgeAI provider registry.
 *
 * Each provider is one small file holding its config + its own baseURL glue (and
 * room for provider-specific request hooks). They ALL feed one shared client
 * (../client.js) and runner (../run.js) — every provider here speaks the same
 * OpenAI Chat Completions protocol, so the protocol logic is written once, not
 * per provider. Only data and thin glue live per-file.
 *
 * Add an OpenAI-compatible service = add a file + one require here.
 * A provider that speaks a DIFFERENT protocol (native Bedrock Converse, Gemini
 * native, Anthropic Messages) does NOT belong here — that needs its own client.
 */

const fs = require('fs');
const config = require('../../config');

const openrouter = require('./openrouter');
const azure = require('./azure');
const bedrock = require('./bedrock');

const PROVIDERS = { openrouter: openrouter, azure: azure, bedrock: bedrock };

function get(id) { return PROVIDERS[id] || null; }
function all() { return Object.keys(PROVIDERS).map(function (k) { return PROVIDERS[k]; }); }

/**
 * Providers whose API key is present in the environment — i.e. usable right now.
 * Availability is gated on this so an unconfigured provider never enters agent
 * selection (keeps the existing claude/codex/opencode auto-select untouched).
 */
function configured(env) {
	env = env || process.env;
	return all().filter(function (p) { return !!env[p.keyEnv]; });
}

/** Auth headers, generic over the preset's authStyle. */
function authHeaders(preset, key) {
	if (preset.authStyle === 'api-key-header') return { 'api-key': key };
	return { Authorization: 'Bearer ' + key };   // 'bearer' (default)
}

/* ---- active-provider selection (shared by the adapter and the CLI) ---- */

function savedProvider() {
	try { return fs.readFileSync(config.BRIDGEAI_PROVIDER_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function saveProvider(id) {
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.BRIDGEAI_PROVIDER_FILE, String(id || ''));
	} catch (e) {}
}

/**
 * The provider a run will use: MFBRIDGE_PROVIDER -> saved -> the only configured
 * one. A chosen provider only wins if its key is actually set (never select one
 * we can't authenticate).
 */
function active(env) {
	env = env || process.env;
	const wanted = env.MFBRIDGE_PROVIDER || savedProvider();
	const w = wanted && get(wanted);
	if (w && env[w.keyEnv]) return w;
	const cfg = configured(env);
	return cfg.length ? cfg[0] : null;
}

module.exports = {
	PROVIDERS: PROVIDERS, get: get, all: all, configured: configured, authHeaders: authHeaders,
	savedProvider: savedProvider, saveProvider: saveProvider, active: active
};
