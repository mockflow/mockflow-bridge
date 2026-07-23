#!/usr/bin/env node

/**
 * MockFlow Bridge CLI - thin dispatcher. Commands live in src/cli.js, the
 * daemon in src/daemon.js.
 *
 *   mockflow-bridge            start the daemon (default)
 *   mockflow-bridge status     daemon status + connected boards
 *   mockflow-bridge agent      show / change which local agent CLI answers
 *   mockflow-bridge reset      clear saved bridge state
 *   mockflow-bridge stdio      stdio MCP shim -> running daemon
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

const argv = process.argv.slice(2);
const cmd = argv[0] || 'start';
const rest = argv.slice(1);

// A leading option (not a subcommand) means "start with these options".
const isStart = cmd === 'start' || cmd.charAt(0) === '-';

if (isStart && cmd !== '--help' && cmd !== '-h' && cmd !== '--version' && cmd !== '-v') {
	var wsIdx = argv.indexOf('--workspace');
	var workspace = wsIdx !== -1 ? argv[wsIdx + 1] : null;
	var agIdx = argv.indexOf('--agent');
	var agent = agIdx !== -1 ? argv[agIdx + 1] : (process.env.MFBRIDGE_AGENT || null);
	require('../src/daemon').start({ workspace: workspace, agent: agent }).catch(function(err) {
		console.error('Failed to start: ' + (err && err.message));
		console.error('Run `mockflow-bridge help` for all commands.');
		process.exit(1);
	});
} else if (cmd === 'stdio') {
	require('../src/stdioProxy').start();
} else if (cmd === 'bridgeai-run') {
	// Internal: one BridgeAI turn, spawned by the bridgeai adapter. Reads the turn
	// from BRIDGEAI_TURN, emits the normalized JSONL event contract on stdout.
	require('../src/bridgeai/run').main();
} else if (cmd === 'bridgeai') {
	// BridgeAI provider & model selection (mockflow-bridge bridgeai [provider|model] ...).
	require('../src/bridgeai/cli').run(rest).catch(function(err) {
		console.error(err && err.message);
		process.exit(1);
	});
} else if (cmd === 'status') {
	require('../src/cli').status();
} else if (cmd === 'agent' || cmd === 'agents') {
	require('../src/cli').agent(rest);
} else if (cmd === 'reset') {
	require('../src/cli').reset(rest);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
	require('../src/cli').help();
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
	console.log(require('../src/config').ENGINE_VERSION);
} else {
	console.error('Unknown command: ' + cmd);
	console.error('');
	require('../src/cli').help();
	process.exit(1);
}
