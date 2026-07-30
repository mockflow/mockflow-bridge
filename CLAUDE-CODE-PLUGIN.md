# MockFlow Claude Code plugin

Working document. Evaluation, scope, identity decisions and the engineering it
depends on. Written to be handed to an agent as context, so it states things that
are obvious to us but not to a fresh reader.

Status: proposed, nothing built.

---

## 1. Product context

MockFlow is transitioning away from wireframing to the board product only. The
IdeaBoard name is being retired and everything becomes MockFlow. This document
uses MockFlow throughout, and WireframePro is out of scope entirely.

## 2. The one thing to understand first

**A plugin does not replace the bridge. It wraps it.**

- **The bridge is machinery.** `@mockflow/mockflow-bridge`, a program on the
  user's computer connecting an AI to a live board in a browser tab and making
  drawings appear on it. Nothing else can do that job.
- **A plugin is a package.** A folder of files Claude Code installs in one
  command. It can hold a connection config, skills, sub agents, hooks and
  executables. It draws nothing itself.

The plugin's job is to remove setup friction, teach the agent how the bridge's
tool surface fits together, and put MockFlow on a shelf inside Claude Code. The
bridge keeps doing all the actual work, unchanged.

## 3. Locked identity

| Thing | Value | Notes |
| --- | --- | --- |
| Repo | `github.com/mockflow/mockflow-claude-plugin` | precedent: `mintlify/mintlify-claude-plugin`. Cheapest string to change later, GitHub redirects renames |
| Plugin name | `mockflow` | gives `/mockflow:draw`, `/mockflow:connect` |
| MCP server key | `mockflow` | already what `src/agents/claude.js` writes, so no bridge change |
| Marketplace name | **OPEN** | see below |

**The one open decision.** Users install as `<plugin>@<marketplace>`. Marketplace
`mockflow` gives `mockflow@mockflow`, which is redundant but unambiguous.
Marketplace `produle` gives `mockflow@produle`, which splits publisher from
product and never rebrands. Either is defensible. It is the only string that
costs a user migration if changed later, so decide it before first publish.

**Naming evidence.** The curated official marketplace is overwhelmingly bare
lowercase product names: `figma`, `miro`, `canva`, `notion`, `linear`, `stripe`,
`vercel`, `supabase`, `datadog`, `airtable`. All three of MockFlow's closest
competitors are already listed and all use the bare form. The `-plugin` suffix on
a plugin name reads as redundant and is a minority pattern.

## 4. What already exists

| Surface | Gives the AI | Gap |
| --- | --- | --- |
| `@mockflow/ideaboard-mcp` (port 21193 or remote) | tools | user must discover and configure it |
| `@mockflow/mockflow-bridge` (21196 + board WS) | tools, live tab, Mode B chat, connected sources | five step setup, secret token copy paste |
| Mida skill exports in `~/.claude/skills/mockflow-*` | subject matter and taste | unversioned, hardcode schemas, stay out of this plugin |

The friction is one line of the bridge README:

```bash
claude mcp add --transport http -s user mockflow http://127.0.0.1:21196/mcp/<token>
```

A token read off a terminal and pasted into a second command. Highest drop off
step we own.

**Decide before building:** does v1 wire to the bridge, to `ideaboard-mcp`, or
detect which is present? Everything below assumes the bridge.

## 5. The layer line (governs what may go in the plugin)

**The catalog owns the components.** Which exist, what each is for, argument
shapes. Fetched at runtime from
`https://app.mockflow.com/call/api/mcpcatalog/ideaboard` precisely so new
components ship without a release. Never duplicate any of it in the plugin.

**The plugin owns the tool surface.** How the bridge's tools fit together. Not in
the catalog, changes rarely, and it is what agents get wrong today.

> **Rule: plugin skills carry operating knowledge of the tool surface. Never
> component names, lists or argument shapes.**

The existing `mockflow-decision-flowchart` export already breaks this by spelling
out the `nodeDataArray` shape. That is the failure mode to avoid.

**Known inconsistency to settle while here:** that same export declares
`allowed-tools: mcp__ideaboard__render_flowchart`, assuming a server key of
`ideaboard`, while the bridge writes `mockflow`. Tool names are prefixed by the
server key, so the allowlist currently matches nothing on the bridge path.
Standardise on `mockflow` and update the content skills.

## 6. Scope

```
mockflow-claude-plugin/
├── .claude-plugin/
│   └── plugin.json          name: mockflow
├── .mcp.json                -> bin/mockflow-connect (not the bridge binary directly)
├── bin/
│   ├── mockflow-connect     launcher, resolves whichever bridge binary is present
│   └── mockflow-preflight   install / daemon / pairing check
├── hooks/
│   └── hooks.json           SessionStart -> preflight
├── skills/
│   ├── draw/SKILL.md        model-invoked
│   └── connect/SKILL.md     model-invoked + /mockflow:connect
└── README.md
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "mockflow": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/mockflow-connect" }
  }
}
```

