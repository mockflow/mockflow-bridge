#!/usr/bin/env node

/**
 * MockFlow Bridge CLI.
 *
 *   mockflow-bridge            start the daemon (default)
 *   mockflow-bridge stdio      stdio MCP shim -> running daemon (for stdio-only clients)
 *   mockflow-bridge status     show daemon status + connected boards
 *   mockflow-bridge help
 */

// Friendly gate before anything else runs: the bridge relies on Node 18+
// features (global fetch, AbortController), which otherwise fail later with
// cryptic errors like "fetch is not defined".
var nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
	console.error('MockFlow Bridge needs Node.js 18 or newer - you are running ' + process.version + '.');
	console.error('Update Node from https://nodejs.org and run this command again.');
	process.exit(1);
}

const config = require('../src/config');
const paint = require('../src/ui').out;

const cmd = process.argv[2] || 'start';

async function status() {
	const endpoint = 'http://127.0.0.1:' + config.PORT + '/status';
	try {
		const resp = await fetch(endpoint);
		const data = await resp.json();
		console.log(paint.green('●') + ' ' + paint.bold('MockFlow Bridge') + ' is running on port ' + config.PORT);
		console.log('  ' + paint.dim('version') + ' : ' + data.version);
		console.log('  ' + paint.dim('catalog') + ' : ' + data.catalog + ' (' + data.tools + ' tools)');
		if (data.boards && data.boards.length) {
			console.log('  ' + paint.dim('boards') + '  :');
			data.boards.forEach(function(b) {
				console.log('    ' + paint.green('✓') + ' "' + (b.title || b.projectid) + '"'
					+ (b.focused ? paint.teal(' (focused)') : ''));
			});
		} else {
			console.log('  ' + paint.dim('boards') + '  : none connected - open a board and switch on "Connect local agent"');
		}
	} catch (e) {
		console.log(paint.yellow('●') + ' ' + paint.bold('MockFlow Bridge') + ' is NOT running. Start it with: '
			+ paint.teal('npx mockflow-bridge'));
		process.exitCode = 1;
	}
}

function help() {
	console.log(paint.bold('MockFlow Bridge') + ' ' + config.ENGINE_VERSION);
	console.log('');
	console.log(paint.bold('Usage:'));
	console.log('  ' + paint.teal('mockflow-bridge') + '           start the bridge daemon (leave it running)');
	console.log('  ' + paint.teal('mockflow-bridge stdio') + '     stdio MCP shim for clients that cannot use HTTP');
	console.log('  ' + paint.teal('mockflow-bridge status') + '    is the daemon running, which boards are connected');
	console.log('');
	console.log(paint.bold('Environment:'));
	console.log('  ' + paint.teal('MFBRIDGE_PORT') + '             port (default ' + config.PORT + ')');
	console.log('  ' + paint.teal('MFBRIDGE_CATALOG_URL') + '      catalog endpoint override');
	console.log('  ' + paint.teal('MFBRIDGE_ALLOWED_ORIGINS') + '  extra comma-separated WS origins');
	console.log('  ' + paint.teal('MFBRIDGE_DEV=1') + '            dev mode (allow any WS origin, e.g. file:// test pages)');
}

if (cmd === 'start' || cmd === '--workspace') {
	// `mockflow-bridge [start] [--workspace <path>]`
	var wsIdx = process.argv.indexOf('--workspace');
	var workspace = wsIdx !== -1 ? process.argv[wsIdx + 1] : null;
	require('../src/daemon').start({ workspace: workspace }).catch(function(err) {
		console.error('Failed to start: ' + (err && err.message));
		process.exit(1);
	});
} else if (cmd === 'stdio') {
	require('../src/stdioProxy').start();
} else if (cmd === 'status') {
	status();
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
	help();
} else {
	console.error('Unknown command: ' + cmd);
	help();
	process.exit(1);
}
