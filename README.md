# MockFlow Bridge

**Use your own AI assistant to draw on your MockFlow board.**

MockFlow Bridge is a small program you run on your own computer. It connects the
AI assistant installed on your machine to the MockFlow board open in your
browser, so the AI can create diagrams, wireframes, mindmaps, plans and charts
directly on your board while you watch.

Two things make it different from using MockFlow AI:

- **It uses your AI, not ours.** The thinking happens on your machine, so it
  does not spend your MockFlow AI credits.
- **Your files stay with you.** If you point it at a folder, the AI can read
  your documents to build boards from them. Those files are never uploaded.
  Only the finished drawing is saved to your board.

---

# Getting started

## What you need

**1. Node.js, version 18 or newer.** This is what runs the bridge.
Download it from [nodejs.org](https://nodejs.org) and install it. To check it
worked, open Terminal (macOS) or Command Prompt (Windows) and type:

```bash
node --version
```

You should see a number like `v20.11.0`. Anything 18 or higher is fine.

**2. One AI assistant app.** The bridge works with any of these. Pick the one
you already pay for, or Claude Code if you have none. If you want to compare
them first, see [AGENT-COMPARISON.md](AGENT-COMPARISON.md).

| Assistant | Install it with | Then sign in with |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` |
| opencode | see [opencode.ai](https://opencode.ai) | `opencode` |
| Codex | `npm i -g @openai/codex` | `codex login` |
| Cursor CLI | see [cursor.com/cli](https://cursor.com/cli) | `cursor-agent login` |

Run the install command in your terminal, then run the sign-in command once and
follow the prompts. You only do this the first time.

**3. A MockFlow board** open in your browser at
[app.mockflow.com](https://app.mockflow.com).

## Step 1: Install and start the bridge

You have two ways to run it. Both are fine, pick one.

**Option A: no install (simplest).** This downloads and runs the latest version
each time:

```bash
npx @mockflow/mockflow-bridge
```

**Option B: install it once.** Then the command is shorter every time after:

```bash
npm i -g @mockflow/mockflow-bridge     # once
mockflow-bridge              # every time you want to start it
```

To update an installed copy later, run `npm i -g @mockflow/mockflow-bridge` again.

Leave this window open. It stays running and shows a **pairing code** that looks
like `941-027`. If you close the window, the connection stops.

## Step 2: Connect your board

1. Open your board in the browser.
2. Open **Ask Mida** and click **Connect Local Agent** at the top.
3. Type in the pairing code from your terminal.

The button turns green when it works, and you will see a message confirming
which assistant is connected. You only pair once per computer.

## Step 3: Ask for something

Type into Ask Mida as you normally would:

- "Draw a flowchart of our onboarding process"
- "Make a mindmap about our product launch"
- "Create a kanban board for this sprint"
- "Add a Blocked column to that kanban"

The reply and the drawing both come from your own assistant.

## Using your own files

By default the AI cannot see any of your files. If you want it to read a
folder, start the bridge like this instead:

```bash
npx @mockflow/mockflow-bridge --workspace ~/Documents/my-project
```

Replace the path with the folder you want it to read. Now you can ask:

- "Read this folder and draw the project structure as a mindmap"
- "Turn the meeting notes in this folder into a summary board"

Your files are read on your computer and are never uploaded to MockFlow. Only
the drawing that appears on your board is saved.

## If you have more than one assistant installed

The first time you start the bridge with several installed, it asks which one
to use and remembers your answer. To change it later:

```bash
npx @mockflow/mockflow-bridge --agent claude
npx @mockflow/mockflow-bridge --agent opencode
npx @mockflow/mockflow-bridge --agent codex
npx @mockflow/mockflow-bridge --agent cursor
```

They differ in small ways (web search, attachments, reading your files). See
[AGENT-COMPARISON.md](AGENT-COMPARISON.md).

## Everyday commands

```bash
npx @mockflow/mockflow-bridge           # start it (leave the window open)
npx @mockflow/mockflow-bridge status    # is it running, which boards are connected
npx @mockflow/mockflow-bridge help      # all options
```

If you installed it with `npm i -g`, drop the `npx` and just type
`mockflow-bridge`, `mockflow-bridge status`, and so on.

To stop it, press `Ctrl + C` in the terminal window, or just close the window.

## If something is not working

| What you see | What to do |
| --- | --- |
| "no supported agent CLI found" | Install one of the three assistants above and sign in once. |
| The pairing code is not accepted | Codes change each time the bridge restarts. Use the one currently shown in your terminal. |
| The button will not turn green | Check the terminal window is still open and shows the bridge running. |
| "Port 21196 is in use" | Another bridge is already running. Close that terminal window and try again. |
| Nothing appears on the board | Make sure the board tab is open and in front. The bridge draws on the board you are looking at. |
| The AI says it cannot read your files | File access is off unless you start with `--workspace`, see above. |

---

# Advanced

Everything below is for developers and power users. You do not need any of it
for normal use.

## Using the bridge from your own terminal agent

Instead of chatting in Ask Mida, you can point your agent at the bridge and ask
it to draw from wherever you work. The bridge prints the exact command to run at
startup, including a secret token, so copy it from there:

```bash
claude mcp add --transport http -s user mockflow http://127.0.0.1:21196/mcp/<token>
codex mcp add mockflow --url http://127.0.0.1:21196/mcp/<token>
gemini mcp add -t http -s user mockflow http://127.0.0.1:21196/mcp/<token>
```

Clients that only speak stdio use `npx @mockflow/mockflow-bridge stdio` as the command.

The token gates the endpoint. Without it any local process, including any web
page you have open, could drive your board and read data from your connected
sources. It is stored in `~/.mockflow/bridge-mcp-token` and survives restarts.

## Options and environment variables

| Option | What it does |
| --- | --- |
| `--workspace <path>` | Let the agent read one folder (off by default) |
| `--agent <id>` | `claude`, `opencode`, `codex` or `cursor` |
| `MFBRIDGE_PORT` | Port (default 21196) |
| `MFBRIDGE_AGENT` | Same as `--agent` |
| `MFBRIDGE_WORKSPACE` | Same as `--workspace` |
| `MFBRIDGE_ALLOW_WRITE=1` | Allow the agent to write files and run shell commands |
| `MFBRIDGE_CATALOG_URL` | Tool catalog endpoint override |
| `MFBRIDGE_ALLOWED_ORIGINS` | Extra comma separated WebSocket origins |
| `MFBRIDGE_DEV=1` | Dev mode (allow any WebSocket origin) |
| `MFBRIDGE_DEBUG=1` | Print what each render produced (see Debugging) |

## How it works

```
Claude Code / opencode / Codex / Cursor   (the brain: generates component JSON)
        | MCP  (POST /mcp/<token>, or the stdio shim)
        v
mockflow-bridge daemon                (engine: validate, map args -> gdata)
        | ws://127.0.0.1:21196/board  (pairing code + token, Origin allow-list)
        v
MockFlow editor tab                   (the hands: showResults() draws it live,
                                       saves via the user's own session)
```

- **Engine** (this package, changes rarely): transports, pairing, board
  targeting, per-board serialization, the generic mapping machinery.
- **Catalog** (data, changes often): tool definitions, descriptions, schemas and
  mapping rules, fetched at startup from
  `https://app.mockflow.com/call/api/mcpcatalog/ideaboard` and cached in
  `~/.mockflow/`. New AI components therefore ship without an npm release. If
  the endpoint is unreachable and there is no cache yet, startup fails with a
  clear message.

**Board targeting.** Renders go to an explicitly selected board
(`select_board`), else the tab the user is focused on, else the only connected
tab. Calls against the same board are serialized, so two agents on one board
never interleave a draw.

## Tools

- All catalog `render_*` tools (flowchart, mindmap, kanban, gantt, charts,
  timeline, storyboard, whiteboard, and so on), drawn live on the board.
- `render_wireframelite` / `render_prototypelite`: the agent writes HTML, the
  connected tab converts it into an editable wireframe or clickable prototype
  through the user's own session.
- `modify_component`: change something already on the board in place, keeping
  its position, size and identity. Re-rendering a component duplicates it,
  this edits it.
- `plan_board`: propose a multi-part board. The list appears in the user's tab,
  the agent's turn ends there, and the user's Generate Board click generates and
  arranges the chosen items.
- `layout_board`: bento layout plus titled section wrap of the batch just drawn.
- `read_board`: the live board (components, ids, labels, positions, sizes),
  including unsaved state.
- `list_boards` / `select_board`: multi-board targeting.
- `list_source_tools` / `describe_source_tool` / `call_source_tool`: read the
  user's connected sources (Notion, Jira, Slack, GitHub and so on) through their
  MockFlow account. Read only: these tools cannot post, create or delete.

## Local agent chat (Mode B)

The same connection works in reverse: Ask Mida, Concept Builder and each
component's QuickSettings AI route to the local agent instead of MockFlow's
server AI.

```
you type in Mida  ->  board socket  ->  bridge spawns the agent headless
                                            | (render tools via MCP loopback)
   reply streams into the Mida bubble  <-   | draws land on the same board
```

- **Read only by default**: the spawned agent gets file reading plus the board
  tools. `MFBRIDGE_ALLOW_WRITE=1` opts into writing and shell.
- **Memory per surface**: sessions are keyed per board and per surface, so Ask
  Mida and each Concept Builder keep separate conversations. Only the first
  message pays the cold start.
- **Attachments stay local**: a file attached in Mida is sent over the local
  socket, saved in `~/.mockflow/attachments/<board>/`, and read by the agent.
  Nothing is uploaded, and the files are deleted when the board tab closes.
- **Connected sources** are fetched by MockFlow, since the credentials live in
  the user's account, and Concept Builder chat is stored in that account so
  builders remember across sessions and teammates see the same conversation.
- One turn at a time per board. If the bridge drops mid-turn the editor falls
  back to MockFlow's server AI so the message is never lost.

## Adding another agent CLI

Agents are plugins in `src/agents/`. Adding one is a single file plus a line in
`src/agents/index.js`, and nothing else in the bridge, the editor or the server
changes. The contract, the capability flags and the fallbacks are documented at
the top of `src/agents/index.js`.

## Security

- The daemon binds `127.0.0.1` only.
- `POST /mcp/<token>` is token gated and sends no CORS headers, so a web page
  cannot reach it.
- The `/board` WebSocket enforces an Origin allow-list (MockFlow editor
  origins; extend with `MFBRIDGE_ALLOWED_ORIGINS`).
- Pairing: the daemon prints a one-time code, and a tab that presents it gets a
  durable token stored in `~/.mockflow/bridge-tokens.json`.
- Connected sources are read only, so an agent cannot post to Slack or create a
  Jira issue on the user's behalf.
- The bridge never holds MockFlow credentials or API keys.

## Development

```bash
npm install
npm run check                      # syntax-check the package
MFBRIDGE_DEV=1 npm start           # dev daemon (any WS origin allowed)

# End-to-end without a browser (these spawn a real headless agent):
node test/fake-tab.js <pairing-code-from-daemon>          # stand-in board tab
node test/fake-chat.js <pairing-code> "your message"      # Mode B chat loop
```

`browser/mockflow-bridge-client.js` is the reference page-side client used by the
test pages; keep its wire-protocol behavior in sync with the MockFlow editor's
own client when changing frames.

### Debugging what a render produced

Everything an agent generates is handed to the board tab and vanishes from view,
so debug tracing prints it instead. It is **on automatically when the catalog
points at a local MockFlow** (`MFBRIDGE_CATALOG_URL=http://localhost:...`); force
it with `MFBRIDGE_DEBUG=1`, or off with `MFBRIDGE_DEBUG=0`. The startup info card
shows the current state.

With it on, every `render_*` call prints the agent's payload (the full HTML for
`render_wireframelite` / `render_prototypelite`, the args JSON otherwise) and
dumps it to `~/.mockflow/bridge-debug/`. Open the dumped `.html` in a browser:
what you see there is what the MockFlow capture sees, so missing icons or charts
are visible immediately.

For `render_wireframelite` the tab also returns a conversion report from the
MockFlow server (`aitoolsManager.htmlToPaintObjects`, logged server-side as
`[html2paintobjects]`). It is printed as `DIAGNOSTICS`, saved next to the HTML,
and appended to the tool result so the AGENT sees it too:

| Field | Reading it |
| --- | --- |
| `paintObjectCount` | components the board received. A real screen is dozens; single digits = the HTML was too sparse. |
| `captureMode` | `charts` = chart-aware capture ran, `plain` = no chart markup was found. |
| `canvasCount` / `chartComponents` | canvases in the HTML vs charts actually captured. A gap = the Chart.js contract was broken (missing `data-chart-component`, script tag, or init). |
| `svgIconRefs` / `inlineSvgs` / `iconFontTags` | how the agent expressed icons. Only `svgIconRefs` (FontAwesome SVG URLs in `<img>`) convert; inline `<svg>` and `<i class="fa…">` capture as nothing. |
| `warnings` | the plain-language version of all of the above. |

Weak wireframes are almost always an HTML problem, not a conversion problem: the
tool description in the catalog is what teaches the agent to emit dense sections,
FontAwesome SVG icons and Chart.js canvases, so fix it there (the catalog is
fetched from MockFlow, no npm publish needed) and re-read the diagnostics.
