import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { AgentEvent } from '@shared/events'
import { bus } from '../bus'
import { id } from '../db'
import { getProject } from '../db/repos/projects'
import { ClaudeCliAdapter } from '../providers/claude/adapter'
import type { LaunchSpec } from '../providers/types'
import { syncMemory, uncuratedCount } from './index'
import { ensureMemoryDirs, memoryDir } from './store'

/**
 * The curator: a cheap pass that keeps memory from turning into a landfill.
 *
 * Deliberately **not** the Pilot. *"We just don't want to load the Pilot with even more
 * tasks."* A Haiku process is enough for merge-the-duplicates work, it costs almost
 * nothing, and it leaves the Pilot free to answer the user. Extracting learnings into a
 * maintained playbook measured +10.6% on agent benchmarks versus leaving them raw, so this
 * is worth doing properly rather than as a cron job that trims by age.
 *
 * It works by **editing the markdown files directly** — cwd is the memory directory and it
 * gets Read/Write/Edit and nothing else. That is the whole payoff of files-as-truth: the
 * maintenance job is a text-editing job, and the index just re-derives afterwards.
 */

const THRESHOLD = 20

const CURATOR_PROMPT = `# You are the curator of this project's memory

Your working directory IS the memory store. Everything here is markdown that agents and the
user wrote while building this project, and your job is to keep it worth reading.

## Layout

- \`_digest.md\` — injected into EVERY agent's prompt on EVERY spawn. It competes with the
  context window, so it must stay small: a target of 2000 tokens, hard.
- \`project/*.md\` — architecture, conventions, gotchas, decisions, glossary.
- \`agents/<name>.md\` — what one teammate has learned. Loaded whenever that teammate spawns.

## Entry format

Each entry is a \`##\` heading, then an HTML comment carrying provenance, then the body:

    ## node:sqlite is absent from module.builtinModules
    <!-- vp source=agent author=Dana at=2026-07-28 files=src/main/db/index.ts -->

    It is isBuiltin() true but missing from the list, so bundlers try to bundle it.

Keep that shape exactly. Preserve the comment when you edit an entry — losing provenance is
worse than losing the entry.

## What to do

1. **Merge duplicates.** Two entries saying the same thing become one, keeping the clearer
   wording and the earlier date.
2. **Mark superseded, do not delete.** When a newer entry contradicts an older one, add
   \`superseded=true\` to the older entry's comment and leave it in place. Someone will want
   to know what we used to believe and why it changed.
3. **Flag staleness, do not guess.** If an entry's \`files=\` no longer exist, or its claim
   is contradicted by what the code now says, add \`superseded=true\` — do not rewrite it
   from your own reading. An entry that was true and is now confidently wrong is the most
   expensive failure in this system.
4. **Rewrite \`_digest.md\`.** The 10–15 things a new agent on this project genuinely needs
   before it starts. Prose, not a list of links. Anything reachable by searching does not
   belong here.

## What NOT to do

- **Never touch an entry marked \`source=user\`.** That is the human telling a teammate
  something about how they want to be worked with. It cannot be re-derived by reading the
  code, it does not expire, and it is not yours to tidy.
- Do not invent entries. You only reorganise what is already written down.
- Do not delete a file.

Work through the files, make the edits, then stop. Reply with one line saying what changed.`

class Curator {
  private running = new Set<string>()
  private timers = new Map<string, NodeJS.Timeout>()

  /** Call after a merge, or whenever memory has grown. Cheap to call; rarely acts. */
  maybeRun(projectId: string, reason: 'merge' | 'volume'): void {
    if (this.running.has(projectId)) return
    if (reason === 'volume' && uncuratedCount(projectId) < THRESHOLD) return

    const t = this.timers.get(projectId)
    if (t) clearTimeout(t)
    // Let the merge settle before spending a process on it.
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId)
        void this.run(projectId).catch(() => undefined)
      }, 5000),
    )
  }

  async run(projectId: string, timeoutMs = 180_000): Promise<boolean> {
    if (this.running.has(projectId)) return false
    const project = getProject(projectId)
    if (!project) return false

    ensureMemoryDirs(project.path)
    const dir = memoryDir(project.path)
    if (!existsSync(dir)) return false

    this.running.add(projectId)
    const adapter = new ClaudeCliAdapter()
    try {
      const spec: LaunchSpec = {
        runId: id(),
        provider: 'claude',
        // The curator is not a teammate: no agents row, no board presence, no slot in the
        // concurrency cap. It is a maintenance pass that happens to be a model.
        agentId: `curator:${projectId}`,
        projectId,
        ticketId: null,
        parentAgentId: null,
        cwd: dir,
        addDirs: [],
        model: 'haiku',
        appendSystemPrompt: CURATOR_PROMPT,
        permissionMode: 'bypassPermissions',
        trustProjectSettings: project.settingsTrusted,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        // No MCP and no Bash: it edits text in one directory and has no business doing
        // anything else. Narrow tools are the containment here, since worktree isolation
        // does not apply.
        disallowedTools: ['Bash', 'Task', 'WebFetch', 'WebSearch'],
        mcp: null,
        sessionId: randomUUID(),
      }

      const finished = new Promise<void>((resolve) => {
        const off = adapter.onEvent((e: AgentEvent) => {
          if (e.type === 'agent:done' || e.type === 'agent:error') {
            off()
            resolve()
          }
        })
      })

      await adapter.start(spec, {
        text: 'Curate the memory in this directory now, then stop.',
        channel: 'user',
      })
      await Promise.race([finished, new Promise((r) => setTimeout(r, timeoutMs))])
      await adapter.stop('curation finished').catch(() => undefined)

      // The files changed underneath the index, so re-derive the whole thing. This is the
      // moment the "index is disposable" claim earns its keep.
      syncMemory(projectId, project.path)
      bus.emitDomain({ type: 'memory:changed', projectId })
      return true
    } finally {
      this.running.delete(projectId)
    }
  }
}

export const curator = new Curator()
