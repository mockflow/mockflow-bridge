/**
 * MockFlow Bridge - MCP endpoint (JSON-RPC method handling).
 *
 * Transport-agnostic: the daemon exposes this over POST /mcp and the stdio
 * shim proxies to the same endpoint, so every MCP client (Claude Code, Codex,
 * Codex, ...) sees one identical server.
 *
 * Tool set = catalog render_* tools (drawn live on the connected board via the
 * hub) + bridge-native board tools (list_boards / select_board / read_board).
 * The agent itself is the model: tool descriptions carry the generation rules
 * and the agent supplies the finished component JSON (Mode A of the spec).
 */

const config = require('./config');
const debug = require('./debug');

const PROTOCOL_VERSION = '2025-03-26';

// Appended to every successful draw. Without it an agent that still has the
// component's data in its own context happily re-renders the whole thing to add
// one branch, which draws a SECOND component instead of editing the first.
const FOLLOWUP_HINT =
	' If the user later asks to change what you just rendered, do NOT render it again:'
	+ ' call read_board for its id and then modify_component. Re-rendering leaves the'
	+ ' original on the board and creates a duplicate.';

const INSTRUCTIONS =
	'MockFlow Bridge draws visualizations LIVE onto the MockFlow board the user has '
	+ 'open in their browser. Use the render_* tools whenever the user asks to create, '
	+ 'visualize, plan, or diagram anything. Everything you render appears instantly on '
	+ 'the board the user is looking at and is saved to their account - never output a '
	+ 'URL or ask the user to open a link. When a request needs SEVERAL visualizations '
	+ '(a plan, workspace, dashboard, or a multi-screen app), call plan_board with the '
	+ 'component list (each item carrying a self-contained brief) and STOP - the user '
	+ 'confirms the list on their board and the chosen items are generated and arranged '
	+ 'automatically, without you. Use read_board to see what is already on the board, '
	+ 'and list_boards / select_board when several boards are connected. When the user '
	+ 'refers to their own content ("my doc", "my issues", "my tickets"), call '
	+ 'list_source_tools first: they may have connected Notion, Jira, Slack or GitHub '
	+ 'to MockFlow, and you can search and fetch that content through the source tools '
	+ 'rather than answering from memory. '
	+ 'Changing something that is ALREADY on the board is modify_component, never a second '
	+ 'render: read_board gives you each component id, its label and whether it can be edited. '
	+ 'Re-rendering a component you drew earlier does not replace it, it duplicates it.';

const BRIDGE_TOOLS = [
	{
		name: 'list_boards',
		description: 'List the MockFlow boards currently connected to the bridge, including which one the user is focused on. Use this when a render fails with a board-targeting error, or before select_board.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'select_board',
		description: 'Choose which connected board the render_* tools draw on. Only needed when several boards are connected and none is focused; by default the bridge draws on the board the user is currently viewing.',
		inputSchema: {
			type: 'object',
			properties: {
				projectid: { type: 'string', description: 'projectid of the board, as returned by list_boards' }
			},
			required: ['projectid']
		}
	},
	{
		name: 'read_board',
		description: 'Read what is currently on the connected board: every component with its id, type, position and size. Use this to understand existing content before adding to it, or to answer questions about the board.',
		inputSchema: {
			type: 'object',
			properties: {
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			}
		}
	},
	{
		name: 'modify_component',
		description: 'Change a component that is ALREADY on the board, in place, instead of drawing a new one. Use this whenever the user asks to refine, update, add to, fix or change something that exists - read_board gives you the component ids. Pass what should change in plain language; the component keeps its position, size and identity.',
		inputSchema: {
			type: 'object',
			properties: {
				componentId: { type: 'string', description: 'The component id (cid) from read_board' },
				instruction: { type: 'string', description: 'What to change, in plain language (e.g. "add a Blocked column", "rename the third task to Ship beta")' }
			},
			required: ['componentId', 'instruction']
		}
	},
	// Connected sources (Notion, Jira, Slack, ...). The user applies a source in
	// their MockFlow tab; these tools reach it through that tab, because the
	// OAuth credentials live in the user's MockFlow account and never on this
	// machine. Deliberately generic: the tool list comes from MockFlow at call
	// time, so connecting a new app never needs a bridge update.
	{
		name: 'list_source_tools',
		description: 'List the tools available for the connected data sources the user applied to this request (Notion, Jira, Slack, GitHub, ...). Call this FIRST whenever the user refers to their own content ("my doc", "my issues", "my tickets") - it tells you what you can search and fetch. Returns tool names with one-line descriptions; use describe_source_tool for a schema and call_source_tool to run one.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'describe_source_tool',
		description: 'Get the full input schema for one source tool returned by list_source_tools, so you can build valid arguments for call_source_tool.',
		inputSchema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'Tool name exactly as returned by list_source_tools' }
			},
			required: ['tool']
		}
	},
	{
		name: 'call_source_tool',
		description: 'Run one source tool against the user\'s connected account and return its raw result. Search or list first to find the right item, then fetch its details. Render ONLY what comes back: pass the fetched content verbatim into whatever render_* tool you use, because the render tools cannot see this result. If nothing relevant comes back, tell the user what you searched for instead of generating from your own knowledge.',
		inputSchema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'Tool name exactly as returned by list_source_tools' },
				args: { type: 'object', description: 'Arguments matching the schema from describe_source_tool' }
			},
			required: ['tool']
		}
	}
];

