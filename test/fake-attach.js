/**
 * End-to-end test of the ATTACHMENT path: send a chat turn carrying a file and
 * check the agent actually read it.
 *
 * The bridge saves the file under ~/.mockflow/attachments/<board>/ and points
 * the agent at that path. An agent whose file tools are confined to its working
 * directory cannot open it, so this reports READ vs COULD-NOT-READ instead of
 * leaving it to look like a normal reply.
 *
 * Usage: node test/fake-attach.js [pairing-code]
 * Requires the daemon running and an agent installed.
 */
const fs = require('fs'), path = require('path'), WebSocket = require('ws');
const PORT = process.env.MFBRIDGE_PORT || 21196;
const TOKEN_FILE = path.join(__dirname, '.fake-tab-token');
const code = process.argv[2] || null;
const MARKER = 'PINEAPPLE-4711';
const FILE = 'The project codename is ' + MARKER + '. Remember it.\n';

let token = null; try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/board', { headers: { Origin: 'https://app.mockflow.com' } });
const send = f => ws.send(JSON.stringify(f));

ws.on('open', () => send({ t: 'hello', token: token || undefined }));
ws.on('message', raw => {
	const f = JSON.parse(raw.toString());
	switch (f.t) {
		case 'pair-required':
			if (!code) { console.log('need pairing code'); process.exit(1); }
			return send({ t: 'pair', code });
		case 'paired': fs.writeFileSync(TOKEN_FILE, f.token); return register();
		case 'ready': return register();
		case 'registered':
			console.log('registered; sending chat with a text attachment...');
			return send({
				t: 'chat', id: 'a1',
				text: 'What is the project codename in the attached file? Reply with just the codename. Do not draw anything.',
				attachment: { name: 'codename.txt', kind: 'file', data: Buffer.from(FILE).toString('base64') }
			});
		case 'tool': case 'toolhtml':
			return send({ t: 'result', id: f.id, ok: true, data: { rendered: f.toolName } });
		case 'chat-done': {
			const text = String(f.text || '');
			const got = text.indexOf(MARKER) !== -1;
			console.log('reply: ' + JSON.stringify(text.slice(0, 160)));
			console.log('VERDICT: ' + (got ? 'READ THE ATTACHMENT' : 'COULD NOT READ IT'));
			return setTimeout(() => process.exit(got ? 0 : 1), 200);
		}
	}
});
function register() { send({ t: 'register', projectid: 'attachboard', title: 'Attach Board', focused: true, visible: true }); }
setTimeout(() => { console.log('timeout'); process.exit(1); }, 180000);
