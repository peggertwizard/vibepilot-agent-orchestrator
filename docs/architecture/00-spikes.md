# Step 0 — architecture spikes

Run 2026-07-28 against `claude.exe` **2.1.220** at `C:\Users\you\.local\bin\claude.exe`.
Scripts: `scripts/spikes/`. Re-run them after any Claude Code update — the CLI self-updates and
the translator is pinned to observed wire shapes.

## Results

| # | Question | Result |
|---|---|---|
| 1 | Does `server.listen(0, '127.0.0.1')` trigger a Windows Firewall prompt? | **PASS** — silent. Explicit loopback bind only; never `0.0.0.0`/`::`. |
| 2 | Can a spawned `claude` reach an in-process HTTP MCP server? | **PASS** — `system/init.mcp_servers = [{"name":"vibepilot","status":"connected"}]` |
| 2a | Is the `headers` key in inline `--mcp-config` honoured? | **PASS** — `Authorization: Bearer …` arrived intact. Per-run token auth works. |
| 2b | Does a `tools/call` actually land? | **PASS** — round-tripped `ping_vibepilot`, result returned to the model. |
| 3 | Does `--allowedTools "mcp__vibepilot__*"` accept a wildcard? | **PASS** — tool exposed as `mcp__vibepilot__ping_vibepilot`. |
| 4 | Is a pre-minted `--session-id` honoured? | **PASS** — `system/init.session_id` equals the UUID we passed. |
| 4a | Does `--resume` work from a *different process*, same cwd? | **PASS** — context carried across processes. |
| 4b | Does `--resume` work from a **different cwd**? | ❌ **FAIL** — `No conversation found with session ID: …` |
| 5 | Does `--append-system-prompt-file` exist? | **PASS** — exists and works. |

Observed MCP protocol version negotiated by the CLI: **`2025-11-25`**. Echo the client's
`protocolVersion` back rather than hardcoding.

## Consequences for the design

**Sessions are cwd-bound (4b).** This is the most important finding of the spike.

- An agent's worktree **must not be deleted while that agent is resumable**. Deleting it
  destroys the `--resume` handle permanently.
- `engine/reaper.ts` may mark an agent `stalled` and offer restart-from-checkpoint, but must
  **never** prune the worktree of an agent in a resumable state. Only prune worktrees whose
  ticket is `merged` or explicitly discarded.
- The worktree path is therefore part of an agent's identity, not a scratch location.

**`--append-system-prompt-file` exists (5).** Long composed prompts (project identity + pilot.md
+ rules + board summary + roster + tool contract) go to
`%LOCALAPPDATA%\vibepilot\runs\<runId>\system.md` rather than argv. This removes the 32,767-char
Windows `CreateProcess` command-line ceiling as a design constraint.

**HTTP MCP is confirmed viable (1, 2).** No stdio bridge needed: no extra `node.exe` per agent,
no asar-unpack problem, no orphan bridge processes. One `http.createServer` on loopback, identity
carried in a header.

## Storage decision (not a spike, but decided here)

`better-sqlite3` failed to install — it needs Visual Studio build tools, which are not present,
and would need an Electron ABI rebuild on top.

**Electron 43.2.0 ships Node 24.18.0, which has a stable `node:sqlite`.** Probed inside Electron:
`DatabaseSync` OK, **FTS5 OK** (needed for `recall`), **JSON1 OK**. Adopted instead — no native
compilation, no `electron-rebuild`, nothing for the user to install.

API differences from `better-sqlite3` that the wrapper in `src/main/db/index.ts` absorbs:

- no `db.transaction(fn)` helper → wrapper implements `tx()` with `BEGIN`/`COMMIT`/`ROLLBACK`
- no `.pluck()` → wrapper exposes `pluck()` that maps the first column
- booleans are not bindable → store as `0`/`1`, wrapper coerces
