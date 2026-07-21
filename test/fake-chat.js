/**
 * End-to-end test of the Mode B chat loop without a browser: pair/register as
 * a board tab, send one {t:'chat'} frame, print the streamed events. Requires
 * the daemon running and Claude Code installed + signed in.
 *
 * Usage: node test/fake-chat.js [pairing-code] ["message"]
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const T0 = Date.now();
function el() { return '+' + ((Date.now() - T0) / 1000).toFixed(1) + 's '; }

const PORT = process.env.MFBRIDGE_PORT || 21196;
const TOKEN_FILE = path.join(__dirname, '.fake-tab-token');
const pairCode = process.argv[2] || null;
const message = process.argv[3] || 'Reply with exactly: hello from local agent. Do not use any tools.';

let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}

const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/board', {
	headers: { Origin: 'https://app.mockflow.com' }
});

function send(frame) { ws.send(JSON.stringify(frame)); }

ws.on('open', function() { send({ t: 'hello', token: token || undefined }); });

ws.on('message', function(raw) {
	const frame = JSON.parse(raw.toString());
	switch (frame.t) {
		case 'pair-required':
			if (!pairCode) { console.error('pairing required - pass the code'); process.exit(1); }
			send({ t: 'pair', code: pairCode });
			return;
		case 'paired':
			fs.writeFileSync(TOKEN_FILE, frame.token);
			// fallthrough to register
		case 'ready':
			send({ t: 'register', projectid: 'chattest1', title: 'Chat Test Board', focused: true, visible: true });
			return;
		case 'registered':
			console.log('[chat-test] registered, sending chat: ' + message);
			send({ t: 'chat', id: 'turn1', text: message });
			return;
		case 'chat-delta':
			console.log(el() + '[chat-test] DELTA: ' + JSON.stringify(frame.text).slice(0, 200));
			return;
		case 'chat-step':
			console.log(el() + '[chat-test] STEP : ' + JSON.stringify(frame.step));
			return;
		case 'chat-done':
			console.log('[chat-test] DONE : ok=' + frame.ok + (frame.error ? ' error=' + frame.error : '') + ' text=' + JSON.stringify(frame.text || '').slice(0, 200));
			process.exit(frame.ok ? 0 : 1);
			return;
		case 'tool':
			console.log('[chat-test] TOOL ' + frame.toolName + ' (drawing on board)');
			send({ t: 'result', id: frame.id, ok: true, data: { rendered: frame.toolName } });
			return;
		case 'toolhtml':
			// HTML-conversion tools (render_wireframelite / render_prototypelite): the real
			// tab posts to MockFlow first; here just acknowledge so the turn can finish.
			console.log(el() + '[chat-test] TOOLHTML ' + frame.toolName + ' html='
				+ String((frame.args && frame.args.html) || '').length + ' chars');
			send({ t: 'result', id: frame.id, ok: true, data: { rendered: frame.toolName } });
			return;
	}
});

ws.on('error', function(err) { console.error('[chat-test] ' + err.message); process.exit(1); });

setTimeout(function() { console.error('[chat-test] timeout after 180s'); process.exit(1); }, 180000);
