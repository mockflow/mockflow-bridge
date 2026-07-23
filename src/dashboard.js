/**
 * MockFlow Bridge — full-screen terminal dashboard.
 *
 * A non-dev-friendly control panel that replaces scrolling logs when the bridge
 * runs in a real terminal: a status header, a live Activity feed, and one-key
 * menus to change agent / provider / model / board, view details/help, or quit.
 * The daemon only launches this when stdout is a TTY; otherwise it keeps the
 * plain banner + line output (piped / CI / headless).
 *
 * Renders to stdout in the alternate screen buffer; input is raw-mode keypresses
 * on stdin; log() output is captured into Activity so it never corrupts the view.
 * All hand-rolled ANSI — no new dependency.
 */

const readline = require('readline');
const ui = require('./ui');
const log = require('./log');
const providers = require('./bridgeai/providers');
const baiModels = require('./bridgeai/models');
const updateCheck = require('./updateCheck');
const health = require('./agents/health');

/* ------------------------------------------------------------ ANSI ---- */
const E = '\x1b[';
const ALT_ON = E + '?1049h', ALT_OFF = E + '?1049l';
const CUR_HIDE = E + '?25l', CUR_SHOW = E + '?25h';
const HOME = E + 'H', CLR_BELOW = E + '0J';
const WRAP_OFF = E + '?7l', WRAP_ON = E + '?7h';   // auto-wrap off while we own the screen (keeps the header fixed)
// ?1002h = button-event tracking: press, release, wheel AND motion-while-a-button-
// is-held (drag). ?1000h alone omits the drag reports, so a selection could never
// grow past its first line. ?1006h = SGR encoding.
const MOUSE_ON = E + '?1002h' + E + '?1006h';
const MOUSE_OFF = E + '?1006l' + E + '?1002l';

const ON = ui.out.enabled;
const RESET = E + '0m';
function hasTrue() { return /truecolor|24bit/i.test(process.env.COLORTERM || ''); }
function rgb256(r, g, b) { return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5); }
function fg(rgb) { return hasTrue() ? E + '38;2;' + rgb[0] + ';' + rgb[1] + ';' + rgb[2] + 'm' : E + '38;5;' + rgb256(rgb[0], rgb[1], rgb[2]) + 'm'; }
function bg(rgb) { return hasTrue() ? E + '48;2;' + rgb[0] + ';' + rgb[1] + ';' + rgb[2] + 'm' : E + '48;5;' + rgb256(rgb[0], rgb[1], rgb[2]) + 'm'; }

// Exact prototype / ui.js palette — dark-committed for now. The dashboard PAINTS
// P.bg itself so it looks like the prototype on any terminal (dark or light). A
// future light theme is a matter of swapping this one table (and picking it by a
// setting / prefers-color-scheme).
const P = {
	bg:    [ 13,  17,  23],  // #0d1117 — painted as the dashboard background
	fg:    [201, 209, 217],  // #c9d1d9
	dim:   [110, 118, 129],  // #6e7681
	white: [240, 246, 252],  // #f0f6fc
	cyan:  [ 86, 212, 221],  // #56d4dd
	green: [ 63, 185,  80],  // #3fb950
	amber: [214, 160,  42],  // #d6a02a
	red:   [248,  81,  73]   // #f85149
};
// Colored tokens reset to BASE FG (not a full reset) so the dark background the
// frame establishes stays behind them; attributes turn off with their own codes.
function tint(rgb, s) { return ON ? fg(rgb) + s + fg(P.fg) : String(s); }
function attr(code, s) { var off = code === '1' ? '22' : code === '7' ? '27' : '0'; return ON ? E + code + 'm' + s + E + off + 'm' : String(s); }
const C = {
	dim:   function (s) { return tint(P.dim, s); },
	gray:  function (s) { return tint(P.dim, s); },
	white: function (s) { return tint(P.white, s); },
	cyan:  function (s) { return tint(P.cyan, s); },
	green: function (s) { return tint(P.green, s); },
	amber: function (s) { return tint(P.amber, s); },
	red:   function (s) { return tint(P.red, s); },
	bold:  function (s) { return attr('1', s); },
	inv:   function (s) { return attr('7', s); }
};
const BG = ON ? bg(P.bg) : '';
const BASEFG = ON ? fg(P.fg) : '';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function vlen(s) { return String(s).replace(ANSI_RE, '').length; }
function padEnd(s, n) { var p = n - vlen(s); return p > 0 ? s + new Array(p + 1).join(' ') : s; }
function clip(s, n) {
	if (vlen(s) <= n) return s;
	// strip-safe truncate (assumes coloring wraps whole tokens — our lines are simple)
	var plain = String(s).replace(ANSI_RE, '');
	return plain.slice(0, Math.max(0, n - 1)) + '…';
}
// A drawn row must be ONE physical line — strip any vertical-motion control char so
// the terminal can never be told to move the cursor down mid-row (which is the only
// thing that scrolls). ANSI colour escapes (\x1b[..m) are preserved.
function safeLine(s) { return String(s).replace(/[\r\n\v\f\u0085\u2028\u2029]/g, " "); }

