/**
 * MockFlow Bridge - terminal UI. Gradient startup banner, info card and
 * pairing-code callout, with zero dependencies (raw ANSI escapes).
 *
 * Colors switch off automatically when the target stream is not a TTY, when
 * NO_COLOR is set, or when TERM=dumb - piped output and CI logs stay plain.
 * Truecolor is used when COLORTERM advertises it, otherwise the gradient is
 * mapped onto the 256-color cube.
 */

const os = require('os');

// MockFlow brand blues (editor.css): light #1b98e1 fading into the primary
// #1c7ce2, left to right across the wordmark.
const GRAD_FROM = { r: 27, g: 152, b: 225 };
const GRAD_TO = { r: 28, g: 124, b: 226 };

// Success marks stay green regardless of the banner gradient.
const GREEN = { r: 76, g: 217, b: 100 };

// The original wordmarks, rendered side by side by banner() so the lockup
// spends 6 terminal lines instead of 15: MOCKFLOW outlined (hollow), BRIDGE
// solid blocks.
const WORDMARK = [
	' __  __   ____    _____  _  __ ______  _       ____  __          __',
	'|  \\/  | / __ \\  / ____|| |/ /|  ____|| |     / __ \\ \\ \\        / /',
	'| \\  / || |  | || |     | \' / | |__   | |    | |  | | \\ \\  /\\  / / ',
	'| |\\/| || |  | || |     |  <  |  __|  | |    | |  | |  \\ \\/  \\/ /  ',
	'| |  | || |__| || |____ | . \\ | |     | |____| |__| |   \\  /\\  /   ',
	'|_|  |_| \\____/  \\_____||_|\\_\\|_|     |______|\\____/     \\/  \\/    '
];

const BRIDGEMARK = [
	'██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗',
	'██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝',
	'██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ',
	'██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ',
	'██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗',
	'╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝'
];

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function supportsColor(stream) {
	if (process.env.NO_COLOR) return false;
	if (process.env.TERM === 'dumb') return false;
	return !!(stream && stream.isTTY);
}

function hasTruecolor() {
	return /truecolor|24bit/i.test(process.env.COLORTERM || '');
}

/** Nearest 256-color cube index for an rgb triple (fallback terminals). */
function rgbTo256(r, g, b) {
	return 16
		+ 36 * Math.round(r / 255 * 5)
		+ 6 * Math.round(g / 255 * 5)
		+ Math.round(b / 255 * 5);
}

function fgCode(rgb) {
	if (hasTruecolor()) return '\x1b[38;2;' + rgb.r + ';' + rgb.g + ';' + rgb.b + 'm';
	return '\x1b[38;5;' + rgbTo256(rgb.r, rgb.g, rgb.b) + 'm';
}

function mix(a, b, t) {
	return {
		r: Math.round(a.r + (b.r - a.r) * t),
		g: Math.round(a.g + (b.g - a.g) * t),
		b: Math.round(a.b + (b.b - a.b) * t)
	};
}

/** Paint helpers bound to one stream, so stdout and stderr each decide
 *  independently whether they are a TTY. */
function makePaint(stream) {
	const on = supportsColor(stream);
	function wrap(code, s) { return on ? code + s + '\x1b[0m' : String(s); }
	return {
		enabled: on,
		bold: function(s) { return wrap('\x1b[1m', s); },
		dim: function(s) { return wrap('\x1b[2m', s); },
		green: function(s) { return wrap(fgCode(GREEN), s); },
		teal: function(s) { return wrap(fgCode(GRAD_TO), s); },
		yellow: function(s) { return wrap('\x1b[33m', s); },
		inverse: function(s) { return wrap('\x1b[7m', s); }
	};
}

function visibleWidth(s) {
	return String(s).replace(ANSI_RE, '').length;
}

function padEnd(s, width) {
	const pad = width - visibleWidth(s);
	return s + (pad > 0 ? new Array(pad + 1).join(' ') : '');
}

/** Home directory shortened to ~ so workspace paths stay readable. */
function shortenPath(p) {
	if (!p) return p;
	const home = os.homedir();
	if (home && p.indexOf(home) === 0) return '~' + p.slice(home.length);
	return p;
}

/** MOCKFLOW and BRIDGE side by side, gradient per column so the shades sweep
 *  left to right across the combined mark. The version rides on the last art
 *  row instead of its own line. */
function banner(version, paint) {
	const rows = WORDMARK.map(function(line, r) { return line + '  ' + BRIDGEMARK[r]; });
	const width = rows[0].length;
	const lines = rows.map(function(line) {
		if (!paint.enabled) return '  ' + line;
		var out = '  ';
		for (var i = 0; i < line.length; i++) {
			const ch = line[i];
			out += ch === ' ' ? ch : fgCode(mix(GRAD_FROM, GRAD_TO, i / (width - 1))) + ch;
		}
		return out + '\x1b[0m';
	});
	lines[lines.length - 1] += '  ' + paint.dim('v' + version);
	return lines.join('\n');
}

/** Rounded info card. rows: array of [label, value] pairs. */
function infoBox(rows, paint) {
	const labelWidth = rows.reduce(function(m, r) { return Math.max(m, r[0].length); }, 0);
	const bodies = rows.map(function(r) {
		return '  ' + paint.dim(padEnd(r[0], labelWidth)) + '   ' + r[1];
	});
	const inner = bodies.reduce(function(m, b) { return Math.max(m, visibleWidth(b)); }, 0) + 2;
	const bar = new Array(inner + 1).join('─');
	const out = ['  ' + paint.dim('╭' + bar + '╮')];
	bodies.forEach(function(b) {
		out.push('  ' + paint.dim('│') + padEnd(b, inner) + paint.dim('│'));
	});
	out.push('  ' + paint.dim('╰' + bar + '╯'));
	return out.join('\n');
}

/** Rounded callout box with a colored border and bold title - for status the
 *  user should not skim past (e.g. file access on/off). `color` is one of the
 *  paint helpers (paint.yellow for warnings, paint.green for good news) and
 *  tints the border and title; body lines are printed as given. */
function noticeBox(title, lines, color, paint) {
	const bodies = ['  ' + color(paint.bold(title))].concat(lines.map(function(l) {
		return l === '' ? '' : '  ' + l;
	}));
	const inner = bodies.reduce(function(m, b) { return Math.max(m, visibleWidth(b)); }, 0) + 2;
	const bar = new Array(inner + 1).join('─');
	const out = ['  ' + color('╭' + bar + '╮')];
	bodies.forEach(function(b) {
		out.push('  ' + color('│') + padEnd(b, inner) + color('│'));
	});
	out.push('  ' + color('╰' + bar + '╯'));
	return out.join('\n');
}

/** The one thing the user must act on, made impossible to miss. */
function pairingLine(code, hint, paint) {
	return '  ' + paint.teal('┃') + '  PAIRING CODE   '
		+ paint.bold(paint.inverse(' ' + code + ' ')) + '  ' + paint.teal('┃')
		+ '   ' + paint.dim(hint);
}

module.exports = {
	out: makePaint(process.stdout),
	err: makePaint(process.stderr),
	banner: banner,
	infoBox: infoBox,
	noticeBox: noticeBox,
	pairingLine: pairingLine,
	shortenPath: shortenPath
};
