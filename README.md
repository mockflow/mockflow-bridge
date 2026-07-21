# MockFlow Bridge

**Your AI agent draws on the MockFlow board you have open.** A small local
daemon that connects any MCP-capable agent (Claude Code, Cursor, Codex, ...)
to the live MockFlow board in your browser. The agent is the brain, the
browser tab is the hands, the bridge is the nervous system between them.

- No MockFlow AI credits for the thinking - your own agent generates the content.
- No credentials in the bridge - every draw happens inside your already
  signed-in browser tab, through the same `showResults()` path Mida uses.
- New AI components ship without updating this package - the tool catalog is
  fetched from MockFlow at startup (Engine + Catalog split, see below).

## Quick start

```bash
# 1. Start the daemon (leave the terminal open - it shows the pairing code)
npx mockflow-bridge

# 2. Point your agent at it
claude mcp add --transport http -s user mockflow http://127.0.0.1:21196/mcp
#    stdio-only clients instead use:  command = npx mockflow-bridge stdio

# 3. Open your board at app.mockflow.com, switch ON "Connect local agent",
#    enter the pairing code from step 1. Then ask your agent to draw.
```

`mockflow-bridge status` shows whether the daemon is up and which boards are
connected.

## How it works

```
Claude Code / Cursor / Codex          (the brain - generates component JSON)
        | MCP  (POST /mcp, or stdio shim)
        v
mockflow-bridge daemon                (engine: validate, map args -> gdata)
        | ws://127.0.0.1:21196/board  (pairing code + token, Origin allow-list)
        v
MockFlow editor tab                   (the hands: showResults() draws it live,
                                       saves via the user's own session)
```

- **Engine** (this package, changes rarely): transports, pairing, board
  targeting, per-board serialization, the generic mapping machinery.
- **Catalog** (data, changes often): tool definitions, descriptions, schemas
  and mapping rules. Fetched at startup from
  `https://app.mockflow.com/call/api/mcpcatalog/ideaboard` and cached locally
  (`~/.mockflow/`); if the endpoint is unreachable and there is no cache yet,
  startup fails with a clear message. Override the endpoint with
  `MFBRIDGE_CATALOG_URL`.

### Board targeting

Renders go to: an explicitly selected board (`select_board`) > the tab the
user is focused on > the only connected tab. With no board connected the tool
result tells the agent the exact steps to relay to the user. Calls against the
same board are serialized, so parallel agents (Claude Code AND Codex on one
board) never interleave a draw.

## Local agent chat inside Ask Mida / Concept Builder (Mode B)

The flow also works in reverse: the **Connect Local Agent** toggle (top-left of
the Ask Mida chat) routes Ask Mida, Concept Builder and each component's
QuickSettings AI to YOUR agent instead of MockFlow's server AI. Zero MockFlow AI
credits for the thinking.

```
you type in Mida  ->  board socket  ->  bridge spawns headless Claude Code
                                            | (render tools via MCP loopback)
   reply streams into the Mida bubble  <-   | draws land on the same board
```

For users:

1. Install Claude Code once: `npm i -g @anthropic-ai/claude-code`, then run
   `claude` and sign in. (The bridge banner shows "Claude Code found".)
2. Start the bridge, connect + pair the board as usual.
3. Click "Connect Local Agent" (top-left of the Mida chat) so it turns green.
   Ask anything - the reply and any drawings come from your agent.

Behavior and safety:

- **Read-only by default**: the spawned agent gets Read/Grep/Glob plus the
  board render tools only. `MFBRIDGE_ALLOW_WRITE=1` opts into Write/Edit/Bash.
- **Workspace (opt-in file access)**: file reading is **off by default**. Pass
  `--workspace ~/git/myproject` (or `MFBRIDGE_WORKSPACE`) to let Mida read and
  visualize that one folder's files. Your files are **never uploaded** either way
  - only what the agent draws is sent to MockFlow; the reading and thinking run on
  your machine. With a workspace set, try asking Mida:
  - "Read this repo and draw its module architecture"
  - "Map this project's folder structure as a mindmap"
  - "Turn the latest meeting transcript in this folder into a mindmap"
  - "Diagram the request flow of the checkout service"
- **Two ways to drive the board**: (1) chat in Ask Mida / Concept Builder with
  the local agent connected, or (2) run your own Claude Code / Cursor / Codex in
  a repo with this bridge added as an MCP server and ask it to draw - it renders
  straight onto the connected board.
- **Multi-turn memory**: the session is kept per board, so "make the third
  one blue" works; only the first message pays the cold-start cost.
- One turn at a time per board; if the bridge disconnects mid-turn the editor
  falls back to MockFlow's server AI so the message is never lost.
- Chats with file/image attachments still go to the server for now.
- Providers: Claude Code today; Gemini CLI and an OpenAI-compatible endpoint
  dialect (Ollama / LM Studio / Hermes / API keys) are next - the editor side
  is provider-agnostic and needs no changes.

### Tools

- All catalog `render_*` tools (flowchart, mindmap, kanban, gantt, charts,
  timeline, storyboard, whiteboard, ...) - drawn live on the connected board.
- `render_wireframelite` / `render_prototypelite` - the agent writes the HTML,
  the connected tab converts it (editable wireframe / clickable prototype)
  through the user's own session and draws the result. No AI credits.
- `plan_board` - propose a multi-part board plan (like MockFlow's own AI): the
  item list appears in the user's board tab, the agent's turn ends there, and
  the user's Generate Board click generates the chosen items from the plan's
  briefs and arranges the batch automatically.
- `layout_board` - bento layout + titled section wrap of the batch just drawn
  (runs inside the tab, ported from the desktop MCP); not needed when a
  plan_board plan is active.
- `read_board` - serialize the live board (components, positions, sizes),
  including unsaved state.
- `list_boards` / `select_board` - multi-board targeting.

## Security

- Daemon binds `127.0.0.1` only.
- `/board` WebSocket: Origin allow-list (MockFlow editor origins; extend with
  `MFBRIDGE_ALLOWED_ORIGINS`, or `MFBRIDGE_DEV=1` to allow all during dev).
- Pairing: the daemon prints a one-time code; a tab that presents it gets a
  durable token (stored in `~/.mockflow/bridge-tokens.json`). No other local
  process can puppet the board, no website can pose as the bridge.
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