/* ------------------------------------------------------------ state --- */
let hub, agents, registry, ctx;
let mode = 'dashboard';          // dashboard | agent | provider | model | board | details | help | quit
let sel = 0, items = [];
let activity = [];               // { g, cls, text }
let scrollOff = 0;               // lines scrolled up from the live bottom (0 = follow live)
let boardsSnap = [];
let healthWarn = null;
let modelState = null;           // { loading, list, err } while the model picker is open
let tick = null, active = false;
let screenWrite = null, origOut = null, origErr = null, capBuf = '';
// Copy-on-select over the Activity feed (opencode-style): mouse capture stays on
// (so the wheel still scrolls), and we do the selection ourselves - drag over the
// feed to highlight lines, and on release the text is copied to the system
// clipboard via OSC 52 (works over SSH too). `y` yanks the whole feed.
// feedTop/feedStartI/feedCount map a screen row to an activity line; sel* hold the
// live line selection as absolute indices into `activity`.
let feedTop = 0, feedStartI = 0, feedCount = 0;
let selecting = false, selAnchor = 0, selHead = 0;
let copiedMsg = '', copiedTimer = null;   // transient "✓ copied" note in the ACTIVITY header

// The bridge mark. Box-drawing line chars sit at the cell's vertical center, so it
// reads a touch low next to baseline text — an accepted font-metrics tradeoff.
const BICON = '╤═╤';
const MAX_ACT = 500;

/* ------------------------------------------------------------ start --- */
function start(opts) {
	hub = opts.hub; agents = opts.agents; registry = opts.registry; ctx = opts;
	active = true;
	healthWarn = warnFromProblems(opts.healthProblems);

	// route log() into the feed
	log.setSink(function (line) { pushAct('·', 'sys', String(line).replace(/^\[bridge[^\]]*\]\s*/, '')); });

	// tap activity: wrap the daemon's per-turn callbacks so we see each step
	tapCallback('onChat'); tapCallback('onCompGen'); tapCallback('onPlanGenerate');

	// seed
	boardsSnap = boardIds();
	pushAct('◦', 'sys', 'Bridge ready. ' + (boardsSnap.length ? boardsSnap.length + ' board(s) connected.' : 'Waiting for a board to pair.'));

	// Capture any OTHER stdout/stderr writes (logs, debug dumps, stray console.*)
	// into the scrolling Activity feed — nothing corrupts the screen, and output
	// scrolls inside the TUI (like opencode). The dashboard renders via the saved
	// real writer (scr), which bypasses this capture.
	origOut = process.stdout.write.bind(process.stdout);
	origErr = process.stderr.write.bind(process.stderr);
	screenWrite = origOut;
	process.stdout.write = capture;
	process.stderr.write = capture;

	// terminal setup
	scr(ALT_ON + CUR_HIDE + WRAP_OFF + MOUSE_ON + BG + (ON ? E + '2J' : ''));   // dark canvas, no wrap-scroll, mouse wheel captured
	readline.emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.on('keypress', onKey);
	process.stdin.on('data', onMouseData);   // parse SGR wheel events ourselves
	process.stdout.on('resize', render);
	process.on('exit', restoreScreen);

	tick = setInterval(pollAndRender, 1000);
	render();
}

function boardIds() { return hub.listBoards().map(function (b) { return b.projectid || b.title; }); }

/** Write to the real screen (bypasses the capture below). */
function scr(s) { (screenWrite || process.stdout.write.bind(process.stdout))(s); }

