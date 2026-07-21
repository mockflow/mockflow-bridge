/**
 * MockFlow Bridge - browser-side client.
 *
 * Runs INSIDE the MockFlow editor page (or a test page). Connects out to the
 * local bridge daemon (ws://127.0.0.1:21196/board), pairs once with the code
 * shown in the bridge terminal, registers the open board, and then executes
 * frames the bridge pushes:
 *
 *   {t:'tool', id, toolName, gdata}  -> mf_main.editorController.aiToolsController.showResults(gdata)
 *   {t:'toolhtml', id, toolName, mcpType, args} -> HTML-conversion tools (render_wireframelite /
 *        render_prototypelite): convert the agent HTML through the MockFlow endpoints
 *        (html2paintobjects / prototype upload) with the page's own session, then draw
 *   {t:'read', id, what:'board'}     -> serialize the live board back
 *   {t:'layout', id, boardTitle}     -> bento layout + section wrap (ported from the desktop MCP)
 *
 * The page is already authenticated, so every draw saves through the user's
 * own session. The bridge never sees credentials - only this pairing token.
 *
 * NOTE: the MockFlow editor ships its own adaptation of this client (with the
 * connect UI and board serializer). Keep the wire protocol behavior in sync.
 *
 * Integration (generic pages / test pages): load this file, then call
 *   MFBridgeClient.connect({
 *     onPairRequired: function(submit) { ...ask user for the code, call submit(code)... },
 *     onStatus: function(status) { ...update the toggle UI... }
 *   });
 * MFBridgeClient.disconnect() turns it off. Token is kept in localStorage.
 */

