/**
 * Map MCP tools <-> OpenAI function tools, and decide which are exposed this turn.
 *
 * MCP tool names are already valid OpenAI function names (render_flowchart,
 * read_board, ...), so BridgeAI uses them verbatim — no prefixing. The model
 * calls `render_flowchart`; we call MCP tools/call with the same name.
 *
 * The manager's allowlist is written in Claude's vocabulary (mcp__mockflow__*),
 * so we translate it back to bare names to filter.
 */

/** Is this (bare-ish) tool name allowed this turn, per the manager's CSV allowlist? */
function isAllowed(name, allowedTools, mockflowTools) {
	const bare = String(name || '').replace(/^mcp__mockflow__|^mockflow[._-]/, '');
	if (!bare) return false;
	if ((mockflowTools || []).indexOf(bare) === -1) return false;   // not a board tool
	const csv = String(allowedTools || '');
	if (csv.indexOf('mcp__mockflow__*') !== -1) return true;        // wildcard: all board tools
	if (csv.indexOf('mcp__mockflow__' + bare) !== -1) return true;  // named
	return false;
}

/** OpenAI `tools` array from the MCP tool list, filtered to the allowed set. */
function toOpenAITools(mcpTools, allowedTools, mockflowTools) {
	const out = [];
	(mcpTools || []).forEach(function (t) {
		if (!t || !t.name) return;
		if (!isAllowed(t.name, allowedTools, mockflowTools)) return;
		out.push({
			type: 'function',
			function: {
				name: t.name,
				description: t.description || '',
				parameters: t.inputSchema || { type: 'object', properties: {} }
			}
		});
	});
	return out;
}

module.exports = { toOpenAITools: toOpenAITools, isAllowed: isAllowed };
