/**
 * Universal-tier adapters: any MCP-capable CLI agent from orca-sized config.
 *
 * The full adapters (claude/codex/opencode) each carry a per-vendor output
 * parser, MCP injection and allowlist translation - a real project per CLI,
 * verified live before listing (see index.js). This tier is the other end of
 * the trade: an adapter built from just a launch command and a
 * prompt-injection mode, exactly the surface orca needs to run "any CLI
 * agent". It became possible when turn success moved off stdout parsing and
 * onto the MCP calls the bridge itself serves (boardHub.noteToolServed):
 * a CLI the bridge understands nothing about can still be judged accurately -
 * calls arrived and it exited cleanly means drawn; nothing arrived means an
 * honest failure with a wiring hint, never a phantom success.
 *
 * What a universal agent gives up (the reason the full adapters stay the
 * premium tier): no per-turn MCP injection - the user wires the bridge into
 * the CLI once with its own `mcp add` (so draws target the selected board,
 * not a per-turn scoped URL); no tool timeline rows; no model label; no
 * session resume (the bridge-owned conversation record still rides every
 * prompt, so follow-ups mostly work); no per-turn tool allowlist (the system
 * prompt states the rules instead). Replies DO work when the CLI prints its
 * answer as plain text in headless mode (gemini -p, cursor-agent -p do):
 * parseLine treats plain stdout lines as the reply and drops JSON/log noise.
 *
 * `capabilities.parserless: true` is how the orchestrator knows this tier:
 * it skips the decide-then-draw declare step (whose value needs a readable
 * reply), defaults imagery to off instead of asking mid-turn, words the
 * no-calls-arrived failure as a wiring hint, and never counts these agents
 * against runtime parser health.
 *
 * LISTING RULES (same bar as index.js): an entry here is labelled "(basic)"
 * only after the live harnesses (test/fake-*.js) have been seen working with
 * it; until then it is labelled "(experimental)" and verified:false. Config
 * from vendor docs alone is how the first opencode adapter shipped broken.
 */