/** Parse SGR mouse reports: `\x1b[<b;x;y M` (press/motion) or `...m` (release).
 *  Button 64/65 = wheel up/down; 0 = left press; 32 = left drag; release ends a
 *  selection. Anything else ignored. Coordinates are 1-based. */
function onMouseData(buf) {
	try {
		var s = buf.toString('latin1');
		var re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, m;
		while ((m = re.exec(s))) {
			var b = parseInt(m[1], 10), y = parseInt(m[3], 10), press = m[4] === 'M';
			if (b === 64) wheel(-1);
			else if (b === 65) wheel(1);
			else if (b === 0 && press) selStart(y);
			else if (b === 32 && press) selDrag(y);
			else if (!press) selEnd();
		}
	} catch (e) {}
}
function wheel(dir) {
	if (!active || mode !== 'dashboard') return;
	scrollOff = dir < 0 ? scrollOff + 3 : Math.max(0, scrollOff - 3);   // 3 lines per notch
	render();
}

/** Screen row (1-based) -> absolute activity index, or -1 if the row is not a feed line. */
function rowToActivity(y) {
	var li = (y - 1) - feedTop;
	if (li < 0 || li >= feedCount) return -1;
	return feedStartI + li;
}
function selStart(y) {
	if (!active || mode !== 'dashboard') return;
	var idx = rowToActivity(y);
	if (idx < 0) return;
	selecting = true; selAnchor = selHead = idx; render();
}
function selDrag(y) {
	if (!selecting) return;
	var li = Math.max(0, Math.min(feedCount - 1, (y - 1) - feedTop));
	selHead = feedStartI + li; render();
}
function selEnd() {
	if (!selecting) return;
	selecting = false;
	var lo = Math.min(selAnchor, selHead), hi = Math.max(selAnchor, selHead);
	var text = activity.slice(lo, hi + 1).map(function (a) {
		return (a.t + ' ' + a.g + ' ' + a.text).replace(ANSI_RE, '').replace(/\s+$/, '');
	}).join('\n');
	copyToClipboard(text, (hi - lo + 1));
	render();
}
/** yank the whole feed to the clipboard (opencode-style keyboard copy). */
function yankFeed() {
	var text = activity.map(function (a) {
		return (a.t + ' ' + a.g + ' ' + a.text).replace(ANSI_RE, '').replace(/\s+$/, '');
	}).join('\n');
	copyToClipboard(text, activity.length);
}
/** Copy to the system clipboard via OSC 52 - no native clipboard dep, works over SSH.
 *  Confirmation shows briefly in the ACTIVITY header, NOT as a feed line (which would
 *  land in the very text being copied). */
function copyToClipboard(text, n) {
	if (!text) return;
	try {
		var b64 = Buffer.from(String(text), 'utf8').toString('base64');
		scr('\x1b]52;c;' + b64 + '\x07');
		flashCopied('✓ copied ' + n + ' line' + (n === 1 ? '' : 's'));
	} catch (e) {
		flashCopied('copy failed');
	}
}
function flashCopied(msg) {
	copiedMsg = msg;
	clearTimeout(copiedTimer);
	copiedTimer = setTimeout(function () { copiedMsg = ''; if (active) render(); }, 2000);
	render();
}

/** Replacement for process.stdout/stderr.write while the TUI is up: split into
 *  lines and push each into the scrolling feed instead of hitting the screen. */
function capture(chunk, enc, cb) {
	try {
		capBuf += (typeof chunk === 'string') ? chunk : chunk.toString('utf8');
		var nl;
		while ((nl = capBuf.indexOf('\n')) >= 0) {
			var line = capBuf.slice(0, nl); capBuf = capBuf.slice(nl + 1);
			var clean = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '').replace(/\s+$/, '')
				.replace(/^\[bridge[^\]]*\]\s*/, '');
			if (clean) pushAct('·', 'sys', clean);
		}
	} catch (e) {}
	var done = (typeof enc === 'function') ? enc : cb;
	if (typeof done === 'function') done();
	return true;
}

function pollAndRender() {
	// detect board connect/disconnect for the feed
	var now = boardIds(), prev = boardsSnap;
	now.forEach(function (id) { if (prev.indexOf(id) === -1) pushAct('＋', 'ok', 'Board connected: ' + label(id)); });
	prev.forEach(function (id) { if (now.indexOf(id) === -1) pushAct('－', 'dim', 'Board disconnected: ' + label(id)); });
	boardsSnap = now;
	render();
}
function label(id) {
	var b = hub.listBoards().filter(function (x) { return (x.projectid || x.title) === id; })[0];
	return (b && (b.title || b.projectid)) || id;
}

