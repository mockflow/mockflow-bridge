# Which AI assistant should I use?

MockFlow Bridge works with three assistants: **Claude Code**, **Codex** and
**opencode**. Any of them draws on your board, so if you already pay for one,
use that one. This page is for deciding when you have no preference, and for the
technical detail behind the differences.

Everything here was checked against these versions: Claude Code 2.1.216,
Codex 0.145.0, opencode 1.18.4.

Only CLIs that have been run end to end against a real board are supported - see
[How support is added](#how-support-is-added) at the end.

---

# Part 1: What you will notice

## The short answer

| If you want | Use |
| --- | --- |
| The smoothest experience, everything supported | **Claude Code** |
| To use the ChatGPT subscription you already pay for | **Codex** |
| To choose your own model, or run one locally | **opencode** |

## Feature by feature

| | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| Draws on your board | Yes | Yes | Yes |
| Edits something already drawn | Yes | Yes | Yes |
| Multi-part board plans | Yes | Yes | Yes |
| Reply appears word by word | Yes | Arrives in one piece at the end | Arrives in one piece at the end |
| "Drawing…" appears while it works | Yes, while it writes the drawing | Only as the drawing lands | Only as the drawing lands |
| Remembers earlier messages | Yes | Yes | Yes |
| Reads a folder you point it at | Yes | Yes | Yes |
| Attachments (files, images) | Yes | Yes | Yes |
| **Web search** | **On** | **Off by default** | Fetch only, depends on your setup |
| Choose your own model | No | No | **Yes** |
| Connected sources (Notion, Jira, Slack) | Yes | Yes | Yes |
| Costs MockFlow AI credits | No | No | No |

## What the two "in one piece" rows mean

Codex and opencode do not stream. They send each message complete, and report a
tool call only once the whole drawing has been written. So on those two you see
a single "thinking" state for most of the turn, then the drawing appears and the
reply arrives with it. On Claude Code the reply types itself out and the
"Drawing…" row appears early, while the drawing is still being written.

This is a property of the CLIs, not a setting. Nothing is lost either way: the
same board is drawn.

## What the web search row means

When you ask for something that depends on current facts (live prices, recent
events, real companies), the assistant may look it up first.

- **Claude Code**: searching and page fetching are both switched on for chat
  turns, so it can research before it draws.
- **Codex**: web search defaults to a cached index rather than live browsing.
  Live search is a setting we can turn on per turn, which we currently do not.
- **opencode**: it can fetch a page you name, but general web search depends on
  what you have configured in opencode itself.

Whichever you use, a component that needs real-world data still generates. When
search is unavailable the assistant falls back to what it already knows and
leaves unknown specifics as placeholders rather than inventing them.

## Things that are the same on all three

- Nothing you draw costs MockFlow AI credits.
- Your files are never uploaded. Reading and thinking happen on your machine.
- None of them can write to your files or run shell commands from a board turn.
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

| Capability | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| `streamsPartialText` | true | false | false |
| `textChunks` | `block` | `block` | `block` |
| `announcesToolsEarly` | true | only once the arguments are written | false |
| `restrictTools` | `per-run` | `per-run` | `per-run` |
| `resume` | `by-id` | `by-id` | `by-id` |
| `systemPrompt` | `flag` | `config` | `config` |
| `extraDirs` | true | false (read-only sandbox already permits reading) | false (attachments go through `-f` instead) |

A `streamsPartialText: false` agent has its text held back until the turn ends,
so the tab shows one honest "working" state instead of a reply that looks
finished while the drawing is still being written.

## Command line

| | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| Binary | `claude` | `codex` | `opencode` |
| Headless | `-p` | `exec` | `run` |
| Machine output | `--output-format stream-json` | `--json` | `--format json` |
| Resume | `--resume <id>` | `exec resume <id>` | `-s <id>` |
| Extra readable dir | `--add-dir` | not needed | none |
| Non-interactive approvals | `--allowedTools` | `-c approval_policy="never"` plus `-c mcp_servers.mockflow.default_tools_approval_mode="approve"` | `permission` map in the per-turn config |

**opencode takes its directory from PWD**, not from the process's working
directory. The adapter sets it when spawning; without that, a turn runs in
whatever directory the daemon was started in, reads that project's files and
ignores `--workspace` entirely.

**Codex flags must survive resume.** `codex exec` and `codex exec resume` do not
accept the same flags: `--sandbox` and `--add-dir` exist only on a fresh `exec`
and make every follow-up message fail with `unexpected argument`. Everything the
adapter sets therefore rides `-c` (including `sandbox_mode`), which both accept.

## How each one is wired up

| | Mechanism | Touches the user's own config? |
| --- | --- | --- |
| Claude Code | `--mcp-config <file>` written by the bridge | No |
| Codex | `-c mcp_servers.mockflow.url=…` per run | No |
| opencode | `OPENCODE_CONFIG_CONTENT` env, inline JSON per turn | No |

opencode reaches the bridge over **stdio** (`mockflow-bridge stdio`), not over
the HTTP endpoint the other two use. A `type: "remote"` server pointed at the
bridge's URL is rejected before a socket is opened - opencode logs
`server unavailable key=mockflow type=remote status=failed` and the turn simply
has no board tools. The stdio shim is a documented bridge feature, so this costs
nothing.

Codex also needs two things switched **off** per run, or a turn can draw
somewhere else entirely:

- `-c features.apps=false` — Codex ships built-in app connectors (server
  `codex_apps`), including a hosted MockFlow IdeaBoard app whose render tools
  look identical to the bridge's. Left on, a turn may call that one: it reports
  success, and the board in front of the user never changes.
- `-c mcp_servers.<name>.enabled=false` for every server in the user's own
  `~/.codex/config.toml` (enumerated once via `codex mcp list --json`), for the
  same reason. Model, provider and auth settings are left alone.

## Per-turn tool restriction

Component AI (Generate, Modify, Convert) pins a turn to exactly one render tool,
so the result fills the component you are editing instead of drawing something
else.

- **Claude Code**: `--allowedTools mcp__mockflow__render_kanban`
- **Codex**: `-c mcp_servers.mockflow.enabled_tools=["render_kanban"]`
- **opencode**: `tools` map in the per-turn config, `{"*": false, "mockflow_render_kanban": true}`.
  The names must be exact - `"mockflow_*"` is not a pattern it honours, and with
  the deny-all default a wildcard leaves the turn with no board tools at all.

"Exactly once" means one *successful* call. The turn's instructions say so
explicitly, because a strict agent otherwise treats a call rejected for
malformed arguments as its one attempt and ends having drawn nothing. The
instructions also name each tool's top-level argument names, read from the
catalog schema, so the first attempt is usually right.

## Event streams

| | Session id | Text | Tool start | Tool end |
| --- | --- | --- | --- | --- |
| Claude Code | `session_id` | `assistant` message content blocks | `content_block_start` (partial stream) | `tool_result`, `is_error` |
| Codex | `thread.started` → `thread_id` | `item.completed`, item type `agent_message` | `item.started` | `item.completed` status |
| opencode | `sessionID` on every event | `text` event, `part.text` | `tool_use` event, `part.tool` | same event, `part.state.status` |

All three are normalized to the same four events (`session`, `text`,
`tool-start`, `tool-end`) in `src/agents/<id>.js`, so nothing above the adapter
knows which CLI produced them.

Note the opencode row: these are the events `opencode run --format json`
actually emits. They are NOT the `session.next.*` events in `opencode serve`'s
OpenAPI document, which an earlier version of the adapter was written against -
see below.

## Process handling

Both are spawned with **stdin closed**. No adapter writes to stdin, and a CLI
that finds an open pipe there may wait on it: `codex exec` prints "Reading
additional input from stdin…" and never returns, which looks exactly like the
agent thinking forever.

## Verification status

| Agent | How its behaviour was established |
| --- | --- |
| Claude Code | In production use, plus the full battery: chat, resumed turn, component Generate and Modify, in-place edit, attachment |
| Codex | Full battery, live, after four adapter fixes (stdin, tool approval, resume flags, app connectors) |
| opencode | Full battery, live, after the adapter was rewritten from observed events, including attachments (via `-f`, the prompt kept before the flag) |

## How support is added

An adapter is not finished when it compiles. The first opencode adapter was
written from vendor documentation - `opencode serve`'s OpenAPI document, while
the bridge invokes `opencode run --format json` - and shipped looking complete.
It failed on every flow: the event parser matched a schema that CLI never
emits, the tool allowlist used a wildcard opencode does not honour so a turn had
no board tools, and the MCP server was declared `type: "remote"` against an
endpoint opencode refuses to dial. None of that was visible from the docs.

So a CLI joins `src/agents/` only after all of these have been seen working
against a real board, using the harnesses in `test/`:

| Flow | Harness |
| --- | --- |
| Chat turn that draws | `test/fake-chat.js` |
| A resumed second turn | run `fake-chat.js` again on the same board |
| Component Generate | `test/fake-compgen.js` |
| Edit what is already drawn | `test/fake-modify.js` |
| Attachments | `test/fake-attach.js` |

`test/fake-modify.js` and `test/fake-attach.js` exist because their flows were
each broken in a way the other harnesses reported as a pass.
