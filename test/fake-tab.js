/**
 * Fake editor tab for end-to-end testing without a browser.
 *
 * Connects to the daemon's /board socket, pairs with the code passed on the
 * command line (or reuses the token saved from a previous pairing), registers
 * as a board, and answers tool/read/layout frames like the real browser client
 * would - printing every gdata it is asked to draw.
 *
 * Usage:
 *   node test/fake-tab.js <pairing-code>     first run
 *   node test/fake-tab.js                    later runs (token cached in test/.fake-tab-token)
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.MFBRIDGE_PORT || 21196;
const TOKEN_FILE = path.join(__dirname, '.fake-tab-token');
const pairCode = process.argv[2] || null;
const PROJECT_ID = process.env.FAKE_PROJECT_ID || 'testproject123';
const TITLE = process.env.FAKE_TITLE || 'Fake Test Board';
const FOCUSED = process.env.FAKE_FOCUSED !== '0';

let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}

const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/board', {
	headers: { Origin: process.env.FAKE_ORIGIN || 'https://app.mockflow.com' }
});

function send(frame) {
	ws.send(JSON.stringify(frame));
}

function register() {
	send({
		t: 'register',
		projectid: PROJECT_ID,
		title: TITLE,
		focused: FOCUSED,
		visible: true,
		url: 'https://app.mockflow.com/board/' + PROJECT_ID
	});
}

ws.on('open', function() {
	console.log('[fake-tab] connected');
	send({ t: 'hello', token: token || undefined });
});

ws.on('message', function(raw) {
	const frame = JSON.parse(raw.toString());

	switch (frame.t) {
		case 'pair-required':
			if (!pairCode) {
				console.error('[fake-tab] pairing required - rerun with: node test/fake-tab.js <code from daemon console>');
				process.exit(1);
			}
			send({ t: 'pair', code: pairCode });
			return;
		case 'paired':
			fs.writeFileSync(TOKEN_FILE, frame.token);
			console.log('[fake-tab] paired, token saved');
			register();
			return;
		case 'ready':
			register();
			return;
		case 'registered':
			console.log('[fake-tab] registered as "' + TITLE + '" - waiting for tool calls');
			return;
		case 'tool':
			console.log('[fake-tab] TOOL ' + frame.toolName + ' gdata='
				+ JSON.stringify(frame.gdata).slice(0, 400));
			send({ t: 'result', id: frame.id, ok: true, data: { rendered: frame.toolName } });
			return;
		case 'toolhtml': {
			var fhtml = String((frame.args && frame.args.html) || '');
			console.log('[fake-tab] TOOLHTML ' + frame.toolName + ' (' + frame.mcpType + ') html='
				+ fhtml.slice(0, 200));
			// Stand in for the conversion report the real tab gets back from
			// /call/api/html2paintobjects, so the bridge's debug path is testable.
			var fdiag = frame.mcpType === 'wireframelite' ? {
				htmlLength: fhtml.length,
				captureWidth: (frame.args && frame.args.viewportWidth) || null,
				captureMode: /<canvas/i.test(fhtml) ? 'charts' : 'plain',
				canvasCount: (fhtml.match(/<canvas/gi) || []).length,
				chartComponents: (fhtml.match(/data-chart-component/gi) || []).length,
				svgIconRefs: (fhtml.match(/<img[^>]+src=["'][^"']*\.svg/gi) || []).length,
				inlineSvgs: (fhtml.match(/<svg[\s>]/gi) || []).length,
				iconFontTags: 0,
				paintObjectCount: 42,
				warnings: []
			} : null;
			send({ t: 'result', id: frame.id, ok: true, data: { rendered: frame.toolName, diagnostics: fdiag } });
			return;
		}
		case 'read':
			console.log('[fake-tab] READ board');
			send({
				t: 'result', id: frame.id, ok: true,
				data: {
					projectid: 'testproject123',
					title: 'Fake Test Board',
					componentCount: 2,
					components: [
						{ eid: 'e1', cid: 'c1', type: 'MF_Kanban_ID', x: 100, y: 100, width: 800, height: 500 },
						{ eid: 'e2', cid: 'c2', type: 'MF_Text', x: 100, y: 650, width: 200, height: 40, text: 'Notes' }
					]
				}
			});
			return;
		case 'layout':
			console.log('[fake-tab] LAYOUT "' + frame.boardTitle + '"');
			send({ t: 'result', id: frame.id, ok: true, data: 2 });
			return;
		case 'snapshot':
			console.log('[fake-tab] SNAPSHOT (plan batch boundary)');
			send({ t: 'result', id: frame.id, ok: true, data: { snapshot: true } });
			return;
		case 'plan-pick':
			// Stand-in user confirms every planned item.
			console.log('[fake-tab] PLAN-PICK "' + frame.boardTitle + '" '
				+ (frame.items || []).map(function(it) { return it.name; }).join(', '));
			send({ t: 'result', id: frame.id, ok: true, data: { items: (frame.items || []).map(function(_, i) { return i; }) } });
			return;
		case 'error':
			console.error('[fake-tab] bridge error: ' + frame.message);
			return;
	}
});

ws.on('close', function() {
	console.log('[fake-tab] disconnected');
	process.exit(0);
});

ws.on('error', function(err) {
	console.error('[fake-tab] ' + err.message + ' - is the daemon running? (npx mockflow-bridge)');
	process.exit(1);
});
