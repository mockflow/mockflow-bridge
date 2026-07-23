/**
 * MockFlow Bridge - configuration.
 *
 * Everything is overridable via environment variables so dev setups and the
 * (future) editor-side integration can point at non-default ports/endpoints.
 */

const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.mockflow');

// Default port deliberately clear of the other MockFlow local servers:
// 21193 (desktop IdeaBoard MCP), 21194 (desktop WireframePro MCP), 21895 (AgentBoard).
const DEFAULT_PORT = 21196;

const DEV = process.env.MFBRIDGE_DEV === '1';

const CATALOG_URL = process.env.MFBRIDGE_CATALOG_URL
	|| 'https://app.mockflow.com/call/api/mcpcatalog/ideaboard';

// Debug tracing (src/debug.js): print everything the agent generates for a
// render_* call plus the conversion diagnostics that come back, and dump the
// payloads to ~/.mockflow/bridge-debug. ON by default when the catalog points
// at a local MockFlow (a dev setup); MFBRIDGE_DEBUG=1/0 forces it on/off.
const LOCAL_CATALOG = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(CATALOG_URL);
const DEBUG = process.env.MFBRIDGE_DEBUG === '1'
	|| (process.env.MFBRIDGE_DEBUG !== '0' && LOCAL_CATALOG);

// Origins allowed to open the /board WebSocket. The bridge draws on whatever
// board connects, so this list is a real security boundary: only MockFlow
// editor origins (plus localhost/file in dev mode) may register as boards.
var allowedOrigins = [
	'https://app.mockflow.com',
	'https://www.mockflow.com',
	'https://mockflow.com',
	// Developer test mode: a locally served editor build on port 8080. Harmless
	// in production - a remote website can never present a localhost Origin.
	'http://localhost:8080',
	'http://127.0.0.1:8080'
];
if (process.env.MFBRIDGE_ALLOWED_ORIGINS) {
	process.env.MFBRIDGE_ALLOWED_ORIGINS.split(',').forEach(function(o) {
		o = o.trim();
		if (o) allowedOrigins.push(o);
	});
}

module.exports = {
	ENGINE_VERSION: require('../package.json').version,
	PKG_NAME: require('../package.json').name,

	HOST: '127.0.0.1',
	PORT: parseInt(process.env.MFBRIDGE_PORT || String(DEFAULT_PORT), 10),

	DEV: DEV,
	DEBUG: DEBUG,
	ALLOWED_ORIGINS: allowedOrigins,

	HOME_DIR: HOME_DIR,
	DEBUG_DIR: path.join(HOME_DIR, 'bridge-debug'),
	PORT_FILE: path.join(HOME_DIR, 'bridge-port'),
	TOKENS_FILE: path.join(HOME_DIR, 'bridge-tokens.json'),
	// Secret in the MCP endpoint path. The endpoint is plain local HTTP with no
	// other authentication, so without it any process - including any web page
	// the user has open, via a cross-origin POST - could drive the board tools
	// and now read the user's connected sources through them.
	MCP_TOKEN_FILE: path.join(HOME_DIR, 'bridge-mcp-token'),
	// Which local agent CLI the user picked when several are installed.
	AGENT_FILE: path.join(HOME_DIR, 'bridge-agent'),
	// Session-scoped chat attachments, one folder per board (agentManager.js).
	ATTACHMENTS_DIR: path.join(HOME_DIR, 'attachments'),
	CATALOG_CACHE_FILE: path.join(HOME_DIR, 'bridge-catalog-cache.js'),
	// Last-known latest version on npm, written by a background check (updateCheck.js)
	// so the "you are behind" notice is instant and offline-safe on the next start.
	UPDATE_CACHE_FILE: path.join(HOME_DIR, 'bridge-update-check.json'),
	// BridgeAI selection: the active OpenAI-compatible provider, and the chosen
	// model PER provider ({ <providerId>: <modelId> } — ids are not portable).
	BRIDGEAI_PROVIDER_FILE: path.join(HOME_DIR, 'bridge-provider'),
	BRIDGEAI_MODEL_FILE: path.join(HOME_DIR, 'bridge-model.json'),

	// The catalog endpoint (Engine + Catalog split): tool definitions, prompts,
	// schemas and mapping rules are fetched from MockFlow at startup so new AI
	// components ship without an npm publish. The fetched copy is cached locally;
	// if the endpoint is unreachable and there is no cache yet, startup fails.
	CATALOG_URL: CATALOG_URL,
	CATALOG_FETCH_TIMEOUT_MS: 6000,

	TOOL_TIMEOUT_MS: 60000,
	// HTML-conversion tools (render_wireframelite / render_prototypelite): the tab
	// runs a server-side HTML render (Puppeteer) or an S3 upload before drawing,
	// so these calls legitimately take far longer than a plain draw.
	HTML_TOOL_TIMEOUT_MS: 180000,
	READ_TIMEOUT_MS: 20000,
	// Connected-source calls (list_source_tools / call_source_tool): the tab
	// relays to MockFlow, which runs the third-party API call (Notion, Jira,
	// Composio), so these are slower than a board read but never as slow as a
	// full HTML render.
	SOURCE_TIMEOUT_MS: 120000,
	// Ceiling for one attached file written to disk (the tab sends it base64 over
	// the local socket). Nothing is uploaded, so the useful limit is disk safety.
	MAX_ATTACHMENT_BYTES: 40 * 1024 * 1024,
	PAIR_TIMEOUT_MS: 5 * 60 * 1000,
	// plan_board batches: a plan that is not completed within this window is
	// discarded (the agent likely gave up), so stale plans never re-arrange a
	// later, unrelated batch of draws.
	PLAN_TIMEOUT_MS: 10 * 60 * 1000,
	// plan_board selection step: how long the picker stays answerable in the
	// tab. The agent's plan_board call returns IMMEDIATELY (its turn ends at
	// the proposal); the user's Generate Board click later triggers the
	// generation turn, so this only bounds how long an ignored picker lingers.
	PLAN_PICK_TIMEOUT_MS: 30 * 60 * 1000
};
