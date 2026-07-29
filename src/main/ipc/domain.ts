import { basename, join, resolve, sep } from 'node:path'
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, dialog, shell } from 'electron'
import { z } from 'zod'
import { activeStep } from '@shared/types'
import { bus } from '../bus'
import {
  createAgent,
  deleteAgent,
  findAgentByName,
  getAgent,
  getPilot,
  listAgents,
  setAgentStatus,
  resetProjectUsage,
  updateAgent,
} from '../db/repos/agents'
import {
  getQuestion,
  listComms,
  listMessages,
  listOpenQuestions,
  markQuestionAskedPilot,
  openQuestionCounts,
} from '../db/repos/messages'
import {
  acceptDraft,
  archiveTicket,
  createTicket,
  deleteTicket,
  getTicket,
  listOpenDrafts,
  listTickets,
  resolveDraft,
  ticketSpend,
  updateDraftPayload,
  updateTicket,
} from '../db/repos/tickets'
import {
  acceptedRoute,
  approveGate,
  getRoute,
  listRoutes,
  proposedRoute,
  rejectRoute,
  setSteps,
} from '../db/repos/routes'
import { acceptSplit, getEpic, listEpics, reconcileEpic, rejectSplit } from '../db/repos/epics'
import { listFindings, listOpenFindings } from '../db/repos/findings'
import { acceptHire, getHire, listOpenHires, rejectHire } from '../db/repos/hires'
import { getProject } from '../db/repos/projects'
import { addMessage } from '../db/repos/messages'
import { changedFiles, listWorktrees, pruneWorktrees, removeWorktree } from '../git/worktree'
import { commitsAhead, githubStatus, overview, pushBase } from '../git/branches'
import { pilot } from '../engine/pilot'
import { manager } from '../engine/manager'
import { placeAll, sweepEmptyReady } from '../engine/board'
import { freeDependents, mergeTicket } from '../engine/merge'
import { relaunchAssignee } from '../engine/heal'
import { listPreviews, startPreview, stopPreview } from '../engine/preview'
import { runCommand } from '../engine/checks'
import {
  deleteEnvironment,
  getEnvironment,
  listDeployments,
  listEnvironments,
  recordDeployment,
  upsertEnvironment,
} from '../db/repos/environments'
import * as gate from '../engine/gate'
import { routing } from '../engine/routing'
import { listMemory, recall, syncMemory } from '../memory'
import { curator } from '../memory/curator'
import { memoryDir, readDigest } from '../memory/store'
import { attachmentsDir } from '../paths'
import { askUserGate } from '../mcp/askUser'
import { flushWrites } from '../db/writer'

type Handle = <S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => R | Promise<R>,
) => void

const ProjectId = z.object({ projectId: z.string().min(1) })
/*
 * Deliberately not the full `Lane` union. `waiting` and `in_progress` are derived from the
 * route and the process table (see shared/board.ts) — accepting a write for them would let a
 * caller assert something about the world rather than about their own intent.
 */
const Lane = z.enum(['backlog', 'todo', 'done'])
const StepKind = z.enum(['research', 'plan', 'build', 'review'])
const Role = z.enum(['builder', 'reviewer', 'scout', 'specialist'])

const Empty = z.object({})

/**
 * Extension to media type, for the handful that matter.
 *
 * Only the image types need to be right — they decide whether a file is sent inline to the
 * model or left as a path. Everything else falls back to a generic type and is handled as a
 * file either way, so guessing wrong there costs nothing.
 */
function mediaTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'md':
    case 'txt':
    case 'csv':
    case 'log':
      return 'text/plain'
    case 'json':
      return 'application/json'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

/** Bytes on disk, best effort. A number that is roughly right beats no number at all. */
function dirSize(path: string): number {
  let total = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
      } else if (e.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          /* vanished between the listing and the stat */
        }
      }
    }
  }
  walk(path, 0)
  return total
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENTS = 10

/**
 * Copy files into the attachments directory and describe them.
 *
 * One function for every way a file arrives — the picker, a drop, a paste — so the size cap,
 * the count cap and the collision-proof naming cannot drift apart between them.
 */
export function copyIntoAttachments(
  paths: string[],
): Array<{ name: string; mediaType: string; path: string; bytes: number }> {
  const root = attachmentsDir()
  const out: Array<{ name: string; mediaType: string; path: string; bytes: number }> = []
  for (const src of paths.slice(0, MAX_ATTACHMENTS)) {
    try {
      const stat = statSync(src)
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) continue
      const name = basename(src)
      // A short random prefix, so attaching two files called "screenshot.png" a week apart
      // does not have the second quietly replace the first.
      const dest = join(root, `${randomBytes(4).toString('hex')}-${name}`)
      copyFileSync(src, dest)
      out.push({ name, mediaType: mediaTypeFor(name), path: dest, bytes: stat.size })
    } catch {
      /* skip anything unreadable rather than failing the whole selection */
    }
  }
  return out
}

/**
 * The slash commands this project actually has.
 *
 * vibePilot deliberately does not implement slash commands — its argv passes them straight to
 * the CLI, so `/compact`, `/clear` and every skill in the repo already work today. What was
 * missing was any way to know they exist. This lists what is there; it does not interpret it.
 * A parallel implementation would drift from the CLI's on the first update.
 */
export function readProjectCommands(
  projectPath: string,
): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = []

  // `.claude/skills/<name>/SKILL.md` — the description lives in the frontmatter.
  const skills = join(projectPath, '.claude', 'skills')
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(skills, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      out.push({ name: entry.name, description: frontmatterDescription(file) })
    }
  }

  // `.claude/commands/<name>.md` — the other shape a project slash command takes.
  const commands = join(projectPath, '.claude', 'commands')
  if (existsSync(commands)) {
    for (const entry of readdirSync(commands, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      if (out.some((c) => c.name === name)) continue
      out.push({ name, description: frontmatterDescription(join(commands, entry.name)) })
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60)
}

/** First `description:` in the YAML frontmatter, if there is one. Never throws. */
function frontmatterDescription(file: string): string {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2000)
    const m = /^description:\s*(.+)$/m.exec(head)
    return m?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 160) ?? ''
  } catch {
    return ''
  }
}

