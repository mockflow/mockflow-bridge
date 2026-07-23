/**
 * Turn staged attachment file paths into OpenAI message content parts.
 *
 * Images  -> image_url (base64 data URI); the model must be vision-capable.
 * Text    -> inlined as a labelled text block (size-capped).
 *
 * BridgeAI has no sandbox / Read tool (capabilities.extraDirs = false), so
 * attachments are read here directly, the way opencode reads them through -f.
 */

const fs = require('fs');
const path = require('path');

const IMAGE_MIME = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.gif': 'image/gif', '.webp': 'image/webp'
};
const MAX_TEXT_BYTES = 200 * 1024;   // inline cap per text file

function toContentParts(paths) {
	const parts = [];
	(paths || []).forEach(function (p) {
		if (!p) return;
		const ext = path.extname(p).toLowerCase();
		const name = path.basename(p);
		try {
			if (IMAGE_MIME[ext]) {
				const b64 = fs.readFileSync(p).toString('base64');
				parts.push({ type: 'image_url', image_url: { url: 'data:' + IMAGE_MIME[ext] + ';base64,' + b64 } });
			} else {
				let text = fs.readFileSync(p, 'utf8');
				if (text.length > MAX_TEXT_BYTES) text = text.slice(0, MAX_TEXT_BYTES) + '\n...[truncated]';
				parts.push({ type: 'text', text: '--- attached file: ' + name + ' ---\n' + text });
			}
		} catch (e) {
			parts.push({ type: 'text', text: '--- attached file: ' + name + ' (could not be read) ---' });
		}
	});
	return parts;
}

module.exports = { toContentParts: toContentParts };
