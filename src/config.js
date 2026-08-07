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
	'http://127.0.0.1:8080',
	// The MockFlow desktop app. Its editor is loaded from file://, which browsers
	// present as Origin "file://" (or "null") - allow-listing that would let any
	// local .html the user happens to open reach the bridge. Instead the desktop
	// app rewrites the Origin of its own bridge handshake to this synthetic value
	// (webRequest.onBeforeSendHeaders in main.js), which no web page can forge.
	'mockflow-desktop://app'
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

	// Basic (free) plan: max live generations per local day through the bridge.
	// A generation is one component/board actually drawn (see generationCap.js).
	// Fixed - not user-overridable. Pro/trial users are never metered.
	BASIC_DAILY_GEN_CAP: 30,
	// Daily generation counter for the basic-plan cap ({ date, count }).
	GEN_CAP_FILE: path.join(HOME_DIR, 'bridge-gencount.json'),

	// The catalog endpoint (Engine + Catalog split): tool definitions, prompts,
	// schemas and mapping rules are fetched from MockFlow at startup so new AI
	// components ship without an npm publish. The fetched copy is cached locally;
	// if the endpoint is unreachable and there is no cache yet, startup fails.
	CATALOG_URL: CATALOG_URL,
	CATALOG_FETCH_TIMEOUT_MS: 6000,
	// A catalog served from this machine is usually starting up alongside the bridge,
	// so the loader waits it out instead of falling back to a stale cache (catalog.js).
	LOCAL_CATALOG: LOCAL_CATALOG,

	TOOL_TIMEOUT_MS: 60000,
	// HTML-conversion tools (render_wireframelite / render_prototypelite): the tab
	// runs a server-side HTML render (Puppeteer) or an S3 upload before drawing,
	// so these calls legitimately take far longer than a plain draw.
	HTML_TOOL_TIMEOUT_MS: 180000,
	// How long the AGENT is told to wait on one of this server's tool calls.
	//
	// The CLIs time MCP calls out on their own clock, and their default is around
	// a minute - shorter than several tools here legitimately take (a modify runs
	// a whole component AI turn in the tab; an HTML render runs Puppeteer). When
	// the agent gives up first the bridge is still working, so the tool "fails",
	// the agent retries, and the same expensive work runs twice - twice the
	// credits, and a component modified two times over. This must therefore stay
	// comfortably ABOVE the longest timeout above; the bridge's own timeouts stay
	// the ones that decide when a call has really failed.
	AGENT_TOOL_TIMEOUT_MS: 600000,
	READ_TIMEOUT_MS: 20000,
	// read_board_component: a component past the read cap is condensed by MockFlow
	// (a small model call in the tab's server round trip) instead of being cut off,
	// so this one read can legitimately outlast a plain board read. The tab gives
	// up on the summary at 45s and answers with the truncated content, so this only
	// has to stay clear of that.
	READ_COMPONENT_TIMEOUT_MS: 90000,
	// Web grounding (fetch_webpage / extract_website_styles /
	// extract_website_images): the tab relays to MockFlow, which fetches the site
	// itself - and a style extraction fans out to several stylesheet downloads on
	// top of the page, so it is slower than a board read. Must stay ABOVE the
	// tab's own 60s extractor timeout (rtc.webExtractCall): if the two tie, the
	// bridge fires first and blames the tab connection for a slow site.
	WEB_TOOL_TIMEOUT_MS: 75000,
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
	PLAN_PICK_TIMEOUT_MS: 30 * 60 * 1000,

	// How many items of a confirmed board plan are rendered AT THE SAME TIME.
	//
	// Composing a component is the slow part of a batch, and it is the agent
	// writing it out token by token - so one turn rendering ten items takes ten
	// times as long as one item, however fast the machine is. MockFlow AI does not
	// have this problem because its screens are separate model calls it fires
	// together (genui's multipage phase 2), and this is the local equivalent: one
	// agent process per item, this many at a time. Each is an independent CLI run
	// billed to the user's own agent subscription, so the ceiling is deliberately
	// modest - it is their machine, their rate limits and their laptop fan.
	// MFBRIDGE_PLAN_CONCURRENCY=1 restores the old single sequential turn.
	PLAN_CONCURRENCY: Math.max(1, Math.min(6,
		parseInt(process.env.MFBRIDGE_PLAN_CONCURRENCY || '3', 10) || 3))
};
