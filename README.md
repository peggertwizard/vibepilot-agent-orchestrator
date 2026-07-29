# vibePilot

A local agent orchestrator. You talk to a **Pilot**; it reads your repo, proposes tickets,
hires teammates, and each teammate does its work in an isolated git worktree. Finished work
squash-merges into your base branch on its own and says so. Nothing is ever pushed or
deployed without you pressing the button.

```bash
npm install
npm run dev
```

Requires [Claude Code](https://claude.com/claude-code) installed and signed in, plus `git`.
The app checks both on launch and tells you what's missing.

## How it talks to Claude

vibePilot **spawns your own `claude` binary as a subprocess** and speaks NDJSON to it. It
never reads, stores or transmits your credentials — Claude Code authenticates itself, the
same way it does in a terminal.

This is deliberate and load-bearing. Anthropic does not permit subscription OAuth tokens to
be used with the Agent SDK or third-party tools; that path requires API-key billing. See
[docs/architecture/auth.md](docs/architecture/auth.md). `npm run compliance` fails the build
if the Agent SDK ever appears in the dependency tree.

## Architecture

```
src/main/          Electron main — the engine
  providers/       Spawn + parse the claude CLI (and codex). translate.ts is the only
                   file that knows the wire format.
  mcp/             vibePilot's own MCP server. Agents connect to it and use its tools
                   to move tickets, ask questions, and hire each other.
  engine/          Pilot session, teammate launching, routing, gates, turn queue,
                   concurrency, merging, previews, deploys.
  git/             Worktrees, branch reporting, local squash-merge.
  memory/          Markdown files on disk, indexed for search. The files are the truth.
  db/              node:sqlite + numbered migrations.
src/renderer/      React UI on the "Industry" design system.
src/shared/        Types, the frozen event vocabulary, and board.ts — where a ticket
                   belongs is derived from facts, never stored.
```

**The MCP server is the orchestration backbone.** Each spawned agent gets its own bearer
token bound to `{run, agent, project, ticket, role}`. Identity is the header, never a tool
argument — so an agent physically cannot impersonate another or write to a ticket it
doesn't own.

**Worktrees live outside your repo** (`%LOCALAPPDATA%\vibepilot\wt\...`). Windows MAX_PATH
makes nesting them inside fatal the moment a real project installs `node_modules`.

**The Pilot cannot edit files.** It reads, plans and delegates. This single restriction does
more for output quality than any prompt wording.

**Where a ticket sits is derived, not stored.** `shared/board.ts` is one pure function from
facts to column. A stored lane is a cache with no invalidation, and six writers disagreeing
about it is how the board came to lie about finished work.

**`.vibepilot/` is the app's own bookkeeping, never your work.** Memory files change on
every turn, so a merge that counted them as "your unsaved changes" would park for ever.
They are committed under one standard message and never appear in a diff you are asked
about.

## What works

- Live Pilot conversation with streaming text and a collapsible tool log
- **One proposal tray** — drafts, routes, splits and hires all wait in the same place,
  reachable from Board and Messages, so answering somewhere answers everywhere
- **One press to create and start** a ticket: summary first, the full brief behind a
  disclosure, the phase strip showing who does what with which model
- Kanban board: Backlog / To do / In progress / Waiting for you / Done, plus archive —
  a blocked card names the ticket it is waiting for
- Per-ticket routes with **sign-off gates**: the plan phase runs immediately, the build
  waits for you, and the plan document is on the card when you decide
- **Auto-start** (off / one at a time / always) and **auto-merge** (off / on green checks /
  always), per project
- **One branch per thing that must land together** — a dependency chain shares one
  worktree and merges once; unrelated work stays properly separate
- `spawn_agent` → a real teammate in its own worktree, on its own branch
- `ask_user` → a blocking question in chat, answered inline
- Memory as markdown files on disk, searchable, curated between runs
- Comms feed, team roster, per-role effort and model defaults
- Local squash-merge with honest conflict reporting (your repo is left untouched on
  failure), plus previews and a gated deploy step
- Live cost and rate-limit telemetry from the CLI's own reporting
- Packaged Windows installer with auto-update

## What isn't built yet

GitHub PRs · a files browser · restart-from-checkpoint (the button's logic; the session
handles are already persisted). The Codex adapter exists but is not a first-class teammate.

## Notes worth knowing

**Rate limits are the real concurrency cap**, not the slot count. Three Opus agents will
exhaust a five-hour window fast. Every route card shows the model and effort for each phase
before you press anything, and changing one there applies **to that step only** — a choice
made for one hard ticket must not quietly become a teammate's setting for ever.

**Worktree isolation is not a sandbox.** With `bypassPermissions`, Claude Code confines
`Write`/`Edit` to the worktree, but `Bash` is unconstrained. Fine for your own repos on your
own machine; don't mistake it for containment.

**A Claude session is bound to the directory it was created in.** `--resume` from a
different cwd fails. So a worktree must never be deleted while its agent is still
resumable — the cleanup path refuses to remove a dirty worktree, and never forces.

**Stopping an agent kills it.** stdin interrupt does not work in Claude Code 2.1.220
(verified — see [docs/architecture/00-spikes.md](docs/architecture/00-spikes.md)), so "Stop"
means killing the process tree and losing the in-flight turn.

## Tests

```bash
npm test
```

That runs `vitest run` — the whole suite once, no watcher. **327 tests across 35 files**,
about 80 seconds, because a few of them are real.

Most are ordinary unit tests over the engine: board placement, routing and gates, merge
decisions, branch grouping, the machine-owned file classification, migrations, memory. Three
are **integration suites that spawn real Claude processes** against the real MCP server and
assert that a teammate actually writes code to its branch and that it merges. Those need
Claude Code signed in, and they share one account — which is why `fileParallelism` is off.

The translator tests are the highest-value ones in the project: Claude Code self-updates,
and they are what turns a breaking wire-format change from a mysteriously blank UI into a
failing test.
