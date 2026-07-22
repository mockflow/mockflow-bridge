# Which AI assistant should I use?

MockFlow Bridge works with two assistants: **Claude Code** and **Codex**. Either
one draws on your board, so if you already pay for one, use that one. This page
is for deciding when you have no preference, and for the technical detail behind
the differences.

Everything here was checked against these versions: Claude Code 2.1.216,
Codex 0.145.0.

Only CLIs that have been run end to end against a real board are supported. See
[Why only two](#why-only-two) at the end.

---

# Part 1: What you will notice

## The short answer

| If you want | Use |
| --- | --- |
| The smoothest experience, everything supported | **Claude Code** |
| To use the ChatGPT subscription you already pay for | **Codex** |

## Feature by feature

| | Claude Code | Codex |
| --- | --- | --- |
| Draws on your board | Yes | Yes |
| Edits something already drawn | Yes | Yes |
| Multi-part board plans | Yes | Yes |
| Reply appears word by word | Yes | Arrives in one piece at the end |
| "Drawing…" appears while it works | Yes, while it writes the drawing | Only as the drawing lands |
| Remembers earlier messages | Yes | Yes |
| Reads a folder you point it at | Yes | Yes |
| Attachments (files, images) | Yes | Yes |
| **Web search** | **On** | **Off by default** |
| Connected sources (Notion, Jira, Slack) | Yes | Yes |
| Costs MockFlow AI credits | No | No |

## What the two "in one piece" rows mean

Codex does not stream. It sends each message complete, and it only reports a
tool call once it has finished writing the whole drawing. So on Codex you see a
single "thinking" state for most of the turn, then the drawing appears and the
reply arrives with it. On Claude Code the reply types itself out and the
"Drawing…" row appears early, while the drawing is still being written.

This is a property of the CLIs, not a setting. Neither one loses anything: the
same board is drawn either way.

## What the web search row means

When you ask for something that depends on current facts (live prices, recent
events, real companies), the assistant may look it up first.

- **Claude Code**: searching and page fetching are both switched on for chat
  turns, so it can research before it draws.
- **Codex**: web search defaults to a cached index rather than live browsing.
  Live search is a setting we can turn on per turn, which we currently do not.

Whichever you use, a component that needs real-world data still generates. When
search is unavailable the assistant falls back to what it already knows and
leaves unknown specifics as placeholders rather than inventing them.

## Things that are the same on both

- Nothing you draw costs MockFlow AI credits.
- Your files are never uploaded. Reading and thinking happen on your machine.
- Neither can write to your files or run shell commands from a board turn.
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

| Capability | Claude Code | Codex |
| --- | --- | --- |
| `streamsPartialText` | true | false |
| `textChunks` | `block` | `block` |
| `announcesToolsEarly` | true | true, but only once the arguments are written |
| `restrictTools` | `per-run` | `per-run` |
| `resume` | `by-id` | `by-id` |
| `systemPrompt` | `flag` | `config` |
| `extraDirs` | true | false (read-only sandbox already permits reading) |

A `streamsPartialText: false` agent has its text held back until the turn ends,
so the tab shows one honest "working" state instead of a reply that looks
finished while the drawing is still being written.

## Command line

| | Claude Code | Codex |
| --- | --- | --- |
| Binary | `claude` | `codex` |
| Headless | `-p` | `exec` |
| Machine output | `--output-format stream-json` | `--json` |
| Resume | `--resume <id>` | `exec resume <id>` |
| Extra readable dir | `--add-dir` | not needed |
| Non-interactive approvals | `--allowedTools` | `-c approval_policy="never"` plus `-c mcp_servers.mockflow.default_tools_approval_mode="approve"` |

**Codex flags must survive resume.** `codex exec` and `codex exec resume` do not
accept the same flags: `--sandbox` and `--add-dir` exist only on a fresh `exec`
and make every follow-up message fail with `unexpected argument`. Everything the
adapter sets therefore rides `-c` (including `sandbox_mode`), which both accept.

## How each one is wired up

| | Mechanism | Touches the user's own config? |
| --- | --- | --- |
| Claude Code | `--mcp-config <file>` written by the bridge | No |
| Codex | `-c mcp_servers.mockflow.url=…` per run | No |

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

Both are normalized to the same four events (`session`, `text`, `tool-start`,
`tool-end`) in `src/agents/<id>.js`, so nothing above the adapter knows which CLI
produced them.

## Process handling

Both are spawned with **stdin closed**. No adapter writes to stdin, and a CLI
that finds an open pipe there may wait on it: `codex exec` prints "Reading
additional input from stdin…" and never returns, which looks exactly like the
agent thinking forever.

## Verification status

| Agent | How its behaviour was established |
| --- | --- |
| Claude Code | In production use, all flows exercised |
| Codex | Live turns through the bridge: chat, a resumed second turn, component Generate and Modify, each drawing on a real board |

## Why only two

Adapters for **opencode** and **Cursor CLI** were written from vendor
documentation and shipped without a live turn ever running through them. When
opencode was finally exercised end to end it failed three ways at once: the
event parser matched a schema that `opencode run --format json` does not emit
(so no text, no tool rows, no session id), the per-turn tool map exposed no
board tools at all (so it could never draw), and its file-reading tool was not
confined to the workspace the bridge advertises. Cursor CLI was never installed
or run at all.

Both adapters were removed rather than left in the picker looking supported.
They are in git history (`git show 7ed0f75:src/agents/opencode.js`) and can come
back the moment chat, a resumed turn and a component turn have all been seen
working against a real board.