**Why the launcher indirection.** Pointing `.mcp.json` at `mockflow-bridge`
by name means a future binary rename silently breaks every installed copy, and
plugin updates are user initiated so no fix can be pushed. The launcher is ours
forever, so a rename becomes two lines inside it.

### skills/draw/SKILL.md

Model-invoked, fires on any visual request. Contains only cross-tool contract:

- `modify_component` edits in place. Re-rendering the same thing duplicates it.
- `plan_board` ends the turn and waits for the user's Generate click. Do not
  continue past it.
- `read_board` first when changing something that already exists.
- `select_board` when more than one tab is connected, otherwise draws land on the
  focused one.
- `layout_board` after a batch, not after each item.
- Multi part boards go through `plan_board`, never a loop of render calls.

Banned from this file: component names, component lists, argument shapes.

### skills/connect/SKILL.md

Pairing, status, which board is targeted, what to do when the tab is not
connected or the daemon is not running. Pure operations, no drift exposure.

Scope both with `allowed-tools` so `connect` cannot draw and `draw` is not pulled
in for a status question.

### Explicitly out

The Mida content skills (`decision-flowchart`, `influencer-content-calendar`,
`retro-windows-98` and the rest). They are subject matter, they come from the
Mida skills system, and keeping them out means the plugin never needs a release
when a Mida skill changes.

No `agents/`. Drawing quality lives in the catalog's `mcpDescription`.

## 7. Critical path

**Everything the plugin delivers rests on one bridge change.**
`mockflow-bridge stdio` currently shims to an *already running* daemon. It must
launch one if none is up, and that daemon must survive without a foreground
terminal window. Without this the plugin buys almost nothing, because the user is
back to keeping a window open.

**Build and test that first, before any plugin file exists.**

Secondary, nice to have: a pairing deep link so the user clicks instead of
retyping a six digit code.

## 8. The user flow it produces

**First time, about ninety seconds.**

```
/plugin marketplace add mockflow/mockflow-claude-plugin
/plugin install mockflow@<marketplace>
```

Claude tries to connect, finds no helper, and the preflight hook says so in plain
English rather than throwing an error. User approves
`npm i -g @mockflow/mockflow-bridge`. Daemon starts in the background, no
terminal to keep open. Claude prints a pairing code, the user enters it on their
board. Never repeated.

**Everyday.** In their repo, no slash command needed:

> draw me a flowchart of what happens when a payment fails, based on the code in src/payments/

Claude reads the real source locally, the code never leaves the machine, the
flowchart draws itself on the board.

> the timeout branch should loop back to retry, not exit

Edited in place. **This is `skills/draw` earning its place**, since the default
behaviour is to render a second overlapping diagram.

> now build out the full review board: this flowchart, a sequence of the webhook retries, and a table of the failure codes

Three items proposed, turn ends, user picks two and clicks Generate. Again the
skill, routing multi part work through `plan_board` instead of three loose render
calls scattered on the canvas.

**Afterwards.** The board is shared as an ordinary MockFlow board. A PM opens it
in a browser, drags things, leaves a comment. No plugin, no terminal, no
awareness that any of it was generated.

## 9. What it is worth, and what it is not

**Worth it.** Install collapses from seven steps to one command plus a pairing
code. A marketplace listing is a shelf inside Claude Code that npm does not give
you. And the local-first story is genuinely differentiated: `figma`, `miro` and
`canva` are all on that same shelf and none of them can read a private repo on
the user's laptop. That belongs in the first sentence of the plugin description,
because that is the part that gets read.

**Not worth overstating.** It does not remove the daemon requirement, only hides
it. It is Claude Code only, so author the skill content in a neutral source and
export it rather than writing it Claude first, since `src/agents/index.js` treats
Claude, Codex, opencode and BridgeAI as peers. And bridge usage spends the user's
own AI rather than MockFlow credits by design, so this is a growth channel and
not revenue.

## 10. Build notes

- Only `plugin.json` goes inside `.claude-plugin/`. Every other directory sits at
  the plugin root. Putting `skills/` or `hooks/` inside it is the common mistake.
- Verify `${CLAUDE_PLUGIN_ROOT}` against the current plugins reference before
  relying on it.
- Test with `claude --plugin-dir ./mockflow-claude-plugin`, reload with
  `/reload-plugins`, validate with `claude plugin validate` before submitting.
- Community submission pins to a commit SHA and CI bumps the pin as you push,
  which is one more reason this lives in its own repo rather than inside
  `mockflow-bridge`.

## 11. Risks

- **Schema drift**, see §5. The most likely way this rots.
- **Agent lock in.** Keep content neutral and export it.
- **Marketplace review.** The plugin installs and runs a local daemon, so expect
  scrutiny of the preflight hook and the install prompt. Keep both visible and
  never silent.
- **Maintenance surface.** Two good skills beat twenty thin ones.