/* ------------------------------------------------------- activity tap - */
function tapCallback(name) {
	var orig = hub[name];
	if (typeof orig !== 'function') return;
	hub[name] = function () {
		var args = Array.prototype.slice.call(arguments);
		var tab = args[0], send = args[2];
		if (typeof send === 'function') {
			var board = (tab && (tab.title || tab.projectid)) || null;
			args[2] = function (frame) { onFrame(board, frame); return send(frame); };
		}
		return orig.apply(hub, args);
	};
}
var openSteps = {};
function onFrame(board, f) {
	if (!f || !f.t) return;
	if (f.t === 'chat-step' || f.t === 'compgen-step' || f.t === 'plan-step') {
		var step = f.step || {};
		if (step.phase === 'start') {
			openSteps[step.stepId] = step.label || 'working';
			var on = board ? ' on ' + C.white('“' + board + '”') : '';
			pushAct('…', 'run', (step.label || 'Working') + (step.detail ? ' · ' + step.detail : '') + on);
		} else if (step.phase === 'end') {
			var lab = openSteps[step.stepId] || 'Done';
			delete openSteps[step.stepId];
			if (step.ok === false) pushAct('✗', 'err', lab + ' — failed');
			else pushAct('✓', 'ok', lab.replace(/^Drawing |^Generating /, '').replace(/^\w/, function (m) { return m.toUpperCase(); }) + ' added');
		}
	}
}

function pushAct(g, cls, text) {
	var d = new Date();
	var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
	// Split on newlines — a multi-line message (e.g. a debug HTML dump) becomes one
	// feed row per physical line, so NO embedded \n ever reaches a rendered row
	// (an embedded \n moves the cursor and scrolls the screen). Strip control chars.
	var parts = String(text).split('\n');
	for (var i = 0; i < parts.length; i++) {
		var line = parts[i].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f]/g, '');
		activity.push({ t: i === 0 ? hh : '        ', g: i === 0 ? g : ' ', cls: cls, text: line });
	}
	// stay anchored on the same lines while the user is scrolled up
	if (scrollOff > 0) scrollOff += parts.length;
	if (activity.length > MAX_ACT) activity.splice(0, activity.length - MAX_ACT);
	if (active && mode === 'dashboard') render();
}

/* ---------------------------------------------------- derive UI state - */
function snapshot() {
	var boards = hub.listBoards();
	var agent = agents.agent, agentOK = agents.detect();
	var isBai = !!(agent && agent.id === 'bridgeai');
	var provider = null, model = null, providerKey = true;
	if (isBai) {
		provider = providers.active(process.env);
		providerKey = !!provider;
		model = provider ? baiModels.resolveModel(provider, { env: process.env }).model : null;
	}
	var warn = null;
	if (!agentOK) warn = 'No AI agent available — press a to choose, or set a provider key for BridgeAI.';
	else if (isBai && !providerKey) warn = 'BridgeAI has no provider key. Set OPENROUTER_API_KEY (or Azure / Bedrock).';
	else if (isBai && !model) warn = 'No model selected for ' + (provider ? provider.label : 'BridgeAI') + ' — press m.';
	else if (healthWarn) warn = healthWarn;

	var active = boards.filter(function (b) { return b.projectid === hub.selectedProjectId; })[0]
		|| boards.filter(function (b) { return b.focused; })[0] || boards[0] || null;

	return {
		boards: boards, agent: agent, agentOK: agentOK, isBai: isBai,
		provider: provider, model: model, providerKey: providerKey,
		paired: boards.length > 0, active: active,
		upd: updateCheck.available(), warn: warn
	};
}

