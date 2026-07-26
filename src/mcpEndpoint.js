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
	+ 'URL or ask the user to open a link. One component wins over a plan: when a single '
	+ 'render_* tool covers the request, call that tool, and a component that is itself '
	+ 'multi-part (many screens, scenes or steps inside one artifact) is still one component. '
	+ 'When a request needs SEVERAL DIFFERENT components '
	+ '(a plan, workspace, dashboard or kit), call plan_board with the '
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
	+ 'Re-rendering a component you drew earlier does not replace it, it duplicates it. '
	+ 'You cannot paint a picture, film a clip, make a sound or build a 3D mesh yourself - but you do '
	+ 'not have to: render_image, render_video, render_audio and render_3dmodel take YOUR prompt and '
	+ 'have MockFlow AI generate the asset in the user\'s browser. Use them whenever the user asks '
	+ 'for one, and write a vivid, self-contained prompt - that prompt is your whole contribution, '
	+ 'because the generator never sees this conversation. They cost the user AI credits, so the user '
	+ 'confirms before each one runs. Never stand in a design, moodboard or any other component for a '
	+ 'request for a picture, and never tell the user MockFlow cannot make one. (Some render tools '
	+ 'also carry AI-generated imagery INSIDE the component they compose - that is a slot in a larger '
	+ 'component, not a way to answer a request for a picture.)';

