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
const election = require('./electionRules');

const PROTOCOL_VERSION = '2025-03-26';

// How many components one turn may open with read_board_component. Mida's own
// read tool caps at 8 for the same reason; here each read is also a round trip
// to the user's browser, so an agent walking the board is time the user watches.
const MAX_COMPONENT_READS_PER_TURN = 8;

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
	+ 'automatically, without you. Use read_board to see what is already on the board and '
	+ 'search_board to find something on a board too big to read whole; either one ALREADY '
	+ 'answers a question about the board as a whole ("what is on this board", "summarize '
	+ 'the board") - answer it from that, and do not open the components one by one. '
	+ 'When the user asks WHERE something is, or wants to find or jump to it, answer with '
	+ 'show_component_links - clickable cards that take them there - and never with coordinates or ids, '
	+ 'which they cannot act on and which change as soon as anything moves. '
	+ 'read_board_component is for a SINGLE component the user is asking about or working '
	+ 'from: read that one before you quote it, convert it or build something out of it, '
	+ 'because the board reads shorten each component\'s text. What you could not read, say '
	+ 'you could not read. '
	+ 'When the user wants something on the board to become a DIFFERENT kind of component, '
	+ 'that is convert_component, not a new render: it carries the real content over. '
	+ 'When the request refers to a real website - its content, its look, or its imagery - '
	+ 'ground yourself in it with fetch_webpage, extract_website_styles and '
	+ 'extract_website_images rather than composing from memory. '
	+ 'Use list_boards / select_board when several boards are connected. When the user '
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
		description: 'Read what is currently on the connected board: every component with its id, type, label, position, size, its text content (including structured content like checklist items or kanban cards), and what it can be converted into (convertTo). This is the whole-board answer - use it to understand what exists before adding to it, and to answer questions about the board itself, without opening the components one by one. text is shortened per component, and textTruncated: true marks one that was cut; when the user then asks about that particular component, read_board_component gives you it in full. On a large board, search_board narrows to what you actually need instead. Base what you render on the content that is actually there, and when you could not read a component, say so rather than inventing the rest.',
		inputSchema: {
			type: 'object',
			properties: {
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			}
		}
	},
	{
		name: 'search_board',
		description: 'grep, over the board. Give it a regular expression and it returns the MATCHING LINES with their line numbers, grouped by component - not the components\' contents. Read-only, instant, free. A component\'s content is made of discrete pieces (a card, a node, a bullet, a cell) and each one is a line here, so a match is a real piece of content you can quote and its cid is what you pass to read_board_component, modify_component or convert_component. Results come back MOST RELEVANT FIRST, and labelMatch: true marks a component whose own name/title matches the pattern - a label match is IDENTITY, a content match is a mention, so when the user singled out one of several same-type components by name, the labelMatch record is the one they mean, not the record with the most content hits. With no pattern it lists the board instead (grep vs ls). Use it whenever the user mentions something you have not already read - it may have been placed manually, in an earlier session, or by a collaborator - and NEVER tell the user something is not on the board without searching for it in the SAME turn, because earlier results go stale as they edit. It searches only this board: not icon or shape libraries, and not the web.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Regular expression to search for (case-insensitive by default). Plain words work and are searched literally when they are not valid regex. Prefer the short distinctive words the user actually used, and remember they describe STRUCTURES loosely - their "flowchart" may be plain notes, so search the content words, not the structure word. Alternation is for VARIANT WORDINGS of one thing ("sign ?up|register") - do NOT split the user\'s distinguishing phrase into alternated words ("basic|plan" matches everything that mentions either word; "basic plan" finds the one they named).' },
				caseSensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
				componentType: { type: 'string', description: 'Restrict to one kind of component, like grep\'s --type. A friendly name ("mindmap", "kanban", "wireframe") or a registry key ("MF_MindMap_ID"); matched loosely.' },
				outputMode: { type: 'string', enum: ['content', 'components', 'count'], description: '"content" (default) returns matching lines with their numbers; "components" returns only which components matched; "count" returns match counts per component. Use content when you need the text, components when you only need to locate something.' },
				contextLines: { type: 'number', description: 'Lines of context either side of each match, like grep -C. Default 0, max 5.' },
				headLimit: { type: 'number', description: 'Stop after this many matching lines in total. Default 100.' },
				includeChildren: { type: 'boolean', description: 'Also search inside wireframe screens and design frames. Default false - their contents are UI fragments ("Submit", "Email") that bury real hits.' },
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			}
		}
	},
	{
		name: 'read_board_component',
		description: 'Read ONE component\'s full current content by its id. Read-only, free, changes nothing. Before acting on what it returns, confirm this is the component the user MEANT: when they singled one out by name ("the basic plan checklist"), its label or content must actually contain their distinguishing words - a component that merely mentions them is not it; if it does not match, search again with those words instead of proceeding on a near miss. read_board and search_board both shorten each component\'s text, so when the user asks about ONE component - quote it, convert it, build something out of it, answer a question about what is inside it - read that one with this first and use ONLY what it returns, never a nearby component and never a guess. It is for a component you have a reason to open, not a step to run over the board: a question about the board AS A WHOLE is already answered by read_board or search_board, and opening every component to answer it is slow enough that the user watches it happen. Returns the component\'s current data (a kanban\'s columns and cards, a mindmap\'s nodes, a document\'s text, a frame\'s design JSON). A component too large for one read comes back condensed with contentSummarized: true - its structure and figures are intact and its OMITTED line says what was dropped, so answer from it, but do not present it as the component\'s exact wording. Get the id from search_board or read_board. If it comes back truncated or unreadable, say what you could and could not read.',
		inputSchema: {
			type: 'object',
			properties: {
				componentId: { type: 'string', description: 'The component id (cid) from read_board or search_board' },
				offset: { type: 'number', description: 'Line to start reading from (1-based), for paging through a large component. Its content is made of discrete lines, the same ones search_board reports line numbers for.' },
				limit: { type: 'number', description: 'How many lines to return. Default 200. The reply states totalLines and hasMore, so page with offset rather than pulling a big component in one go.' },
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			},
			required: ['componentId']
		}
	},
	{
		name: 'show_component_links',
		description: 'Point the user at components on their board by showing CLICKABLE CARDS in the chat, one per component - clicking one scrolls and zooms their board to it. Call this whenever the user asks WHERE something is, or wants to find, see or jump to a component ("where is the pricing doc?", "show me the mindmaps"), right after search_board gives you the ids. Then tell them to click a card. Never answer a "where is it" question with coordinates or ids: the user cannot use either, positions change the moment anything moves, and the card is the thing that actually takes them there. The card\'s wording comes from the live component, so pass ids and nothing else matters.',
		inputSchema: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					description: 'The components to show cards for, in the order they should appear.',
					items: {
						type: 'object',
						properties: {
							cid: { type: 'string', description: "The component's cid, exactly as search_board or read_board returned it." }
						},
						required: ['cid']
					}
				},
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			},
			required: ['items']
		}
	},
	{
		name: 'convert_component',
		description: 'Turn a component that is already on the board into a DIFFERENT kind of component, keeping its content ("convert this checklist into a mind map", "turn that table into a pie chart"). The new component is generated from the source component\'s real data and drawn beside it, connected to it; the source is left on the board unchanged. Only components read_board reports a convertTo list for can be converted, and the target must be one of the names in that list. This is not modify_component (that edits the same component in place) and not a render_* call (that would invent the content instead of carrying it over). When the component cannot be converted, or the type you want is not one of its targets, read it with read_board_component and render the component you want from that content.',
		inputSchema: {
			type: 'object',
			properties: {
				componentId: { type: 'string', description: 'The component id (cid) of the component to convert, from read_board or search_board. When the user named one of several same-type components, this must be the one whose label/title matches their words - verify with read_board_component first if unsure, and never convert a near miss.' },
				target: { type: 'string', description: 'What to convert it into - one of the names in that component\'s convertTo list (e.g. "Mind Map")' },
				instruction: { type: 'string', description: 'Optional extra instruction for the conversion (e.g. "group the items by owner"). The content carries over on its own; this is only for what should change about it.' },
				projectid: { type: 'string', description: 'Optional: a specific connected board. Defaults to the active one.' }
			},
			required: ['componentId', 'target']
		}
	},
	// Web grounding. These run on MockFlow, through the user's board tab: the
	// extractors are the server's own and the fetches are SSRF-guarded there.
	// None of them costs the user AI credits.
	{
		name: 'fetch_webpage',
		description: 'Read a public webpage and return its readable text (not raw HTML). Use it to ground what you render in a real page: a URL the user pasted, or a site they asked you to refer to. Do NOT use it to pick up a site\'s visual design - extract_website_styles does that - and do not use it for a site\'s images, which is extract_website_images.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Full public URL including protocol, e.g. "https://www.redhat.com/en/products"' }
			},
			required: ['url']
		}
	},
	{
		name: 'extract_website_styles',
		description: 'Visit a public website and extract its visual design system - brand colors, font families, corner radii, shadows and CSS design tokens - as a STYLE GUIDANCE block. Call this whenever the user wants what you draw to match an existing site\'s look ("make it look like stripe.com", "use our brand from acme.com"), then include the returned block VERBATIM inside the prompt or text you pass to the render tool. It returns style values distilled from the site\'s CSS and nothing else: it cannot download a file, a logo or any other asset from the site (extract_website_images lists a site\'s images). If the user asks for something no tool can retrieve, say so plainly - never claim it was extracted and never substitute generated output for it.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Full public URL of the site whose styles to extract, e.g. "https://www.stripe.com". The homepage usually carries the brand styles.' }
			},
			required: ['url']
		}
	},
	{
		name: 'extract_website_images',
		description: 'List the images present on a public webpage (site icons, meta/social images, page images) with their URLs, labels and kind. Call this when the user asks what imagery a site has, or asks you to use a real picture from one. It only lists what is in the page HTML - nothing is downloaded and nothing is generated - so if a site returns none, tell the user truthfully instead of drawing a replacement. The URLs it returns are real, public image URLs: you may use one where a render tool\'s schema accepts a real image URL, but they are not files on the user\'s board, and importing one into their image library is done from MockFlow, not from here.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Full public URL of the page whose images to list, e.g. "https://www.miro.com". The homepage usually carries the brand assets.' }
			},
			required: ['url']
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
		// projectid -> how many times this turn's declaration has been sent back for
		// not matching the user's words. Bounded, so a model that keeps naming the
		// same component cannot bounce forever (see declare_render).
		this.heldDeclares = new Map();
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
					return (declaring && t.name === 'declare_render')
						? self5._declareToolDef((ctx && ctx.boardId) || null) : t;
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
	_declareToolDef(board) {
		const blocked = this._isFileModeTurn(board) ? this._fileModeBlockedTools() : null;
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
			// The menu must match the catalog exactly - naming a tool here that the
			// drawing step will not be given is how an agent declares an intent it
			// then cannot carry out.
			if (blocked && blocked[e.mcpToolName]) continue;
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
				+ 'plan_board. Pass "none" whenever nothing is meant to land on the board and carry on '
				+ 'answering normally: a question, a chat, a change to something already on the board, or a '
				+ 'request for suggestions, ideas, opinions or feedback (including about what is already '
				+ 'there). What decides this is WHERE the user wants the result, never whether their wording '
				+ 'sounds generative - when you are unsure, pass "none" and answer in chat; they can ask you '
				+ 'to draw it afterwards. Pass "none" too when a drawing request is missing something that '
				+ 'would materially change what you draw and neither the conversation nor the board supplies '
				+ 'it: ask one or two focused questions instead, and draw once the user has '
				+ 'answered.\n\nWhat you may name:\n' + lines.join('\n'),
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

	/**
	 * Tools that cannot run on a local .mockflow file, by MCP tool name.
	 *
	 * Both of these need a MockFlow session: the component is UPLOADED and then
	 * served from MockFlow (a prototype's share URL, an artifact's host), and a
	 * local file has no session to upload with and nothing local to serve from.
	 * They are dropped from the catalog rather than refused on use, so the agent
	 * never proposes a prototype to someone who cannot have one - a refusal after
	 * the fact still spends a turn and still leaves the user told about a feature
	 * that was never available to them.
	 *
	 * render_wireframelite is deliberately NOT here: its conversion is a DOM
	 * capture the desktop app runs in-process, so wireframes work fully on a local
	 * file and are the right thing for the agent to reach for instead.
	 */
	_fileModeBlockedTools() {
		return { render_prototypelite: true, render_artifact: true };
	}

	/** True when this turn's board cannot run the server-backed render tools. */
	_isFileModeTurn(board) {
		return typeof this.hub.isFileModeBoard === 'function' && this.hub.isFileModeBoard(board);
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
		const blocked = this._isFileModeTurn(board) ? this._fileModeBlockedTools() : null;
		return this.registry.getToolDefinitions({ bridge: true }).filter(function(def) {
			return !(blocked && blocked[def.name]);
		}).map(function(def) {
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

		// Ground truth for the turn's verdict: this call REACHED the bridge,
		// whatever the agent's own output stream says about it. Counted before
		// dispatch on purpose - see hub.noteToolServed.
		if (typeof this.hub.noteToolServed === 'function') this.hub.noteToolServed(board);

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
					// A drawing request is starting, so any plan card still sitting
					// unanswered from an EARLIER request is stale: the user asked for
					// something else, which is their answer to it. Released here or the
					// board refuses this draw too, and every one after it, until the
					// 30-minute picker timeout - the deadlock a terminal-driven agent
					// cannot get out of, because the card it is told to wait for lives in
					// a browser tab and it has no way to reach it. Not done for 'none':
					// a question about the board is not the user walking away from the
					// proposal.
					this.hub.releasePendingPick(board, 'a new drawing request was declared');
					// The blocked tools are already absent from this board's menu, so this
					// is only reachable from a tools/list the agent cached before the board
					// became a local file. Answered with the alternative rather than a bare
					// refusal, because "prototype" is a word users say and the agent needs
					// somewhere to go with it.
					const blockedD = this._isFileModeTurn(board) ? this._fileModeBlockedTools() : null;
					if (blockedD && blockedD[want]) {
						return this._err(want + ' needs a MockFlow session to host what it builds, and this board is '
							+ 'a local file. Declare render_wireframelite instead - it works fully here - and tell the '
							+ 'user that a clickable prototype needs a cloud project.');
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
					if (!this._entry(want)) {
						return this._err('Unknown render tool "' + want + '". Name one of this server\'s render_* tools, '
							+ '"plan" if the request needs several different components, or "none" if nothing is being drawn.');
					}
					// A component the user alone can ask for (a clickable prototype) is held
					// to the words they actually used - the catalog states the rule and this
					// applies it, because the line in the menu saying so was read and passed
					// over often enough to be worth enforcing. See electionRules.
					const heldD = election.hold(this.registry, want, this._userWords(board));
					if (heldD.held) {
						this.log('[declare] ' + heldD.from + ' -> ' + heldD.tool + ': the user\'s own words ask for '
							+ 'nothing ' + election.wordsPhrase(heldD.words, 3).replace(/"/g, '') + ' ('
							+ heldD.source + ' rule)');
						// SENT BACK, not swapped. The component asked for may be the one that
						// carries a whole product in a single call, while the one it is held to
						// carries a single screen - so accepting the swap silently turns "build
						// a movie streaming app" into one wireframe. Correcting the type also
						// re-opens how MANY, and that is the agent's to answer, so it declares
						// again. Bounded: a second attempt at the same thing is settled below
						// rather than bounced, so this can never loop.
						// Keyed by the request too, so the count belongs to THIS turn: a turn
						// that ended mid-bounce never spends the next one's first attempt.
						const bkey = (board || '') + '|' + this._userWords(board).slice(0, 120);
						const tries = (this.heldDeclares.get(bkey) || 0) + 1;
						this.heldDeclares.set(bkey, tries);
						if (tries < 2) {
							return this._err(heldD.from + ' is only for a request whose OWN words ask for one ('
								+ election.wordsPhrase(heldD.words, 4) + '), and this one does not - the user asked '
								+ 'for: "' + this._userWords(board).slice(0, 200) + '". Nothing has failed and nothing '
								+ 'is missing; you are still in the deciding step. Decide again and call '
								+ 'declare_render once more with the right choice: "' + heldD.tool + '" if this is ONE '
								+ 'screen or surface, or "plan" if it covers SEVERAL - a whole app, site, dashboard or '
								+ 'product flow is one ' + heldD.tool + ' per screen, which is a plan.');
						}
						this.log('[declare] settling on ' + heldD.tool + ' - asked twice');
					}
					this.heldDeclares.delete((board || '') + '|' + this._userWords(board).slice(0, 120));
					const declared = heldD.tool;
					const dEntry = this._entry(declared);
					const dLabel = dEntry.planUILabel || dEntry.planUIType
						|| declared.replace(/^render_/, '').replace(/_/g, ' ');
					const self4 = this;
					// Recorded now, not when the user answers: the deciding step's process
					// may exit first, and its turn has to stay open for the drawing step.
					// The held flag travels with it: a correction re-opens the one-component
					// -or-several question for the drawing step (see agentManager).
					this.hub.noteDeclared(board, declared, heldD.held);
					// What the drawing step is told, when the choice was corrected. It names
					// the rule rather than the component, so the agent can see why - and it
					// re-opens the batch question, because the component it asked for may have
					// been the one that carries a whole product in a single call while its
					// replacement carries one screen.
					const heldNote = heldD.held
						? ('NOT a ' + (this._entry(heldD.from).planUILabel || heldD.from.replace(/^render_/, ''))
							+ ': that is only for a request whose OWN words ask for it ('
							+ election.wordsPhrase(heldD.words, 3) + '), and this one does not - so it is a '
							+ dLabel + '. If the request covers SEVERAL screens or surfaces, call plan_board with '
							+ 'one ' + declared + ' item per screen instead of drawing one. ')
						: '';
					const needsAsk = !!(dEntry.imageSlots || dEntry.mediaComponent)
						&& this.hub.getImageChoice(board) === undefined;
					if (needsAsk) {
						// Ask NOW, before anything is composed. The drawing step starts
						// when they answer.
						this.hub.askImages(board, {
							toolName: declared, label: dLabel,
							kind: dEntry.mediaComponent ? 'component' : 'slots'
						// null = the user cancelled the question rather than answering it,
						// so the drawing step never runs and the held turn is closed.
						}).then(function(on) { self4.hub.requestCompose(board, on === null); })
						  .catch(function() { self4.hub.requestCompose(board); });
						return this._ok('Noted: a ' + dLabel + '. ' + heldNote + 'The user is being asked whether it '
							+ 'should include AI-generated images, and the drawing step starts by itself as soon as '
							+ 'they answer. Write nothing further now.');
					}
					this.hub.requestCompose(board);
					return this._ok('Noted: a ' + dLabel + '. ' + heldNote + 'YOUR STEP IS OVER: call nothing else '
						+ 'and write nothing at all. The drawing step is already starting with the render tools '
						+ 'available, and it draws the component itself. Nothing has failed and nothing is missing.');
				}

				case 'read_board': {
					const data = await this.hub.runOnBoard(args.projectid || board || null,
						{ t: 'read', what: 'board' }, config.READ_TIMEOUT_MS);
					return this._ok(JSON.stringify(data));
				}

				case 'search_board': {
					const target = args.projectid || board || null;
					const data = await this.hub.runOnBoard(target,
						{
							t: 'search',
							pattern: String(args.pattern || args.query || ''),
							caseSensitive: args.caseSensitive === true,
							componentType: String(args.componentType || ''),
							outputMode: args.outputMode || 'content',
							contextLines: args.contextLines,
							headLimit: args.headLimit,
							includeChildren: args.includeChildren === true
						}, config.READ_TIMEOUT_MS);
					// An empty result is an ANSWER, not a failure: the agent asked whether
					// something is on the board and it is not. Said plainly here so it is
					// not read as a broken tool and retried.
					if (data && data.components && data.components.length === 0) {
						return this._ok('Nothing on this board matches that search. Say so plainly rather than '
							+ 'assuming the component exists. ' + JSON.stringify(data));
					}
					// Feed the rolling turn transcript: which components this search
					// surfaced is exactly what a next-turn "convert it" resolves against.
					if (data && Array.isArray(data.components) && data.components.length
						&& typeof this.hub.noteTurnEvent === 'function') {
						const top = data.components.slice(0, 3)
							.map(function(c) { return '"' + (c.label || c.type) + '" (cid ' + c.cid + ')'; })
							.join(', ');
						this.hub.noteTurnEvent(target, 'search_board'
							+ (args.pattern ? ' for "' + String(args.pattern).slice(0, 60) + '"' : '')
							+ ' found: ' + top
							+ (data.components.length > 3 ? ' and ' + (data.components.length - 3) + ' more' : ''));
					}
					return this._ok(JSON.stringify(data));
				}

				case 'read_board_component': {
					if (!args.componentId) {
						return this._err('read_board_component needs a componentId - call search_board or read_board first.');
					}
					// Each read is a round trip to the browser tab, so a turn that walks
					// the board one component at a time is minutes of "Thinking" with
					// nothing on screen. grep is what answers those questions. The count
					// is checked BEFORE recording so refused calls do not inflate it.
					const rtarget = args.projectid || board || null;
					const reads = (typeof this.hub.peekComponentReads === 'function')
						? this.hub.peekComponentReads(rtarget) : 0;
					if (reads >= MAX_COMPONENT_READS_PER_TURN) {
						return this._err('You have opened ' + reads + ' components this turn, which is as many as '
							+ 'one request gets. Answer from what you have already read, and use search_board (it greps '
							+ 'the whole board in one call and returns the matching lines) instead of opening components '
							+ 'one by one.');
					}
					if (typeof this.hub.recordComponentRead === 'function') this.hub.recordComponentRead(rtarget);
					const data = await this.hub.runOnBoard(rtarget,
						{
							t: 'readcomp',
							cid: String(args.componentId),
							offset: args.offset,
							limit: args.limit
						}, config.READ_COMPONENT_TIMEOUT_MS);
					if (data && (data.label || data.componentType) && typeof this.hub.noteTurnEvent === 'function') {
						this.hub.noteTurnEvent(rtarget, 'read_board_component ' + String(args.componentId)
							+ ' -> ' + (data.label ? '"' + data.label + '"' : data.componentType));
					}
					return this._ok(JSON.stringify(data));
				}

				case 'show_component_links': {
					const items = Array.isArray(args.items) ? args.items.filter(Boolean) : [];
					if (!items.length) {
						return this._err('show_component_links needs an items array of component ids (from search_board).');
					}
					const ltarget = args.projectid || board || null;
					const shown = await this.hub.runOnBoard(ltarget,
						{ t: 'links', items: items }, config.READ_TIMEOUT_MS);
					if (typeof this.hub.noteTurnEvent === 'function') {
						this.hub.noteTurnEvent(ltarget, 'show_component_links showed cards for cid '
							+ items.map(function(it) { return it.cid; }).join(', cid '));
					}
					return this._ok(typeof shown === 'string' ? shown : JSON.stringify(shown));
				}

				case 'convert_component': {
					if (!args.componentId || !args.target) {
						return this._err('convert_component needs both componentId (from read_board) and target '
							+ '(one of that component\'s convertTo names).');
					}
					// Like modify_component, the tab owns the component's data and runs the
					// conversion itself; this only carries the request. surface keeps
					// anything that turn asks the user in the chat this call came from.
					// Unqueued on purpose: the tab answers this by running a component AI
					// turn whose agent then calls a render tool, and that render has to
					// reach the same tab while this frame is still open. Through the
					// per-board queue the two wait on each other until the timeout (see
					// runOnBoardUnqueued). modify_component does not have this problem -
					// its result is a fill routed back through the armed capture.
					const runConvert = (typeof this.hub.runOnBoardUnqueued === 'function')
						? this.hub.runOnBoardUnqueued.bind(this.hub)
						: this.hub.runOnBoard.bind(this.hub);
					// The surface lookup keys on the TARGET board: an explicit-projectid
					// convert must ask its questions on the board being converted, not on
					// this connection's default board.
					const ctarget = args.projectid || board || null;
					const res = await runConvert(ctarget,
						{
							t: 'convert',
							cid: String(args.componentId),
							target: String(args.target),
							instruction: String(args.instruction || ''),
							surface: (typeof this.hub.getTurnSurface === 'function') ? this.hub.getTurnSurface(ctarget) : ''
						},
						config.HTML_TOOL_TIMEOUT_MS);
					if (typeof this.hub.noteTurnEvent === 'function') {
						this.hub.noteTurnEvent(ctarget, 'convert_component ' + String(args.componentId)
							+ ' -> ' + String(args.target));
					}
					return this._ok(typeof res === 'string' ? res : JSON.stringify(res));
				}

				// Web grounding, run on MockFlow through the user's tab (see the tool
				// definitions above). Read-only and free.
				case 'fetch_webpage':
				case 'extract_website_styles':
				case 'extract_website_images': {
					const url = String(args.url || '').trim();
					if (!/^https?:\/\//i.test(url)) {
						return this._err('A full public URL including http:// or https:// is required.');
					}
					const op = name === 'fetch_webpage' ? 'fetch'
						: (name === 'extract_website_styles' ? 'styles' : 'images');
					const data = await this.hub.runOnBoard(args.projectid || board || null,
						{ t: 'web', op: op, url: url }, config.WEB_TOOL_TIMEOUT_MS);
					if (op === 'styles' && data && data.guidance) {
						return this._ok(data.guidance
							+ '\n\nInclude this STYLE GUIDANCE block verbatim in the prompt or text you pass to the render tool.');
					}
					return this._ok(typeof data === 'string' ? data : JSON.stringify(data));
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
					const mtarget = args.projectid || board || null;
					const res = await this.hub.runOnBoard(mtarget,
						{
							t: 'modify',
							cid: String(args.componentId),
							instruction: String(args.instruction),
							surface: (typeof this.hub.getTurnSurface === 'function') ? this.hub.getTurnSurface(mtarget) : ''
						},
						config.HTML_TOOL_TIMEOUT_MS);
					if (typeof this.hub.noteTurnEvent === 'function') {
						this.hub.noteTurnEvent(mtarget, 'modify_component ' + String(args.componentId)
							+ ': ' + String(args.instruction).slice(0, 80));
					}
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
					// Third election point: a plan's items name their own tools, and a plan
					// is how a whole-product request arrives - so the batch is exactly where
					// a prototype item slips in for a request that never asked for one. An
					// item is CORRECTED in place rather than refused: nothing has been
					// composed yet (an item is a name and a brief), so the batch is still
					// good with the right tool in it.
					const words = this._userWords(board);
					const swapped = [];
					items.forEach(function(it) {
						const h = election.hold(self2.registry, it.tool, words);
						if (!h.held) return;
						swapped.push(it.tool + ' -> ' + h.tool);
						it.tool = h.tool;
					});
					if (swapped.length) {
						this.log('[plan] held to the user\'s words: ' + swapped.join(', '));
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
					return this._ok((swapped.length
							? 'Corrected before it was shown (' + swapped.join('; ') + '): a component whose '
								+ 'catalog entry reserves it for a request that asks for it in so many words '
								+ 'cannot be planned for a request that does not. '
							: '')
						+ 'The plan (' + items.length + ' components under "' + title + '") is now on '
						+ 'the user\'s screen for review. YOUR TURN IS COMPLETE: do not render anything and do '
						+ 'not call any more tools - when the user clicks Generate Board, the chosen items are '
						+ 'generated and arranged automatically. Briefly tell the user to review the list and '
						+ 'click Generate Board, and never output a URL or a link.');
				}
			}

			// Catalog render_* tools.
			const entry = this._entry(name);
			if (!entry) return this._err('Unknown tool: ' + name);

			// declare_render is only ONE of the ways a component gets elected: the
			// drawing step can call a different tool than the one it declared, and an
			// external MCP agent never declares at all. So the same rule applies here.
			// REFUSED rather than swapped - what an agent writes for one of these tools
			// is not usable by the other (a prototype's HTML wires screens together with
			// script a wireframe has no way to run), so it has to compose the right
			// thing rather than have its work redirected.
			const heldR = election.hold(this.registry, name, this._userWords(board));
			if (heldR.held) {
				this.log('[render] refused ' + name + ': the user\'s own words do not ask for it - '
					+ heldR.tool + ' instead (' + heldR.source + ' rule)');
				return this._err(name + ' is only for a request whose OWN words ask for one ('
					+ election.wordsPhrase(heldR.words, 4) + '), and this request does not - the user asked for: "'
					+ this._userWords(board).slice(0, 200) + '". Nothing was drawn. Compose it as a '
					+ heldR.tool + ' instead: one screen per call, or - if the request covers several screens or '
					+ 'surfaces - call plan_board with one ' + heldR.tool + ' item per screen and stop.');
			}

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
		// Not an answer at all: the user cancelled the question (askImages resolves
		// null for that). A no still draws a slots component without its pictures,
		// which is exactly what they declined - so nothing happens here.
		if (on !== true && on !== false) {
			this.log('[images] the ' + pending.label + ' was cancelled - nothing drawn');
			return;
		}
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

	/**
	 * The user's OWN words for the turn open on this board, or '' when this turn
	 * is not one: a component the user opened and asked to fill, a confirmed plan
	 * generating from briefs, or an agent connected from outside the editor. A
	 * component choice is only second-guessed against something the user actually
	 * typed (electionRules), so '' means every choice stands.
	 */
	_userWords(board) {
		if (typeof this.hub.getTurnRequest !== 'function') return '';
		// A component AI turn fills the component the USER opened - the tool is
		// their choice, not the agent's, and there is no election to hold.
		if (typeof this.hub.hasCapture === 'function' && this.hub.hasCapture(board)) return '';
		return this.hub.getTurnRequest(board) || '';
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
