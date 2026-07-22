# Which AI assistant should I use?

MockFlow Bridge works with four assistants. Any of them draws on your board, so
if you already pay for one, use that one. This page is for deciding when you do
not have a preference, and for the technical detail behind the differences.

Everything here was checked against these versions: Claude Code 2.1.216,
opencode 1.18.4, Codex 0.145.0, Cursor CLI (documented behaviour, see the
verification note at the end).

---

# Part 1: What you will notice

## The short answer

| If you want | Use |
| --- | --- |
| The most complete experience, everything supported | **Claude Code** |
| To choose your own model, or run one locally | **opencode** |
| You already pay for ChatGPT and want to use that | **Codex** |
| You already pay for Cursor | **Cursor CLI** |

## Feature by feature

| | Claude Code | opencode | Codex | Cursor CLI |
| --- | --- | --- | --- | --- |
| Draws on your board | Yes | Yes | Yes | Yes |
| Edits something already drawn | Yes | Yes | Yes | Yes |
| Multi-part board plans | Yes | Yes | Yes | Yes |
| Reply appears word by word | Yes | Yes | Arrives in one piece | Arrives in segments |
| "Drawing…" appears while it works | Yes | Yes | Yes | Yes |
| Remembers earlier messages | Yes | Yes | Yes | Yes |
| Reads a folder you point it at | Yes | Yes | Yes | Not yet |
| Attachments (files, images) | Yes | Yes | Yes | Not yet |
| **Web search** | **On** | **Fetch only** | **Off by default** | Unverified |
| Connected sources (Notion, Jira, Slack) | Yes | Yes | Yes | Yes |
| Costs MockFlow AI credits | No | No | No | No |

## What the web search row means

When you ask for something that depends on current facts (live prices, recent
events, real companies), the assistant may look it up first.

- **Claude Code**: searching and page fetching are both switched on for chat
  turns, so it can research before it draws.
- **opencode**: it can fetch a page you name, but general web search depends on
  what you have configured in opencode itself.
- **Codex**: web search defaults to a cached index rather than live browsing.
  Live search is a setting we can turn on per turn, which we currently do not.
- **Cursor CLI**: not verified yet.

Whichever you use, a component that needs real-world data still generates. When
search is unavailable the assistant falls back to what it already knows and
leaves unknown specifics as placeholders rather than inventing them.

## Things that are the same on all four

- Nothing you draw costs MockFlow AI credits.
- Your files are never uploaded. Reading and thinking happen on your machine.
- Connected sources are fetched by MockFlow, because your Notion or Jira login
  lives in your MockFlow account, and they are read only: an assistant cannot
  post to Slack or create a ticket on your behalf.
- Concept Builder conversations are stored in your MockFlow account, so a
  builder remembers across sessions and your teammates see the same chat.

---

# Part 2: Technical comparison

## Adapter capabilities

These are the flags each adapter declares, which is what the orchestrator adapts
to. Anything not supported has a fallback, so the feature degrades rather than
breaking.

| Capability | Claude Code | opencode | Codex | Cursor CLI |
| --- | --- | --- | --- | --- |
| `streamsPartialText` | true | true | false | true |
| `textChunks` | `block` | `delta` | `block` | `block` |
| `announcesToolsEarly` | true | true | true | true |
| `restrictTools` | `per-run` | `per-run` | `per-run` | `none` |
| `resume` | `by-id` | `by-id` | `by-id` | `by-id` |
| `systemPrompt` | `flag` | `config` | `config` | `prompt-prefix` |
| `extraDirs` | true | false | true | false |

## Command line

| | Claude Code | opencode | Codex | Cursor CLI |
| --- | --- | --- | --- | --- |
| Binary | `claude` | `opencode` | `codex` | `cursor-agent` (or `agent`) |
| Headless | `-p` | `run` | `exec` | `--print` |
| Machine output | `--output-format stream-json` | `--format json` | `--json` | `--output-format stream-json` |
| Resume | `--resume <id>` | `-s <id>` | `exec resume <id>` | `--resume <chatId>` |
| Extra readable dir | `--add-dir` | none | `--add-dir` | none |
| Non-interactive approvals | `--allowedTools` | `permission` map | `-c approval_policy="never"` | `--trust --approve-mcps` |

## How each one is wired up

| | Mechanism | Touches the user's own config? |
| --- | --- | --- |
| Claude Code | `--mcp-config <file>` written by the bridge | No |
| opencode | `OPENCODE_CONFIG_CONTENT` env, inline JSON per turn | No |
| Codex | `-c mcp_servers.mockflow.url=…` per run | No |
| Cursor CLI | `.cursor/mcp.json` in the turn's working directory | **Writes a project file** (merged, never overwrites other servers) |

Cursor is the one exception. It has no per-run MCP flag and reads project config
before global config, so the bridge writes the server into the directory the turn
runs in. Existing entries in that file are preserved. When `--workspace` points
at one of your repositories, that file lands in the repository.

## Per-turn tool restriction

Component AI (Generate, Modify, Convert) pins a turn to exactly one render tool,
so the result fills the component you are editing instead of drawing something
else.

- **Claude Code**: `--allowedTools mcp__mockflow__render_kanban`
- **opencode**: `tools` map in the per-turn config, `{"*": false, "mockflow_render_kanban": true}`
- **Codex**: `-c mcp_servers.mockflow.enabled_tools=["render_kanban"]`
- **Cursor CLI**: no mechanism exists. The turn's system prompt names the tool
  instead, and the bridge validates the call's arguments before anything is
  drawn, so a wrong call is corrected rather than rendered.

## Event streams

| | Session id | Text | Tool start | Tool end |
| --- | --- | --- | --- | --- |
| Claude Code | `session_id` | `assistant` message content blocks | `content_block_start` (partial stream) | `tool_result`, `is_error` |
| opencode | `sessionID` on every event | `session.next.text.delta` | `session.next.tool.input.started` | `session.next.tool.success` / `.failed` |
| Codex | `thread.started` → `thread_id` | `item.completed`, item type `agent_message` | `item.started` | `item.completed` status |
| Cursor CLI | `system`/`init` → `session_id` | `assistant` message content | `tool_call`/`started` | `tool_call`/`completed` result |

All four are normalized to the same four events (`session`, `text`,
`tool-start`, `tool-end`) in `src/agents/<id>.js`, so nothing above the adapter
knows which CLI produced them.

## Verification status

| Agent | How its behaviour was established |
| --- | --- |
| opencode | Event names and fields read from the installed binary's own OpenAPI document (`opencode serve`, then `GET /doc`) |
| Codex | Envelope confirmed from a real `codex exec --json` run; the MCP tool-call item's exact fields are inferred and handled defensively |
| Claude Code | In production use, all flows exercised |
| Cursor CLI | Documentation only. Not installed here, so no live turn has run |

Anything marked inferred is contained inside one `parseLine` function. If a
first live turn shows different field names, it is a small edit in a single
file, not a change to the bridge.
