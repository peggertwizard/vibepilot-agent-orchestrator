# How vibePilot talks to Claude — and why it's built this way

## The constraint

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
states, under *Authentication and credential use*:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
> and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
> other native Anthropic applications.
>
> **Developers** building products or services that interact with Claude's capabilities, including
> those using the Agent SDK, should use API key authentication through Claude Console or a
> supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai
> login or to route requests through Free, Pro, or Max plan credentials on behalf of their users.

So a third-party app that embeds `@anthropic-ai/claude-agent-sdk` and authenticates it with a
subscription OAuth token is outside the terms — regardless of whether it is personal, local, or
single-user. That restriction was tightened and server-side enforced in early 2026.

## What vibePilot does instead

vibePilot **spawns the user's own `claude` executable as a child process** and speaks NDJSON to it
over stdin/stdout:

```
claude -p --input-format stream-json --output-format stream-json --verbose …
```

This is ordinary use of Claude Code. The binary authenticates itself exactly as it does when run
from a terminal. Concretely, vibePilot:

- **never** imports or bundles `@anthropic-ai/claude-agent-sdk`
- **never** reads, stores, forwards, logs or transmits an OAuth token or API key
- **never** offers a Claude.ai login, and has no account system of its own
- **never** proxies anyone else's requests — it is a local, single-user desktop app
- redacts the vibePilot MCP bearer token from `agent_runs.argv_json` before persisting it

The user's credentials live where Claude Code put them, and only Claude Code reads them.

## Enforcement

`npm run compliance` (`scripts/check-compliance.mjs`) fails if the Agent SDK appears in
`package.json` or is imported anywhere under `src/`. This is a real risk to guard: the SDK has
nicer TypeScript types than parsing NDJSON by hand, and reaching for them would silently change
the app's legal posture.

## The honest caveats

**This is not a licence to run a fleet.** The same page says advertised Pro/Max limits *"assume
ordinary, individual usage of Claude Code and the Agent SDK."* vibePilot defaults to a
concurrency cap of 3 and surfaces a live quota meter driven by the CLI's own `rate_limit_event`,
so heavy use is visible rather than mysterious. Running dozens of always-on agents would be
pushing past ordinary individual use whatever the architecture.

**Worktree isolation is not a sandbox.** With `--permission-mode bypassPermissions`, Claude Code
confines `Write`/`Edit` to the agent's `cwd` plus `--add-dir`, but `Bash` is unconstrained — an
agent can `cd ..` and touch anything the user can. The Settings screen says this plainly rather
than implying containment.
