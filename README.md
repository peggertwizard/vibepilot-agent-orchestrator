# vibePilot

A desktop agent orchestrator for Windows.

You talk to a **Pilot**. It reads your repository, proposes tickets, and hires teammates —
each working in its own isolated git worktree. Nothing reaches your base branch until you
merge it.

**[Download the latest version →](../../releases/latest)**

Run `vibePilot Setup <version>.exe`. After that the app updates itself: it checks in the
background, downloads quietly, and installs when you next close it. Your projects, tickets and
history live outside the application folder and are never touched by an update. A portable
`.exe` is also published for trying it without installing — note that the portable build cannot
update itself.

Requires [Claude Code](https://claude.com/claude-code), installed and signed in, plus `git`.
The app checks both on launch and tells you what is missing.

## How it talks to Claude

vibePilot **spawns your own `claude` binary as a subprocess** and speaks NDJSON to it. It never
reads, stores or transmits your credentials — Claude Code authenticates itself, exactly as it
does in a terminal.

This is deliberate and load-bearing. Anthropic does not permit subscription OAuth tokens to be
used with the Agent SDK or third-party tools; that path requires API-key billing. See
[docs/architecture/auth.md](docs/architecture/auth.md). `npm run compliance` fails the build if
the Agent SDK ever appears in the dependency tree.

## Routes, not a pipeline

Most tools that run coding agents impose one sequence on every task: plan, build, test, verify,
repeat. That is wrong for a typo and wrong for a question.

vibePilot proposes a **route per ticket**. Most tickets are a single build step. A question is
research and never touches code. Only risky or visual work earns a separate review pass, and a
failed review sends the ticket back to the *same* teammate — context intact — rather than
starting someone new.

## Architecture

```
src/main/          Electron main — the engine
  providers/       Spawn + parse the claude CLI. translate.ts is the only file that
                   knows the wire format.
  mcp/             vibePilot's own MCP server. Agents connect to it and use its tools
                   to move tickets, ask questions, and hire each other.
  engine/          Pilot session, teammate launching, turn queue, concurrency.
  memory/          Markdown files as truth, SQLite FTS as a derived index.
  git/             Worktrees and local squash-merge.
  db/              node:sqlite + numbered migrations.
src/renderer/      React UI on the "Industry" design system.
src/shared/        Types and the frozen event vocabulary.
```

**The MCP server is the orchestration backbone.** Each spawned agent gets its own bearer token
bound to `{run, agent, project, ticket, role}`. Identity is the header, never a tool argument —
so an agent physically cannot impersonate another or write to a ticket it does not own.

**Worktrees live outside your repo.** Windows `MAX_PATH` makes nesting them inside fatal the
moment a real project installs `node_modules`.

**The Pilot cannot edit files.** It reads, plans and delegates. This single restriction does
more for output quality than any prompt wording.

**Memory is files.** Project knowledge lives in markdown inside your repo — diffable,
reviewable, editable by hand. The search index is derived from those files and can be rebuilt
from them at any time; it is never the source of truth.

## Trust

A project folder can contain its own `.claude/settings.json`, and that file can run commands
whenever an agent starts. Interactive Claude Code shows a trust dialog the first time you open
a directory; headless spawning never gets one, so vibePilot is the gate instead — it **ignores
a folder's settings unless you mark that folder trusted**, in Settings.

Leave it off for any repository you did not write yourself.

## Things worth knowing

**Rate limits are the real concurrency cap**, not the slot count. Models are chosen explicitly
per agent with no default, because a silent default is how you stall the board without knowing
why.

**Worktree isolation is not a sandbox.** With `bypassPermissions`, Claude Code confines
`Write`/`Edit` to the worktree, but `Bash` is unconstrained. Fine for your own repos on your own
machine; do not mistake it for containment.

**A Claude session is bound to the directory it was created in.** `--resume` from a different
cwd fails, so a worktree must never be deleted while its agent is still resumable — the cleanup
path refuses to remove a dirty worktree and never forces.

**Stopping an agent kills it.** stdin interrupt does not work in Claude Code 2.1.220 (verified —
see [docs/architecture/00-spikes.md](docs/architecture/00-spikes.md)), so "Stop" means killing
the process tree and losing the in-flight turn.

## Development

```bash
npm install
npm run dev

npm test          # 230 tests
npm run typecheck
npm run compliance
npm run dist      # installers into dist/
```

The two integration suites spawn **real Claude processes** against the real MCP server and
assert that a teammate actually writes code to its branch and that it merges. The translator
tests are the highest-value ones in the project: Claude Code self-updates, and they are what
turns a breaking wire-format change from a mysteriously blank UI into a failing test.

`docs/architecture/` records behaviour verified against the shipped CLI rather than assumed.
Several of the stranger decisions in this codebase exist because of what is written there.

## Licence

Not yet chosen. Until one is added, the usual default applies: the source is readable here, but
no rights to use, copy or redistribute it are granted.
