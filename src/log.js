/**
 * MockFlow Bridge - tiny logger. stderr only, so the stdio MCP shim can share
 * the module without corrupting the JSON-RPC stream on stdout.
 *
 * A sink can be installed (by the terminal dashboard) to capture log lines into
 * the Activity feed instead of writing to stderr, so full-screen rendering is
 * never corrupted. setSink(null) restores normal stderr logging.
 */

var sink = null;
var fs = require('fs');
var path = require('path');
var os = require('os');
// Every line is also appended to ~/.mockflow/bridge.log, so a turn can be traced
// after the fact without the terminal that ran the daemon. Best effort only.
var LOG_FILE = path.join(os.homedir(), '.mockflow', 'bridge.log');
function toFile(line) {
	try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function ts() {
	return new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
}

function log() {
	var args = Array.prototype.slice.call(arguments);
	toFile('[bridge ' + ts() + '] ' + args.join(' '));
	if (sink) { try { return sink(args.join(' ')); } catch (e) {} }
	console.error.apply(console, ['[bridge ' + ts() + ']'].concat(args));
}

log.setSink = function (fn) { sink = fn || null; };

module.exports = log;
