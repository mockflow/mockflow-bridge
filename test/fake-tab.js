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
		case 'search':
			console.log('[fake-tab] SEARCH pattern="' + (frame.pattern || frame.query || '') + '" type="'
				+ (frame.componentType || '') + '" mode=' + (frame.outputMode || 'content')
				+ ' children=' + !!frame.includeChildren);
			// Pattern "__none__" stands in for a board where nothing matches - the
			// answer an agent must relay instead of assuming the component exists.
			if ((frame.pattern || frame.query) === '__none__') {
				send({ t: 'result', id: frame.id, ok: true,
					data: { projectid: 'testproject123', title: 'Fake Test Board', total: 0, truncated: false, components: [] } });
				return;
			}
			send({
				t: 'result', id: frame.id, ok: true,
				data: {
					projectid: 'testproject123',
					title: 'Fake Test Board',
					total: 1,
					truncated: false,
					components: [
						{ cid: 'c1', type: 'MF_Kanban_ID', label: 'Launch Board', x: 100, y: 100, w: 800, h: 500,
							canModify: true, canConvert: true, convertTargets: ['Mind Map', 'Todo List'],
							text: 'Backlog | Ship beta | Done', textTruncated: true }
					]
				}
			});
			return;
		case 'readcomp':
			console.log('[fake-tab] READCOMP cid=' + frame.cid);
			// cid "big" stands in for a component past the read cap, which the real
			// tab answers with a server-made summary (contentSummarized), and cid
			// "bigfail" for the summary not coming back (truncation fallback).
			if (frame.cid === 'big' || frame.cid === 'bigfail') {
				const summarized = frame.cid === 'big';
				send({
					t: 'result', id: frame.id, ok: true,
					data: {
						cid: frame.cid,
						componentType: 'MF_Markdown2_ID',
						content: summarized
							? 'Launch Plan. Sections: Goals (3 targets, Q3), Risks (5 listed), Timeline (Aug 1 - Oct 15).\nOMITTED: per-item descriptions.'
							: 'Launch Plan. Goals... '.repeat(20),
						contentSummarized: summarized || undefined,
						contentTruncated: summarized ? undefined : true,
						note: summarized
							? 'Content was too large for a full read; this is a structure-preserving summary (its OMITTED line says what was condensed).'
							: 'This component is larger than one read returns and could not be condensed, so the tail is missing.'
					}
				});
				return;
			}
			send({
				t: 'result', id: frame.id, ok: true,
				data: {
					cid: frame.cid,
					componentType: 'MF_Kanban_ID',
					content: 'Kanban "Launch Board". Columns: Backlog (Ship beta, Write docs), Doing (Fix login), Done (Pick name).'
				}
			});
			return;
		case 'convert':
			console.log('[fake-tab] CONVERT cid=' + frame.cid + ' -> "' + frame.target + '"'
				+ (frame.instruction ? ' instruction="' + frame.instruction + '"' : ''));
			send({ t: 'result', id: frame.id, ok: true,
				data: 'Converted the Kanban into a ' + frame.target + '. It is on the user\'s board, beside the original.' });
			return;
		case 'links':
			console.log('[fake-tab] LINKS ' + (frame.items || []).map(function(i) { return i.cid; }).join(', '));
			// The real tab drops ids that are not on the board and builds each card's
			// wording from the live component; c1/c2 exist here, anything else does not.
			var known = (frame.items || []).filter(function(i) { return i && (i.cid === 'c1' || i.cid === 'c2'); });
			if (!known.length) {
				send({ t: 'result', id: frame.id, ok: false, error: 'None of those components are on this board.' });
				return;
			}
			send({ t: 'result', id: frame.id, ok: true,
				data: 'Showed ' + known.length + ' clickable card(s) in the chat. Tell the user to click one; never quote coordinates or ids.' });
			return;
		case 'web':
			console.log('[fake-tab] WEB ' + frame.op + ' ' + frame.url);
			if (frame.op === 'styles') {
				send({ t: 'result', id: frame.id, ok: true, data: {
					site: 'Example', finalUrl: frame.url,
					guidance: 'STYLE GUIDANCE (extracted from ' + frame.url + ' — Example):\n- Color palette (most used first): #0a2540, #635bff\n- Font families (most used first): Sohne'
				} });
			} else if (frame.op === 'images') {
				send({ t: 'result', id: frame.id, ok: true, data: {
					site: 'Example', finalUrl: frame.url,
					images: [{ url: frame.url + '/logo.svg', label: 'Example logo', kind: 'logo' }]
				} });
			} else {
				send({ t: 'result', id: frame.id, ok: true, data: {
					title: 'Example', finalUrl: frame.url, truncated: false,
					text: 'Example page text used for grounding.'
				} });
			}
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
	console.error('[fake-tab] ' + err.message + ' - is the daemon running? (npx @mockflow/mockflow-bridge)');
	process.exit(1);
});