export function registerDomainIpc(handle: Handle): void {
  // ── messages / the Pilot ────────────────────────────────────────────────────
  handle('messages:list', ProjectId, ({ projectId }) => listMessages(projectId))

  handle(
    'messages:send',
    z.object({
      projectId: z.string().min(1),
      text: z.string().min(1).max(60_000),
      model: z.string().min(1),
      attachments: z
        .array(
          z.object({
            name: z.string().max(300),
            mediaType: z.string().max(120),
            path: z.string().max(1000),
            bytes: z.number().int().nonnegative(),
          }),
        )
        .max(10)
        .default([]),
    }),
    async ({ projectId, text, model, attachments }) => {
      // Paths are re-checked against the attachments directory: the renderer is not trusted,
      // and this argument ends up being read off disk and sent to a model.
      const root = attachmentsDir()
      const safe = attachments.filter((a) => resolve(a.path).startsWith(resolve(root)))
      await pilot.send(projectId, text, model, safe)
      return true
    },
  )

  /**
   * Attach files.
   *
   * The dialog runs in main and the chosen paths never come from the renderer — same rule as
   * adding a project. Files are COPIED into userData rather than referenced where they sit,
   * so a message does not silently break when you tidy your Downloads folder.
   */
  handle('messages:attach', Empty, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (res.canceled) return []
    return copyIntoAttachments(res.filePaths)
  })

  /*
   * Attach files the user dropped on the window, or pasted.
   *
   * Same destination and same limits as the Attach button — the trigger differs, nothing else.
   * The renderer never reads a file: Electron hands it a real path on drop, and main is what
   * copies it into the attachments directory. That matters because `messages:send` will only
   * accept paths already inside that directory, so this is the single gate between "a path the
   * renderer named" and "a file that gets read off disk and sent to a model".
   */
  handle(
    'messages:attachPaths',
    z.object({ paths: z.array(z.string().min(1)).max(20) }),
    ({ paths }) => copyIntoAttachments(paths),
  )

  /*
   * A pasted image has no path — it exists only in the clipboard, so the bytes have to come
   * through. For a screenshot this is the most natural gesture there is, and it is the one
   * case where the renderer legitimately holds the content.
   */
  handle(
    'messages:attachData',
    z.object({
      name: z.string().min(1).max(200),
      // 25 MB of binary is ~34 MB of base64; the length cap is the real limit.
      dataBase64: z.string().min(1).max(36_000_000),
    }),
    ({ name, dataBase64 }) => {
      const buf = Buffer.from(dataBase64, 'base64')
      if (buf.byteLength === 0 || buf.byteLength > MAX_ATTACHMENT_BYTES) return null

      // basename() strips any directory the renderer put in the name — a pasted file has no
      // business choosing where it lands.
      const safeName = basename(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'pasted'
      const dest = join(attachmentsDir(), `${randomBytes(4).toString('hex')}-${safeName}`)
      writeFileSync(dest, buf)
      return {
        name: safeName,
        mediaType: mediaTypeFor(safeName),
        path: dest,
        bytes: buf.byteLength,
      }
    },
  )

  /** What `/` offers. Read fresh: a skill added while the app is open should just appear. */
  handle('messages:commands', ProjectId, ({ projectId }) => {
    const project = getProject(projectId)
    return project ? readProjectCommands(project.path) : []
  })

  handle('messages:stop', ProjectId, async ({ projectId }) => {
    await pilot.stop(projectId)
    return true
  })

  // ── tickets ─────────────────────────────────────────────────────────────────
  handle(
    'tickets:list',
    z.object({ projectId: z.string().min(1), includeArchived: z.boolean().default(false) }),
    // `placeAll` is what makes the board honest — see engine/board.ts. Never return raw
    // tickets from here; the stored lane is a preference, not a statement about the world.
    ({ projectId, includeArchived }) => placeAll(listTickets(projectId, includeArchived)),
  )

  handle(
    'tickets:create',
    z.object({
      projectId: z.string().min(1),
      title: z.string().min(1).max(120),
      body: z.string().max(20_000).default(''),
      lane: Lane.default('backlog'),
      needsPlanning: z.boolean().default(false),
      /*
       * Both columns have existed since migrations 005 and 013 and both were reachable only
       * to the Pilot: the create form could not set a budget or a dependency, so "advanced
       * setup" meant asking the Pilot in prose and hoping.
       */
      budgetUsd: z.number().min(0).max(10_000).nullish(),
      dependsOn: z.array(z.number().int().min(1)).max(20).default([]),
    }),
    (input) => {
      const t = createTicket(input)
      bus.emitDomain({ type: 'tickets:changed', projectId: input.projectId })
      // A new ticket has no route. Ask the Pilot how it should be handled — coalesced, so
      // adding five at once costs one turn, not five.
      routing.nudge(input.projectId)
      return t
    },
  )

  handle(
    'tickets:update',
    z.object({
      projectId: z.string().min(1),
      ticketId: z.string().min(1),
      patch: z.object({
        title: z.string().min(1).max(120).optional(),
        body: z.string().max(20_000).optional(),
        lane: Lane.optional(),
        needsPlanning: z.boolean().optional(),
        /*
         * `budgetUsd` was missing here, and zod strips unknown keys rather than rejecting
         * them — so the budget field in the ticket detail panel sent its value, the handler
         * returned success, `updateTicket` never saw it and the old number reloaded. A control
         * that silently does nothing, with every layer around it type-checking.
         */
        budgetUsd: z.number().min(0).max(10_000).nullish(),
        dependsOn: z.array(z.number().int().min(1)).max(20).optional(),
      }),
    }),
    ({ projectId, ticketId, patch }) => {
      const t = updateTicket(ticketId, patch)
      bus.emitDomain({ type: 'tickets:changed', projectId })
      return t
    },
  )

  handle(
    'tickets:archive',
    z.object({ projectId: z.string().min(1), ticketId: z.string().min(1) }),
    ({ projectId, ticketId }) => {
      archiveTicket(ticketId)
      bus.emitDomain({ type: 'tickets:changed', projectId })
      return true
    },
  )

  handle(
    'tickets:delete',
    z.object({ projectId: z.string().min(1), ticketId: z.string().min(1) }),
    ({ projectId, ticketId }) => {
      deleteTicket(ticketId)
      bus.emitDomain({ type: 'tickets:changed', projectId })
      return true
    },
  )

  // ── drafts ──────────────────────────────────────────────────────────────────
  handle('drafts:list', ProjectId, ({ projectId }) => listOpenDrafts(projectId))

  handle(
    'drafts:accept',
    z.object({ projectId: z.string().min(1), draftId: z.string().min(1) }),
    ({ projectId, draftId }) => {
      const t = acceptDraft(draftId)
      flushWrites()
      bus.emitDomain({ type: 'tickets:changed', projectId })
      bus.emitDomain({ type: 'drafts:changed', projectId })
      if (t) {
        pilot.notify(projectId, `The user accepted your draft. It is now ticket #${t.number}: ${t.title}`)
        routing.nudge(projectId)
      }
      return t
    },
  )

  handle(
    'drafts:update',
    z.object({
      projectId: z.string().min(1),
      draftId: z.string().min(1),
      patch: z.object({
        title: z.string().min(1).max(120).optional(),
        body: z.string().max(20_000).optional(),
        lane: Lane.optional(),
        needsPlanning: z.boolean().optional(),
      }),
    }),
    ({ projectId, draftId, patch }) => {
      const d = updateDraftPayload(draftId, patch)
      bus.emitDomain({ type: 'drafts:changed', projectId })
      return d
    },
  )

  handle(
    'drafts:reject',
    z.object({
      projectId: z.string().min(1),
      draftId: z.string().min(1),
      reason: z.string().max(500).default(''),
    }),
    ({ projectId, draftId, reason }) => {
      resolveDraft(draftId, 'rejected')
      bus.emitDomain({ type: 'drafts:changed', projectId })
      pilot.notify(
        projectId,
        `The user turned down that draft.${reason ? ` They said: ${reason}` : ''} Do not re-propose the same thing.`,
      )
      return true
    },
  )

  // ── routes ──────────────────────────────────────────────────────────────────
  handle('routes:list', ProjectId, ({ projectId }) => listRoutes(projectId))

  handle(
    'routes:accept',
    z.object({
      projectId: z.string().min(1),
      routeId: z.string().min(1),
      /** Present when the user changed anything on the card before pressing Start. */
      steps: z
        .array(
          z.object({
            kind: StepKind,
            note: z.string().max(300).nullish(),
            assigneeAgentId: z.string().min(1).nullish(),
            brief: z.string().max(12_000).nullish(),
          }),
        )
        .min(1)
        .max(6)
        .optional(),
    }),
    ({ projectId, routeId, steps }) => {
      const r = getRoute(routeId)
      if (!r) throw new Error('That route no longer exists.')
      // Edits are applied to the proposal first, so `apply` has one job and the accepted
      // row records exactly what the user agreed to rather than what was suggested.
      //
      // Carry forward by KIND, not by index: dropping the review step from a
      // [build, review] route used to shift the builder's assignee and brief onto whatever
      // now sat at that position.
      const edited = steps
        ? setSteps(
            routeId,
            steps.map((s, i) => {
              const prior = r.steps.find((p) => p.kind === s.kind)
              return {
                id: `s${i + 1}`,
                kind: s.kind,
                assigneeAgentId:
                  s.assigneeAgentId !== undefined
                    ? s.assigneeAgentId
                    : (prior?.assigneeAgentId ?? null),
                status: 'pending' as const,
                passes: 1,
                note: s.note ?? prior?.note ?? null,
                brief: s.brief !== undefined ? s.brief : (prior?.brief ?? null),
              }
            }),
          )
        : r
      return edited ? routing.apply(edited) : null
    },
  )

  handle(
    'routes:reject',
    z.object({
      projectId: z.string().min(1),
      routeId: z.string().min(1),
      reason: z.string().max(500).default(''),
    }),
    ({ projectId, routeId, reason }) => {
      const r = getRoute(routeId)
      rejectRoute(routeId)
      bus.emitDomain({ type: 'routes:changed', projectId })
      if (r) {
        const t = getTicket(r.ticketId)
        pilot.notify(
          projectId,
          `The user rejected the route for #${t?.number ?? '?'}.` +
            (reason ? ` They said: ${reason}` : '') +
            ` Propose a different one — probably a shorter one.`,
        )
      }
      return true
    },
  )

  /** What the board needs per ticket, without shipping every superseded proposal. */
  handle(
    'routes:forTicket',
    z.object({ ticketId: z.string().min(1) }),
    ({ ticketId }) => ({
      accepted: acceptedRoute(ticketId),
      proposed: proposedRoute(ticketId),
    }),
  )

  // ── agents / the roster ─────────────────────────────────────────────────────
  handle('agents:list', ProjectId, ({ projectId }) => listAgents(projectId))

  handle(
    'agents:create',
    z.object({
      projectId: z.string().min(1),
      name: z.string().min(1).max(40),
      role: Role,
      provider: z.enum(['claude', 'codex']),
      model: z.string().min(1),
      // Null is meaningful: "follow the default for this role".
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'ultracode', 'max']).nullish(),
      instructions: z.string().max(20_000).default(''),
    }),
    (input) => {
      if (findAgentByName(input.projectId, input.name)) {
        throw new Error(`There is already a teammate called "${input.name}".`)
      }
      const a = createAgent({ ...input, isRoster: true, ephemeral: false })
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
      pilot.notify(
        input.projectId,
        `The user added ${a.name} to the team — a ${a.role} on ${a.model}. ` +
          (a.instructions ? `Their instructions: ${a.instructions}` : 'No special instructions.') +
          ` Put them on a ticket with assign_teammate when it suits their role.`,
      )
      return a
    },
  )

  handle(
    'agents:update',
    z.object({
      projectId: z.string().min(1),
      agentId: z.string().min(1),
      patch: z.object({
        name: z.string().min(1).max(40).optional(),
        role: Role.optional(),
        provider: z.enum(['claude', 'codex']).optional(),
        model: z.string().min(1).optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'ultracode', 'max']).nullish(),
        instructions: z.string().max(20_000).optional(),
      }),
    }),
    ({ projectId, agentId, patch }) => {
      /*
       * The teammate has to belong to the project the call claims.
       *
       * `projectId` was only ever used to address the change event, so an editor left open
       * from another project would write to *that* project's teammate while *this* project's
       * roster refreshed — the wrong roster changed and the right one never redrew. Keying the
       * panes by project (App.tsx) makes it unreachable from the UI; this makes it impossible.
       */
      const owner = getAgent(agentId)
      if (!owner || owner.projectId !== projectId) {
        throw new Error('That teammate is not on this project.')
      }
      const a = updateAgent(agentId, patch)
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId })
      return a
    },
  )

  handle(
    'agents:delete',
    z.object({ projectId: z.string().min(1), agentId: z.string().min(1) }),
    async ({ projectId, agentId }) => {
      const a = getAgent(agentId)
      if (a && a.projectId !== projectId) throw new Error('That teammate is not on this project.')
      if (a?.isPilot) throw new Error('The Pilot cannot be removed.')
      // Kill the process first — a deleted row with a live process is an orphan nobody
      // can see or stop.
      await manager.stop(agentId, 'removed from the team')
      deleteAgent(agentId)
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId })
      if (a) pilot.notify(projectId, `The user removed ${a.name} from the team. Do not assign them work.`)
      return true
    },
  )

  handle(
    'agents:stop',
    z.object({ agentId: z.string().min(1) }),
    async ({ agentId }) => {
      /*
       * Stop has to mean stop on a queued card too. `unpark` existed with no callers, so
       * pressing Stop on something that had not started yet killed a process that did not
       * exist, and the launch went ahead the moment a slot freed.
       */
      const wasParked = gate.unpark(agentId)
      if (wasParked) {
        const who = getAgent(agentId)
        setAgentStatus(agentId, 'idle', 'Stopped before it started')
        flushWrites()
        if (who) bus.emitDomain({ type: 'agents:changed', projectId: who.projectId })
        return true
      }
      await manager.stop(agentId, 'stopped by user')
      return true
    },
  )

  /**
   * An attached image, as a data URL the renderer can put in an `<img>`.
   *
   * Attachments were stored on the message and rendered nowhere, so a screenshot you sent
   * vanished from the transcript the moment you pressed send — the Pilot could see it and you
   * could not, which makes a conversation about an image impossible to reread.
   *
   * A data URL rather than a `file://` src because the CSP allows `data:` and deliberately does
   * not allow `file:`. That restriction is worth keeping: it is the thing that stops a
   * compromised renderer dependency reading whatever it likes off the disk.
   *
   * Hence the two guards below. The renderer names a path; it does not get to choose one.
   */
  handle('attachments:data', z.object({ path: z.string().min(1) }), ({ path }) => {
    const root = resolve(attachmentsDir())
    const full = resolve(path)
    // Inside the attachments directory, or nothing. `startsWith` on the resolved paths, with
    // the separator appended, so `…/attachments-evil` cannot pass for `…/attachments`.
    if (!full.startsWith(root + sep) && full !== root) return null

    const type = mediaTypeFor(full)
    if (!type.startsWith('image/')) return null

    try {
      const bytes = statSync(full).size
      // A data URL is a string in memory in two processes. Past a few megabytes that is a
      // real cost for a thumbnail nobody asked to see at full size.
      if (bytes > 8 * 1024 * 1024) return null
      return `data:${type};base64,${readFileSync(full).toString('base64')}`
    } catch {
      return null
    }
  })

  // ── preview and deployment ──────────────────────────────────────────────────

  /**
   * Run this ticket's work on its own port, in its own worktree.
   *
   * Deliberately explicit rather than automatic on ready: it is a node process and a port per
   * ticket, and starting one unasked for every finished ticket would be a surprise of exactly
   * the kind this app keeps having to un-build.
   */
  handle('preview:start', z.object({ ticketId: z.string().min(1) }), ({ ticketId }) =>
    startPreview(ticketId),
  )
  handle('preview:stop', z.object({ ticketId: z.string().min(1) }), ({ ticketId }) => ({
    ok: stopPreview(ticketId),
  }))
  handle('preview:list', ProjectId, ({ projectId }) => listPreviews(projectId))

  handle('environments:list', ProjectId, ({ projectId }) => listEnvironments(projectId))
  handle(
    'environments:save',
    z.object({
      projectId: z.string().min(1),
      name: z.string().min(1).max(60),
      cmd: z.string().min(1).max(1000),
      confirm: z.boolean().optional(),
      position: z.number().int().min(0).max(50).optional(),
    }),
    (input) => upsertEnvironment(input),
  )
  handle('environments:delete', z.object({ envId: z.string().min(1) }), ({ envId }) => {
    deleteEnvironment(envId)
    return true
  })
  handle('deployments:list', ProjectId, ({ projectId }) => listDeployments(projectId))

  /**
   * Deploy, pressed by the user.
   *
   * The Pilot's `deploy` tool refuses any environment marked as needing confirmation. This is
   * where that confirmation lands — a button the user presses, not an argument the Pilot can
   * pass. There is deliberately no way to reach one path from the other.
   */
  handle(
    'deploy:run',
    z.object({ envId: z.string().min(1), ticketId: z.string().nullish() }),
    async ({ envId, ticketId }) => {
      const env = getEnvironment(envId)
      if (!env) return { ok: false, reason: 'That environment no longer exists.' }
      const project = getProject(env.projectId)
      if (!project) return { ok: false, reason: 'That project no longer exists.' }

      const startedAt = Date.now()
      const res = await runCommand(env.cmd, project.path)
      const record = recordDeployment({
        projectId: env.projectId,
        environmentId: env.id,
        environment: env.name,
        ticketId: ticketId ?? null,
        byAgentId: null,
        ok: res.ok,
        exitCode: res.exitCode,
        output: res.output,
        startedAt,
      })

      addMessage({
        projectId: env.projectId,
        agentId: null,
        authorType: 'system',
        kind: res.ok ? 'notice' : 'error',
        body: res.ok
          ? `Deployed to ${env.name}.`
          : `Deploy to ${env.name} failed (exit ${res.exitCode}).`,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: env.projectId })
      return { ok: res.ok, deployment: record }
    },
  )

  /**
   * Pick a stalled teammate back up.
   *
   * `markAllStalledOnBoot` has always set every interrupted agent to `stalled` on launch, and
   * its comment said the UI "offers a restart instead". It did not. Closing the app mid-work
   * therefore ended that work for good: the worktree survived, the session id survived, and
   * nothing in the app could use either. This spends them.
   *
   * It goes through the gate like any other launch, so a restart respects the concurrency cap
   * and the pause toggle rather than jumping the queue.
   */
  handle(
    'agents:restart',
    z.object({ agentId: z.string().min(1) }),
    ({ agentId }) => {
      const who = getAgent(agentId)
      if (!who || who.isPilot) return { ok: false, reason: 'Not a teammate.' }
      if (manager.forAgent(agentId)) return { ok: false, reason: 'It is already running.' }

      // Whatever it was last working on. Without a ticket there is nothing to resume into.
      const ticket = listTickets(who.projectId).find((t) => t.assigneeAgentId === agentId)
      if (!ticket) return { ok: false, reason: 'It is not assigned to a ticket.' }

      const step = activeStep(acceptedRoute(ticket.id))

      /*
       * Through `relaunchAssignee` so the button, the Pilot's `restart_step` tool and the
       * automatic heal are one code path. They used to be three copies, and two of them were
       * missing the `.catch` that keeps a failed launch from freezing the agent at `queued`.
       */
      relaunchAssignee({
        agentId,
        ticketId: ticket.id,
        brief:
          step?.brief ??
          `Carry on with #${ticket.number}: ${ticket.title}. You were interrupted when ` +
            `vibePilot closed — check what you had already done before redoing any of it.`,
        because: 'Restarting',
        pilotAgentId: getPilot(who.projectId)?.id ?? '',
      })
      return { ok: true }
    },
  )

  /**
   * Say something to a teammate directly, without going through the Pilot.
   *
   * `message_agent` has existed as a Pilot-only MCP tool since the rework loop was built —
   * it delivers into a live process's stdin with its context intact. What was missing was any
   * way for a person to use it. Watching someone read the wrong file and being able only to
   * tell the Pilot about it is the wrong shape.
   */
  handle(
    'agents:message',
    z.object({
      projectId: z.string().min(1),
      agentId: z.string().min(1),
      text: z.string().min(1).max(8000),
    }),
    ({ projectId, agentId, text }) => {
      const who = getAgent(agentId)
      if (!who) throw new Error('That teammate no longer exists.')
      const sent = manager.send(agentId, { text, channel: 'user' })
      if (!sent) throw new Error(`${who.name} is not running, so there is nobody to tell.`)

      /*
       * Put it in the transcript. Without this the message went to the teammate's stdin and
       * nowhere else — you pressed Send, the text disappeared, and the only evidence it had
       * arrived was the reply eventually referring to it.
       */
      bus.emitAgent({
        type: 'agent:text',
        projectId,
        agentId,
        runId: manager.forAgent(agentId)?.runId ?? '',
        seq: bus.nextSeq(),
        ts: Date.now(),
        messageId: null,
        blockIndex: 0,
        final: text,
        fromUser: true,
      })

      // The Pilot is told THAT you said something, not the whole exchange. Otherwise you and
      // the Pilot steer the same agent while each believing you are the only one — which is
      // the failure this whole app exists to avoid.
      pilot.notify(
        projectId,
        `The user said something directly to ${who.name} while they were working: ` +
          `"${text.slice(0, 400)}". You do not need to relay anything; just do not ` +
          `contradict it.`,
      )
      return true
    },
  )

  // ── questions ───────────────────────────────────────────────────────────────
  handle('questions:listOpen', ProjectId, ({ projectId }) => listOpenQuestions(projectId))

  /** Drives the sidebar badge, so a question on a project you are not looking at is visible. */
  handle('questions:counts', z.object({}).optional(), () => openQuestionCounts())

  handle(
    'questions:answer',
    z.object({
      projectId: z.string().min(1),
      questionId: z.string().min(1),
      answer: z.string().min(1).max(8000),
    }),
    ({ projectId, questionId, answer }) => {
      // Persists and unblocks the waiting agent in one step.
      askUserGate.deliver(questionId, answer, 'user')
      bus.emitDomain({ type: 'questions:changed', projectId })
      return true
    },
  )

  handle(
    /*
     * Delegate a question to the Pilot.
     *
     * Deliberately does NOT mint a second question: `questions.id` is the handle the blocked
     * teammate is parked on, so a new row would strand it forever. The same row is marked as
     * having been handed over and stays open — you can still answer it, and if you do first,
     * the Pilot's later `answer_question` is a harmless no-op.
     *
     * Starts the Pilot if it isn't running. A button that quietly does nothing because a
     * background process happened to be stopped is worse than no button.
     */
    'questions:askPilot',
    z.object({ projectId: z.string().min(1), questionId: z.string().min(1) }),
    async ({ projectId, questionId }) => {
      const q = getQuestion(questionId)
      if (!q || q.status !== 'open') return false

      const asker = getAgent(q.agentId)
      const ticket = q.ticketId ? getTicket(q.ticketId) : null

      markQuestionAskedPilot(questionId)
      flushWrites()
      bus.emitDomain({ type: 'questions:changed', projectId })

      const pilotAgent = listAgents(projectId).find((a) => a.isPilot)
      await pilot.ensure(projectId, pilotAgent?.model ?? 'opus')

      const lines = [
        'The user has passed you a question instead of answering it themselves.',
        '',
        `From: ${asker?.name ?? 'a teammate'}${asker ? ` (${asker.role})` : ''}`,
        ticket ? `Ticket: #${ticket.number} ${ticket.title}` : 'Ticket: none',
        `Question id: ${questionId}`,
        '',
        `They asked: ${q.question}`,
      ]
      if (q.context) lines.push(`What they found: ${q.context}`)
      if (q.choices.length) lines.push(`Options they offered: ${q.choices.join(' | ')}`)
      lines.push(
        '',
        'They are blocked, and every stretch of waiting costs them a model turn. Work it out',
        "from the ticket, the user's earlier messages, the code and project memory, then either:",
        `- \`answer_question("${questionId}", ...)\` — you are confident; they carry on at once.`,
        `- \`escalate_question("${questionId}", ...)\` — a real judgement call; say what you`,
        '  checked and it goes back to the user with your work attached.',
        '',
        'The user can still answer it at any moment. If they get there first your call is simply',
        'ignored, so do not worry about racing them.',
      )
      pilot.notify(projectId, lines.join('\n'))
      return true
    },
  )

  /**
   * Everything one ticket knows about itself.
   *
   * Clicking a ticket used to do nothing at all — a grep for `selectedTicket|TicketDetail|
   * Modal|Drawer` across the whole renderer returned nothing, and the only editable field on a
   * ticket anywhere in the app was which lane it sat in, changed by dragging it. Meanwhile the
   * body (the Pilot's brief), the route rationale, per-step assignee and effort, the branch and
   * worktree, and the cost were all recorded and rendered nowhere.
   *
   * Assembled here rather than in four renderer round-trips: the diff and the spend are both
   * derived, and deriving them in one place keeps the corrections below in one place too.
   */
  handle('tickets:detail', z.object({ ticketId: z.string().min(1) }), async ({ ticketId }) => {
    const ticket = getTicket(ticketId)
    if (!ticket) return null
    const project = getProject(ticket.projectId)

    /*
     * Which files actually changed, from the diff.
     *
     * There is no other honest source. Teammates — the agents that edit files — never persist
     * their tool calls: `teammate.ts` handles `agent:tool:start` for a status line and has no
     * `agent:tool:end` case at all. Only the Pilot records tool summaries, and the Pilot is
     * hard-blocked from writing files, so even that could never contain an `Edit`. The diff is
     * the truth rather than a reconstruction, and it works on tickets that already exist.
     */
    const files =
      ticket.worktreePath && project
        ? await changedFiles(ticket.worktreePath, project.defaultBaseBranch).catch(() => [])
        : []

    const ahead =
      ticket.branch && project
        ? await commitsAhead(project.path, project.defaultBaseBranch, ticket.branch)
        : 0

    /*
     * What the plan step actually concluded.
     *
     * `teammate.ts` has told plan steps to write `plan.md` since the step kind existed, and
     * nothing ever read it. Surfaced here so the sign-off card can show it — deciding whether
     * to approve a build is exactly the moment the document is worth something.
     */
    let planMd: string | null = null
    if (ticket.worktreePath) {
      try {
        const p = join(ticket.worktreePath, 'plan.md')
        // Capped: a plan long enough to exceed this is not something to read in a card.
        if (existsSync(p)) planMd = readFileSync(p, 'utf8').slice(0, 40_000)
      } catch {
        /* unreadable is the same as absent, for this purpose */
      }
    }

    return {
      ticket,
      accepted: acceptedRoute(ticketId),
      proposed: proposedRoute(ticketId),
      findings: listFindings(ticketId),
      files,
      commitsAhead: ahead,
      planMd,
      spend: ticketSpend(ticketId),
    }
  })

  // ── git ─────────────────────────────────────────────────────────────────────

  /** Where all the work is. Local git only — no network, so it cannot fail offline. */
  handle('git:overview', ProjectId, async ({ projectId }) => {
    const project = getProject(projectId)
    if (!project) return null
    /*
     * Clear ghosts before answering. A ticket marked ready on a branch with nothing on it
     * queues behind itself for ever — #5 in a real project did exactly that, because it
     * reached ready before the commits-ahead guard existed. Swept here because this is the
     * read that happens whenever anyone looks at the Branches tab.
     */
    await sweepEmptyReady(projectId)
    return overview(project.path, project.defaultBaseBranch)
  })

  /**
   * Push the base branch. Never agent branches — the finished result leaves your machine and
   * the working copies never do.
   */
  handle('git:push', ProjectId, async ({ projectId }) => {
    const project = getProject(projectId)
    if (!project) return { ok: false as const, reason: 'That project no longer exists.' }

    const result = await pushBase(project.path, project.defaultBaseBranch)
    addMessage({
      projectId,
      authorType: 'system',
      kind: result.ok ? 'notice' : 'error',
      body: result.ok
        ? `Pushed ${project.defaultBaseBranch} to origin.`
        : `Nothing pushed: ${result.reason}`,
    })
    flushWrites()
    bus.emitDomain({ type: 'messages:changed', projectId })
    return result
  })

  /** Explicit, never polled. A network call happens because you asked for one. */
  handle('git:github', ProjectId, async ({ projectId }) => {
    const project = getProject(projectId)
    if (!project) return null
    return githubStatus(project.path)
  })

  /**
   * Working copies that can be freed.
   *
   * `removeWorktree`, `pruneWorktrees` and `listWorktrees` all existed with **zero callers**,
   * and a comment referred to "the reaper" as though it were a thing. It was not: every ticket
   * left a full copy of the project on the system drive, forever.
   */
  handle('git:worktrees', ProjectId, async ({ projectId }) => {
    const project = getProject(projectId)
    if (!project) return []

    const tickets = listTickets(projectId, true)
    const entries = await listWorktrees(project.path)
    return entries
      // The repository itself is a worktree in git's eyes. It is not a leftover.
      .filter((w) => resolve(w.path) !== resolve(project.path))
      .map((w) => {
        const ticket = tickets.find((t) => t.branch && t.branch === w.branch)
        return {
          path: w.path,
          branch: w.branch,
          ticketNumber: ticket?.number ?? null,
          ticketTitle: ticket?.title ?? null,
          // Safe means merged, or archived — somewhere the work is not only here.
          safeToRemove: ticket ? ticket.mergeState === 'merged' || !!ticket.archivedAt : false,
          bytes: dirSize(w.path),
        }
      })
  })

  handle(
    'git:removeWorktree',
    z.object({ projectId: z.string().min(1), path: z.string().min(1) }),
    async ({ projectId, path }) => {
      const project = getProject(projectId)
      if (!project) return { removed: false, reason: 'That project no longer exists.' }

      // Never force. Losing an agent's uncommitted work to a cleanup pass is not a trade-off
      // worth making for disk space.
      const freed = dirSize(path)
      const result = await removeWorktree(project.path, path)
      if (result.removed) {
        await pruneWorktrees(project.path).catch(() => undefined)
        addMessage({
          projectId,
          authorType: 'system',
          kind: 'notice',
          // Disk space appearing should be something that happened, not something that vanished.
          body: `Working copy removed — ${formatBytes(freed)} freed.`,
        })
        flushWrites()
        bus.emitDomain({ type: 'messages:changed', projectId })
      }
      return result
    },
  )

  handle(
    'git:merge',
    z.object({
      projectId: z.string().min(1),
      ticketId: z.string().min(1),
      setAside: z.boolean().optional(),
    }),
    async ({ projectId, ticketId, setAside }) => {
      const project = getProject(projectId)
      const ticket = getTicket(ticketId)
      if (!project || !ticket) return { ok: false, reason: 'That ticket no longer exists.' }

      /*
       * The same service the automatic path uses.
       *
       * These were two implementations of one operation, which is how they came to differ:
       * the button gained an empty-branch check only after a ticket sat "ready" on a branch
       * with nothing on it for days. One path means one set of guarantees.
       */
      const result = await mergeTicket(ticketId, { setAside })
      if (!result.ok) {
        return { ok: false, reason: result.reason, conflicts: result.conflicts }
      }

      /*
       * Clean up the working copy, now that the work is safe.
       *
       * Only after a merge, and never forced. A Claude session is cwd-bound, so removing a
       * worktree ends any chance of resuming that agent — fine here, because the route is
       * complete and the code is on the base branch. Unmerged worktrees stay: that is where
       * work you might still need lives.
       */
      let freed = ''
      if (ticket.worktreePath) {
        const bytes = dirSize(ticket.worktreePath)
        const removal = await removeWorktree(project.path, ticket.worktreePath)
        if (removal.removed) {
          await pruneWorktrees(project.path).catch(() => undefined)
          freed = ` Working copy removed — ${formatBytes(bytes)} freed.`
        }
      }

      addMessage({
        projectId,
        authorType: 'system',
        kind: 'notice',
        body:
          `#${ticket.number} merged into ${project.defaultBaseBranch} as ` +
          `${result.sha.slice(0, 7)}.${freed}` +
          // Say plainly that their own work was moved and moved back. Silence about that is
          // what makes people distrust a tool that touched their folder.
          (result.setAsideNote ? `\n\n${result.setAsideNote}` : ''),
      })
      flushWrites()
      bus.emitDomain({ type: 'tickets:changed', projectId })
      bus.emitDomain({ type: 'messages:changed', projectId })

      /*
       * The done-report. The diff is the one description of what happened that cannot be
       * wrong, so feed it to the Pilot and have it say what changed in the user's language.
       */
      const changed = ticket.worktreePath
        ? await changedFiles(ticket.worktreePath, project.defaultBaseBranch).catch(() => [])
        : []
      pilot.notify(
        projectId,
        `The user merged #${ticket.number} ("${ticket.title}") into ${project.defaultBaseBranch} ` +
          `as ${result.sha.slice(0, 7)}.` +
          (changed.length
            ? `\n\nFiles changed:\n${changed.map((f) => `  ${f.status} ${f.path}`).join('\n')}`
            : '') +
          `\n\nWrite two or three plain sentences on what actually changed, for someone who ` +
          `did not read the code — "the cookie sentence now says X instead of Y on both ` +
          `language files", not "modified de.ts and en.ts". No preamble, no restating the ` +
          `ticket title.`,
      )

      // A merge is the natural moment to tidy: the ticket's lessons are all written by now.
      curator.maybeRun(projectId, 'merge')
      if (ticket.epicId) {
        reconcileEpic(ticket.epicId)
        bus.emitDomain({ type: 'epics:changed', projectId })
      }

      // Whatever was waiting on this ticket is now free, and may begin.
      freeDependents(projectId)

      return { ok: true, sha: result.sha }
    },
  )

  /**
   * Approve a gated step and let the route carry on.
   *
   * The decision this exists for is "you sign off before it is built" — made with the plan
   * document in front of you, because the planning step has already run by the time you are
   * asked. Approving clears the gate and starts the step immediately.
   */
  handle(
    'routes:approveGate',
    z.object({ projectId: z.string().min(1), ticketId: z.string().min(1) }),
    ({ projectId, ticketId }) => {
      const route = approveGate(ticketId)
      if (!route) return { ok: false, reason: 'There is nothing waiting for approval here.' }

      const ticket = getTicket(ticketId)
      const started = routing.startApproved(ticketId)
      addMessage({
        projectId,
        agentId: null,
        authorType: 'system',
        kind: 'notice',
        body: `#${ticket?.number} approved${started ? ` — ${started} is on it.` : '.'}`,
      })
      flushWrites()
      bus.emitDomain({ type: 'routes:changed', projectId })
      bus.emitDomain({ type: 'tickets:changed', projectId })
      bus.emitDomain({ type: 'messages:changed', projectId })
      return { ok: true }
    },
  )

  // ── epics ───────────────────────────────────────────────────────────────────
  handle('epics:list', ProjectId, ({ projectId }) => listEpics(projectId))

  handle(
    'epics:accept',
    z.object({
      projectId: z.string().min(1),
      epicId: z.string().min(1),
      /** Present when the user edited the breakdown before accepting. */
      pieces: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            body: z.string().max(8000).default(''),
            dependsOnIndexes: z.array(z.number().int().min(0)).max(10).default([]),
            sizeNote: z.string().max(80).nullable().default(null),
          }),
        )
        .min(1)
        .max(15)
        .optional(),
    }),
    ({ projectId, epicId, pieces }) => {
      const created = acceptSplit(epicId, pieces)
      if (created.length === 0) throw new Error('That breakdown could not be turned into tickets.')
      flushWrites()
      bus.emitDomain({ type: 'epics:changed', projectId })
      bus.emitDomain({ type: 'tickets:changed', projectId })
      const e = getEpic(epicId)
      pilot.notify(
        projectId,
        `The user accepted the breakdown for "${e?.title ?? 'that request'}". It is now ` +
          `${created.length} tickets: ${created.map((t) => `#${t.number}`).join(', ')}. ` +
          `Route each of them.`,
      )
      routing.nudge(projectId)
      return created
    },
  )

  handle(
    'epics:reject',
    z.object({
      projectId: z.string().min(1),
      epicId: z.string().min(1),
      reason: z.string().max(500).default(''),
    }),
    ({ projectId, epicId, reason }) => {
      const e = getEpic(epicId)
      rejectSplit(epicId)
      bus.emitDomain({ type: 'epics:changed', projectId })
      pilot.notify(
        projectId,
        `The user turned down the breakdown for "${e?.title ?? 'that request'}".` +
          (reason ? ` They said: ${reason}` : '') +
          ` Talk it through with them before proposing another.`,
      )
      return true
    },
  )

  // ── hires ───────────────────────────────────────────────────────────────────
  handle('hires:list', ProjectId, ({ projectId }) => listOpenHires(projectId))

  handle(
    'hires:accept',
    z.object({
      projectId: z.string().min(1),
      hireId: z.string().min(1),
      // The user may rename or re-tier before approving — that is the point of a proposal.
      overrides: z
        .object({
          name: z.string().min(1).max(40).optional(),
          model: z.string().min(1).optional(),
          instructions: z.string().max(20_000).optional(),
        })
        .optional(),
    }),
    ({ projectId, hireId, overrides }) => {
      const a = acceptHire(hireId, overrides)
      if (!a) throw new Error('That hire could not be made — the name may already be taken.')
      flushWrites()
      bus.emitDomain({ type: 'hires:changed', projectId })
      bus.emitDomain({ type: 'agents:changed', projectId })
      pilot.notify(
        projectId,
        `The user approved hiring ${a.name} — a ${a.role} on ${a.model}. ` +
          (a.instructions ? `Their instructions: ${a.instructions} ` : '') +
          `Assign them with assign_teammate when there is work that suits them.`,
      )
      return a
    },
  )

  handle(
    'hires:reject',
    z.object({
      projectId: z.string().min(1),
      hireId: z.string().min(1),
      reason: z.string().max(500).default(''),
    }),
    ({ projectId, hireId, reason }) => {
      const h = getHire(hireId)
      rejectHire(hireId)
      bus.emitDomain({ type: 'hires:changed', projectId })
      if (h && h.proposedByAgentId) {
        pilot.notify(
          projectId,
          `The user turned down hiring ${h.name}.` +
            (reason ? ` They said: ${reason}` : '') +
            ` Work with the roster you have — do not re-propose the same person.`,
        )
      }
      return true
    },
  )

  // ── review findings ─────────────────────────────────────────────────────────
  handle('findings:list', ProjectId, ({ projectId }) => listOpenFindings(projectId))

  handle(
    'findings:forTicket',
    z.object({ ticketId: z.string().min(1) }),
    ({ ticketId }) => listFindings(ticketId),
  )

  // ── memory ──────────────────────────────────────────────────────────────────
  /** Start the counters again from zero. History is untouched; only the numbers restart. */
  handle('agents:resetUsage', ProjectId, ({ projectId }) => {
    const n = resetProjectUsage(projectId)
    flushWrites()
    bus.emitDomain({ type: 'agents:changed', projectId })
    return n
  })

  handle('memory:list', ProjectId, ({ projectId }) => listMemory(projectId))

  /*
   * The digest, which is the one piece of memory every agent actually loads on spawn. It was
   * readable only by opening the file: the Memory tab listed *entries*, so a project whose
   * digest held real knowledge still reported "Nothing remembered yet".
   */
  handle('memory:digest', ProjectId, ({ projectId }) => {
    const p = getProject(projectId)
    return p ? readDigest(p.path).trim() : ''
  })

  handle(
    'memory:search',
    z.object({ projectId: z.string().min(1), query: z.string().max(2000).default('') }),
    ({ projectId, query }) =>
      query.trim() ? recall(projectId, query, { limit: 20 }) : listMemory(projectId),
  )

  /**
   * Rebuild the index from the markdown. Exposed as a button because it is the honest
   * answer whenever you edit the files by hand — and because being able to press it is the
   * proof that the files, not this table, are the source of truth.
   */
  handle('memory:resync', ProjectId, ({ projectId }) => {
    const p = getProject(projectId)
    if (!p) return 0
    const n = syncMemory(projectId, p.path)
    bus.emitDomain({ type: 'memory:changed', projectId })
    return n
  })

  handle('memory:curate', ProjectId, async ({ projectId }) => curator.run(projectId))

  handle(
    'memory:openFolder',
    z.object({ projectId: z.string().min(1), file: z.string().max(300).default('') }),
    ({ projectId, file }) => {
      const p = getProject(projectId)
      if (!p) return false
      const target = file ? join(memoryDir(p.path), file) : memoryDir(p.path)
      void shell.showItemInFolder(target)
      return true
    },
  )

  // ── comms ───────────────────────────────────────────────────────────────────
  handle('comms:list', ProjectId, ({ projectId }) => listComms(projectId))

  handle(
    /*
     * Say something to the Pilot out of band.
     *
     * This was `comms:post` and it wrote a `shoutout` row attributed to nobody, as though the
     * user were broadcasting to the team. There is deliberately no such channel: you talk to
     * the Pilot and the Pilot talks to the team, because two broadcast paths is how the team
     * ends up holding two conflicting instructions at once.
     *
     * Used by the board's "hand this to X" and by Improve on a presentation card.
     */
    'pilot:tell',
    z.object({
      projectId: z.string().min(1),
      body: z.string().min(1).max(4000),
    }),
    ({ projectId, body }) => {
      pilot.notify(projectId, body)
      return true
    },
  )
}
