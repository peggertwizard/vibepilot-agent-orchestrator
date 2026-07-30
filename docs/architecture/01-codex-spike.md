# Codex spike — the real `codex exec --json` wire

Captured against **codex-cli codex-cli 0.145.0**, driving a real process through four cases.

This exists because the plan for a Codex adapter was written having only ever observed
`agent_message` on the wire. Everything else was inferred, and an adapter built on
inferred event names breaks silently on the first interesting turn.

## Event types observed

| Event | Count | Seen in |
|---|---|---|
| `item.completed / agent_message` | 7 | plain answer, shell command, file edit, command that fails |
| `thread.started` | 4 | plain answer, shell command, file edit, command that fails |
| `turn.started` | 4 | plain answer, shell command, file edit, command that fails |
| `turn.completed` | 4 | plain answer, shell command, file edit, command that fails |
| `item.started / command_execution` | 3 | shell command, file edit, command that fails |
| `item.completed / command_execution` | 3 | shell command, file edit, command that fails |
| `item.started / mcp_tool_call` | 2 | file edit |
| `item.completed / mcp_tool_call` | 2 | file edit |

## Samples

### `thread.started`

```json
{
  "type": "thread.started",
  "thread_id": "019fa90b-e283-79a0-99c6-245e22cfa593"
}
```

### `turn.started`

```json
{
  "type": "turn.started"
}
```

### `item.completed / agent_message`

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_0",
    "type": "agent_message",
    "text": "pong"
  }
}
```

### `turn.completed`

```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 18995,
    "cached_input_tokens": 0,
    "cache_write_input_tokens": 0,
    "output_tokens": 5,
    "reasoning_output_tokens": 0
  }
}
```

### `item.started / command_execution`

```json
{
  "type": "item.started",
  "item": {
    "id": "item_0",
    "type": "command_execution",
    "command": "\"C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\pwsh.exe\" -Command 'git status --short'",
    "aggregated_output": "",
    "exit_code": null,
    "status": "in_progress"
  }
}
```

### `item.completed / command_execution`

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_0",
    "type": "command_execution",
    "command": "\"C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\pwsh.exe\" -Command 'git status --short'",
    "aggregated_output": "execution error: Io(Custom { kind: Other, error: \"windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\\\\Users\\\\you\\\\Claude Work\\\\Projects\\\\VibePilot, log=C:\\\\Users\\\\you\\\\.codex\\\\.sandbox\\\\sandbox.2026-07-28.log, error=program not found\" })",
    "exit_code": -1,
    "status": "failed"
  }
}
```

### `item.started / mcp_tool_call`

```json
{
  "type": "item.started",
  "item": {
    "id": "item_3",
    "type": "mcp_tool_call",
    "server": "node_repl",
    "tool": "js",
    "arguments": {
      "code": "var fs1 = await import('node:fs/promises'); var path1 = await import('node:path'); var target1 = path1.join(nodeRepl.cwd, 'src', 'greet.js'); var before1 = await fs1.readFile(target1, 'utf8'); nodeRepl.write(before1);",
      "title": "Inspect greet module"
    },
    "result": null,
    "error": null,
    "status": "in_progress"
  }
}
```

### `item.completed / mcp_tool_call`

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_3",
    "type": "mcp_tool_call",
    "server": "node_repl",
    "tool": "js",
    "arguments": {
      "code": "var fs1 = await import('node:fs/promises'); var path1 = await import('node:path'); var target1 = path1.join(nodeRepl.cwd, 'src', 'greet.js'); var before1 = await fs1.readFile(target1, 'utf8'); nodeRepl.write(before1);",
      "title": "Inspect greet module"
    },
    "result": {
      "content": [
        {
          "type": "text",
          "text": "export function greet() {\n  return \"hello\"\n}\n"
        }
      ],
      "structured_content": null
    },
    "error": null,
    "status": "completed"
  }
}
```

## Per-case notes

### plain answer

- exit code: `0`
- events: 4
- non-JSON lines on stdout: 0

stderr:
```
Reading prompt from stdin...
```

### shell command

- exit code: `0`
- events: 6
- non-JSON lines on stdout: 0

stderr:
```
Reading prompt from stdin...
2026-07-28T14:06:07.966111Z ERROR codex_core::exec: exec error: windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\Users\you\Claude Work\Projects\VibePilot, log=C:\Users\you\.codex\.sandbox\sandbox.2026-07-28.log, error=program not found
2026-07-28T14:06:07.966483Z ERROR codex_core::tools::router: error=execution error: Io(Custom { kind: Other, error: "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\\Users\\you\\Claude Work\\Projects\\VibePilot, log=C:\\Users\\you\\.codex\\.sandbox\\sandbox.2026-07-28.log, error=program not found" })
```

### file edit

- exit code: `0`
- events: 12
- non-JSON lines on stdout: 0

stderr:
```
Reading prompt from stdin...
2026-07-28T14:06:17.347796Z ERROR codex_core::exec: exec error: windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\Users\you\Claude Work\Projects\VibePilot, log=C:\Users\you\.codex\.sandbox\sandbox.2026-07-28.log, error=program not found
2026-07-28T14:06:17.348160Z ERROR codex_core::tools::router: error=execution error: Io(Custom { kind: Other, error: "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\\Users\\you\\Claude Work\\Projects\\VibePilot, log=C:\\Users\\you\\.codex\\.sandbox\\sandbox.2026-07-28.log, error=program not found" })
2026-07-28T14:06:23.283658Z ERROR codex_core::
```

### command that fails

- exit code: `0`
- events: 7
- non-JSON lines on stdout: 0

stderr:
```
Reading prompt from stdin...
2026-07-28T14:07:12.780645Z ERROR codex_core::exec: exec error: windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\Users\you\Claude Work\Projects\VibePilot, log=C:\Users\you\.codex\.sandbox\sandbox.2026-07-28.log, error=program not found
2026-07-28T14:07:12.780935Z ERROR codex_core::tools::router: error=execution error: Io(Custom { kind: Other, error: "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=C:\\Users\\you\\Claude Work\\Projects\\VibePilot, log=C:\\Users\\you\\.codex\\.sandbox\\sandbox.2026-07-28.log, error=program not found" })
```

## Session identity

Candidate resume handles seen on the wire:

- `thread_id=019fa90b-e283-79a0-99c6-245e22cfa593`
- `thread_id=019fa90b-f84a-7bf2-aafb-1a4ec062d5d7`
- `thread_id=019fa90c-1d1a-7023-be92-30dbd1377cfc`
- `thread_id=019fa90c-f901-7c32-9a2f-309056756cf3`

## Did the file edit actually land?

Yes — `workspace-write` wrote to the scratch repo.
