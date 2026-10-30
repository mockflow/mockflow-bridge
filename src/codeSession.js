/**
 * Claude Code Session: one long-lived Claude Code process per board component.
 *
 * The host tab drives a session with {t:'cs', op, sid} frames (open, prompt,
 * answer, interrupt, close). Everything the session does streams back as
 * {t:'cs', op:'event', sid, ev}. Tools that need approval arrive from the CLI as
 * can_use_tool control requests and are held until the tab answers.
 *
 *   tab -> bridge:  {t:'cs', op:'open', sid, resume?}
 *                   {t:'cs', op:'prompt', sid, text}
 *                   {t:'cs', op:'answer', sid, reqId, behavior:'allow'|'deny', answers?, scope?, message?, by?}
 *                   {t:'cs', op:'interrupt', sid}
 *                   {t:'cs', op:'close', sid}
 *   bridge -> tab:  {t:'cs', op:'ready', sid, info}
 *                   {t:'cs', op:'event', sid, ev}
 *                   {t:'cs', op:'error', sid, code, message}
 */

const path = require('path');

const MAX_OUTPUT = 6000;
const MAX_FIELD = 3000;
// Tab gone longer than the editor's reconnect window: the session is ended.
const ORPHAN_MS = 45000;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const SYSTEM_PROMPT = [
	'You are running inside a Claude Code Session component on a MockFlow IdeaBoard.',
	'Several collaborators share this session during a meeting; each prompt starts with the name of the person asking.',
	'The board is shared context: use the mockflow board tools to read the frames, notes and diagrams people mention, and to draw diagrams beside the session when that helps the group.',
	'Keep answers readable for a mixed audience of designers, product managers and developers.'
].join(' ');

function clip(s, max) {
	s = String(s == null ? '' : s);
	return s.length > max ? s.slice(0, max) + '\n… (' + (s.length - max) + ' more characters)' : s;
}

// Tool input with every long string shortened, safe to stream to the board.
function trimInput(input) {
	if (!input || typeof input !== 'object') return input;
	const out = Array.isArray(input) ? [] : {};
	Object.keys(input).forEach(function(k) {
		const v = input[k];
		if (typeof v === 'string') out[k] = clip(v, MAX_FIELD);
		else if (v && typeof v === 'object') out[k] = trimInput(v);
		else out[k] = v;
	});
	return out;
}

function resultText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map(function(c) { return c && c.type === 'text' ? c.text : ''; }).join('\n');
}

class CodeSessionManager {
	constructor(opts) {
		this.log = (opts && opts.log) || function() {};
		this.agents = opts.agents;
		this.sessions = new Map(); // sid -> session
	}

	handle(tab, msg, send) {
		const sid = msg && typeof msg.sid === 'string' ? msg.sid : '';
		if (!sid) return;
		switch (msg.op) {
			case 'open': return this.open(tab, sid, msg, send);
			case 'prompt': return this.prompt(sid, msg, send);
			case 'answer': return this.answer(sid, msg);
			case 'interrupt': return this.interrupt(sid);
			case 'close': return this.close(sid);
		}
	}