/* ------------------------------------------------------------ render -- */
function render() {
	if (!active) return;
	var W = process.stdout.columns || 80, H = process.stdout.rows || 24;
	var lines;
	if (mode === 'dashboard') lines = dash(W, H);
	else if (mode === 'help') lines = message(W, H, 'Help', helpBody());
	else if (mode === 'details') lines = message(W, H, 'Details', detailBody());
	else if (mode === 'quit') lines = message(W, H, 'Quit the bridge?', [
		'', '  ' + C.white('Stop the bridge?'),
		'  ' + C.dim('Your board stays exactly as it is — drawing just pauses'),
		'  ' + C.dim('until you start the bridge again.'), '',
		'  ' + C.red('y') + ' quit    ' + C.cyan('esc') + ' keep running']);
	else lines = picker(W, H);
	// clamp to height and paint
	lines = lines.slice(0, H);
	while (lines.length < H) lines.push('');
	var EL = ON ? E + 'K' : '';   // erase to EOL — fills the right pad with the dark bg (BCE)
	// Position every row absolutely (\x1b[row;1H) and emit NO newline — the screen
	// can never scroll, so the header stays fixed regardless of the reported row count.
	var buf = BG + BASEFG;
	for (var r = 0; r < H; r++) buf += E + (r + 1) + ';1H' + safeLine(clip(lines[r], W)) + EL;
	buf += (ON ? E + 'J' : '');
	scr(buf);
}

function rule(W) { return C.dim(new Array(Math.max(0, W - 1)).join('─')); }

function dash(W, H) {
	var s = snapshot(), out = [];
	// header (with top padding)
	var live = !s.paired ? C.cyan('● waiting for a board') : C.green('● connected · ' + s.boards.length + ' board' + (s.boards.length > 1 ? 's' : ''));
	var brand = C.cyan(BICON) + '  ' + C.white(C.bold('MockFlow Bridge'));
	out.push('');
	out.push(' ' + padEnd(brand, W - vlen(live) - 3) + live + ' ');
	out.push(rule(W));

	// two columns: left agent-specific, right connection
	var L = [], R = [];
	if (!s.agentOK) L.push(fld('Agent', C.dim('none — press a to choose')));
	else if (s.isBai) {
		L.push(fld('Agent', C.white('BridgeAI')));
		L.push(fld('Provider', s.providerKey ? C.cyan(s.provider.label) : C.amber('not set — press p')));
		L.push(fld('Model', !s.providerKey ? C.dim('set a key first') : (s.model ? C.white(s.model) : C.amber('none — press m'))));
	} else {
		L.push(fld('Agent', C.white(s.agent.label) + '  ' + C.dim(agentVersion(s.agent))));
	}
	if (s.paired) {
		R.push(fld('Board', C.white(s.active ? (s.active.title || s.active.projectid) : '—') + (s.boards.length > 1 ? C.dim('  (+' + (s.boards.length - 1) + ')') : '')));
		R.push(fld('Pairing', C.amber(pcode())));
	} else {
		R.push(fld('Board', C.dim('none yet')));
	}
	// interleave columns
	var rows = Math.max(L.length, R.length), half = Math.floor(W / 2);
	for (var i = 0; i < rows; i++) {
		out.push(' ' + padEnd(L[i] || '', half - 2) + '  ' + (R[i] || ''));
	}
	// files chip
	if (s.paired && s.agentOK) out.push(' ' + C.dim('◦ Files off') + C.dim(' — press d to allow one folder'));

	// alert strips (update at the TOP of the alert stack)
	out.push('');
	if (s.upd) out.push(' ' + C.cyan('⬆ Update available — v' + s.upd.current + ' → v' + s.upd.latest) + C.dim('   press ? to update'));
	if (!s.paired) out.push(' ' + C.cyan('◎ Open MockFlow and enter code ') + C.amber(pcode()) + C.dim('   to connect a board'));
	if (s.warn) out.push(' ' + C.amber('⚠ ' + s.warn));

	// activity — a scrollable viewport (opencode-style): a window into the buffer,
	// followed live at the bottom, scrollable up through history with the arrows /
	// PageUp/Down, and End to snap back to live.
	out.push('');
	var footRows = 2;                       // blank + hotkey bar
	var avail = Math.max(3, H - footRows - out.length - 2);   // -2 for the header + rule below
	var maxOff = Math.max(0, activity.length - avail);
	if (scrollOff > maxOff) scrollOff = maxOff;               // clamp to valid range
	var end = activity.length - scrollOff;
	var startI = Math.max(0, end - avail);
	var hdr = ' ' + C.dim('ACTIVITY') + (copiedMsg ? '   ' + C.green(copiedMsg) : C.dim('   drag to copy · y to copy all'));
	if (scrollOff > 0) hdr += '   ' + C.amber('↑ ' + scrollOff + ' newer below · End to follow');
	out.push(hdr);
	out.push(rule(W));
	// Record the feed's on-screen position so mouse rows map back to activity lines
	// (each out[] entry is painted at row index+1; see render()).
	feedTop = out.length; feedStartI = startI; feedCount = end - startI;
	var selLo = Math.min(selAnchor, selHead), selHi = Math.max(selAnchor, selHead);
	activity.slice(startI, end).forEach(function (a, li) {
		var absIdx = startI + li;
		if (selecting && absIdx >= selLo && absIdx <= selHi)
			out.push('\x1b[7m' + clip(actLine(a).replace(ANSI_RE, ''), W) + '\x1b[27m');   // reverse-video = selected
		else
			out.push(actLine(a));
	});
	while (out.length < H - footRows) out.push('');

	out.push('');
	out.push(hotbar(W, s));
	return out;
}

