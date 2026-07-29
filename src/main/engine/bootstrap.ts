import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '@shared/events'
import type { AgentRole } from '@shared/types'
import { MODEL_OPTIONS } from '@shared/types'
import { bus } from '../bus'
import { id, now, run } from '../db'
import { listRoster } from '../db/repos/agents'
import { proposeHire } from '../db/repos/hires'
import { addMessage } from '../db/repos/messages'
import { getProject } from '../db/repos/projects'
import { flushWrites } from '../db/writer'
import { ClaudeCliAdapter } from '../providers/claude/adapter'
import type { LaunchSpec } from '../providers/types'

/**
 * The startup scan: read a new project shallowly and propose a team to start with.
 *
 * *"On startup, if there's an existing project, scan the codebase roughly and propose a team
 * to start with."* An empty roster is a bad first impression of an orchestrator — you open
 * it and there is nobody to give work to, and no obvious clue what a good team looks like
 * for this repo.
 *
 * Deliberately a **proposal**, not a fait accompli: it produces hire cards you approve. The
 * scan runs once per project (`projects.bootstrapped_at`) so re-opening the app does not
 * re-suggest a team you already turned down.
 */

const SCAN_PROMPT = `# You are scouting a codebase to propose a starting team

Read this repository shallowly — a few minutes, not an audit. You are working out what kind
of help this project needs, not reviewing it.

Look for: the languages and framework, whether there is a test runner and what it is, whether
there is a UI, whether there is user-facing copy, roughly how large it is, and anything
unusual that would need a specialist.

## What to produce

Reply with ONLY a JSON object, no prose around it, no code fence:

{
  "summary": "one or two sentences on what this project is",
  "team": [
    { "name": "Dana", "role": "builder", "model": "sonnet",
      "why": "Most of this is TypeScript feature work in one app.",
      "instructions": "Match the surrounding code rather than importing your own style." }
  ]
}

Rules for the team:

- \`role\` is one of: builder, reviewer, scout, specialist.
- \`model\` is one of: opus, sonnet, haiku.
- Between 1 and 4 people. Fit the team to the repo — a small script does not need four
  agents, and a large product with a UI probably wants more than a lone builder.
- \`name\` is a short human first name. Distinct from each other.
- \`why\` must point at something you actually saw in the repo. "Good practice" is not a
  reason; "there is a large amount of marketing copy in src/content" is.
- \`instructions\` is how that person should work, in the second person.

Do not write files. Do not run anything that changes the repo.`

interface ScanResult {
  summary?: string
  team?: Array<{
    name?: string
    role?: string
    model?: string
    why?: string
    instructions?: string
  }>
}

const ROLES = new Set<AgentRole>(['builder', 'reviewer', 'scout', 'specialist'])

/**
 * Models say "here is the JSON:" no matter how firmly you ask them not to. Pull the first
 * balanced object out rather than trusting the whole reply to parse.
 */
export function extractJson(text: string): ScanResult | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as ScanResult
        } catch {
          return null
        }
      }
    }
  }
  return null
}

class Bootstrap {
  private running = new Set<string>()

  /** Runs once per project, and never when a roster already exists. */
  async maybeScan(projectId: string): Promise<boolean> {
    const project = getProject(projectId)
    if (!project || project.bootstrappedAt) return false
    // Someone who has already built a team does not want suggestions.
    if (listRoster(projectId).some((a) => !a.isPilot)) {
      this.markDone(projectId)
      return false
    }
    return this.scan(projectId)
  }