	open(tab, sid, msg, send) {
		const existing = this.sessions.get(sid);
		if (existing && existing.proc && existing.projectid === tab.projectid) {
			// Same board reconnected (reload, socket drop): keep the live process.
			clearTimeout(existing.orphanTimer);
			existing.orphanTimer = null;
			existing.send = send;
			send({ t: 'cs', op: 'ready', sid: sid, info: existing.info, busy: existing.busy });
			existing.pending.forEach(function(p, reqId) { send({ t: 'cs', op: 'event', sid: sid, ev: p.ev }); });
			return;
		}
		const adapter = this.agents.agent;
		if (!adapter || typeof adapter.buildSessionArgs !== 'function') {
			send({ t: 'cs', op: 'error', sid: sid, code: 'unsupported',
				message: 'Claude Code Session needs Claude Code as the local agent. Start the bridge with Claude Code selected.' });
			return;
		}
		if (!this.agents.detect()) {
			send({ t: 'cs', op: 'error', sid: sid, code: 'missing', message: adapter.installHint() });
			return;
		}

		const cwd = this.agents._effectiveWorkspace(tab);
		const spec = adapter.buildSessionArgs({
			projectid: tab.projectid,
			resume: typeof msg.resume === 'string' && /^[\w-]{8,80}$/.test(msg.resume) ? msg.resume : null,
			systemPrompt: SYSTEM_PROMPT
		});
		let proc;
		try {
			proc = adapter.spawn(spec.args, { cwd: cwd, env: this.agents._turnEnv(spec), stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (e) {
			send({ t: 'cs', op: 'error', sid: sid, code: 'spawn', message: 'Could not start Claude Code on this machine.' });
			return;
		}

		const s = {
			sid: sid, projectid: tab.projectid, proc: proc, send: send, cwd: cwd,
			buf: '', busy: false, allowEdits: false, allowAlways: new Set(),
			pending: new Map(), openText: [], textSeq: 0, orphanTimer: null, interrupting: false,
			info: {
				workspaceName: this.agents._workspaceEnabled(tab) ? path.basename(cwd) : null,
				version: (adapter.detect() || {}).version || '',
				commands: [], terminalOnly: [], model: null, claudeSessionId: null
			}
		};
		this.sessions.set(sid, s);
		this.log('[code session] started for board ' + (tab.title || tab.projectid) + (msg.resume ? ' (resumed)' : ''));

		const self = this;
		proc.stdout.on('data', function(d) {
			s.buf += d;
			let i;
			while ((i = s.buf.indexOf('\n')) >= 0) {
				const line = s.buf.slice(0, i);
				s.buf = s.buf.slice(i + 1);
				if (line.trim()) self._onLine(s, line);
			}
		});
		proc.stderr.on('data', function(d) { self.log('[code session] ' + String(d).trim().slice(0, 300)); });
		proc.on('error', function() { self._ended(s, null); });
		proc.on('close', function(code) { self._ended(s, code); });
		this._write(s, { type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: null } });
	}

	prompt(sid, msg, send) {
		const s = this.sessions.get(sid);
		const text = String(msg.text || '').trim();
		if (!s) { send({ t: 'cs', op: 'error', sid: sid, code: 'closed', message: 'This session is not running.' }); return; }
		if (!text) return;
		if (s.busy) { send({ t: 'cs', op: 'error', sid: sid, code: 'busy', message: 'The session is still working.' }); return; }
		this._setBusy(s, true);
		this._write(s, { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
	}

	answer(sid, msg) {
		const s = this.sessions.get(sid);
		if (!s) return;
		const p = s.pending.get(msg.reqId);
		if (!p) return;
		s.pending.delete(msg.reqId);
		const allow = msg.behavior === 'allow';
		let response;
		if (!allow) {
			response = { behavior: 'deny', message: String(msg.message || 'The user declined this.').slice(0, 2000) };
		} else if (p.kind === 'question') {
			const answers = {};
			const given = msg.answers && typeof msg.answers === 'object' ? msg.answers : {};
			Object.keys(given).forEach(function(q) { answers[String(q)] = String(given[q]).slice(0, 2000); });
			response = { behavior: 'allow', updatedInput: Object.assign({}, p.input, { answers: answers }) };
		} else {
			response = { behavior: 'allow', updatedInput: p.input };
			if (msg.scope === 'session') {
				if (EDIT_TOOLS.indexOf(p.tool) !== -1) s.allowEdits = true;
				else s.allowAlways.add(this._ruleKey(p.tool, p.input));
			}
		}
		this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: msg.reqId, response: response } });
		this._event(s, { k: 'answered', reqId: msg.reqId, behavior: allow ? 'allow' : 'deny',
			scope: msg.scope === 'session' ? 'session' : 'once', by: String(msg.by || '').slice(0, 120),
			answers: p.kind === 'question' && allow ? response.updatedInput.answers : undefined });
	}

	interrupt(sid) {
		const s = this.sessions.get(sid);
		if (!s || !s.busy) return;
		// Waiting asks would hold the turn open; settle them as stopped first.
		const self = this;
		Array.from(s.pending.keys()).forEach(function(reqId) {
			self.answer(sid, { reqId: reqId, behavior: 'deny', message: 'Stopped by the user.' });
		});
		s.interrupting = true;
		this._write(s, { type: 'control_request', request_id: 'int' + Date.now(), request: { subtype: 'interrupt' } });
	}

	close(sid) {
		const s = this.sessions.get(sid);
		if (!s) return;
		this.sessions.delete(sid);
		clearTimeout(s.orphanTimer);
		try { s.proc.kill(); } catch (e) {}
		this.log('[code session] closed');
	}

	/** The board's tab went away: end its sessions unless it reconnects in time. */
	tabGone(tab) {
		const self = this;
		this.sessions.forEach(function(s) {
			if (s.projectid !== tab.projectid || s.orphanTimer) return;
			s.orphanTimer = setTimeout(function() {
				if (self.sessions.get(s.sid) === s) self.close(s.sid);
			}, ORPHAN_MS);
		});
	}

	closeAll() {
		Array.from(this.sessions.keys()).forEach(this.close.bind(this));
	}

	isBusy() {
		let busy = false;
		this.sessions.forEach(function(s) { if (s.busy) busy = true; });
		return busy;
	}

	_ruleKey(tool, input) {
		return tool + ':' + (input && input.command ? String(input.command) : '');
	}

	_write(s, obj) {
		try { s.proc.stdin.write(JSON.stringify(obj) + '\n'); }
		catch (e) { this.log('[code session] write failed: ' + (e && e.message)); }
	}

	_event(s, ev) {
		s.send({ t: 'cs', op: 'event', sid: s.sid, ev: ev });
	}

	_setBusy(s, busy) {
		if (s.busy === busy) return;
		s.busy = busy;
		this._event(s, { k: 'status', busy: busy });
	}

	_ended(s, code) {
		if (s.done) return;
		s.done = true;
		clearTimeout(s.orphanTimer);
		if (this.sessions.get(s.sid) === s) this.sessions.delete(s.sid);
		this._event(s, { k: 'exit', code: code });
	}

	_summary(s, input) {
		input = input || {};
		const rel = function(p) {
			p = String(p || '');
			return p.indexOf(s.cwd + path.sep) === 0 ? p.slice(s.cwd.length + 1) : p;
		};
		if (input.command) return String(input.command);
		if (input.file_path) return rel(input.file_path);
		if (input.notebook_path) return rel(input.notebook_path);
		if (input.pattern) return String(input.pattern) + (input.path ? ' in ' + rel(input.path) : '');
		if (input.url) return String(input.url);
		if (input.query) return String(input.query);
		if (input.description) return String(input.description);
		if (input.subject) return String(input.subject);
		if (Array.isArray(input.todos)) return input.todos.length + ' tasks';
		return '';
	}

	_onLine(s, line) {
		let j;
		try { j = JSON.parse(line); } catch (e) { return; }

		if (j.type === 'control_response') {
			const r = j.response || {};
			if (r.request_id === 'init') {
				const res = r.response || {};
				s.info.commands = (res.commands || []).map(function(c) {
					return { name: c.name, description: clip(c.description || '', 300), hint: c.argumentHint || '', builtin: !!c.builtin };
				});
				const def = (res.models || []).filter(function(m) { return m.value === 'default'; })[0];
				if (def) s.info.model = def.displayName && def.description ? def.description.split(' · ')[0] : def.resolvedModel;
				s.send({ t: 'cs', op: 'ready', sid: s.sid, info: s.info, busy: s.busy });
			}
			return;
		}

		if (j.type === 'control_request') {
			const req = j.request || {};
			if (req.subtype !== 'can_use_tool') {
				this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: {} } });
				return;
			}
			this._onPermission(s, j.request_id, req);
			return;
		}

		if (j.type === 'system' && j.subtype === 'init') {
			s.info.claudeSessionId = j.session_id || s.info.claudeSessionId;
			s.info.terminalOnly = j.terminal_slash_commands || [];
			if (j.model) s.info.modelId = j.model;
			this._event(s, { k: 'session', claudeSessionId: s.info.claudeSessionId, terminalOnly: s.info.terminalOnly });
			return;
		}

		if (j.type === 'stream_event') {
			const e = j.event || {};
			if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text' && !j.parent_tool_use_id) {
				const key = 't' + (++s.textSeq);
				s.openText.push(key);
				this._event(s, { k: 'text-start', key: key });
			} else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && !j.parent_tool_use_id) {
				const key = s.openText[s.openText.length - 1];
				if (key) this._event(s, { k: 'delta', key: key, text: e.delta.text });
			}
			return;
		}

		if (j.type === 'assistant' && j.message && !j.parent_tool_use_id) {
			const self = this;
			(j.message.content || []).forEach(function(b) {
				if (b.type === 'text' && b.text) {
					const key = s.openText.shift() || ('t' + (++s.textSeq));
					self._event(s, { k: 'text', key: key, text: b.text });
				} else if (b.type === 'tool_use') {
					if (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode') return;
					self._event(s, { k: 'tool', id: b.id, name: b.name, summary: clip(self._summary(s, b.input), 300), input: trimInput(b.input) });
				}
			});
			return;
		}

		if (j.type === 'user' && j.message && Array.isArray(j.message.content) && !j.parent_tool_use_id) {
			const self = this;
			j.message.content.forEach(function(c) {
				if (c.type === 'tool_result')
					self._event(s, { k: 'tool-result', id: c.tool_use_id, ok: !c.is_error, output: clip(resultText(c.content), MAX_OUTPUT) });
			});
			return;
		}

		if (j.type === 'result') {
			const interrupted = s.interrupting;
			s.interrupting = false;
			s.openText = [];
			const adapter = this.agents.agent;
			const auth = adapter && adapter.authFailureHint ? adapter.authFailureHint(j.result) : null;
			if (auth) this._event(s, { k: 'error', message: auth });
			this._event(s, { k: 'result', ok: j.subtype === 'success' && !j.is_error, interrupted: interrupted,
				durationMs: j.duration_ms || 0, turns: j.num_turns || 0 });
			this._setBusy(s, false);
		}
	}

	_onPermission(s, reqId, req) {
		const tool = req.tool_name || '';
		const input = req.input || {};
		// Board tools only draw on the board the host already has open.
		if (tool.indexOf('mcp__mockflow__') === 0
			|| (s.allowEdits && EDIT_TOOLS.indexOf(tool) !== -1)
			|| s.allowAlways.has(this._ruleKey(tool, input))) {
			this._write(s, { type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { behavior: 'allow', updatedInput: input } } });
			return;
		}
		const kind = tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
		const ev = { k: 'ask', reqId: reqId, kind: kind, tool: tool, description: clip(req.description || '', 300),
			summary: clip(this._summary(s, input), 300), input: kind === 'question' ? input : trimInput(input) };
		s.pending.set(reqId, { kind: kind, tool: tool, input: input, ev: ev });
		this._event(s, ev);
	}
}

module.exports = CodeSessionManager;