class McpEndpoint {
	/**
	 * @param {object} opts
	 * @param {any[]}    opts.registry  loaded catalog (registry array with helpers)
	 * @param {string}   opts.catalogSource  'remote' | 'cache'
	 * @param {BoardHub} opts.hub
	 * @param {Function} [opts.log]
	 */
	constructor(opts) {
		this.registry = opts.registry;
		this.catalogSource = opts.catalogSource;
		this.hub = opts.hub;
		this.log = opts.log || function() {};
	}

	async handle(method, params) {
		if (!method) return {};
		if (method.indexOf('notifications/') === 0 || method === 'initialized') return {};

		switch (method) {
			case 'initialize':
				return {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'MockFlow Bridge', version: config.ENGINE_VERSION },
					instructions: INSTRUCTIONS
				};
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: this.registry.getToolDefinitions().concat(BRIDGE_TOOLS) };
			case 'tools/call':
				return this._toolsCall(params || {});
			case 'resources/list':
				return { resources: [] };
			case 'prompts/list':
				return { prompts: [] };
			default:
				throw new Error('Method not found: ' + method);
		}
	}

	async _toolsCall(params) {
		const name = params.name;
		const args = params.arguments || {};
		if (!name) throw new Error('Tool name is required');

		try {
			switch (name) {
				case 'list_boards':
					return this._ok(JSON.stringify({ boards: this.hub.listBoards() }));

				case 'select_board': {
					const boards = this.hub.listBoards();
					const found = boards.some(function(b) { return b.projectid === args.projectid; });
					if (!found) {
						return this._err('Board "' + args.projectid + '" is not connected. Connected boards: '
							+ JSON.stringify(boards));
					}
					this.hub.selectedProjectId = args.projectid;
					return this._ok('Now drawing on board "' + args.projectid + '".');
				}

				case 'read_board': {
					const data = await this.hub.runOnBoard(args.projectid || null,
						{ t: 'read', what: 'board' }, config.READ_TIMEOUT_MS);
					return this._ok(JSON.stringify(data));
				}

				case 'modify_component': {
					if (!args.componentId || !args.instruction) {
						return this._err('modify_component needs both componentId (from read_board) and instruction.');
					}
					// The tab owns the component's current data, so it builds the modify
					// prompt and runs the edit; this only carries the request.
					const res = await this.hub.runOnBoard(args.projectid || null,
						{ t: 'modify', cid: String(args.componentId), instruction: String(args.instruction) },
						config.HTML_TOOL_TIMEOUT_MS);
					return this._ok(typeof res === 'string' ? res : JSON.stringify(res));
				}

				// Source tools. The tab knows which sources the user applied and
				// forwards to MockFlow; a source the user did not apply is refused
				// there, so this side stays a dumb relay.
				case 'list_source_tools':
				case 'describe_source_tool':
				case 'call_source_tool': {
					const op = name === 'list_source_tools' ? 'list'
						: (name === 'describe_source_tool' ? 'describe' : 'call');
					// Connected sources are a Pro feature. Refuse the basic plan here so an
					// external MCP agent (Cursor, Codex) gets a clear reason too - the editor
					// gates its own source path as well (agentbridge handleSource).
					if (this.hub.isTargetBasic(args.projectid || null)) {
						return this._err('Connected sources (Notion, Jira, Slack, GitHub, ...) are a Pro feature. '
							+ 'Ask the user to upgrade to connect and use their data sources from the local agent.');
					}
					if (op !== 'list' && !args.tool) {
						return this._err('"tool" is required - use list_source_tools to see the available tool names.');
					}
					const data = await this.hub.runOnBoard(args.projectid || null,
						{ t: 'source', op: op, tool: args.tool || '', args: args.args || {} },
						config.SOURCE_TIMEOUT_MS || config.TOOL_TIMEOUT_MS);
					return this._ok(typeof data === 'string' ? data : JSON.stringify(data));
				}

				case 'layout_board': {
					// An explicit layout consumes any armed plan - never arrange the same batch twice.
					this.hub.clearPlan(null);
					const count = await this.hub.runOnBoard(null,
						{ t: 'layout', boardTitle: args.boardTitle || 'Board' });
					return this._ok('Arranged ' + count + ' visualizations in a bento layout under the section "'
						+ (args.boardTitle || 'Board') + '". The board is already updated in front of the user.');
				}

				case 'plan_board': {
					// Plan-first multiboard pipeline (the MockFlow AI flow): the agent declares
					// the batch, the hub counts the following draws and auto-arranges the board
					// after the last planned item - no reliance on the agent remembering layout.
					const items = Array.isArray(args.items) ? args.items.filter(Boolean) : [];
					if (items.length < 2) {
						return this._err('plan_board needs at least 2 items - the ordered list of components you '
							+ 'will draw, each with the render_* tool that draws it. For a single component just '
							+ 'call its render tool directly.');
					}
					const self2 = this;
					const unknown = items.filter(function(it) { return !it.tool || !self2._entry(it.tool); });
					if (unknown.length) {
						return this._err('Unknown render tools in the plan: '
							+ unknown.map(function(it) { return it && it.tool; }).join(', ')
							+ '. Every item.tool must be a render_* tool of this server.');
					}
					const noBrief = items.filter(function(it) { return !it.brief || !String(it.brief).trim(); });
					if (noBrief.length) {
						return this._err('Every plan item needs a self-contained "brief" (what to generate: '
							+ 'content, data, device, style) - generation runs from the briefs after the user '
							+ 'confirms, without your conversation context. Missing briefs on: '
							+ noBrief.map(function(it) { return it && it.name; }).join(', '));
					}
					const title = args.boardTitle || 'Board';

					// Selection step (parity with MockFlow AI): the plan is shown in the
					// user's board tab and THIS TURN ENDS - no waiting, no polling. The
					// user's Generate Board click later arms the auto-arrange plan and
					// starts the generation turn (hub.onPlanGenerate -> agent manager);
					// until they decide, the hub refuses draws on the board.
					this.hub.startPlanPick(args._projectid || null, title, items);
					return this._ok('The plan (' + items.length + ' components under "' + title + '") is now on '
						+ 'the user\'s screen for review. YOUR TURN IS COMPLETE: do not render anything and do '
						+ 'not call any more tools - when the user clicks Generate Board, the chosen items are '
						+ 'generated and arranged automatically. Briefly tell the user to review the list and '
						+ 'click Generate Board, and never output a URL or a link.');
				}
			}

			// Catalog render_* tools.
			const entry = this._entry(name);
			if (!entry) return this._err('Unknown tool: ' + name);

			// Debug tracing: print/dump what the agent generated for this render (see debug.js).
			debug.toolCall(name, args);

			if (entry.clientIsHtmlConversion) {
				// render_wireframelite / render_prototypelite ship raw HTML. The CONNECTED TAB
				// runs the conversion (HTML -> paintObjects render, or the prototype S3 upload)
				// through the MockFlow endpoints with the user's own session, then draws the
				// result - the bridge only relays the args (see boardHub.drawHtml).
				const mcpType = name.replace('render_', '');
				const hres = await this.hub.drawHtml(args._projectid || null, name, mcpType, args);
				// Conversion report from the tab (component/chart/icon counts + warnings). It
				// goes back to the AGENT too: a sparse or icon-less render is something the
				// agent can fix by regenerating the HTML, but only if it is told.
				const report = debug.toolResult(name, hres);
				const suffix = report ? '\n\nConversion report: ' + report : '';
				if (hres && hres.arranged) {
					return this._ok('Rendered the ' + mcpType + ' - that was the last planned item, so the board '
						+ 'was arranged automatically under "' + hres.boardTitle + '". You are done: do not call '
						+ 'layout_board or any other tool, and never output a URL or a link.' + suffix);
				}
				return this._ok('Rendered the ' + mcpType + ' onto the board the user has open. '
					+ 'It is already visible on their screen - do not output or ask the user to open a link.'
					+ FOLLOWUP_HINT + suffix);
			}

			// Shape check BEFORE anything is drawn. Agents sometimes invent argument
			// names or stringify structured values, and until now that produced a
			// silently malformed component: the mapping just found nothing under the
			// documented keys and rendered whatever was left. Returning a precise
			// error instead turns a bad render into a retry the agent can act on.
			const shapeErr = this._checkArgs(name, args);
			if (shapeErr) return this._err(shapeErr);

			// Same pre-flight sanitization the desktop and web MCP servers run.
			if (name === 'render_flowchart' || name === 'render_swimlane' || name === 'render_cloudarchitecture') {
				if (typeof this.registry.sanitizeFlowData === 'function') {
					this.registry.sanitizeFlowData(args);
				}
			}

			const gdata = this.registry.mapToolToGdata(name, args);
			if (!gdata) return this._err('Tool ' + name + ' has no client rendering mapping.');

			// If a component Generate/Modify turn armed a capture for this board,
			// the gdata fills the component the user is editing instead of drawing
			// a new one (fill-in-place). Otherwise it draws normally.
			const res = await this.hub.captureOrDraw(args._projectid || null, name, gdata);

			const type = name.replace('render_', '');
			if (res && res.captured) {
				return this._ok('Generated the ' + type + ' and applied it to the component the user is '
					+ 'editing. It is already updated on their screen - you are done, do not call any more tools.');
			}
			if (res && res.arranged) {
				return this._ok('Rendered the ' + type + ' - that was the last planned item, so the board was '
					+ 'arranged automatically under "' + res.boardTitle + '". You are done: do not call '
					+ 'layout_board or any other tool, and never output a URL or a link.');
			}
			return this._ok('Rendered the ' + type + ' onto the board the user has open. '
				+ 'It is already visible on their screen - do not output or ask the user to open a link.'
				+ FOLLOWUP_HINT);
		} catch (err) {
			return this._err('Error running ' + name + ': ' + (err && err.message));
		}
	}

	/**
	 * Validate one render tool call against its own catalog schema, and repair the
	 * one thing that is always safe to repair: a structured value handed over as a
	 * JSON string (args are mutated in place). Everything else is reported back to
	 * the agent naming the documented properties and what it actually sent.
	 *
	 * Registry-driven, so it stays correct as the catalog changes and needs no
	 * per-tool knowledge.
	 *
	 * Returns an error string, or null when the call is usable.
	 */
	_checkArgs(toolName, args) {
		const entry = this._entry(toolName);
		const schema = entry && entry.mcpInputSchema;
		const props = (schema && schema.properties) || null;
		if (!props) return null;

		const documented = Object.keys(props);

		// Liberal on input: a JSON string where an object or array is documented is
		// unambiguous, so parse it rather than bouncing the call.
		for (const key of documented) {
			const want = props[key] && props[key].type;
			const got = args[key];
			if ((want === 'object' || want === 'array') && typeof got === 'string') {
				try {
					const parsed = JSON.parse(got);
					if (parsed && typeof parsed === 'object') args[key] = parsed;
				} catch (e) {}
			}
		}

		const required = Array.isArray(schema.required) && schema.required.length
			? schema.required
			: documented;
		const missing = required.filter(function(k) {
			const v = args[k];
			return v === undefined || v === null || v === '';
		});
		if (!missing.length) return null;

		// Callers pass internal hints like _projectid; they are not the agent's doing.
		const sent = Object.keys(args).filter(function(k) { return k.charAt(0) !== '_'; });
		return toolName + ' was called with the wrong arguments. It takes: '
			+ documented.map(function(k) {
				return k + ' (' + ((props[k] && props[k].type) || 'value') + ')';
			}).join(', ')
			+ '. Missing: ' + missing.join(', ')
			+ (sent.length ? '. You sent: ' + sent.join(', ') : '. You sent nothing')
			+ '. Read this tool\'s description for the exact structure and call it again with those'
			+ ' argument names - nothing was drawn.';
	}

	_entry(toolName) {
		for (var i = 0; i < this.registry.length; i++) {
			if (this.registry[i].mcpToolName === toolName) return this.registry[i];
		}
		return null;
	}

	_ok(text) {
		return { content: [{ type: 'text', text: text }], isError: false };
	}

	_err(text) {
		return { content: [{ type: 'text', text: text }], isError: true };
	}
}

module.exports = McpEndpoint;
// The tools the BRIDGE adds on top of the catalog's render tools. Exported
// because a per-turn allowlist has to cover exactly what tools/list serves:
// leaving modify_component and read_board out of it means the agent cannot edit
// what is already on the board and re-renders instead, silently duplicating it.
module.exports.BRIDGE_TOOL_NAMES = BRIDGE_TOOLS.map(function(t) { return t.name; });