function fld(k, v) { return C.dim(padEnd(k, 9)) + ' ' + v; }
function actLine(a) {
	var g = a.cls === 'ok' ? C.green(a.g) : a.cls === 'err' ? C.red(a.g) : a.cls === 'run' ? C.cyan(a.g) : C.dim(a.g);
	return ' ' + C.dim(a.t) + ' ' + g + ' ' + (a.cls === 'sys' ? C.dim(a.text) : a.text);
}
function pcode() { return hub.pairingCode; }
function agentVersion(a) { try { return (a.detect && a.detect().version) || ''; } catch (e) { return ''; } }

function hotbar(W, s) {
	var keys = [k('a', 'Change agent')];
	if (s.agentOK && s.isBai) { keys.push(k('p', 'Provider')); keys.push(k('m', 'Model')); }
	if (s.boards.length > 1) keys.push(k('b', 'Boards'));
	keys.push(k('d', 'Details'));
	keys.push(k('?', 'Help'));
	keys.push(k('q', 'Quit', true));
	return ' ' + keys.join('   ');
}
function k(key, lab, red) { return (red ? C.red(key) : C.cyan(key)) + ' ' + lab; }

/* --------------------------------------------------------- overlays --- */
function picker(W, H) {
	var out = ['', ' ' + C.bold(pickerTitle()), rule(W)];
	if (mode === 'model' && modelState && modelState.loading) { out.push(' ' + C.dim('  fetching tool-capable models…')); }
	else if (mode === 'model' && modelState && modelState.err) {
		out.push(' ' + C.amber('  ' + modelState.err));
		out.push(' ' + C.dim('  set it directly: ') + C.cyan('mockflow-bridge bridgeai model <id>'));
	} else if (!items.length) {
		out.push(' ' + C.dim('  nothing to choose.'));
	} else {
		items.forEach(function (it, i) {
			var cur = it.cur ? C.green('●') : C.dim('○');
			var row = ' ' + cur + ' ' + padEnd(it.label, 26) + (it.note ? C.dim(it.note) : '');
			out.push(i === sel ? C.inv(padEnd(' ▸' + row.slice(1), W - 2)) : '  ' + row);
		});
	}
	out.push(rule(W));
	out.push(' ' + C.dim('↑↓ move   ⏎ select   esc back'));
	return out;
}
function pickerTitle() {
	if (mode === 'agent') return 'Choose agent';
	if (mode === 'provider') return 'Choose provider · BridgeAI';
	if (mode === 'model') return 'Choose model · ' + (providers.active(process.env) || {}).label;
	if (mode === 'board') return 'Switch board';
	return '';
}

