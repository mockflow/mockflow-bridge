/**
 * BridgeAI model selection.
 *
 * Model choice is PER PROVIDER — the same model has a different id on each
 * service (anthropic/claude-sonnet-5 on OpenRouter, us.anthropic.claude-sonnet-4-6
 * on Bedrock, a deployment name on Azure) — so the saved choice is a map keyed by
 * provider id. This file owns: the saved store, resolution order, the /models
 * fetch + tool-capability filter, and boot validation.
 *
 * Board drawing IS function-calling, so a model that cannot call tools can never
 * draw — that is the one capability we filter the picker on and validate at boot.
 *
 * Every network path is offline-safe: a failed /models fetch returns null and the
 * caller degrades (trusts the id) rather than blocking startup.
 */

const fs = require('fs');
const config = require('../config');
const providers = require('./providers');

/* ---- saved store: ~/.mockflow/bridge-model.json = { <providerId>: <modelId> } ---- */

function loadSaved() {
	try { return JSON.parse(fs.readFileSync(config.BRIDGEAI_MODEL_FILE, 'utf8')) || {}; }
	catch (e) { return {}; }
}

function saveModel(providerId, modelId) {
	const map = loadSaved();
	map[providerId] = modelId;
	try {
		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		fs.writeFileSync(config.BRIDGEAI_MODEL_FILE, JSON.stringify(map, null, '\t'));
	} catch (e) {}
	return map;
}

/* ---- resolution: --model -> MFBRIDGE_MODEL -> saved[provider] -> preset default ---- */

/**
 * The model to use for `preset`, and where it came from. `source: 'unset'` with a
 * null model means the provider has no default and nothing was chosen — the caller
 * tells the user to run `mockflow-bridge model`.
 */
function resolveModel(preset, opts) {
	opts = opts || {};
	const env = opts.env || process.env;
	if (opts.flag) return { model: opts.flag, source: 'flag' };
	if (env.MFBRIDGE_MODEL) return { model: env.MFBRIDGE_MODEL, source: 'env' };
	const saved = (opts.saved || loadSaved())[preset.id];
	if (saved) return { model: saved, source: 'saved' };
	if (preset.defaultModel) return { model: preset.defaultModel, source: 'default' };
	return { model: null, source: 'unset' };
}

/* ---- /models fetch + tool-capability normalization ---- */

/**
 * Whether a /models entry can call tools. OpenRouter exposes `supported_parameters`
 * (an array that includes "tools"); providers that don't expose it yield null —
 * "unknown", which we do NOT treat as "incapable" (a real turn decides).
 */
function toolCapable(m) {
	const sp = m && m.supported_parameters;
	if (Array.isArray(sp)) return sp.indexOf('tools') !== -1;
	return null;
}

/**
 * GET <baseURL>/models, normalized to [{ id, toolCapable }]. Returns null when the
 * provider doesn't list models, a key/baseURL is missing, or the call fails — all
 * degrade gracefully.
 */
async function fetchModels(preset, key, baseURL) {
	if (!preset.listModels || !baseURL || !key) return null;
	try {
		const headers = Object.assign({ accept: 'application/json' },
			providers.authHeaders(preset, key), preset.extraHeaders || {});
		const res = await fetch(baseURL.replace(/\/+$/, '') + '/models', { headers: headers });
		if (!res.ok) return null;
		const body = await res.json();
		const data = (body && body.data) || [];
		return data.map(function (m) { return { id: m.id, toolCapable: toolCapable(m) }; });
	} catch (e) { return null; }
}

/** Tool-capable subset for the picker. If none report capability, show all (unknown ≠ excluded). */
function pickable(list) {
	if (!list) return [];
	const known = list.filter(function (m) { return m.toolCapable === true; });
	return known.length ? known : list;
}

/* ---- boot validation: cheap, metadata-only (no probe call) ---- */

/**
 * Validate the resolved (provider, key, model) at startup. Returns
 * { ok, warnings:[{level,msg}] } — `ok` is false only on error-level problems.
 * Uses /models metadata when available; never makes a chat/probe call.
 */
async function validate(preset, key, baseURL, model) {
	const warnings = [];
	if (!key) warnings.push({ level: 'error', msg: preset.label + ': ' + preset.keyEnv + ' not set' });
	if (!model) warnings.push({ level: 'error', msg: preset.label + ': no model selected — run `mockflow-bridge model`' });
	if (!key || !model) return { ok: false, warnings: warnings };

	const list = await fetchModels(preset, key, baseURL);
	if (list) {
		const hit = list.filter(function (m) { return m.id === model; })[0];
		if (!hit) {
			warnings.push({ level: 'warn', msg: preset.label + ': model "' + model + '" not found in /models' });
		} else if (hit.toolCapable === false) {
			warnings.push({ level: 'error', msg: preset.label + ': model "' + model + '" can\'t call tools — boards won\'t draw' });
		}
	}
	const errors = warnings.filter(function (w) { return w.level === 'error'; });
	return { ok: errors.length === 0, warnings: warnings };
}

module.exports = {
	loadSaved: loadSaved,
	saveModel: saveModel,
	resolveModel: resolveModel,
	fetchModels: fetchModels,
	toolCapable: toolCapable,
	pickable: pickable,
	validate: validate
};
