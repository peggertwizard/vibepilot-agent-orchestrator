# Working on a project that lives somewhere else

*"working via SSH in projects needs to somehow be possible"*

Plan 27 offers three architectures and recommends measuring the cheapest one before building
anything, **because it may end the plan**. This records what the measurement found.

## What the code assumes today

Verified by reading, not guessed:

| | |
|---|---|
| `paths.ts:19` | the SQLite file — a real local descriptor, and it stays local |
| `paths.ts:23` | **worktrees live under `LOCALAPPDATA`, not beside the project** |
| `git/worktree.ts` | every git command runs via `execFile` in a local cwd |
| `providers/process/spawn.ts` | `spawn()` a local binary |

There is no transport seam anywhere. Nothing takes a "where does this run" parameter.

The third row is the interesting one and it was not obvious until the spike was written. A
worktree under `LOCALAPPDATA` for a project on a mount is a **local working tree pointing at a
remote object store** — `.git` in a worktree is a file containing a path back to the original
repository. So the files an agent edits are local and fast, and every `git status`, `git diff`
and `git commit` still crosses the network. That split is why the mount option is worth
measuring rather than dismissing: the expensive half is already local by accident.

## The measurement

`scripts/spikes/remote-path.mjs <path>` times the operations vibePilot actually performs, in
the order it performs them, ending with a real `git worktree add` — which is what starting a
ticket costs.

**Local baseline**, this repository, warm cache:

```
  stat the folder                                  0 ms
  list the top level                               0 ms
  git rev-parse --show-toplevel                   30 ms
  git status --porcelain                          32 ms
  git rev-list --count HEAD                       47 ms
  git log -50 --oneline                           49 ms
  git diff --name-only HEAD~1                     37 ms
  git worktree add (a real ticket start)         227 ms
  git status inside the worktree                  70 ms
  git worktree remove                             81 ms
  ─────────────────────────────────────────────────────
  total                                          574 ms
```

**Over a mount: not yet measured.** This needs a real remote host, and stating a number for
one that was never run would be worse than stating none. Run the same script against the same
project over sshfs or an SMB share and add the column.

Read it as:

- **under ~2×** — option (b) works, and plan 27 collapses into a settings note
- **around 5×** — usable for small tickets, painful for large ones
- **past ~10×, or `worktree add` fails** — the SSH runner is the only honest answer

## What has been done pending that

Nothing speculative. Option (a) touches every part of the process layer and plan 27 explicitly
says not to build it on spec.

What *has* shipped is honesty at the point of choosing: adding a project on a UNC or mapped
network path now says plainly that it will work and will be slower, and points at the spike.
Silently accepting the path and letting the user discover it through a slow ticket would be
the same shape of problem as a board that reports finished work as in progress.

## The questions that still have no answer

These are decisions, not unknowns to be measured, and they are what makes option (a) large:

- **Authentication.** Claude Code on the remote must be signed in as the user. vibePilot's
  whole compliance story is that it never touches your credentials — running the CLI on a
  machine you authenticated separately is arguably fine, but it is a promise worth restating
  deliberately rather than sliding past.
- **The MCP bridge.** The server binds localhost with a per-run bearer token. A remote agent
  reaching it means a reverse tunnel, or binding wider — which weakens a boundary that was
  chosen on purpose.
- **Where the worktree lives** — remote (fast for the agent, invisible to you) or local (the
  reverse). The spike shows the current answer is already "local", which may be the right one.
- **A dropped connection mid-turn.** Today a dead process is a stalled agent, and there is now
  a restart for it. Over SSH that stops being rare, so "restart" would need to be automatic
  rather than a button.