// What imagery means on a MODIFY, whatever the component. Deliberately not
// per-component: "keep what is there" is the same instruction for a moodboard,
// a design and a document, and it is the opposite of the create-time rules.
const MODIFY_IMAGERY =
	'THIS RENDER IS BUILT FROM SOMETHING ALREADY ON THE BOARD - an edit of it, a conversion of it, or a '
	+ 'new screen matching it - so its EXISTING imagery stays. Copy every image reference you were given '
	+ 'across exactly as it is and give it no new prompt - never drop a picture that is already there, '
	+ 'and never replace a real picture with a placeholder.';

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
		name: 'declare_render',
		description: 'FIRST STEP of a drawing request: say WHICH component you are about to create, before you create it. The render tools are deliberately not available to you yet - they appear once this is answered. Pass the render_* tool you intend to use, or "plan" when no single component covers the request and it needs several different ones. If the user is NOT asking for anything to be drawn (a question, a chat, an edit to something that already exists), pass "none" and carry on answering normally.',
		inputSchema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'The render_* tool you will use (e.g. "render_moodframe"), "plan" for several different components, or "none" if this request does not draw anything.' }
			},
			required: ['tool']
		}
	},
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
		this.genCap = opts.genCap || null;
		this.log = opts.log || function() {};
	}

	/**
	 * Count one basic-plan generation and push the updated usage to the board tab.
	 * The bridge only MEASURES the daily cap - it never blocks. The editor reads the
	 * usage and does the prevention itself, the same way it gates on AI credits.
	 */
	_recordGen(projectid) {
		if (!this.genCap) return;
		const count = this.genCap.record();
		const remaining = this.genCap.remaining();
		if (remaining <= 0)
			this.log('Basic plan: daily local generation limit reached (' + count + '/' + this.genCap.limit + ') - further generations run on MockFlow AI until it resets tomorrow.');
		else
			this.log('Basic plan: local generation ' + count + '/' + this.genCap.limit + ' (' + remaining + ' left today).');
		this.hub.notifyGenUsage(projectid || null);
	}

	// ctx.boardId (when present) is the board this connection is bound to - the
	// projectid the daemon parsed from the /mcp/<token>/<projectid> URL that this
	// turn was spawned with. It makes every draw target THIS turn's board instead
	// of the shared hub.selectedProjectId, so two tabs generating at once no longer
	// race that global (both landing on whichever was selected last). A null boardId
	// (an unscoped /mcp/<token> connection, e.g. an external agent) keeps the old
	// selectedProjectId fallback.
	async handle(method, params, ctx) {
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
			case 'tools/list': {
				const declaring = typeof this.hub.getTurnPhase === 'function'
					&& this.hub.getTurnPhase((ctx && ctx.boardId) || null) === 'declare';
				const self5 = this;
				// declare_render exists only while deciding. Offering it once the
				// render tools are back invites a second, pointless declaration.
				const bridgeTools = BRIDGE_TOOLS.filter(function(t) {
					return declaring ? true : t.name !== 'declare_render';
				}).map(function(t) {
					// While deciding, the render tools are not in the list - so the
					// agent cannot see what it is allowed to name. Give declare_render
					// the menu, or it guesses ("render_colorpalette") and burns a call
					// per guess until it stumbles on a real name.
					return (declaring && t.name === 'declare_render') ? self5._declareToolDef() : t;
				});
				return { tools: this._toolDefsForTurn(ctx).concat(bridgeTools) };
			}
			case 'tools/call':
				return this._toolsCall(params || {}, ctx);
			case 'resources/list':
				return { resources: [] };
			case 'prompts/list':
				return { prompts: [] };
			default:
				throw new Error('Method not found: ' + method);
		}
	}

	/**
	 * The tool list for THIS turn.
	 *
	 * A component that can carry imagery is composed differently depending on
	 * whether it has any - a moodboard built around photo tiles is not the same
	 * layout as one built from colour and type. So each such tool's description
	 * gets exactly ONE of its two branches appended: the mode this turn is in.
	 * The agent never reads the rules for the mode it is not in, which is how the
	 * server generators do it (one prompt, the applicable half appended).
	 *
	 * Every turn is a fresh agent process and therefore a fresh tools/list, and
	 * the user's answer is recorded before the process is spawned - so by the time
	 * this is called the mode is already known. An unanswered turn is the no-imagery
	 * branch, which is what the agent should compose first anyway.
	 */
	/**
	 * declare_render, with the menu of components it may name.
	 *
	 * Built from the catalog so it can never drift from what actually exists: the
	 * enum makes an invented name impossible, and one line each is enough to pick
	 * the right one. Deliberately short - the whole point of the deciding step is
	 * that it does not carry the full catalog.
	 */
	_declareToolDef() {
		const names = ['none', 'plan'];
		const lines = [];
		// "plan" is described from the catalog like every other choice. Left bare it
		// was the one option in a thirty-item menu with nothing beside it, so the
		// requests that need it - a whole app, which is one wireframe per screen -
		// went to whichever single component happened to read closest instead.
		lines.push('plan - ' + this._declareLine(this._entry('plan_board'),
			'Several DIFFERENT components at once (a plan, workspace, dashboard or kit).'));
		for (var i = 0; i < this.registry.length; i++) {
			const e = this.registry[i];
			if (!e.mcpToolName || e.mcpToolName.indexOf('render_') !== 0) continue;
			names.push(e.mcpToolName);
			lines.push(e.mcpToolName + ' - ' + this._declareLine(e, ''));
		}
		return {
			name: 'declare_render',
			description: 'FIRST STEP of a drawing request: say WHICH component you are about to create, before you '
				+ 'create it. The render tools are deliberately not available to you yet - they appear once this is '
				+ 'answered. Pass one of the names below EXACTLY as written; do not invent one. The line beside each '
				+ 'name says WHEN to pick it and decides this on its own: whether a many-screen request is one '
				+ 'component or several is stated there per component, so read the lines and follow them rather '
				+ 'than assuming either way. Pass "plan" when no single component can carry the request and it '
				+ 'genuinely needs SEVERAL DIFFERENT ones: the drawing step then proposes the batch with '
				+ 'plan_board. If the user is NOT '
				+ 'asking for anything to be drawn (a question, a chat, a change to something already on the board), '
				+ 'pass "none" and carry on answering normally.\n\nWhat you may name:\n' + lines.join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					tool: { type: 'string', enum: names, description: 'The render_* tool you will use, "plan" for several different components, or "none".' }
				},
				required: ['tool']
			}
		};
	}

	/**
	 * The one line describing a component in the deciding step's menu.
	 *
	 * `mcpDeclareLine` is the catalog's own statement of WHEN to pick a tool - the
	 * counterpart of the server classifier's detectionPromptDescription, which is
	 * likewise a field of its own rather than the head of the generation prompt.
	 * The opening sentence of mcpDescription is only the fallback, for a catalog
	 * that predates the field: it says what a tool DOES, and a description-shaped
	 * one ("Convert HTML to an editable UI wireframe") carries no signal at all for
	 * "create a mobile CRM app", which is how those requests reached the prototype.
	 */
	_declareLine(entry, fallback) {
		if (!entry) return fallback;
		if (entry.mcpDeclareLine) return String(entry.mcpDeclareLine).trim();
		var first = String(entry.mcpDescription || '').split(/\n|(?<=\.)\s/)[0].trim();
		if (first.length > 120) first = first.slice(0, 117) + '...';
		return first || fallback;
	}

	_toolDefsForTurn(ctx) {
		const board = (ctx && ctx.boardId) || null;
		// Decide-then-draw: in the declare step the agent gets NO render tools, so
		// it cannot compose anything. That is what makes the imagery question
		// answerable before the work is done rather than after it.
		if (typeof this.hub.getTurnPhase === 'function' && this.hub.getTurnPhase(board) === 'declare') return [];
		const on = this.hub.getImageChoice(board) === true;
		const modify = (typeof this.hub.getTurnMode === 'function')
			&& this.hub.getTurnMode(board) === 'modify';
		const self = this;
		// { bridge: true }: the catalog keeps back tools that only a connected editor tab
		// can carry out (an in-place edit of a component the user has open). This IS that
		// tab's agent, so they belong in its list; an older catalog simply ignores the flag.
		return this.registry.getToolDefinitions({ bridge: true }).map(function(def) {
			const entry = self._entry(def.name);
			if (!entry || !entry.imageSlots) return def;
			// A component's two branches are COMPOSITION rules - they describe how to
			// build the thing. Editing one that already exists is a different
			// instruction entirely, and the same one for every component: whatever
			// imagery is already there stays. Without this, "no imagery" reads as
			// "delete the pictures" on a modify.
			var branch;
			if (modify) {
				branch = MODIFY_IMAGERY + (on
					? ' You may add NEW pictures where the change calls for one, following these rules:\n\n'
						+ (entry.imagesOnGuidance || '')
					: ' Add no NEW pictures.');
			} else {
				branch = on ? entry.imagesOnGuidance : entry.imagesOffGuidance;
			}
			if (!branch) return def;
			return Object.assign({}, def, { description: def.description + '\n\n' + branch });
		});
	}

	async _toolsCall(params, ctx) {
		const name = params.name;
		const args = params.arguments || {};
		if (!name) throw new Error('Tool name is required');

		// The board this connection is bound to (see handle()). Used as the target
		// for every draw/read/relay below, so a concurrent turn on another tab can
		// never redirect this one. Falls back to null (-> hub.selectedProjectId) for
		// an unscoped connection, and an explicit args.projectid still wins where a
		// tool documents one.
		const board = (ctx && ctx.boardId) || null;

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

				case 'declare_render': {
					const want = String(args.tool || '').trim();
					if (!want || want === 'none') {
						// Not a drawing request: the turn carries on as a normal answer, and this
						// step is the one that gives it - so it keeps the floor.
						this.hub.setTurnPhase(board, 'compose');
						this.hub.noteDeclared(board, 'none');
						return this._ok('Nothing to draw - carry on and answer the user normally.');
					}
					if (want === 'plan') {
						// No single component covers the request, so this turn draws a batch. The
						// drawing step gets the full catalog and proposes it with plan_board. Imagery
						// is not asked here: the plan picker carries its own toggle, next to the list
						// it applies to.
						this.hub.noteDeclared(board, 'plan');
						this.hub.requestCompose(board);
						return this._ok('Noted: several components. YOUR STEP IS OVER: call nothing else and '
							+ 'write nothing at all. The drawing step is already starting with the render tools '
							+ 'available, and it proposes the batch with plan_board itself. Nothing has failed and '
							+ 'nothing is missing.');
					}
					const dEntry = this._entry(want);
					if (!dEntry) {
						return this._err('Unknown render tool "' + want + '". Name one of this server\'s render_* tools, '
							+ '"plan" if the request needs several different components, or "none" if nothing is being drawn.');
					}
					const dLabel = dEntry.planUILabel || dEntry.planUIType
						|| want.replace(/^render_/, '').replace(/_/g, ' ');
					const self4 = this;
					// Recorded now, not when the user answers: the deciding step's process
					// may exit first, and its turn has to stay open for the drawing step.
					this.hub.noteDeclared(board, want);
					const needsAsk = !!(dEntry.imageSlots || dEntry.mediaComponent)
						&& this.hub.getImageChoice(board) === undefined;
					if (needsAsk) {
						// Ask NOW, before anything is composed. The drawing step starts
						// when they answer.
						this.hub.askImages(board, {
							toolName: want, label: dLabel,
							kind: dEntry.mediaComponent ? 'component' : 'slots'
						}).then(function() { self4.hub.requestCompose(board); })
						  .catch(function() { self4.hub.requestCompose(board); });
						return this._ok('Noted: a ' + dLabel + '. The user is being asked whether it should include '
							+ 'AI-generated images, and the drawing step starts by itself as soon as they answer. '
							+ 'Write nothing further now.');
					}
					this.hub.requestCompose(board);
					return this._ok('Noted: a ' + dLabel + '. YOUR STEP IS OVER: call nothing else and write '
						+ 'nothing at all. The drawing step is already starting with the render tools available, '
						+ 'and it draws the component itself. Nothing has failed and nothing is missing.');
				}

				case 'read_board': {
					const data = await this.hub.runOnBoard(args.projectid || board || null,
						{ t: 'read', what: 'board' }, config.READ_TIMEOUT_MS);
					return this._ok(JSON.stringify(data));
				}

				case 'modify_component': {
					if (!args.componentId || !args.instruction) {
						return this._err('modify_component needs both componentId (from read_board) and instruction.');
					}
					// The tab owns the component's current data, so it builds the modify
					// prompt and runs the edit; this only carries the request.
					//
					// surface: the tab answers this by running a component AI turn of its
					// own, and anything that turn asks the user must be asked where THIS
					// turn is being read - the Concept Builder that called the tool, not
					// whatever a turn with no surface of its own falls back to.
					const res = await this.hub.runOnBoard(args.projectid || board || null,
						{
							t: 'modify',
							cid: String(args.componentId),
							instruction: String(args.instruction),
							surface: (typeof this.hub.getTurnSurface === 'function') ? this.hub.getTurnSurface(board) : ''
						},
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
					if (this.hub.isTargetBasic(args.projectid || board || null)) {
						return this._err('Connected sources (Notion, Jira, Slack, GitHub, ...) are a Pro feature. '
							+ 'Ask the user to upgrade to connect and use their data sources from the local agent.');
					}
					if (op !== 'list' && !args.tool) {
						return this._err('"tool" is required - use list_source_tools to see the available tool names.');
					}
					const data = await this.hub.runOnBoard(args.projectid || board || null,
						{ t: 'source', op: op, tool: args.tool || '', args: args.args || {} },
						config.SOURCE_TIMEOUT_MS || config.TOOL_TIMEOUT_MS);
					return this._ok(typeof data === 'string' ? data : JSON.stringify(data));
				}

				case 'layout_board': {
					// An explicit layout consumes any armed plan - never arrange the same batch twice.
					this.hub.clearPlan(board);
					const count = await this.hub.runOnBoard(board,
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
					// Tell the picker which items can carry imagery, so the question is
					// asked there - with the whole list in front of the user - instead of
					// mid-batch, where ending the turn would abandon the remaining items.
					const self3 = this;
					items.forEach(function(it) {
						const e = self3._entry(it && it.tool);
						if (e && (e.imageSlots || e.mediaComponent)) it.imageCapable = true;
					});
					this.hub.startPlanPick(board, title, items);
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

			// Image slots: this component can carry AI-generated imagery, which only
			// MockFlow can produce (and which spends the user's credits), so the user
			// is asked first. The question does NOT block this call - see _imageGate.
			const gate = this._imageGate(board, entry, name, args);
			if (gate) return this._ok(gate);
			// Inside a confirmed plan this is the item's OWN answer, not the board's:
			// the plan card asks per image-capable row, so a batch can hold both a
			// component the user wants pictures in and one they do not. The tab empties
			// any slot that arrives without agreement, which makes this the enforcement
			// point rather than the prompt.
			const withImages = !!(entry.imageSlots && this._imagesForDraw(board, name));

			return await this._draw(board, entry, name, args, withImages);
		} catch (err) {
			return this._err('Error running ' + name + ': ' + (err && err.message));
		}
	}

	/**
	 * Draw one catalog render call and describe the result for the agent.
	 *
	 * Called straight from the tool call, and again later when a component that
	 * was waiting on the "generate images?" answer is finally drawn - in that case
	 * nobody reads the returned message, the draw itself is the point.
	 *
	 * `withImages` says whether the user agreed to spend credits on this
	 * component's imagery; the tab honours it and empties any slot that arrives
	 * without agreement.
	 */
	async _draw(board, entry, name, args, withImages) {
		// Basic-plan daily generation cap is MEASURED here, never enforced: the
		// bridge counts every draw a basic board makes - including component
		// Create/Modify AI, which fills in place (a capture) but is still a
		// generation - and reports the running usage to the editor, which does the
		// prevention itself (like AI credits). Pro/trial boards are not metered.
		const meter = this.hub.isTargetBasic(board);

		// Debug tracing: print/dump what the agent generated for this render (see debug.js).
		debug.toolCall(name, args);

		if (entry.clientIsHtmlConversion) {
			// render_wireframelite / render_prototypelite ship raw HTML. The CONNECTED TAB
			// runs the conversion (HTML -> paintObjects render, or the prototype S3 upload)
			// through the MockFlow endpoints with the user's own session, then draws the
			// result - the bridge only relays the args (see boardHub.drawHtml).
			const mcpType = name.replace('render_', '');
			const hres = await this.hub.drawHtml(board, name, mcpType, args, withImages);
			// A wireframelite/prototypelite render always draws - count it for basic plans.
			if (meter) this._recordGen(board);
			// Conversion report from the tab (component/chart/icon counts + warnings). It
			// goes back to the AGENT too: a sparse or icon-less render is something the
			// agent can fix by regenerating the HTML, but only if it is told.
			const report = debug.toolResult(name, hres);
			const suffix = report ? '\n\nConversion report: ' + report : '';
			// Filled the component the user is editing (a Generate/Modify turn on a
			// component whose local tool is this HTML one) - say so, or the agent reads
			// "rendered onto the board" as a new component and may draw again.
			if (hres && hres.filled) {
				return this._ok('Filled the ' + mcpType + ' component the user is editing with this design. '
					+ 'It has replaced that component\'s content on their screen. You are done: do not call '
					+ 'this or any other render tool again, and never output a URL or a link.' + suffix);
			}
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

		if (entry.clientServerGenerate) {
			// The asset is made by a MockFlow generator running in the user's tab,
			// from the prompt this agent wrote. It costs credits and can take a
			// while, so the tab fires it and answers at once.
			const kind = name.replace('render_', '');
			await this.hub.drawServerGen(board, name, {
				aitype: entry.clientAitype,
				args: args,
				tocomp: entry.clientToComp || null,
				promptPrefix: entry.clientPromptPrefix || '',
				// Extra request fields this generator needs (catalog-driven, so a
				// new media type declares its own without any code here).
				extra: entry.clientGenExtra || null
			});
			if (meter) this._recordGen(board);
			return this._ok('MockFlow AI is generating the ' + kind + ' from your prompt and it appears on '
				+ 'the user\'s board when it is ready. You are done: do not call any more tools, do not '
				+ 'render anything else, and never output a URL or a link. Tell the user it is generating.');
		}

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
		const res = await this.hub.captureOrDraw(board, name, gdata, entry.imageSlotForm || null, withImages);

		// Count the draw against the basic-plan cap - whether it drew a new
		// component or filled one in place (capture). Both are a generation.
		if (meter) this._recordGen(board);

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
	}

	/**
	 * The "generate images?" gate for one render call.
	 *
	 * A local agent is a text model: it writes the component but cannot draw the
	 * pictures in it. MockFlow can, in the user's own tab, against their AI
	 * credits - so the user decides, and only they can. Nobody can ask earlier
	 * than this: the agent chose the component type inside its own process, and
	 * this call is the first moment anyone knows an image-capable component is
	 * being made.
	 *
	 * The call does NOT wait for the answer. Like plan_board, it hands the
	 * question to the tab and ENDS the agent's turn; the work resumes on its own
	 * when the user answers (_afterImageAnswer). Blocking here would put an open
	 * question in front of a user on one side and a stalled agent on the other,
	 * with every agent CLI's own call ceiling deciding who gave up first.
	 *
	 * Entirely catalog-driven (imageSlots / imagesOnGuidance), so a component
	 * gains the whole flow by declaring it - no tool names live here.
	 *
	 * @returns {string|null} the message to end this turn with, or null when the
	 *          call may proceed and draw right now.
	 */
	_imageGate(board, entry, name, args) {
		if (!entry) return null;
		// Two shapes of the same question. A component with image SLOTS can be drawn
		// either way (the imagery is optional decoration inside it); a MEDIA
		// component IS the asset, so a no means it is not drawn at all.
		const kind = entry.mediaComponent ? 'component' : (entry.imageSlots ? 'slots' : null);
		if (!kind) return null;

		const before = this.hub.getImageChoice(board);
		// Already answered for this turn: act on it. When the answer was yes, the
		// agent was told how to fill the slots (its system prompt at turn start, or
		// the re-render turn below) and this call is its response to that.
		if (before === true) return null;
		if (before === false) {
			// Slots are optional, so the component still draws without them. A media
			// component is nothing but the asset, so there is nothing left to draw.
			if (kind === 'slots') return null;
			return 'The user chose not to spend AI credits on this, so nothing was generated. Tell them '
				+ 'plainly that the ' + String(name).replace(/^render_/, '') + ' was not created, and do '
				+ 'not try again unless they ask.';
		}

		// What this component is CALLED to a person: the catalog's own plan-picker
		// type where it has one (render_moodframe is a "moodboard", not a
		// "moodframe"), since this label is read by the user on the ask card and
		// by the agent in the re-render prompt.
		const label = entry.planUILabel || entry.planUIType
			|| String(name).replace(/^render_/, '').replace(/_/g, ' ');
		const self = this;
		// What the agent authored is kept as-is: for slots it is drawn unchanged if
		// the user says no, and for a media component it is the prompt to generate.
		const pending = { toolName: name, args: args, entry: entry, label: label, kind: kind };
		this.hub.askImages(board, { toolName: name, label: label, kind: kind })
			.then(function(on) { return self._afterImageAnswer(board, pending, on); })
			.catch(function(err) { self.log('[images] resume failed: ' + (err && err.message)); });

		if (kind === 'component') {
			return 'Only MockFlow AI can generate a ' + label + ', and it uses the user\'s AI credits, so '
				+ 'they are being asked to confirm. YOUR TURN IS COMPLETE: do not call any more tools - the '
				+ label + ' is generated automatically as soon as they confirm. Briefly tell the user to '
				+ 'confirm on their board, and never output a URL or a link.';
		}
		return 'The user is choosing whether this ' + label + ' should include AI-generated images '
			+ '(only MockFlow can generate pictures, and they use the user\'s AI credits). YOUR TURN IS '
			+ 'COMPLETE: do not render anything and do not call any more tools - the ' + label + ' is drawn '
			+ 'automatically as soon as they answer. Briefly tell the user to answer the question on their '
			+ 'board, and never output a URL or a link.';
	}

	/**
	 * The user answered the image question; the turn that asked it is long over.
	 *
	 *  - no  -> draw what the agent already produced. It was authored without image
	 *           slots (the default it is told to use), so it is already correct and
	 *           no agent needs to run again.
	 *  - yes -> that component has no imagery in it, and only the agent can say
	 *           where the pictures belong. Start a fresh turn that hands it back
	 *           exactly what it sent, plus this tool's slot instructions.
	 */
	_afterImageAnswer(board, pending, on) {
		// A media component IS the asset: yes generates it from the prompt the agent
		// already wrote (no agent re-runs), no means nothing is created.
		if (pending.kind === 'component') {
			if (!on) {
				this.log('[images] the user declined the ' + pending.label + ' - nothing generated');
				return;
			}
			this.log('[images] generating the ' + pending.label + ' the user confirmed');
			return this._draw(board, pending.entry, pending.toolName, pending.args, true)
				.catch(function() {});
		}
		if (on) {
			this.hub.requestImageRerender(board, {
				toolName: pending.toolName,
				args: pending.args,
				label: pending.label,
				guidance: pending.entry.imagesOnGuidance || ''
			});
			return;
		}
		this.log('[images] drawing the ' + pending.label + ' the agent already produced, without images');
		return this._draw(board, pending.entry, pending.toolName, pending.args, false)
			.catch(function() {});
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

	/**
	 * Whether THIS draw may carry imagery: the plan item's own answer when a
	 * confirmed batch is running, otherwise the board-level answer for the turn.
	 * An older hub without per-item plans simply falls through to the latter.
	 */
	_imagesForDraw(board, toolName) {
		if (typeof this.hub.plannedImageChoice === 'function') {
			const perItem = this.hub.plannedImageChoice(board, toolName);
			if (perItem === true || perItem === false) return perItem;
		}
		return this.hub.getImageChoice(board) === true;
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