(function() {
	'use strict';

	var DEFAULT_PORT = 21196;
	var TOKEN_KEY = 'mfbridge_token';
	var RECONNECT_MIN_MS = 2000;
	var RECONNECT_MAX_MS = 30000;

	var ws = null;
	var enabled = false;
	var reconnectDelay = RECONNECT_MIN_MS;
	var reconnectTimer = null;
	var opts = {};
	var status = 'disconnected'; // disconnected | connecting | pairing | connected
	var snapshotEids = null;     // component eids before the first tool of a batch (for layout)
	var listenersBound = false;

	function log() {
		if (window.console && console.log) {
			console.log.apply(console, ['[MFBridge]'].concat(Array.prototype.slice.call(arguments)));
		}
	}

	function setStatus(s) {
		status = s;
		if (opts.onStatus) {
			try { opts.onStatus(s); } catch (e) {}
		}
	}

	// ---- editor access (guarded - also works on stub test pages) -------------

	function editor() {
		if (typeof mf_main === 'undefined' || !mf_main || !mf_main.editorController) return null;
		return mf_main.editorController;
	}

	function boardInfo() {
		var ec = editor();
		var projectid = null;
		var title = null;
		try {
			if (ec && ec.projectObj) {
				projectid = ec.projectObj.id || null;
				title = ec.projectObj.title || ec.projectObj.name || null;
			}
		} catch (e) {}
		return {
			projectid: projectid,
			title: title || document.title || null,
			focused: document.hasFocus(),
			visible: !document.hidden,
			url: location.href
		};
	}

	function childComponents() {
		var ec = editor();
		if (!ec || !ec.page || !ec.page.childComponents) return null;
		return ec.page.childComponents;
	}

	// ---- frames --------------------------------------------------------------

	function send(frame) {
		if (ws && ws.readyState === 1) {
			try { ws.send(JSON.stringify(frame)); } catch (e) {}
		}
	}

	function reply(id, ok, dataOrError) {
		var frame = { t: 'result', id: id, ok: ok };
		if (ok) frame.data = dataOrError;
		else frame.error = String(dataOrError || 'failed');
		send(frame);
	}

	function register() {
		var info = boardInfo();
		send({
			t: 'register',
			projectid: info.projectid,
			title: info.title,
			focused: info.focused,
			visible: info.visible,
			url: info.url
		});
	}

	function sendState() {
		if (status !== 'connected') return;
		var info = boardInfo();
		send({ t: 'state', projectid: info.projectid, title: info.title, focused: info.focused, visible: info.visible });
	}

	function bindStateListeners() {
		if (listenersBound) return;
		listenersBound = true;
		window.addEventListener('focus', sendState);
		window.addEventListener('blur', sendState);
		document.addEventListener('visibilitychange', sendState);
	}

	// ---- frame handlers ------------------------------------------------------

	function takeSnapshotIfNeeded() {
		if (snapshotEids) return;
		var list = childComponents();
		if (!list) return;
		snapshotEids = {};
		try {
			for (var i = 0; i < list.size(); i++) {
				snapshotEids[list.getItemAt(i).eid] = true;
			}
		} catch (e) {
			snapshotEids = null;
		}
	}

	function handleTool(frame) {
		var ec = editor();
		if (!ec || !ec.aiToolsController || typeof ec.aiToolsController.showResults !== 'function') {
			return reply(frame.id, false, 'No editor with aiToolsController on this page');
		}
		try {
			takeSnapshotIfNeeded();
			ec.aiToolsController.showResults(frame.gdata);
			reply(frame.id, true, { rendered: frame.toolName });
		} catch (e) {
			reply(frame.id, false, (e && e.message) || 'showResults failed');
		}
	}

	/**
	 * HTML-conversion render tools (render_wireframelite / render_prototypelite).
	 * The agent ships raw HTML; the page runs the same processing the hosted MCP
	 * backend runs (HTML -> paintObjects render, or the prototype S3 upload) with
	 * its own session, builds the gdata via the aitools MCP transform, and draws.
	 * Needs the full editor runtime (MF_Global / MF_UserSession / aitools) - on
	 * stub test pages it fails honestly.
	 */
	function handleHtmlTool(frame) {
		var ec = editor();
		if (!ec || !ec.aiToolsController || typeof ec.aiToolsController.showResults !== 'function') {
			return reply(frame.id, false, 'No editor with aiToolsController on this page');
		}
		if (typeof MF_Global === 'undefined' || typeof MF_UserSession === 'undefined') {
			return reply(frame.id, false, 'HTML-conversion tools are not available on this page');
		}
		var args = frame.args || {};
		if (typeof args.html !== 'string' || !args.html.trim()) {
			return reply(frame.id, false, 'The ' + (frame.toolName || 'render') + ' call must include the complete HTML in the "html" argument.');
		}

		// diagnostics: the conversion report the MockFlow server returned, echoed back with
		// the result so the bridge console can explain a weak render (see src/debug.js).
		function drawFromTransform(mcpType, storedObj, diagnostics) {
			var transforms = ec.aiToolsController._mcpTransforms;
			var tf = transforms && transforms[mcpType];
			if (typeof tf !== 'function') return reply(frame.id, false, 'No client transform for ' + mcpType);
			try {
				var gdata = tf(JSON.stringify(storedObj));
				if (frame.fromconvert && gdata && gdata.data) gdata.data.fromconvert = frame.fromconvert;
				takeSnapshotIfNeeded();
				ec.aiToolsController.showResults(gdata);
				reply(frame.id, true, { rendered: frame.toolName, diagnostics: diagnostics || null });
			} catch (e) {
				reply(frame.id, false, (e && e.message) || 'showResults failed');
			}
		}

		function post(path, body, onOk) {
			fetch(MF_Global.getNodeServerURL() + path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json; charset=UTF-8' },
				body: JSON.stringify(body)
			}).then(function(r) { return r.json(); }).then(onOk).catch(function(e) {
				reply(frame.id, false, 'Conversion request failed: ' + (e && e.message));
			});
		}

		// Frame title parity with the editor client: explicit title arg first, then the
		// agent's own <title> tag (generic placeholders rejected, like _extractHtmlTitle).
		function htmlDocTitle(html) {
			var m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
			if (!m) return '';
			var t = m[1].replace(/\s+/g, ' ').trim();
			if (!t || t.length > 40) return '';
			if (/^(document|untitled|title|page|home page|wireframe|mockup|screen|prototype|app|home|index)$/i.test(t)) return '';
			return t;
		}

		if (frame.mcpType === 'wireframelite') {
			// width: multi-screen apps capture every screen at the same device viewport
			// so all frames pin to one uniform width (server ignores null).
			post('/call/api/html2paintobjects', { html: args.html, width: args.viewportWidth || null }, function(resp) {
				if (!resp || !resp.success || !resp.paintObjects || resp.paintObjects.length === 0) {
					return reply(frame.id, false, 'The HTML could not be converted to wireframe components.');
				}
				var stored = {};
				for (var k in args) stored[k] = args[k];
				stored.paintObjects = resp.paintObjects;
				if (!stored.title) stored.title = htmlDocTitle(args.html);
				drawFromTransform('wireframelite', stored, resp.diagnostics || null);
			});
		} else if (frame.mcpType === 'prototypelite') {
			var cid = MF_Utils.guidGenerator();
			var deviceType = args.deviceType || 'mobile';
			post('/call/api/prototype/upload', {
				html: args.html,
				deviceType: deviceType,
				title: args.title || '',
				clientid: MF_UserSession.getUser().company,
				projectid: ec.projectObj.id,
				cid: cid
			}, function(resp) {
				if (!resp || !resp.success) {
					return reply(frame.id, false, 'The prototype could not be stored: ' + ((resp && resp.error) || 'storage failed'));
				}
				drawFromTransform('prototypelite', {
					clientCreateComp: 'MF_PrototypeLite_ID',
					cid: cid,
					deviceType: deviceType,
					prototypePath: resp.prototypePath,
					prototypeVersion: resp.prototypeVersion,
					prototypeEntry: resp.prototypeEntry,
					prototypeToken: resp.prototypeToken,
					prototypeCid: resp.prototypeCid || cid,
					prototypeMode: resp.prototypeMode || 'single',
					prototypeTitle: resp.prototypeTitle || 'Prototype',
					prototypeScreens: resp.prototypeScreens || []
				});
			});
		} else {
			reply(frame.id, false, 'Unknown HTML-conversion tool: ' + (frame.toolName || frame.mcpType));
		}
	}

	function handleRead(frame) {
		var list = childComponents();
		if (!list) return reply(frame.id, false, 'No board page on this page');
		try {
			var info = boardInfo();
			var comps = [];
			for (var i = 0; i < list.size(); i++) {
				var c = list.getItemAt(i);
				var item = {
					eid: c.eid,
					cid: c.cid || null,
					type: c.componentName || c.name || (c.constructor && c.constructor.name) || 'unknown',
					x: Math.round(c.x || 0),
					y: Math.round(c.y || 0),
					width: Math.round(c.width || 0),
					height: Math.round(c.height || 0)
				};
				try {
					if (typeof c.text === 'string' && c.text) item.text = c.text.slice(0, 200);
				} catch (e) {}
				comps.push(item);
			}
			reply(frame.id, true, {
				projectid: info.projectid,
				title: info.title,
				componentCount: comps.length,
				components: comps
			});
		} catch (e) {
			reply(frame.id, false, (e && e.message) || 'serialize failed');
		}
	}

	/**
	 * Bento layout + titled section wrap over the components created since the
	 * batch snapshot. Direct port of the desktop MCP's layout routine - same
	 * clustering, same MF_BoardLayoutEngine, same wrapInSection styling.
	 */
	function handleLayout(frame) {
		var ec = editor();
		var list = childComponents();
		if (!ec || !list) return reply(frame.id, false, 'No board page on this page');
		if (!snapshotEids) return reply(frame.id, false, 'No components to layout. Call render_* tools first, then layout_board.');
		if (typeof MF_Utils === 'undefined' || !MF_Utils.loadsScripts) {
			return reply(frame.id, false, 'Layout is not available on this page');
		}

		var beforeEids = snapshotEids;
		var boardTitle = frame.boardTitle || 'Board';

		MF_Utils.loadsScripts(['modules/genui/boardlayout.js']).then(function() {
			try {
				var newComps = [];
				for (var i = 0; i < list.size(); i++) {
					var comp = list.getItemAt(i);
					if (!beforeEids[comp.eid]) newComps.push(comp);
				}

				if (newComps.length === 0) {
					snapshotEids = null;
					return reply(frame.id, true, 0);
				}

				// Cluster overlapping components - each cluster is likely one render_* call.
				var items = [];
				var assigned = {};
				for (var i = 0; i < newComps.length; i++) {
					if (assigned[newComps[i].eid]) continue;
					var cluster = [newComps[i]];
					assigned[newComps[i].eid] = true;

					var changed = true;
					while (changed) {
						changed = false;
						for (var j = 0; j < newComps.length; j++) {
							if (assigned[newComps[j].eid]) continue;
							for (var k = 0; k < cluster.length; k++) {
								var a = cluster[k], b = newComps[j];
								var pad = 20;
								if (a.x - pad < b.x + b.width && a.x + a.width + pad > b.x
									&& a.y - pad < b.y + b.height && a.y + a.height + pad > b.y) {
									cluster.push(newComps[j]);
									assigned[newComps[j].eid] = true;
									changed = true;
									break;
								}
							}
						}
					}

					var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
					for (var c = 0; c < cluster.length; c++) {
						if (cluster[c].x < minX) minX = cluster[c].x;
						if (cluster[c].y < minY) minY = cluster[c].y;
						if (cluster[c].x + cluster[c].width > maxX) maxX = cluster[c].x + cluster[c].width;
						if (cluster[c].y + cluster[c].height > maxY) maxY = cluster[c].y + cluster[c].height;
					}
					items.push({
						id: 'item_' + items.length,
						components: cluster,
						width: maxX - minX || 400,
						height: maxY - minY || 300,
						sizeHint: 'medium'
					});
				}

				if (items.length >= 2) {
					var engine = new MF_BoardLayoutEngine({ gap: 80, originX: 0, originY: 0 });
					var tempLayout = engine.computeLayout(items);

					// Find empty board space, ignoring the new components themselves.
					var newEids = {};
					for (var i = 0; i < newComps.length; i++) newEids[newComps[i].eid] = true;
					var hiddenComps = [];
					for (var i = list.size() - 1; i >= 0; i--) {
						var obj = list.getItemAt(i);
						if (newEids[obj.eid]) {
							hiddenComps.push({ comp: obj, index: i });
							list.removeItemAt(i);
						}
					}
					var ncoord = mf_main.componentList.getFinalOffsets(tempLayout.totalWidth, tempLayout.totalHeight);
					for (var i = hiddenComps.length - 1; i >= 0; i--) {
						list.addItemAt(hiddenComps[i].comp, hiddenComps[i].index);
					}

					engine.ORIGIN_X = ncoord.offsetXPos;
					engine.ORIGIN_Y = ncoord.offsetYPos;
					var layoutResult = engine.computeLayout(items);

					for (var i = 0; i < items.length; i++) {
						var pos = layoutResult.positions[i];
						var comps = items[i].components;
						if (comps.length === 0) continue;

						var minX = Infinity, minY = Infinity;
						for (var c = 0; c < comps.length; c++) {
							if (comps[c].x < minX) minX = comps[c].x;
							if (comps[c].y < minY) minY = comps[c].y;
						}
						var dx = pos.x - minX;
						var dy = pos.y - minY;

						for (var j = 0; j < comps.length; j++) {
							var newX = (comps[j].x || 0) + dx;
							var newY = (comps[j].y || 0) + dy;
							comps[j].e2xml.addPropObject('ecoordinates', { x: newX, y: newY }, 'default', true);
							comps[j].render(false);
							if (comps[j].selector) {
								comps[j].selector.x = comps[j].x;
								comps[j].selector.y = comps[j].y;
								comps[j].selector.width = comps[j].width;
								comps[j].selector.height = comps[j].height;
							}
						}
					}
				}

				try {
					var selects = [];
					for (var i = 0; i < newComps.length; i++) {
						if (newComps[i].selector) selects.push(newComps[i].selector);
					}
					ec.componentSelect = selects;
					var sectionComp = ec.wrapInSection();
					if (sectionComp) {
						sectionComp.e2xml.addPropSingle('text', boardTitle, 'default', true);
						sectionComp.e2xml.addPropSingle('fontSize', 20, 'default', true);
						sectionComp.e2xml.addPropSingle('fontColor', '#FFFFFF', 'default', true);
						sectionComp.e2xml.addPropSingle('layoutType', 'tab', 'default', true);
						sectionComp.e2xml.addPropArray('borderColors', ['#000000', '#000000', '#000000', '#000000', '#000000'], 'String', 'default', true);
						sectionComp.e2xml.addPropArray('fillColors', ['#FFFFFF', '#FFFFFF'], 'String', 'default', true);
						sectionComp.render(true);
					}
				} catch (e) {
					log('Section wrap error:', e && e.message);
				}

				ec.resizePage(true);
				snapshotEids = null;
				reply(frame.id, true, items.length);
			} catch (e) {
				snapshotEids = null;
				reply(frame.id, false, (e && e.message) || 'layout failed');
			}
		}, function() {
			reply(frame.id, false, 'Could not load the layout engine');
		});
	}

	// ---- connection ----------------------------------------------------------

	function connect(userOpts) {
		opts = userOpts || {};
		enabled = true;
		reconnectDelay = RECONNECT_MIN_MS;
		bindStateListeners();
		open();
	}

	function disconnect() {
		enabled = false;
		clearTimeout(reconnectTimer);
		if (ws) {
			try { ws.close(); } catch (e) {}
			ws = null;
		}
		setStatus('disconnected');
	}

	function open() {
		if (!enabled) return;
		var port = opts.port || DEFAULT_PORT;
		setStatus('connecting');

		try {
			ws = new WebSocket('ws://127.0.0.1:' + port + '/board');
		} catch (e) {
			return scheduleReconnect();
		}

		ws.onopen = function() {
			reconnectDelay = RECONNECT_MIN_MS;
			var token = null;
			try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
			send({ t: 'hello', token: token || undefined });
		};

		ws.onmessage = function(ev) {
			var frame;
			try { frame = JSON.parse(ev.data); } catch (e) { return; }
			if (!frame || typeof frame.t !== 'string') return;

			switch (frame.t) {
				case 'pair-required':
					setStatus('pairing');
					if (opts.onPairRequired) {
						opts.onPairRequired(function submit(code) {
							send({ t: 'pair', code: String(code) });
						});
					} else {
						log('Pairing required - call MFBridgeClient.pair("<code from the bridge terminal>")');
					}
					return;
				case 'paired':
					try { localStorage.setItem(TOKEN_KEY, frame.token); } catch (e) {}
					register();
					return;
				case 'ready':
					register();
					return;
				case 'registered':
					setStatus('connected');
					log('Connected to local bridge');
					return;
				case 'tool':
					handleTool(frame);
					return;
				case 'toolhtml':
					handleHtmlTool(frame);
					return;
				case 'read':
					handleRead(frame);
					return;
				case 'layout':
					handleLayout(frame);
					return;
				case 'snapshot':
					// plan_board batch boundary: forget the previous batch and snapshot
					// the board NOW, so the coming layout arranges only the planned draws.
					snapshotEids = null;
					takeSnapshotIfNeeded();
					reply(frame.id, true, { snapshot: true });
					return;
				case 'plan-pick':
					// plan_board selection step. The production editor shows the Mida
					// "Select items to generate" picker and replies with the user's
					// choice (their Generate Board click starts the generation turn).
					// Generic/test pages have no picker UI: answer auto, which the
					// bridge treats as "full plan confirmed".
					reply(frame.id, true, { auto: true });
					return;
				case 'error':
					log('Bridge error:', frame.message);
					if (opts.onError) {
						try { opts.onError(frame.message); } catch (e) {}
					}
					return;
			}
		};

		ws.onclose = function() {
			ws = null;
			if (enabled) {
				setStatus('disconnected');
				scheduleReconnect();
			}
		};

		ws.onerror = function() {
			// onclose follows; reconnect is handled there.
		};
	}

	function scheduleReconnect() {
		if (!enabled) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(open, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	window.MFBridgeClient = {
		connect: connect,
		disconnect: disconnect,
		pair: function(code) { send({ t: 'pair', code: String(code) }); },
		getStatus: function() { return status; }
	};
})();
