/**
 * End-to-end test of the component-AI (QuickSettings Generate) loop without a
 * browser: pair/register as a board tab, send one {t:'compgen'} frame for a
 * Gantt, and print the streamed events. The bridge should run headless Claude
 * Code, capture its render_gantt call, and send the generated data back as a
 * {t:'compgen-data'} frame (fill-in-place), then {t:'compgen-done', ok:true}.
 *
 * Usage: node test/fake-compgen.js [pairing-code]
 * Requires the daemon running (MFBRIDGE_DEV=1) and Claude Code installed.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.MFBRIDGE_PORT || 21196;
const TOKEN_FILE = path.join(__dirname, '.fake-tab-token');
const pairCode = process.argv[2] || null;
const PROJECT = 'test-board-compgen';

let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}

const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/board', {
	headers: { Origin: 'https://app.mockflow.com' }
});

function send(frame) { ws.send(JSON.stringify(frame)); }

let gotData = false, gotDone = false;

ws.on('open', function() { send({ t: 'hello', token: token || undefined }); });

ws.on('message', function(raw) {
	const frame = JSON.parse(raw.toString());
	switch (frame.t) {
		case 'pair-required':
			if (!pairCode) { console.log('Need pairing code: node test/fake-compgen.js <code>'); process.exit(1); }
			send({ t: 'pair', code: pairCode });
			return;
		case 'paired':
			fs.writeFileSync(TOKEN_FILE, frame.token);
			register();
			return;
		case 'ready':
			register();
			return;
		case 'registered':
			var ct = process.argv[3] || 'MF_GanttChart_ID';
			var pr = process.argv[4] || 'Create a simple 3 phase website launch plan with a few tasks in each phase.';
			console.log('registered; sending compgen (' + ct + ', createai)...');
			send({ t: 'compgen', id: 'cg_test_1', comptype: ct, mode: 'createai', prompt: pr });
			return;
		case 'compgen-step':
			console.log('  step:', JSON.stringify(frame.step));
			return;
		case 'compgen-data':
			gotData = true;
			var gd = frame.gdata || {};
			console.log('  >> compgen-data received. aitype=' + gd.aitype + ' comp=' + gd.comp
				+ ' charts=' + (gd.charts || false) + ' dataKeys=' + JSON.stringify(Object.keys(gd.data || {})));
			var dataFields = Object.keys(gd.data || {}).filter(function(k){ return k !== 'prompt'; });
			dataFields.forEach(function(k) {
				var v = gd.data[k];
				console.log('     ' + k + ': ' + (typeof v === 'string' ? (v.length + ' chars, starts: ' + v.slice(0, 60)) : typeof v));
			});
			return;
		case 'compgen-done':
			gotDone = true;
			console.log('  >> compgen-done ok=' + frame.ok + ' fallback=' + (frame.fallback || false)
				+ (frame.error ? ' error=' + frame.error : ''));
			console.log(gotData && frame.ok ? 'RESULT: PASS (filled in place)' : 'RESULT: ' + (frame.fallback ? 'FALLBACK' : 'FAIL'));
			setTimeout(function() { process.exit(0); }, 200);
			return;
		case 'error':
			console.log('  error:', frame.message);
			return;
	}
});

function register() {
	send({ t: 'register', projectid: PROJECT, title: 'Compgen Test Board', focused: true, visible: true, url: 'https://app.mockflow.com/editor/' + PROJECT });
}

ws.on('close', function() { if (!gotDone) { console.log('socket closed before done'); process.exit(1); } });
setTimeout(function() { console.log('TIMEOUT'); process.exit(1); }, 150000);
