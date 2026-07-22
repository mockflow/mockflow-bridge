/**
 * Terminal picker for "which local agent CLI should run turns?".
 *
 * Shared by the daemon (asked once when the setup is ambiguous) and by the
 * `mockflow-bridge agent` command (asked whenever the user wants to change it),
 * so both look and behave the same.
 */

const ui = require('./ui');

/**
 * Ask which of `choices` (detectAll()/installed() rows) to use.
 * `current` is the id to mark as the one in effect, if any.
 * Any invalid answer falls through to the first choice; an empty answer with a
 * `current` keeps the current one.
 */
function ask(choices, current) {
	const paint = ui.err;
	console.error('');
	console.error(paint.bold('Which agent should MockFlow run local turns on?'));
	choices.forEach(function(c, i) {
		console.error('  ' + paint.teal(String(i + 1)) + '. ' + c.label
			+ (c.version ? paint.dim(' ' + c.version) : '')
			+ (c.id === current ? paint.green('  (current)') : ''));
	});
	console.error(paint.dim('  (remembered for next time - change it any time with '
		+ 'mockflow-bridge agent)'));
	const currentIdx = indexOfId(choices, current);
	const dflt = currentIdx === -1 ? 0 : currentIdx;
	return new Promise(function(resolve) {
		const readline = require('readline');
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		rl.question('  Choice [' + (dflt + 1) + ']: ', function(answer) {
			rl.close();
			const raw = String(answer).trim();
			if (!raw) return resolve(choices[dflt]);
			const idx = parseInt(raw, 10) - 1;
			resolve(choices[idx] || choices[dflt]);
		});
	});
}

function indexOfId(choices, id) {
	for (var i = 0; i < choices.length; i++) {
		if (choices[i].id === id) return i;
	}
	return -1;
}

module.exports = { ask: ask };
