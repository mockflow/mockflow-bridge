/**
 * Per-session transcript store — makes resume work despite the OpenAI Chat
 * Completions API being stateless. Each turn runs in a fresh subprocess, so the
 * message history lives on disk: ~/.mockflow/bridgeai-sessions/<id>.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

function dir() { return path.join(config.HOME_DIR, 'bridgeai-sessions'); }
function file(id) { return path.join(dir(), String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json'); }

function newId() { return 'bai_' + crypto.randomUUID(); }

function load(id) {
	if (!id) return [];
	try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) || []; }
	catch (e) { return []; }
}

function save(id, messages) {
	if (!id) return;
	try {
		fs.mkdirSync(dir(), { recursive: true });
		fs.writeFileSync(file(id), JSON.stringify(messages));
	} catch (e) {}
}

module.exports = { newId: newId, load: load, save: save };