function message(W, H, title, body) {
	var out = ['', ' ' + C.bold(title), rule(W)];
	body.forEach(function (l) { out.push(l); });
	out.push('');
	out.push(rule(W));
	out.push(' ' + C.dim('esc back'));
	return out;
}
function helpBody() {
	var s = snapshot();
	var lines = [
		'', ' ' + C.dim('This window keeps your MockFlow board connected to your AI.'),
		' ' + C.dim('You chat inside your board — this just keeps things running.'),
		'', ' ' + C.bold('Keys'),
		'   ' + C.cyan('a') + ' switch AI agent      ' + C.cyan('b') + ' switch board',
		'   ' + C.cyan('p') + ' provider (BridgeAI)   ' + C.cyan('m') + ' model (BridgeAI)',
		'   ' + C.cyan('d') + ' connection details    ' + C.cyan('q') + ' stop the bridge',
		'   ' + C.cyan('drag') + ' select+copy lines   ' + C.cyan('y') + ' copy whole feed',
		'   ' + C.cyan('↑↓ PgUp PgDn') + ' scroll activity   ' + C.cyan('End') + ' follow live',
		'', ' ' + C.bold('Update')
	];
	if (s.upd) { lines.push('   ' + C.cyan('v' + s.upd.latest + ' available') + C.dim(' (you\'re on v' + s.upd.current + ')')); lines.push('   ' + C.white('npm i -g @mockflow/mockflow-bridge')); }
	else lines.push('   ' + C.green('up to date ✓'));
	lines.push(''); lines.push(' ' + C.bold('Need a hand?'));
	lines.push('   ' + C.cyan('support.mockflow.com') + C.dim(' · ') + C.cyan('support@mockflow.com'));
	return lines;
}
function detailBody() {
	return [
		'', ' ' + C.bold('Connection'),
		'   ' + fld('Endpoint', C.cyan(ctx.endpoint + '/mcp/••••••')),
		'   ' + fld('Socket', C.cyan('ws://127.0.0.1:' + ctx.config.PORT + '/board')),
		'   ' + C.dim('Point a coding CLI at the endpoint to draw on your board by hand.'),
		'', ' ' + C.bold('This machine'),
		'   ' + fld('Files', (agents.hasWorkspace ? C.white(ui.shortenPath(agents.workspace)) : C.dim('off — start with --workspace <folder> to allow one folder'))),
		'   ' + fld('Version', C.cyan('v' + ctx.config.ENGINE_VERSION)),
		'   ' + C.dim('Files are read locally only — nothing is uploaded to MockFlow.')
	];
}

/* ---------------------------------------------------------- actions --- */
function openAgent() { var s = snapshot(); items = registry.AGENTS.map(function (a) { var d = a.detect ? a.detect() : {}; return { id: a.id, label: a.label, note: d.available ? (d.version || 'ready') : 'not available', cur: a === s.agent, disabled: !d.available }; }); mode = 'agent'; setSelCur(); render(); }
function openProvider() { var cur = providers.active(process.env); items = providers.all().map(function (p) { var has = !!process.env[p.keyEnv]; return { id: p.id, label: p.label, note: has ? 'ready' : 'set ' + p.keyEnv, cur: cur && p.id === cur.id, disabled: !has }; }); mode = 'provider'; setSelCur(); render(); }
function openBoard() { var s = snapshot(); items = s.boards.map(function (b) { return { id: b.projectid, label: b.title || b.projectid, note: b.focused ? 'focused' : '', cur: s.active && b.projectid === s.active.projectid }; }); mode = 'board'; setSelCur(); render(); }
function openModel() {
	mode = 'model'; items = []; sel = 0; modelState = { loading: true }; render();
	var p = providers.active(process.env); var key = p && process.env[p.keyEnv]; var base = p && p.resolveBaseURL(process.env);
	if (!p || !key || !base || !base.url || !p.listModels) {
		modelState = { err: p && !p.listModels ? p.label + ' can\'t list models.' : 'Provider not ready.' }; render(); return;
	}
	baiModels.fetchModels(p, key, base.url).then(function (list) {
		if (mode !== 'model') return;
		if (!list || !list.length) { modelState = { err: 'Could not list models.' }; render(); return; }
		var cur = baiModels.resolveModel(p, { env: process.env }).model;
		items = baiModels.pickable(list).slice(0, 60).map(function (m) { return { id: m.id, label: m.id, cur: m.id === cur }; });
		modelState = null; setSelCur(); render();
	});
}
function setSelCur() { sel = 0; for (var i = 0; i < items.length; i++) if (items[i].cur) { sel = i; break; } }

