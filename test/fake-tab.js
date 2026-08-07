/**
 * Fake editor tab for end-to-end testing without a browser.
 *
 * Connects to the daemon's /board socket, pairs with the code passed on the
 * command line (or reuses the token saved from a previous pairing), registers
 * as a board, and answers tool/read/layout frames like the real browser client
 * would - printing every gdata it is asked to draw.
 *
 * The board-reading messages answer from ONE shared fixture board (see
 * FIXTURE_COMPONENTS) with the real reply contracts, so the board tools are
 * manually testable end to end:
 *   read      - full inventory with label / text / textTruncated / convertTo /
 *               modifiable per component (two same-type checklists with
 *               distinct labels, so wrong-pick scenarios are exercisable)
 *   search    - a real grep over the fixture components' lines (pattern,
 *               caseSensitive, outputMode, contextLines, headLimit,
 *               includeChildren), or the listing shape when no pattern is given
 *   readcomp  - one component's lines, paged with offset/limit
 *               (totalLines / hasMore / nextOffset); the oversized "Launch
 *               Plan" doc (cid c5) answers an unpaged read with a
 *               contentSummarized summary, like the real tab's server summary
 *   links     - cids checked against the fixture board, unknown ones dropped
 *   convert / web - canned replies in the real shapes
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

// The one board every read message answers from. `lines` are the component's
// content as the discrete pieces the real extractor produces (a card, an item,
// a bullet) - search greps them and readcomp pages them, joined with ' | ' for
// the flat previews, exactly the coordinate system the real tab uses.
// c3/c4 are two checklists whose LABELS differ ("Basic Plan Features" vs
// "Unified Product Feature Checklist") while their items overlap, so an agent
// that grabs "the checklist" without reading labels picks the wrong one here
// too. c6 sits inside the c7 wireframe screen and is only searched with
// includeChildren, like the real design-container rule.
const FIXTURE_COMPONENTS = [
	{
		eid: 'e1', cid: 'c1', type: 'MF_Kanban_ID', label: 'Launch Board',
		x: 100, y: 100, width: 800, height: 500,
		modifiable: true, convertTo: ['Mind Map', 'Todo List'],
		lines: [
			'Backlog: Ship beta',
			'Backlog: Write docs',
			'Doing: Fix login',
			'Done: Pick name'
		]
	},
	{
		eid: 'e2', cid: 'c2', type: 'MF_Text', label: 'Notes',
		x: 100, y: 650, width: 200, height: 40,
		modifiable: false,
		lines: ['Notes']
	},
	{
		eid: 'e3', cid: 'c3', type: 'MF_CheckList_ID', label: 'Basic Plan Features',
		x: 950, y: 100, width: 300, height: 260,
		modifiable: true, convertTo: ['Mind Map', 'Kanban Board'],
		lines: [
			'3 projects',
			'1 GB storage',
			'Community support',
			'Watermarked exports'
		]
	},
	{
		eid: 'e4', cid: 'c4', type: 'MF_CheckList_ID', label: 'Unified Product Feature Checklist',
		x: 950, y: 400, width: 300, height: 320,
		modifiable: true, convertTo: ['Mind Map', 'Kanban Board'],
		lines: [
			'Unlimited projects',
			'100 GB storage',
			'Priority support',
			'Team workspaces',
			'SSO and audit logs'
		]
	},
	{
		eid: 'e5', cid: 'c5', type: 'MF_Markdown2_ID', label: 'Launch Plan',
		x: 1300, y: 100, width: 500, height: 600,
		modifiable: true, convertTo: ['Mind Map'],
		// Oversized on purpose: an unpaged read of this one answers with the
		// contentSummarized summary below, the way the real tab answers with the
		// server-made summary past the content cap. Paged reads get real lines.
		summarize: true,
		summary: 'Launch Plan. Sections: Goals (3 targets, Q3), Risks (5 listed), Timeline (Aug 1 - Oct 15), '
			+ 'Milestones (40 items).\nOMITTED: per-milestone descriptions.',
		lines: (function() {
			const l = [
				'Launch Plan',
				'Goals: 3 targets for Q3',
				'Risks: 5 listed, top one is app-store review time',
				'Timeline: Aug 1 - Oct 15'
			];
			for (let i = 1; i <= 40; i++) {
				l.push('Milestone ' + i + ': owner, deliverable and acceptance criteria for step ' + i);
			}
			return l;
		})()
	},
	{
		eid: 'e7', cid: 'c7', type: 'MF_WireframeLite_ID', label: 'Signup Screen',
		x: 1900, y: 100, width: 400, height: 700,
		modifiable: true,
		lines: ['Signup Screen']
	},
	{
		eid: 'e6', cid: 'c6', type: 'MF_Text', label: 'Submit',
		x: 1950, y: 700, width: 100, height: 40,
		modifiable: false, parentCid: 'c7',
		lines: ['Submit', 'Email', 'Password']
	}
];

function findComp(cid) {
	for (let i = 0; i < FIXTURE_COMPONENTS.length; i++) {
		const c = FIXTURE_COMPONENTS[i];
		if (c.cid === cid || c.eid === cid) return c;
	}
	return null;
}

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

/**
 * The grep half of the search message: a real regex scan over the fixture
 * components' lines, in the reply shape the real tab's handleSearch returns
 * (see agentbridge.js / MF_Utils.grepBoard) - matching lines with their
 * numbers, ctx-flagged context lines, headLimit truncation, and label-matched
 * components ordered first.
 */
