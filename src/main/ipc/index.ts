import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type { DoctorReport } from '@shared/types'
import { checkForUpdate, currentUpdateState, downloadUpdate } from '../updater'
import { dbPath, worktreeRoot } from '../paths'
import {
  addProject,
  archiveProject,
  detectChecks,
  getProject,
  listProjects,
  updateProject,
} from '../db/repos/projects'
import { clearResolveCache, resolveClaude, probeVersion } from '../providers/process/resolve'
import { getSetting, setSetting } from '../db/repos/settings'
import { bootstrap } from '../engine/bootstrap'
import { detectGitRepo, ghVersion, gitVersion } from '../git/repo'
import { mcpServer } from '../mcp/server'
import { registerDomainIpc } from './domain'

type GetWindow = () => BrowserWindow | null

/**
 * Every channel validates its payload here. The renderer is not trusted: a compromised
 * renderer dependency must not be able to spawn a process or read an arbitrary path.
 */
function handle<S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (_e, raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`${channel}: invalid payload — ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    }
    return await fn(parsed.data)
  })
}

const Empty = z.undefined().or(z.null()).or(z.object({}).passthrough()).optional()
const ProjectId = z.object({ projectId: z.string().min(1) })

export function registerIpc(getWindow: GetWindow): void {
  // ── projects ────────────────────────────────────────────────────────────────
  handle('projects:list', Empty, () => listProjects())
  handle('projects:get', ProjectId, ({ projectId }) => getProject(projectId))
  handle('projects:archive', ProjectId, ({ projectId }) => {
    archiveProject(projectId)
    return true
  })
  handle(
    'projects:update',
    z.object({
      projectId: z.string().min(1),
      patch: z.object({
        name: z.string().min(1).max(80).optional(),
        defaultBaseBranch: z.string().min(1).max(120).optional(),
        maxConcurrentAgents: z.number().int().min(1).max(20).optional(),
        escalation: z.enum(['ask_me', 'balanced', 'ship_it']).optional(),
        // Trusting a folder means running whatever hooks its .claude settings define.
        settingsTrusted: z.boolean().optional(),
        checks: z
          .object({
            test: z.string().max(400).nullish(),
            typecheck: z.string().max(400).nullish(),
            lint: z.string().max(400).nullish(),
            build: z.string().max(400).nullish(),
          })
          .optional(),
        deployCmd: z.string().max(1000).nullish(),
        deployNote: z.string().max(4000).nullish(),
        // One pass is a legitimate choice; more than five is a loop nobody wants to pay for.
        // 0 is "keep going until it passes" — deliberately allowed, and warned about in the UI.
        reviewPasses: z.number().int().min(0).max(20).nullish(),
        reviewSensitivity: z.number().int().min(1).max(10).optional(),
        launchPaused: z.boolean().optional(),
        pilotModel: z.string().max(80).nullish(),
        pilotEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'ultracode', 'max']).nullish(),
        spendCeilingUsd: z.number().min(0).max(10_000).nullish(),
      }),
    }),
    ({ projectId, patch }) => updateProject(projectId, patch),
  )

  /**
   * Where the Claude binary is, when it is not on PATH.
   *
   * The Doctor's not-found error has always said *"Install it, or set the binary path in
   * Settings"* — and no such control existed. `resolveClaude` already reads this key and
   * `setSetting` had zero callers, so this is the missing four lines rather than a feature.
   */
  handle('settings:claudeBinary', z.object({}).optional(), () => getSetting('claudeBinaryPath'))

  /*
   * Updates are a button, never a background download. `check` returns the state it settled on
   * so the caller can say something immediately rather than waiting on an event.
   */
  handle('update:state', z.object({}).optional(), () => currentUpdateState())
  handle('update:check', z.object({}).optional(), () => checkForUpdate())
  handle('update:download', z.object({}).optional(), async () => {
    await downloadUpdate()
    return currentUpdateState()
  })

  handle(
    'settings:setClaudeBinary',
    z.object({ path: z.string().max(1000) }),
    ({ path }) => {
      setSetting('claudeBinaryPath', path.trim())
      // The resolver caches its answer for the life of the process; a new path is useless
      // until that is dropped.
      clearResolveCache()
      return true
    },
  )

  /**
   * Re-read the commands from `package.json`.
   *
   * Detection runs when a project is added, which does nothing for the projects that already
   * existed before this shipped. Rather than guess on open — an all-blank form is a legitimate
   * choice and overwriting it would be worse than the gap — this is a button.
   */
  handle('projects:detectChecks', ProjectId, ({ projectId }) => {
    const project = getProject(projectId)
    if (!project) return null
    return updateProject(projectId, { checks: detectChecks(project.path) })
  })

  /** Scan the repo and propose a starting team. User-initiated; costs one Haiku turn. */
  handle('projects:bootstrap', ProjectId, ({ projectId }) => bootstrap.scan(projectId))

  /** "Not now" — records the offer as resolved so it is not asked again on every launch. */
  handle('projects:bootstrapSkip', ProjectId, ({ projectId }) => {
    bootstrap.skip(projectId)
    return true
  })

  /** Add a project by picking a folder. Path never comes from the renderer. */
  handle('projects:pick', Empty, async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose a project folder',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const path = res.filePaths[0]
    const git = await detectGitRepo(path)
    const project = addProject({
      path,
      gitRemote: git.remote,
      defaultBaseBranch: git.defaultBranch ?? 'main',
    })
    // Deliberately NOT scanning here. It spends a model turn on the user's account, and
    // doing that unannounced the instant a folder is picked is both surprising and
    // expensive. The renderer offers it, with the cost stated.
    return project
  })

  // ── system ──────────────────────────────────────────────────────────────────
  handle('system:doctor', Empty, async (): Promise<DoctorReport> => {
    const problems: string[] = []
    const resolved = await resolveClaude()
    let version: string | null = null
    if (resolved) {
      version = await probeVersion(resolved)
      if (!version) problems.push('Found the Claude binary but could not read its version.')
    } else {
      problems.push(
        'Claude Code was not found. Install it, or set the binary path in Settings. vibePilot ' +
          'runs your own claude executable — it never handles your credentials.',
      )
    }
    const gv = await gitVersion()
    if (!gv) problems.push('git was not found on PATH. Worktrees and merging will not work.')

    // Deliberately NOT a problem when absent. It is listed so its absence is visible rather
    // than mysterious — the GitHub section simply does not appear, and nothing else changes.
    const gh = await ghVersion()

    return {
      claudeBinary: resolved?.file ?? null,
      claudeVersion: version,
      claudeKind: resolved?.kind ?? null,
      gitVersion: gv,
      ghVersion: gh,
      mcpPort: mcpServer.boundPort,
      dbPath: dbPath(),
      worktreeRoot: worktreeRoot(),
      problems,
    }
  })

  handle('system:openExternal', z.object({ url: z.string().url() }), async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs may be opened.')
    await shell.openExternal(url)
    return true
  })

  handle('system:revealInExplorer', z.object({ path: z.string().min(1) }), ({ path }) => {
    shell.showItemInFolder(path)
    return true
  })

  // ── window chrome (frameless) ───────────────────────────────────────────────
  handle('window:minimize', Empty, () => (getWindow()?.minimize(), true))
  handle('window:maximize', Empty, () => {
    const w = getWindow()
    if (!w) return false
    w.isMaximized() ? w.unmaximize() : w.maximize()
    return w.isMaximized()
  })
  handle('window:close', Empty, () => (getWindow()?.close(), true))

  registerDomainIpc(handle)
}
