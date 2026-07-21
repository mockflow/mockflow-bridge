/**
 * MockFlow Bridge - debug tracing for render tools.
 *
 * WHY: everything the agent generates (component JSON, or the raw HTML for
 * render_wireframelite / render_prototypelite) is handed to the board tab and
 * disappears from view - so "the wireframe came out weak" is impossible to
 * diagnose from the bridge console alone. With debug on, every render_* call
 * prints what the agent generated and what the conversion actually produced,
 * and dumps the full payload to a file you can open in a browser.
 *
 * ON when:
 *   - MFBRIDGE_DEBUG=1, or
 *   - the catalog points at a local MockFlow (localhost / 127.0.0.1), i.e. a
 *     dev setup - see config.DEBUG. MFBRIDGE_DEBUG=0 forces it off.
 *
 * Dumps land in ~/.mockflow/bridge-debug/ as
 *   <timestamp>-<tool>.html   the exact HTML the agent sent (open it in a
 *                             browser: what you see there is what the capture
 *                             sees, so missing icons/charts are visible)
 *   <timestamp>-<tool>.json   tool args (non-HTML tools) or the diagnostics
 *                             the conversion returned.
 *
 * The DIAGNOSTICS line is the fastest signal. It comes from the MockFlow
 * server (aitoolsManager.htmlToPaintObjects, logged there as
 * [html2paintobjects]) and reports, for the HTML that was just converted:
 *   paintObjectCount  how many components the board got (a real screen is
 *                     dozens; single digits means the HTML was too sparse)
 *   captureMode       "charts" = chart-aware capture ran, "plain" = no chart
 *                     markup was detected in the HTML
 *   canvasCount / chartComponents   canvases in the HTML vs charts actually
 *                     captured; a gap means the Chart.js contract was broken
 *                     (missing data-chart-component, script, or init)
 *   svgIconRefs / inlineSvgs / iconFontTags   how the agent expressed icons;
 *                     only svgIconRefs (FontAwesome SVG URLs in <img>) convert
 *   warnings          plain-language version of the above
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir() {
	try {
		fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
		return true;
	} catch (e) {
		return false;
	}
}

function write(name, content) {
	if (!ensureDir()) return null;
	const file = path.join(config.DEBUG_DIR, name);
	try {
		fs.writeFileSync(file, content);
		return file;
	} catch (e) {
		return null;
	}
}

/** Print (and dump) what the agent generated for a render_* call. */
function toolCall(toolName, args) {
	if (!config.DEBUG) return;
	const a = args || {};
	const base = stamp() + '-' + String(toolName || 'tool').replace(/[^\w.-]/g, '_');

	if (typeof a.html === 'string' && a.html) {
		log('DEBUG ' + toolName + ': agent HTML (' + a.html.length + ' chars), title='
			+ JSON.stringify(a.title || '') + ', viewportWidth=' + (a.viewportWidth || 'auto')
			+ ', fidelity=' + (a.fidelity || 'low'));
		log('----- ' + toolName + ' HTML -----\n' + a.html + '\n----- end ' + toolName + ' HTML -----');
		const file = write(base + '.html', a.html);
		if (file) log('DEBUG ' + toolName + ': HTML saved to ' + file);
		return;
	}

	var json;
	try { json = JSON.stringify(a, null, '\t'); } catch (e) { json = String(a); }
	log('DEBUG ' + toolName + ': agent args (' + json.length + ' chars)');
	log('----- ' + toolName + ' args -----\n' + json + '\n----- end ' + toolName + ' args -----');
	const file = write(base + '.json', json);
	if (file) log('DEBUG ' + toolName + ': args saved to ' + file);
}

/**
 * Print the conversion report the board tab sent back (HTML-conversion tools).
 * Returns a one-line summary, or '' when there is nothing to report.
 */
function toolResult(toolName, res) {
	const diag = res && res.diagnostics;
	if (!diag) return '';
	const summary = 'components=' + diag.paintObjectCount
		+ ' capture=' + diag.captureMode
		+ ' canvas=' + diag.canvasCount + '/charts=' + diag.chartComponents
		+ ' iconUrls=' + diag.svgIconRefs
		+ (diag.inlineSvgs ? ' inlineSvg=' + diag.inlineSvgs : '')
		+ (diag.iconFontTags ? ' iconFonts=' + diag.iconFontTags : '');
	if (config.DEBUG) {
		log('DEBUG ' + toolName + ': DIAGNOSTICS ' + summary);
		(diag.warnings || []).forEach(function(w) { log('DEBUG ' + toolName + ': WARNING ' + w); });
		const file = write(stamp() + '-' + String(toolName || 'tool').replace(/[^\w.-]/g, '_') + '-diagnostics.json',
			JSON.stringify(diag, null, '\t'));
		if (file) log('DEBUG ' + toolName + ': diagnostics saved to ' + file);
	}
	return summary + ((diag.warnings && diag.warnings.length) ? ' | ' + diag.warnings.join(' | ') : '');
}

module.exports = { toolCall: toolCall, toolResult: toolResult };
