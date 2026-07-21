/**
 * MockFlow Bridge - tiny logger. stderr only, so the stdio MCP shim can share
 * the module without corrupting the JSON-RPC stream on stdout.
 */

function ts() {
	return new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
}

function log() {
	var args = Array.prototype.slice.call(arguments);
	console.error.apply(console, ['[bridge ' + ts() + ']'].concat(args));
}

module.exports = log;
