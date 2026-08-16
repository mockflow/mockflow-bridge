/**
 * One stream-watching loop for every agent turn.
 *
 * Each turn lane (chat, component AI, plan lanes, shared-facts, image
 * re-render) used to carry its own copy of the same plumbing: a newline
 * buffer over stdout feeding parseLine, a newline buffer over stderr feeding
 * parseStderr, and a rolling stderr tail for error messages. A fix to any of
 * it had to be made in four places. This is that plumbing, once.
 *
 * It also keeps the numbers that make a broken parser VISIBLE instead of
 * silent (see agents/runtimeHealth.js): how many stdout lines the CLI
 * produced against how many the parser actually understood. Turn success no
 * longer rides on these events alone - the orchestrator cross-checks them
 * against the MCP calls the bridge itself served - so a vendor changing its
 * output format degrades the progress display rather than failing the turn,
 * and the mismatch is reported instead of guessed at.
 *
 * The parser is additionally wrapped in try/catch here: a parseLine that
 * throws on a shape it has never seen must cost one unread line, never the
 * turn.
 */

/**
 * Watch a spawned agent process's streams.
 *
 * handlers (all optional):
 *   onEvent(ev)   one normalized event from agent.parseLine
 *   onModel(id)   a model id found on stderr via agent.parseStderr
 *   onChunk(len)  raw stdout volume, for liveness heartbeats
 *
 * Returns a live stats object the caller reads when the process closes:
 *   stdoutLines   non-empty stdout lines seen
 *   parsedEvents  normalized events the parser produced
 *   toolStarts    ...of which were tool-start
 *   textEvents    ...of which were text
 *   sessionSeen   a session id was parsed
 *   parseErrors   lines on which parseLine threw
 *   stderrTail    last ~2000 chars of stderr (for lastErrorLine)
 */
function watchTurn(agent, proc, handlers) {
	handlers = handlers || {};
	const stats = {
		stdoutLines: 0,
		parsedEvents: 0,
		toolStarts: 0,
		textEvents: 0,
		sessionSeen: false,
		parseErrors: 0,
		stderrTail: ''
	};

	let outBuf = '';
	proc.stdout && proc.stdout.on('data', function(chunk) {
		if (handlers.onChunk) handlers.onChunk(chunk.length);
		outBuf += chunk.toString();
		let nl;
		while ((nl = outBuf.indexOf('\n')) >= 0) {
			const line = outBuf.slice(0, nl).trim();
			outBuf = outBuf.slice(nl + 1);
			if (!line) continue;
			stats.stdoutLines++;
			let events;
			try { events = agent.parseLine(line) || []; }
			catch (e) { stats.parseErrors++; continue; }
			for (let i = 0; i < events.length; i++) {
				const ev = events[i];
				if (!ev || !ev.type) continue;
				stats.parsedEvents++;
				if (ev.type === 'tool-start') stats.toolStarts++;
				else if (ev.type === 'text') stats.textEvents++;
				else if (ev.type === 'session') stats.sessionSeen = true;
				if (handlers.onEvent) handlers.onEvent(ev);
			}
		}
	});

	let errBuf = '';
	proc.stderr && proc.stderr.on('data', function(d) {
		const text = d.toString();
		stats.stderrTail = (stats.stderrTail + text).slice(-2000);
		if (!agent.parseStderr || !handlers.onModel) return;
		errBuf += text;
		let nl;
		while ((nl = errBuf.indexOf('\n')) >= 0) {
			const line = errBuf.slice(0, nl);
			errBuf = errBuf.slice(nl + 1);
			let ev = null;
			try { ev = agent.parseStderr(line); } catch (e) {}
			if (ev && ev.type === 'model' && ev.id) handlers.onModel(ev.id);
		}
	});

	return stats;
}

module.exports = { watchTurn };
