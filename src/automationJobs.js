/**
 * MockFlow Bridge - automation runs made by the local agent.
 *
 * An automation can be set to be made by "my local agent". The MockFlow server
 * cannot reach this bridge (it listens on 127.0.0.1 only), so the bridge asks
 * the server for work instead, with a token the signed-in editor tab handed it
 * ({t:'automation-auth'}). A job is run as a component AI "create" turn with a
 * stand-in board: the capture that normally fills a component in the tab hands
 * the component data back here, and it goes to the server, which draws it.
 *
 * One job at a time. Nothing is asked while a job runs, and nothing at all
 * until a tab has signed the bridge in.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

const ACCOUNTS_FILE = path.join(config.HOME_DIR, 'bridge-automations.json');
const POLL_MS = 15000;
const REQUEST_MS = 20000;

// Where a token may be sent. The live server always; a local MockFlow only when
// the tab that handed it over is itself a local dev page.
const LIVE_SERVER = 'https://app.mockflow.com';
const LOCAL_SERVER = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
const LOCAL_TAB = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function serverAllowed(server, tabOrigin) {
	if (server === LIVE_SERVER) return true;
	return LOCAL_SERVER.test(server) && LOCAL_TAB.test(String(tabOrigin || ''));
}

class AutomationJobs {
	/**
	 * opts: { log, agents (AgentManager), hub (BoardHub), agentLabel }
	 */
	constructor(opts) {
		this.log = opts.log || function() {};
		this.agents = opts.agents;
		this.hub = opts.hub;
		this.agentLabel = opts.agentLabel || 'local agent';
		// key "server|email" -> { server, email, token }
		this.accounts = new Map();
		this.busy = false;
		this.timer = null;
		this._load();
	}

	start() {
		if (this.timer) return;
		const self = this;
		this.timer = setInterval(function() { self.tick(); }, POLL_MS);
		if (this.accounts.size) this.log('Automations: taking runs for ' + Array.from(this.accounts.values()).map(function(a) { return a.email; }).join(', '));
		setTimeout(function() { self.tick(); }, 2000);
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
	}

	/** A signed-in tab handed over its account's automation token. */
	addAccount(frame, tab) {
		const server = String((frame && frame.server) || '').replace(/\/+$/, '');
		const token = String((frame && frame.token) || '');
		const email = String((frame && frame.email) || '');
		if (!server || !token || !email) return;

		if (!serverAllowed(server, tab && tab.origin)) {
			this.log('Automations: ignored a sign-in for ' + server + ' from ' + ((tab && tab.origin) || 'an unknown page'));
			return;
		}

		const key = server + '|' + email;
		const had = this.accounts.get(key);
		if (had && had.token === token) return;

		this.accounts.set(key, { server: server, email: email, token: token });
		this._save();
		this.log('Automations: ' + email + ' can now run automations on this ' + this.agentLabel + '.');
		this.tick();
	}

	async tick() {
		if (this.busy || !this.accounts.size) return;
		this.busy = true;
		try {
			for (const account of Array.from(this.accounts.values())) {
				const res = await this._post(account, 'next', { agent: this.agentLabel });
				if (res && res.job) await this._run(account, res.job);
			}
		} catch (e) {
			this.log('Automations: ' + e.message);
		} finally {
			this.busy = false;
		}
	}

	/** Run one job as a component create turn and send back what the agent made. */
	_run(account, job) {
		const self = this;
		const turnId = 'auto_' + job.id;
		// A stand-in for a board tab: the job has no tab, and its key never matches a real board
		// isBasic keeps the workspace folder out of an unattended run: the agent writes from the job alone
		const tab = { id: turnId, projectid: turnId, title: 'Automation run', ws: null, origin: null, registered: true, isBasic: true };
		const started = Date.now();

		this.log('Automations: making a ' + job.comptype + ' for ' + account.email + ' (run ' + job.id + ')');

		return new Promise(function(resolve) {
			let gdata = null;
			let done = false;

			const finish = async function(ok, error) {
				if (done) return;
				done = true;
				const secs = ((Date.now() - started) / 1000).toFixed(0);
				try {
					await self._post(account, 'result', { id: job.id, claim: job.claim, ok: ok, gdata: ok ? gdata : null, error: ok ? null : error });
					self.log('Automations: run ' + job.id + (ok ? ' made in ' + secs + 's' : ' failed after ' + secs + 's: ' + error));
				} catch (e) {
					self.log('Automations: could not send run ' + job.id + ' back: ' + e.message);
				}
				resolve();
			};

			const send = function(frame) {
				if (!frame) return;
				if (frame.t === 'compgen-data' && frame.gdata) gdata = frame.gdata;
				if (frame.t === 'compgen-done') {
					if (gdata) finish(true);
					else finish(false, frame.error || (frame.fallback ? 'the local agent could not make this component' : 'the local agent made nothing'));
				}
			};

			try {
				self.agents.handleCompGen(tab, { id: turnId, comptype: job.comptype, mode: 'createai', prompt: job.prompt }, send, self.hub);
			} catch (e) {
				finish(false, e.message);
			}
		});
	}

	async _post(account, op, body) {
		const ctl = new AbortController();
		const timer = setTimeout(function() { ctl.abort(); }, REQUEST_MS);
		try {
			const res = await fetch(account.server + '/call/automations/agent/' + op, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + account.token },
				body: JSON.stringify(body || {}),
				signal: ctl.signal
			});
			const json = await res.json().catch(function() { return {}; });

			// A token that was revoked or ran out: forget it until a tab signs in again
			if (res.status === 401) {
				this.accounts.delete(account.server + '|' + account.email);
				this._save();
				this.log('Automations: ' + account.email + ' is signed out. Open a MockFlow board to sign in again.');
				return null;
			}
			if (!res.ok) throw new Error(json.error || (op + ' answered ' + res.status));
			return json;
		} finally {
			clearTimeout(timer);
		}
	}

	_load() {
		try {
			const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
			(Array.isArray(list) ? list : []).forEach((a) => {
				if (a && a.server && a.token && a.email) this.accounts.set(a.server + '|' + a.email, a);
			});
		} catch (e) {}
	}

	_save() {
		try {
			fs.mkdirSync(config.HOME_DIR, { recursive: true });
			fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(Array.from(this.accounts.values()), null, 2), { mode: 0o600 });
		} catch (e) {
			this.log('Automations: could not save the sign-in: ' + e.message);
		}
	}
}

module.exports = AutomationJobs;
