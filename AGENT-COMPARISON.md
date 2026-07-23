# Which AI assistant should I use?

MockFlow Bridge works with three assistant apps &mdash; **Claude Code**,
**Codex** and **opencode** &mdash; plus **BridgeAI**, a fourth option built into
the bridge that uses an API key instead of a separate app. Any of them draws on
your board, so if you already pay for one of the apps, use that one; if you have
none, BridgeAI is the quickest start. This page is for deciding when you have no
preference, and for the technical detail behind the differences.

Parts 1 and 2 compare the three assistant **apps** in depth, since each was run
end to end against a real board. **BridgeAI** is summarised separately under
[BridgeAI, the built-in option](#bridgeai-the-built-in-option): it is our own
runner rather than an external CLI, so what it can do depends on the model and
provider you point it at.

Everything about the three apps was checked against these versions: Claude Code
2.1.216, Codex 0.145.0, opencode 1.18.4.

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
| To start without installing an assistant app (bring an API key) | **BridgeAI** |

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
| Fetch a web page you name | Yes | Yes | Yes |
| General web search (no URL) | Yes, live | Yes, live | No, fetch only |
| Choose your own model | No | No | **Yes** |
| Connected sources (Notion, Jira, Slack) | Yes | Yes | Yes |
| Costs MockFlow AI credits | No | No | No |

**BridgeAI** is not a column above because its abilities follow the model you
choose rather than a fixed CLI. What is constant: its reply streams in word by
word (like Claude Code), it uses the same board tools to draw and edit, it
remembers earlier messages, and it never costs MockFlow AI credits. Web search
and how attachments are handled depend on the provider and model you point it at.
See [BridgeAI, the built-in option](#bridgeai-the-built-in-option).

## What the two "in one piece" rows mean

Codex and opencode do not stream. They send each message complete, and report a
tool call only once the whole drawing has been written. So on those two you see
a single "thinking" state for most of the turn, then the drawing appears and the
reply arrives with it. On Claude Code the reply types itself out and the
"Drawing…" row appears early, while the drawing is still being written.

This is a property of the CLIs, not a setting. Nothing is lost either way: the
same board is drawn.

## What the two web rows mean

When you ask for something that depends on current facts (live prices, recent
events, real companies), the assistant may look it up first. There are two
different abilities here, and they were tested by giving each agent a real turn.

**Fetching a page you name** works on all three. Given a URL, each one retrieves
it and reads the content (Claude Code's `WebFetch`, opencode's `webfetch`, and
Codex's built-in fetch).

**General web search - finding pages without a URL - differs:**

- **Claude Code**: has a live `WebSearch` tool, on for chat turns. Asked for a
  current fact it searches and returns sources.
- **Codex**: also searches the live web. Its `exec` stream shows a `web_search`
  item running, and it returns current facts with sources (verified by asking
  for today's date, which it got right). This is Codex's own built-in search, on
  by default - the bridge does not have to enable it.
- **opencode**: has no general search tool in a bridge turn, only page fetch.
  Asked to search, it says so rather than guessing.

(How this was established: the bridge's chat timeline only shows MockFlow tools,
so an agent's own web tool never appears there. Whether a CLI searched was read
from its raw event stream - Claude's `WebSearch`, Codex's `web_search` item -
not from the bridge's step rows.)

Whichever you use, a component that needs real-world data still generates. When
search is unavailable the assistant falls back to what it already knows and
leaves unknown specifics as placeholders rather than inventing them.

## Which model answered

`mockflow-bridge status` and the editor show the model that generated the last
turn, when the CLI reveals it:

- **Claude Code**: named in its JSON stream, so it is always known and exact.
- **opencode**: read from its `--print-logs` output (the `agent=mfbridge` line),
  so it shows whatever model your opencode is configured to use.
- **Codex**: not reported. Its `exec --json` stream carries no model field and
  there is no log flag that prints one, so the bridge leaves it blank rather than
  guess.

The value updates after each turn and rides the `agent-info` frame and
`chat-done`/`compgen-done`, so the editor can label a drawing with the model
that made it.

## Things that are the same on all three

- Nothing you draw costs MockFlow AI credits.
- Your files are never uploaded. Reading and thinking happen on your machine.
- None of them can write to your files or run shell commands from a board turn.
- Connected sources are fetched by MockFlow, because your Notion or Jira login
  lives in your MockFlow account, and they are read only: an assistant cannot
  post to Slack or create a ticket on your behalf.
- Concept Builder conversations are stored in your MockFlow account, so a
  builder remembers across sessions and your teammates see the same chat.

## BridgeAI, the built-in option

BridgeAI comes with the bridge, so there is no separate app to install or sign
into. Instead it connects to an AI provider with an **API key** you supply, and
you choose which model answers. It is the quickest way to start if you don't
already use one of the three apps above.

- **Providers:** OpenRouter (easiest &mdash; one key, many models, a sensible
  default is picked for you), Azure OpenAI, and Amazon Bedrock. Set the key, then
  pick a model with `mockflow-bridge bridgeai model`. Full setup is in the
  [README](README.md#using-bridgeai-no-app-to-install).
- **What stays constant:** the reply streams in word by word, it draws and edits
  on your board with the same tools, it remembers earlier messages, and it costs
  no MockFlow AI credits.
- **What depends on your choice:** whether the model can search the web, how well
  it writes wireframe HTML, and its speed and quality all follow the model and
  provider you point it at, not the bridge.
- **Under the hood** it is our own runner speaking the OpenAI chat-completions
  protocol, and it emits the same normalized events (`session`, `text`,
  `tool-start`, `tool-end`) the three CLI adapters do, locked by the startup
  self-test in `src/agents/health.js`.

---

# Part 2: Technical comparison

## Adapter capabilities

These are the flags each adapter declares, which is what the orchestrator adapts
to. Anything not supported has a fallback, so the feature degrades rather than
breaking.

| Capability | Claude Code | Codex | opencode | BridgeAI |
| --- | --- | --- | --- | --- |
| `streamsPartialText` | true | false | false | true |
| `textChunks` | `block` | `block` | `block` | `delta` |
| `announcesToolsEarly` | true | only once the arguments are written | false | true |
| `restrictTools` | `per-run` | `per-run` | `per-run` | `per-run` |
| `resume` | `by-id` | `by-id` | `by-id` | `by-id` |
| `systemPrompt` | `flag` | `config` | `config` | `config` |
| `extraDirs` | true | false (read-only sandbox already permits reading) | false (attachments go through `-f` instead) | false (attachments read and inlined directly) |

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
| BridgeAI | Our own OpenAI chat-completions runner; the normalized event contract it emits is locked by the startup self-test (`src/agents/health.js`). It uses the same board tools as the CLIs, but is not benchmarked per-feature here because behaviour follows the chosen model, not a fixed CLI. |

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
