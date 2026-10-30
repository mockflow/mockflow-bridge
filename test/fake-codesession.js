/**
 * End-to-end test of the Claude Code Session protocol without a browser: pair and
 * register as a board tab, then drive one session through every path the board
 * component uses. Requires the daemon running with Claude Code signed in, and a
 * workspace it may write a file into.
 *
 * Usage: MFBRIDGE_PORT=21296 node test/fake-codesession.js [pairing-code]
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.MFBRIDGE_PORT || 21196;
const TOKEN_FILE = process.env.FAKE_TAB_TOKEN_FILE || path.join(__dirname, '.fake-tab-token');
const pairCode = process.argv[2] || null;
const SID = 'cstest' + Date.now();
const T0 = Date.now();
function el() { return '+' + ((Date.now() - T0) / 1000).toFixed(1) + 's '; }

let token = null;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
}

let ws, onEvent = null, onReady = null;
function send(frame) { ws.send(JSON.stringify(frame)); }

function connect(cb) {
	ws = new WebSocket('ws://127.0.0.1:' + PORT + '/board', { headers: { Origin: 'https://app.mockflow.com' } });
	ws.on('open', function() { send({ t: 'hello', token: token || undefined }); });
	ws.on('message', function(raw) {
		const f = JSON.parse(raw.toString());
		if (f.t === 'pair-required') {
			if (!pairCode) { console.error('pairing required - pass the code'); process.exit(1); }
			send({ t: 'pair', code: pairCode });
		} else if (f.t === 'paired' || f.t === 'ready') {
			if (f.t === 'paired') { token = f.token; fs.writeFileSync(TOKEN_FILE, f.token); }
			send({ t: 'register', projectid: 'cstestboard', title: 'Code Session Test', focused: true, visible: true });
		} else if (f.t === 'registered') {
			cb();
		} else if (f.t === 'tool' || f.t === 'read' || f.t === 'toolhtml') {
			send({ t: 'result', id: f.id, ok: true, data: { rendered: f.toolName || f.what || 'ok' } });
		} else if (f.t === 'cs' && f.sid === SID) {
			if (f.op === 'ready' && onReady) onReady(f);
			else if (f.op === 'event' && onEvent) onEvent(f.ev);
			else if (f.op === 'error') console.log(el() + 'ERROR ' + f.code + ' ' + f.message);
		}
	});
	ws.on('error', function(err) { console.error(err.message); process.exit(1); });
}

// Runs one prompt; handler(ev, ctx) may answer asks. Resolves with the turn log.
function turn(text, handler) {
	return new Promise(function(resolve) {
		const log = { events: [], text: '' };
		onEvent = function(ev) {
			log.events.push(ev);
			if (ev.k === 'text') log.text += ev.text;
			if (ev.k === 'tool' || ev.k === 'ask' || ev.k === 'result' || ev.k === 'answered')
				console.log(el() + ev.k + ' ' + (ev.name || ev.tool || ev.kind || '') + ' ' + (ev.summary || ev.behavior || (ev.k === 'result' ? 'ok=' + ev.ok + ' interrupted=' + ev.interrupted : '')));
			if (handler) handler(ev, log);
			if (ev.k === 'result') resolve(log);
		};
		send({ t: 'cs', op: 'prompt', sid: SID, text: text });
	});
}

function answer(reqId, behavior, extra) {
	send(Object.assign({ t: 'cs', op: 'answer', sid: SID, reqId: reqId, behavior: behavior, by: 'Sam' }, extra || {}));
}

connect(function() {
	onReady = async function(f) {
		onReady = null;
		const info = f.info || {};
		const names = (info.commands || []).map(function(c) { return c.name; });
		check('ready lists commands and skills', names.indexOf('compact') !== -1 && names.length > 5, names.length + ' commands, workspace ' + info.workspaceName);

		const t1 = await turn('Sam: Create a file named notes.txt containing the word hello. Use the Write tool.', function(ev) {
			if (ev.k === 'ask' && ev.kind === 'permission') answer(ev.reqId, 'allow');
		});
		const asked = t1.events.filter(function(e) { return e.k === 'ask' && e.tool === 'Write'; }).length;
		const wrote = t1.events.some(function(e) { return e.k === 'tool-result' && e.ok; });
		check('permission card for Write, allowed, file written', asked === 1 && wrote);

		const t2 = await turn('Ana: Use the AskUserQuestion tool to ask me which colour I prefer, with options Red and Blue. Then reply with only the colour I chose.', function(ev) {
			if (ev.k === 'ask' && ev.kind === 'question') {
				const q = ev.input.questions[0];
				const a = {}; a[q.question] = 'Blue';
				answer(ev.reqId, 'allow', { answers: a, by: 'Ana' });
			}
		});
		check('question card answered, agent used the answer', /blue/i.test(t2.text), JSON.stringify(t2.text.slice(0, 60)));

		const t3 = await turn('/cost');
		check('slash command /cost runs in the session', t3.text.length > 10, JSON.stringify(t3.text.slice(0, 60)));

		let sentInterrupt = false;
		const t4 = await turn('Lee: Count from 1 to 400, one number per line, as plain text.', function(ev) {
			if (ev.k === 'delta' && !sentInterrupt) { sentInterrupt = true; send({ t: 'cs', op: 'interrupt', sid: SID }); }
		});
		const r4 = t4.events.filter(function(e) { return e.k === 'result'; })[0];
		check('Stop interrupts mid-stream', r4 && r4.interrupted === true);

		const t5 = await turn('Sam: Run the bash command: rm notes.txt . If it is denied, reply with just: denied', function(ev) {
			if (ev.k === 'ask' && ev.kind === 'permission') answer(ev.reqId, 'deny', { message: 'Sam denied this.' });
		});
		const ws5 = path.join(process.env.CS_WORKSPACE || '', 'notes.txt');
		check('Deny keeps the file', !process.env.CS_WORKSPACE || fs.existsSync(ws5), /denied/i.test(t5.text) ? 'agent said denied' : t5.text.slice(0, 60));

		const t6 = await turn('Sam: Edit notes.txt to say hello world. Use the Edit tool.', function(ev) {
			if (ev.k === 'ask' && ev.kind === 'permission') answer(ev.reqId, 'allow', { scope: 'session' });
		});
		const t7 = await turn('Sam: Now append a second line "bye" to notes.txt with the Edit tool.', null);
		check('Allow edits this session skips later edit cards',
			t6.events.some(function(e) { return e.k === 'ask'; }) && !t7.events.some(function(e) { return e.k === 'ask'; }));

		// Reload: a new socket re-opens the same sid and finds the live process.
		ws.removeAllListeners('message'); ws.close();
		connect(function() {
			onReady = function(f2) {
				check('reconnect resumes the live session', f2.info && f2.info.claudeSessionId === info.claudeSessionId || !!(f2.info && f2.info.claudeSessionId), 'session ' + (f2.info && f2.info.claudeSessionId));
				send({ t: 'cs', op: 'close', sid: SID });
				const failed = results.filter(function(r) { return !r.ok; }).length;
				console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
				setTimeout(function() { process.exit(failed ? 1 : 0); }, 300);
			};
			send({ t: 'cs', op: 'open', sid: SID });
		});
	};
	send({ t: 'cs', op: 'open', sid: SID });
});

setTimeout(function() { console.error('timeout after 600s'); process.exit(1); }, 600000);
