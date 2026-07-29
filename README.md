# vibePilot

A local agent orchestrator. You talk to a **Pilot**; it reads your repo, proposes tickets,
hires teammates, and each teammate does its work in an isolated git worktree. Nothing
reaches your base branch until you merge it.

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
  providers/       Spawn + parse the claude CLI. translate.ts is the only file that
                   knows the wire format.
  mcp/             vibePilot's own MCP server. Agents connect to it and use its tools
                   to move tickets, ask questions, and hire each other.
  engine/          Pilot session, teammate launching, turn queue, concurrency.
  git/             Worktrees and local squash-merge.
  db/              node:sqlite + numbered migrations.
src/renderer/      React UI on the "Industry" design system.
src/shared/        Types and the frozen event vocabulary.
```

**The MCP server is the orchestration backbone.** Each spawned agent gets its own bearer
token bound to `{run, agent, project, ticket, role}`. Identity is the header, never a tool
argument — so an agent physically cannot impersonate another or write to a ticket it
doesn't own.

**Worktrees live outside your repo** (`%LOCALAPPDATA%\vibepilot\wt\...`). Windows MAX_PATH
makes nesting them inside fatal the moment a real project installs `node_modules`.

**The Pilot cannot edit files.** It reads, plans and delegates. This single restriction does
more for output quality than any prompt wording.

## What works

- Live Pilot conversation with streaming text and a collapsible tool log
- `propose_ticket` → a draft card you accept or reject; nothing is created behind your back
- Kanban board: Backlog / To do / In progress (Plan · Build · Verify) / Done, plus archive
- `spawn_agent` → a real teammate in its own worktree, on its own branch
- `ask_user` → a blocking question in chat, answered inline
- Comms feed for agent-to-agent messages and shoutouts
- Team view with the four-stage pipeline and role definitions
- Local squash-merge with honest conflict reporting (your repo is left untouched on failure)
- Live cost and rate-limit telemetry from the CLI's own reporting

## What isn't built yet

Codex teammates · GitHub PRs · deploy integration · packaging to an installer · a files
browser · the deeper Settings screens · restart-from-checkpoint (the button's logic; the
session handles are already persisted).

## Notes worth knowing

**Rate limits are the real concurrency cap**, not the slot count. Three Opus agents will
exhaust a five-hour window fast. Models are therefore chosen explicitly per agent with no
default — a silent default is how you stall the board without knowing why.

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

33 tests. The unit tests cover the wire-format translator and the Windows argv quoting; the
two integration suites spawn **real Claude processes** against the real MCP server and
assert that a teammate actually writes code to its branch and that it merges.

The translator tests are the highest-value ones in the project: Claude Code self-updates,
and they are what turns a breaking wire-format change from a mysteriously blank UI into a
failing test.