function choose() {
	var it = items[sel]; if (!it || it.disabled) return;
	if (mode === 'agent') {
		var a = registry.byId(it.id);
		if (a && agents.setAgent(a)) {
			hub.agentInfo.agentId = a.id; hub.agentInfo.agentName = a.label; hub.agentInfo.hasLocalAgent = agents.detect();
			try { hub.broadcast({ t: 'agent-info', agentInfo: hub.agentInfo }); } catch (e) {}
			healthWarn = warnFromProblems(safeCheck(a));
			registry.savePreference(a.id);
			pushAct('⚙', 'run', 'Switched agent to ' + a.label);
		}
	} else if (mode === 'provider') { providers.saveProvider(it.id); pushAct('⚙', 'run', 'Provider → ' + label2(it.label)); }
	else if (mode === 'model') { var p = providers.active(process.env); if (p) { baiModels.saveModel(p.id, it.id); pushAct('⚙', 'run', 'Model → ' + it.id); } }
	else if (mode === 'board') { hub.selectedProjectId = it.id; pushAct('⚙', 'run', 'Now drawing on “' + label2(it.label) + '”'); }
	mode = 'dashboard'; render();
}
function label2(s) { return String(s).replace(ANSI_RE, ''); }
function safeCheck(a) { try { return health.problems([health.checkOne(a)]); } catch (e) { return []; } }

/* ------------------------------------------------------------ input --- */
function onKey(str, key) {
	if (!active) return;
	key = key || {};
	if (key.sequence && key.sequence.indexOf('\x1b[<') === 0) return;   // mouse report — handled by onMouseData
	if (key.ctrl && key.name === 'c') return quit();

	if (mode === 'dashboard') {
		var s = snapshot();
		// scrollback through the Activity feed
		if (key.name === 'up' || str === 'k') { scrollOff += 1; return render(); }
		if (key.name === 'down' || str === 'j') { scrollOff = Math.max(0, scrollOff - 1); return render(); }
		if (key.name === 'pageup') { scrollOff += 8; return render(); }
		if (key.name === 'pagedown') { scrollOff = Math.max(0, scrollOff - 8); return render(); }
		if (key.name === 'home') { scrollOff = 1e9; return render(); }   // clamped to oldest in dash()
		if (key.name === 'end') { scrollOff = 0; return render(); }      // follow live
		switch (str) {
			case 'a': return openAgent();
			case 'p': if (s.agentOK && s.isBai) return openProvider(); return;
			case 'm': if (s.agentOK && s.isBai) return openModel(); return;
			case 'b': if (s.boards.length > 1) return openBoard(); return;
			case 'y': return yankFeed();
			case 'd': mode = 'details'; return render();
			case '?': case 'h': mode = 'help'; return render();
			case 'q': mode = 'quit'; return render();
		}
		return;
	}
	if (mode === 'help' || mode === 'details') { if (key.name === 'escape') { mode = 'dashboard'; render(); } return; }
	if (mode === 'quit') {
		if (str === 'y' || str === 'Y') return quit();
		if (key.name === 'escape') { mode = 'dashboard'; render(); }
		return;
	}
	// pickers
	if (key.name === 'escape') { mode = 'dashboard'; modelState = null; return render(); }
	if (key.name === 'up') { sel = (sel - 1 + items.length) % Math.max(1, items.length); return render(); }
	if (key.name === 'down') { sel = (sel + 1) % Math.max(1, items.length); return render(); }
	if (key.name === 'return') return choose();
}

/* ------------------------------------------------------------ teardown  */
function warnFromProblems(problems) {
	if (!problems || !problems.length) return null;
	var p = problems[0];
	if (p.kind === 'version') return p.label + ' ' + p.installed + ' is newer than tested ' + p.tested + ' — turns may misbehave.';
	if (p.kind === 'capability') {
		if (p.critical && p.critical.length) return p.label + ': ' + p.critical[0].label + ' missing — turns may draw nothing.';
		if (p.degraded && p.degraded.length) return p.label + ': ' + p.degraded[0].label + ' unavailable.';
		if (p.helpFailed) return p.label + ': could not read its --help.';
	}
	if (p.kind === 'canary') return p.label + ': internal parser check failed.';
	return null;
}

function restoreScreen() { try { scr(E + '0m' + WRAP_ON + MOUSE_OFF + CUR_SHOW + ALT_OFF); } catch (e) {} }

function quit() {
	active = false;
	if (tick) clearInterval(tick);
	try { process.stdin.setRawMode && process.stdin.setRawMode(false); } catch (e) {}
	process.stdin.removeListener('keypress', onKey);
	process.stdin.removeListener('data', onMouseData);
	log.setSink(null);
	if (origOut) process.stdout.write = origOut;
	if (origErr) process.stderr.write = origErr;
	restoreScreen();
	if (typeof ctx.onQuit === 'function') ctx.onQuit();
}

module.exports = { start: start };
