/**
 * MockFlow Bridge - catalog loader (the Catalog half of the Engine + Catalog split).
 *
 * The catalog is the component registry: MCP tool definitions, descriptions,
 * input schemas and the args-to-gdata mapping rules. It is fetched from a
 * MockFlow endpoint at startup so that new AI components and prompt updates
 * ship WITHOUT an npm publish. Load order:
 *
 *   1. remote  - CATALOG_URL (written to the local cache on success)
 *   2. cache   - last successfully fetched copy (~/.mockflow/bridge-catalog-cache.js)
 * If neither is available, load() throws (no snapshot ships in this package).
 *
 * The loaded module is a registry array exposing getToolDefinitions /
 * mapToolToGdata / sanitizeFlowData, so all consumers stay in lock-step via one
 * endpoint.
 *
 * A catalog may declare `minBridgeVersion`; when the running engine is older,
 * the bridge still starts but tells the user to update the package.
 */

const fs = require('fs');
const config = require('./config');
const log = require('./log');

function versionLessThan(a, b) {
	var pa = String(a).split('.').map(Number);
	var pb = String(b).split('.').map(Number);
	for (var i = 0; i < 3; i++) {
		var x = pa[i] || 0, y = pb[i] || 0;
		if (x < y) return true;
		if (x > y) return false;
	}
	return false;
}

function requireFresh(file) {
	delete require.cache[require.resolve(file)];
	return require(file);
}

function validateRegistry(registry) {
	return registry && Array.isArray(registry)
		&& typeof registry.getToolDefinitions === 'function'
		&& typeof registry.mapToolToGdata === 'function'
		&& registry.length > 0;
}

async function fetchRemote() {
	const controller = new AbortController();
	const timer = setTimeout(function() { controller.abort(); }, config.CATALOG_FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(config.CATALOG_URL, { signal: controller.signal });
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		const text = await resp.text();
		if (text.indexOf('module.exports') === -1) throw new Error('not a catalog module');

		fs.mkdirSync(config.HOME_DIR, { recursive: true });
		// Write-then-rename so a crash mid-write never corrupts the cache.
		const tmp = config.CATALOG_CACHE_FILE + '.tmp';
		fs.writeFileSync(tmp, text);
		const registry = requireFresh(tmp);
		if (!validateRegistry(registry)) throw new Error('catalog failed validation');
		fs.renameSync(tmp, config.CATALOG_CACHE_FILE);
		return requireFresh(config.CATALOG_CACHE_FILE);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Load the catalog: remote endpoint first, then the last cached copy. Throws a
 * clear error if neither is available (the package ships no bundled snapshot).
 * @returns {Promise<{registry: any[], source: string}>}
 */
async function load() {
	try {
		const registry = await fetchRemote();
		log('Catalog: loaded from ' + config.CATALOG_URL + ' (' + registry.length + ' entries)');
		warnIfEngineOld(registry);
		return { registry: registry, source: 'remote' };
	} catch (err) {
		log('Catalog: remote fetch unavailable (' + (err && err.message) + '), trying cache');
	}

	try {
		if (fs.existsSync(config.CATALOG_CACHE_FILE)) {
			const registry = requireFresh(config.CATALOG_CACHE_FILE);
			if (validateRegistry(registry)) {
				log('Catalog: loaded from cache (' + registry.length + ' entries)');
				warnIfEngineOld(registry);
				return { registry: registry, source: 'cache' };
			}
		}
	} catch (err) {
		log('Catalog: cache unusable (' + (err && err.message) + ')');
	}

	throw new Error(
		'Could not load the MockFlow tool catalog. The endpoint ' + config.CATALOG_URL
		+ ' is unreachable and there is no local cache yet. Connect to the internet and start the '
		+ 'bridge once to fetch and cache it, or set MFBRIDGE_CATALOG_URL to a reachable catalog.');
}

function warnIfEngineOld(registry) {
	if (registry.minBridgeVersion && versionLessThan(config.ENGINE_VERSION, registry.minBridgeVersion)) {
		log('WARNING: this catalog needs bridge >= ' + registry.minBridgeVersion
			+ ' but you are running ' + config.ENGINE_VERSION
			+ '. Some tools may not work - update with: npm i -g @mockflow/mockflow-bridge');
	}
}

module.exports = { load: load };
