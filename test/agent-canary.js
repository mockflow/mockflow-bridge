#!/usr/bin/env node
/**
 * Offline parser canary for every agent adapter.
 *
 * Runs each adapter's committed selfTest fixtures through its own parser and
 * exits non-zero on any mismatch. No CLI, no daemon, no board - safe for CI and
 * a pre-publish gate. It guards OUR parsers against accidental regressions; it
 * does NOT prove the real CLI still emits these shapes (that is the version floor
 * plus a live turn - test/fake-*.js).
 *
 *   node test/agent-canary.js
 */

const registry = require('../src/agents');
const health = require('../src/agents/health');

let failed = 0;
registry.AGENTS.forEach(function (agent) {
	const r = health.runCanary(agent);
	if (r.ok) {
		console.log('✓ ' + agent.id + ' - canary passed');
	} else {
		failed++;
		console.log('✗ ' + agent.id + ' - canary FAILED');
		r.failures.forEach(function (f) { console.log('    ' + f); });
	}
});

if (failed) {
	console.error('\n' + failed + ' adapter(s) failed the canary.');
	process.exit(1);
}
console.log('\nAll adapters passed.');