const fs = require('fs');
const config = require('../config');
const { spawnCli, spawnCliSync } = require('./spawnPortable');

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The bridge's unscoped MCP endpoint, for wiring hints and failure messages. */
function endpointUrl() {
	let token = '';
	try { token = fs.readFileSync(config.MCP_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
	return 'http://127.0.0.1:' + config.PORT + '/mcp/' + token;
}

/**
 * Build one universal adapter from config:
 *   id, label            label carries the tier: "(basic)" once live-verified,
 *                        "(experimental)" until then
 *   bin                  the executable on PATH
 *   promptFlag           e.g. '-p'; null means the prompt is the last positional
 *   baseArgs             always-on args (approval modes, output format)
 *   extraDirsFlag        per-dir flag granting read access, or null
 *   promptFileTool       the CLI's own file-read tool name, for the Windows
 *                        staged-prompt route; null falls back to stdin
 *   acceptsStdinPrompt   the CLI reads piped stdin as (part of) the prompt
 *   noiseLine(line)      optional: true for a stdout line that is CLI chatter,
 *                        not answer text
 *   install              one-line install hint
 *   wire(endpoint)       -> { title, lines[] } for the startup box; the first
 *                        line doubles as the in-turn wiring hint
 *   verified             live harnesses seen passing (index.js listing rule)
 *   testedVersion        set when verified, same meaning as the full adapters
 */
function makeUniversalAgent(cfg) {
	let _available = null;

	return {
		id: cfg.id,
		label: cfg.label,
		tier: 'universal',
		testedVersion: cfg.testedVersion || '',

		capabilities: {
			// The tier flag the orchestrator adapts on - see the file header.
			parserless: true,
			streamsPartialText: false,
			// Plain text lines are appended as they come, newlines intact.
			textChunks: 'delta',
			announcesToolsEarly: false,
			restrictTools: 'none',
			resume: 'none',
			systemPrompt: 'inline',
			systemPromptPerTurn: true,
			extraDirs: !!cfg.extraDirsFlag,
			acceptsStdinPrompt: cfg.acceptsStdinPrompt !== false,
			promptFileTool: cfg.promptFileTool || undefined
		},

		detect() {
			if (_available !== null) return _available;
			try {
				const r = spawnCliSync(cfg.bin, ['--version'], { encoding: 'utf8' });
				_available = { available: r.status === 0, version: (r.stdout || '').trim() };
			} catch (e) {
				_available = { available: false, version: '' };
			}
			return _available;
		},

		installHint() { return cfg.install; },

		mcpAddHint(endpoint) { return cfg.wire(endpoint); },

		/** One line for the "no board calls arrived" turn failure. */
		wiringHint() {
			const w = cfg.wire(endpointUrl());
			return (w.lines && w.lines[0]) || '';
		},

		/**
		 * One turn as a command line. The system prompt is merged into the prompt
		 * text - this tier assumes no per-turn config channel. On Windows its
		 * newlines become spaces (it is prose), because the merged text rides the
		 * cmd.exe command line; the turn's own large/multi-line content already
		 * arrives via the staged-file or stdin route (_deliverPrompt).
		 */
		buildArgs(turn) {
			const args = (cfg.baseArgs || []).slice();
			let text = (turn.systemPrompt ? turn.systemPrompt + '\n\nTHE REQUEST:\n' : '') + (turn.prompt || '');
			if (process.platform === 'win32') text = text.replace(/\r?\n/g, ' ');
			(turn.extraDirs || []).forEach(function(dir) {
				if (dir && cfg.extraDirsFlag) args.push(cfg.extraDirsFlag, dir);
			});
			// turn.resume deliberately unread: resume is 'none' for this tier.
			if (cfg.promptFlag) args.push(cfg.promptFlag, text);
			else args.push(text);
			return { args: args, env: {} };
		},

		spawn(args, opts) {
			return spawnCli(cfg.bin, args, opts);
		},

		/** No parsed tool events exist on this tier, so no timeline rows either. */
		isRunnableTool() { return false; },

		/**
		 * Plain stdout lines ARE the reply in these CLIs' headless modes. JSON
		 * lines are telemetry, not answer text; ANSI is stripped; per-CLI chatter
		 * is dropped via cfg.noiseLine.
		 */
		parseLine(line) {
			const t = String(line || '').replace(ANSI_RE, '').trim();
			if (!t) return [];
			if (t[0] === '{' || t[0] === '[') {
				try { JSON.parse(t); return []; } catch (e) { /* not JSON - keep it */ }
			}
			if (cfg.noiseLine && cfg.noiseLine(t)) return [];
			return [{ type: 'text', text: t + '\n' }];
		},

		selfTest: {
			lines: [
				{ line: 'Here is the answer.', expect: ['text'] },
				{ line: '{"event":"telemetry"}', expect: [] },
				{ line: '   ', expect: [] }
			]
		}
	};
}

/**
 * Gemini CLI. Headless via `-p`; the bridge is wired once with gemini's own
 * `mcp add` (user scope + --trust so headless tool calls run without an
 * approval prompt nobody is there to answer). `--include-directories` grants
 * read access to attachment folders; the staged Windows prompt file is read
 * with its read_file tool. Flags verified against gemini 0.54.0 --help.
 */
const gemini = makeUniversalAgent({
	id: 'gemini',
	label: 'Gemini CLI (basic)',
	bin: 'gemini',
	promptFlag: '-p',
	// --skip-trust: headless gemini refuses untrusted directories, and a turn's
	// cwd is the bridge scratch dir or the user's own --workspace - the same
	// folders every agent turn already reads, so trusting them for the session
	// is the existing trust model, not a widening of it.
	baseArgs: ['--skip-trust'],
	extraDirsFlag: '--include-directories',
	promptFileTool: 'read_file',
	acceptsStdinPrompt: true,
	noiseLine: function(t) {
		return /^(Loaded cached credentials|Initializing|Loading|Using model |Data collection is )/i.test(t);
	},
	install: 'Gemini CLI is not installed on this machine. Install it with: npm i -g @google/gemini-cli, '
		+ 'sign in once with `gemini`, then try again.',
	wire: function(endpoint) {
		return {
			title: 'Add to Gemini CLI (required once - this is how its turns reach the board):',
			lines: ['gemini mcp add -s user -t http --trust mockflow ' + endpoint]
		};
	},
	// Live-verified 2026-08-16 on 0.54.0: fake-chat (text reply parsed from
	// headless stdout) and fake-compgen (Gantt drawn over the user-wired HTTP
	// endpoint, filled in place). Needs GEMINI auth configured (API key or
	// OAuth) and the one-time `gemini mcp add` above.
	verified: true,
	testedVersion: '0.54.0'
});

/**
 * Cursor CLI (cursor-agent). Headless via `-p` with plain text output; the
 * bridge is declared once in ~/.cursor/mcp.json (no `mcp add` command).
 * EXPERIMENTAL: drafted from vendor docs, not yet seen passing the live
 * harnesses - which is exactly how adapters turn out wrong, so the label
 * says so until someone with it installed runs test/fake-*.js.
 */
const cursor = makeUniversalAgent({
	id: 'cursor',
	label: 'Cursor CLI (experimental)',
	bin: 'cursor-agent',
	promptFlag: '-p',
	baseArgs: ['--output-format', 'text'],
	extraDirsFlag: null,
	promptFileTool: null,
	acceptsStdinPrompt: true,
	install: 'Cursor CLI is not installed on this machine. Install it from https://cursor.com/cli, '
		+ 'sign in once with `cursor-agent login`, then try again.',
	wire: function(endpoint) {
		return {
			title: 'Add to Cursor CLI  (~/.cursor/mcp.json - required once):',
			lines: ['"mcpServers": { "mockflow": { "url": "' + endpoint + '" } }']
		};
	},
	verified: false,
	testedVersion: ''
});

module.exports = { makeUniversalAgent, gemini, cursor };