  async scan(projectId: string, timeoutMs = 180_000): Promise<boolean> {
    if (this.running.has(projectId)) return false
    const project = getProject(projectId)
    if (!project) return false

    this.running.add(projectId)
    const adapter = new ClaudeCliAdapter()
    let text = ''

    try {
      const spec: LaunchSpec = {
        runId: id(),
        provider: 'claude',
        // Not a teammate: no agents row, no board presence, no concurrency slot.
        agentId: `bootstrap:${projectId}`,
        projectId,
        ticketId: null,
        parentAgentId: null,
        cwd: project.path,
        addDirs: [],
        // Haiku: this is breadth, not depth, and it should not cost anything noticeable
        // before the user has even given the app a task.
        model: 'haiku',
        appendSystemPrompt: SCAN_PROMPT,
        permissionMode: 'bypassPermissions',
        trustProjectSettings: project.settingsTrusted,
        allowedTools: ['Read', 'Glob', 'Grep'],
        // Read-only by construction. A scan that can write is not a scan.
        disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task'],
        mcp: null,
        sessionId: randomUUID(),
      }

      const finished = new Promise<void>((resolve) => {
        const off = adapter.onEvent((e: AgentEvent) => {
          if (e.type === 'agent:text' && e.final !== undefined) text += e.final
          if (e.type === 'agent:done' || e.type === 'agent:error') {
            off()
            resolve()
          }
        })
      })

      await adapter.start(spec, {
        text: 'Scan this repository and propose a starting team.',
        channel: 'user',
      })
      await Promise.race([finished, new Promise((r) => setTimeout(r, timeoutMs))])
      await adapter.stop('scan finished').catch(() => undefined)
    } finally {
      this.running.delete(projectId)
    }

    const parsed = extractJson(text)
    // Always mark it done, even on a failed parse. A scan that silently retries on every
    // app launch is worse than one that quietly gives up — you can still hire by hand.
    this.markDone(projectId)
    if (!parsed?.team?.length) {
      addMessage({
        projectId,
        authorType: 'agent',
        kind: 'notice',
        body:
          'I had a look around, but I could not work out a sensible starting team from what ' +
          'is here. Add teammates yourself on the Team tab, or just tell me what you want ' +
          'built and I will suggest someone.',
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId })
      return false
    }

    const proposals = parsed.team
      .filter((m) => m.name && ROLES.has(m.role as AgentRole))
      .map((m) => ({
        name: m.name!.trim().slice(0, 40),
        role: m.role as Exclude<AgentRole, 'pilot'>,
        // A model it invented is not a model we have. Fall back rather than refusing the
        // whole scan over one bad field.
        model: MODEL_OPTIONS.some((o) => o.id === m.model && o.provider === 'claude')
          ? m.model!
          : 'sonnet',
        why: (m.why ?? '').slice(0, 600),
        instructions: (m.instructions ?? '').slice(0, 8000),
      }))
      .slice(0, 4)

    const seen = new Set<string>()
    for (const p of proposals) {
      const key = p.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      proposeHire({
        projectId,
        proposedByAgentId: null,
        name: p.name,
        role: p.role,
        model: p.model,
        instructions: p.instructions,
        why: p.why,
        fromBootstrap: true,
      })
    }

    if (seen.size === 0) return false

    addMessage({
      projectId,
      // 'agent' with no agentId, not 'system'. MessageRow branches on authorType alone:
      // 'system' renders as an impersonal grey block with no avatar, name or timestamp,
      // which is right for a merge notice and wrong for first-person prose. The agent
      // branch already defaults to the Pilot when there is no agent row.
      authorType: 'agent',
      kind: 'notice',
      body:
        `I had a look around this project and suggested a team to start with — ` +
        `${seen.size} ${seen.size === 1 ? 'person' : 'people'} on the Team tab, each with a ` +
        `reason. Approve the ones you want; nobody exists until you do.` +
        (parsed.summary ? `\n\n${parsed.summary}` : ''),
    })
    flushWrites()
    bus.emitDomain({ type: 'hires:changed', projectId })
    bus.emitDomain({ type: 'messages:changed', projectId })
    return true
  }

  /** Records that the offer has been resolved — by running it, or by declining. */
  skip(projectId: string): void {
    this.markDone(projectId)
  }

  private markDone(projectId: string): void {
    run('UPDATE projects SET bootstrapped_at = ?, updated_at = ? WHERE id = ?', now(), now(), projectId)
  }
}

export const bootstrap = new Bootstrap()