function grepFixture(frame) {
	const pattern = String(frame.pattern || frame.query || '');
	const flags = frame.caseSensitive ? 'g' : 'gi';
	let rx = null;
	let isRegex = true;
	// An invalid pattern ("C++") is searched literally, never errored.
	try { rx = new RegExp(pattern, flags); }
	catch (e) {
		rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
		isRegex = false;
	}

	const HEAD = (typeof frame.headLimit === 'number' && frame.headLimit > 0) ? frame.headLimit : 100;
	const CONTEXT = (typeof frame.contextLines === 'number' && frame.contextLines > 0)
		? Math.min(frame.contextLines, 5) : 0;
	const MAX_LINE = 300;
	const mode = frame.outputMode || 'content';
	const norm = function(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
	const typeFilter = frame.componentType ? norm(frame.componentType) : '';

	const labelFirst = [];
	const rest = [];
	let totalMatches = 0;
	let truncated = false;
	let emitted = 0;

	for (let i = 0; i < FIXTURE_COMPONENTS.length && !truncated; i++) {
		const comp = FIXTURE_COMPONENTS[i];
		// Children of a design container are searched only when asked for.
		if (comp.parentCid && !frame.includeChildren) continue;
		if (typeFilter) {
			const nType = norm(comp.type);
			const nLabel = norm(comp.label);
			if (nType.indexOf(typeFilter) === -1 && nLabel.indexOf(typeFilter) === -1
				&& typeFilter.indexOf(nLabel) === -1) continue;
		}

		const lines = comp.lines || [];
		const hitLines = [];
		let matchCount = 0;
		for (let n = 0; n < lines.length; n++) {
			rx.lastIndex = 0;
			const hits = String(lines[n]).match(rx);
			if (!hits || !hits.length) continue;
			matchCount += hits.length;
			hitLines.push(n);
		}
		rx.lastIndex = 0;
		const labelHit = rx.test(comp.label || '');
		if (!matchCount && !labelHit) continue;

		const rec = {
			cid: comp.cid,
			type: comp.type,
			label: comp.label,
			x: comp.x, y: comp.y, w: comp.width, h: comp.height,
			canModify: !!comp.modifiable
		};
		if (comp.parentCid) rec.parentCid = comp.parentCid;
		if (comp.convertTo) rec.convertTo = comp.convertTo;
		if (labelHit) rec.labelMatch = true;
		if (!matchCount && labelHit) rec.matchedOn = 'label';
		// components mode answers only WHICH components matched; the counts
		// belong to count (and content) mode.
		if (mode !== 'components') {
			rec.matchCount = matchCount;
			rec.lineCount = lines.length;
		}

		if (mode === 'content' && matchCount) {
			const isHit = {};
			const wanted = {};
			for (let h = 0; h < hitLines.length; h++) {
				isHit[hitLines[h]] = true;
				for (let d = -CONTEXT; d <= CONTEXT; d++) {
					const n2 = hitLines[h] + d;
					if (n2 >= 0 && n2 < lines.length) wanted[n2] = true;
				}
			}
			const nums = Object.keys(wanted).map(Number).sort(function(a, b) { return a - b; });
			rec.matches = [];
			for (let w = 0; w < nums.length; w++) {
				if (isHit[nums[w]] && emitted >= HEAD) { truncated = true; break; }
				let lt = String(lines[nums[w]]);
				if (lt.length > MAX_LINE) lt = lt.substring(0, MAX_LINE) + '…';
				const row = { n: nums[w] + 1, text: lt };
				if (!isHit[nums[w]]) row.ctx = true;
				rec.matches.push(row);
				if (isHit[nums[w]]) emitted++;
			}
		}

		totalMatches += matchCount;
		(rec.labelMatch ? labelFirst : rest).push(rec);
	}

	const components = labelFirst.concat(rest);
	return {
		projectid: PROJECT_ID,
		title: TITLE,
		pattern: pattern,
		isRegex: isRegex,
		totalMatches: totalMatches,
		totalComponents: components.length,
		truncated: truncated,
		components: components
	};
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
		case 'read': {
			console.log('[fake-tab] READ board');
			// The enriched inventory the real handleRead returns: label, capped
			// text preview (textTruncated marks the cut - the oversized Launch
			// Plan doc trips it), modifiable and convertTo per component.
			const TEXT_CAP = 400;
			const comps = FIXTURE_COMPONENTS.map(function(c) {
				const item = {
					eid: c.eid, cid: c.cid, type: c.type, label: c.label,
					x: c.x, y: c.y, width: c.width, height: c.height,
					modifiable: !!c.modifiable
				};
				const text = (c.lines || []).join(' | ');
				if (text) {
					item.text = text.slice(0, TEXT_CAP);
					if (text.length > TEXT_CAP) item.textTruncated = true;
				}
				if (c.convertTo) item.convertTo = c.convertTo;
				return item;
			});
			send({
				t: 'result', id: frame.id, ok: true,
				data: {
					projectid: PROJECT_ID,
					title: TITLE,
					componentCount: comps.length,
					components: comps
				}
			});
			return;
		}
		case 'search': {
			console.log('[fake-tab] SEARCH pattern="' + (frame.pattern || frame.query || '') + '" type="'
				+ (frame.componentType || '') + '" mode=' + (frame.outputMode || 'content')
				+ ' children=' + !!frame.includeChildren);
			// Pattern "__none__" stands in for a board where nothing matches - the
			// answer an agent must relay instead of assuming the component exists.
			if ((frame.pattern || frame.query) === '__none__') {
				send({ t: 'result', id: frame.id, ok: true,
					data: { projectid: PROJECT_ID, title: TITLE, pattern: '__none__', isRegex: true,
						totalMatches: 0, totalComponents: 0, truncated: false, components: [] } });
				return;
			}
			// A pattern greps; no pattern lists (grep vs ls), like the real tab.
			if (frame.pattern || frame.query) {
				send({ t: 'result', id: frame.id, ok: true, data: grepFixture(frame) });
				return;
			}
			const PREVIEW_CAP = 120;
			const listed = FIXTURE_COMPONENTS.filter(function(c) {
				return !c.parentCid || !!frame.includeChildren;
			}).map(function(c) {
				const rec = {
					cid: c.cid, type: c.type, label: c.label,
					x: c.x, y: c.y, w: c.width, h: c.height,
					canModify: !!c.modifiable
				};
				if (c.parentCid) rec.parentCid = c.parentCid;
				if (c.convertTo) rec.convertTo = c.convertTo;
				const text = (c.lines || []).join(' | ');
				if (text) {
					rec.text = text.slice(0, PREVIEW_CAP);
					if (text.length > PREVIEW_CAP) rec.textTruncated = true;
				}
				return rec;
			});
			send({
				t: 'result', id: frame.id, ok: true,
				data: { projectid: PROJECT_ID, title: TITLE, total: listed.length, truncated: false, components: listed }
			});
			return;
		}
		case 'readcomp': {
			console.log('[fake-tab] READCOMP cid=' + frame.cid
				+ (typeof frame.offset === 'number' || typeof frame.limit === 'number'
					? ' offset=' + frame.offset + ' limit=' + frame.limit : ''));
			// cid "bigfail" stands in for the summary not coming back on an
			// oversized read (truncation fallback); the summary-path fixture is
			// the real Launch Plan doc (c5), and "big" is kept as its alias.
			if (frame.cid === 'bigfail') {
				send({
					t: 'result', id: frame.id, ok: true,
					data: {
						cid: frame.cid,
						componentType: 'MF_Markdown2_ID',
						content: 'Launch Plan. Goals... '.repeat(20),
						contentTruncated: true,
						note: 'This component is larger than one read returns and could not be condensed, so the tail is missing.'
					}
				});
				return;
			}
			const comp = findComp(frame.cid === 'big' ? 'c5' : String(frame.cid || ''));
			if (!comp) {
				send({ t: 'result', id: frame.id, ok: false,
					error: 'No component with id "' + frame.cid + '" is on this board. Call search_board for the current ids.' });
				return;
			}
			const lines = comp.lines || [];
			// Paged read: the same 1-based window contract as MF_Utils.sliceLines,
			// so "grep line 7, then read from 7" lands on the same line here.
			if (typeof frame.offset === 'number' || typeof frame.limit === 'number') {
				const offset = (typeof frame.offset === 'number' && frame.offset > 0) ? Math.floor(frame.offset) : 1;
				const limit = (typeof frame.limit === 'number' && frame.limit > 0) ? Math.floor(frame.limit) : 200;
				const start = offset - 1;
				const window = [];
				for (let i = start; i < lines.length && window.length < limit; i++) {
					window.push({ n: i + 1, text: String(lines[i]) });
				}
				const hasMore = (start + window.length) < lines.length;
				const out = {
					cid: comp.cid,
					componentType: comp.type,
					label: comp.label,
					lines: window,
					offset: offset,
					returned: window.length,
					totalLines: lines.length,
					hasMore: hasMore
				};
				if (hasMore) {
					out.nextOffset = offset + window.length;
					out.note = 'Lines ' + offset + '-' + (offset + window.length - 1) + ' of ' + lines.length
						+ '. Call again with offset ' + out.nextOffset + ' for the next page.';
				}
				send({ t: 'result', id: frame.id, ok: true, data: out });
				return;
			}
			// Unpaged read of the oversized doc: the structure-preserving summary
			// (with its OMITTED line), the way the real tab answers past the cap.
			if (comp.summarize) {
				send({
					t: 'result', id: frame.id, ok: true,
					data: {
						cid: comp.cid,
						componentType: comp.type,
						label: comp.label,
						content: comp.summary,
						contentSummarized: true,
						note: 'Content was too large for a full read; this is a structure-preserving summary (its OMITTED line says what was condensed).'
					}
				});
				return;
			}
			send({
				t: 'result', id: frame.id, ok: true,
				data: {
					cid: comp.cid,
					componentType: comp.type,
					label: comp.label,
					content: lines.join('\n')
				}
			});
			return;
		}
		case 'convert':
			console.log('[fake-tab] CONVERT cid=' + frame.cid + ' -> "' + frame.target + '"'
				+ (frame.instruction ? ' instruction="' + frame.instruction + '"' : ''));
			send({ t: 'result', id: frame.id, ok: true,
				data: 'Converted the Kanban into a ' + frame.target + '. It is on the user\'s board, beside the original.' });
			return;
		case 'links': {
			console.log('[fake-tab] LINKS ' + (frame.items || []).map(function(i) { return i.cid; }).join(', '));
			// The real tab drops ids that are not on the board and builds each card's
			// wording from the live component; the fixture components exist here,
			// anything else does not.
			var known = (frame.items || []).filter(function(i) { return i && findComp(String(i.cid || '')); });
			if (!known.length) {
				send({ t: 'result', id: frame.id, ok: false, error: 'None of those components are on this board.' });
				return;
			}
			send({ t: 'result', id: frame.id, ok: true,
				data: 'Showed ' + known.length + ' clickable card(s) in the chat. Tell the user to click one; never quote coordinates or ids.' });
			return;
		}
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
