import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BusBatch } from '@shared/events'
import type {
  Agent,
  Attachment,
  BranchOverview,
  Comm,
  Deployment,
  DoctorReport,
  Environment,
  Epic,
  EpicPiece,
  Finding,
  GhStatus,
  HireProposal,
  MemoryEntry,
  Message,
  PreviewInfo,
  Project,
  Question,
  StepKind,
  Ticket,
  TicketDetail,
  TicketDraft,
  TicketRoute,
  UpdateState,
  WorktreeInfo,
} from '@shared/types'

/**
 * The only bridge between renderer and main. `ipcRenderer` itself is never exposed — the
 * renderer gets a fixed set of named operations, each validated again in main.
 */
const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload ?? {}) as Promise<T>

const api = {
  projects: {
    list: () => invoke<Project[]>('projects:list'),
    get: (projectId: string) => invoke<Project | null>('projects:get', { projectId }),
    pick: () => invoke<Project | null>('projects:pick'),
    update: (projectId: string, patch: Record<string, unknown>) =>
      invoke<Project | null>('projects:update', { projectId, patch }),
    /** Re-read the check commands from package.json. Costs nothing; overwrites what is there. */
    detectChecks: (projectId: string) =>
      invoke<Project | null>('projects:detectChecks', { projectId }),
    /** Reads the repo and proposes a starting team. Spends one Haiku turn. */
    bootstrap: (projectId: string) => invoke<boolean>('projects:bootstrap', { projectId }),
    bootstrapSkip: (projectId: string) => invoke<boolean>('projects:bootstrapSkip', { projectId }),
  },
  messages: {
    list: (projectId: string) => invoke<Message[]>('messages:list', { projectId }),
    send: (projectId: string, text: string, model: string, attachments: Attachment[] = []) =>
      invoke<boolean>('messages:send', { projectId, text, model, attachments }),
    /** Opens a file dialog in main and copies the picks into userData. */
    attach: () => invoke<Attachment[]>('messages:attach'),
    /**
     * Dropped files. The renderer passes paths only — main does the reading, the copying and
     * the size check, exactly as the picker does.
     */
    attachPaths: (paths: string[]) => invoke<Attachment[]>('messages:attachPaths', { paths }),
    /** A pasted image has no path, so the bytes come through. Screenshots, mostly. */
    attachData: (name: string, dataBase64: string) =>
      invoke<Attachment | null>('messages:attachData', { name, dataBase64 }),
    /** Skills and commands this repo defines — what the `/` menu lists under "this project". */
    commands: (projectId: string) =>
      invoke<Array<{ name: string; description: string }>>('messages:commands', { projectId }),
    stop: (projectId: string) => invoke<boolean>('messages:stop', { projectId }),
  },
  tickets: {
    list: (projectId: string, includeArchived = false) =>
      invoke<Ticket[]>('tickets:list', { projectId, includeArchived }),
    create: (input: {
      projectId: string
      title: string
      body?: string
      lane?: string
      needsPlanning?: boolean
    }) => invoke<Ticket>('tickets:create', input),
    update: (projectId: string, ticketId: string, patch: Record<string, unknown>) =>
      invoke<Ticket | null>('tickets:update', { projectId, ticketId, patch }),
    archive: (projectId: string, ticketId: string) =>
      invoke<boolean>('tickets:archive', { projectId, ticketId }),
    /** Everything one ticket knows: route, findings, the diff, and what it cost. */
    detail: (ticketId: string) => invoke<TicketDetail | null>('tickets:detail', { ticketId }),
  },
  routes: {
    list: (projectId: string) => invoke<TicketRoute[]>('routes:list', { projectId }),
    accept: (
      projectId: string,
      routeId: string,
      steps?: Array<{
        kind: StepKind
        note?: string | null
        assigneeAgentId?: string | null
        brief?: string | null
      }>,
    ) => invoke<TicketRoute | null>('routes:accept', { projectId, routeId, steps }),
    reject: (projectId: string, routeId: string, reason = '') =>
      invoke<boolean>('routes:reject', { projectId, routeId, reason }),
    forTicket: (ticketId: string) =>
      invoke<{ accepted: TicketRoute | null; proposed: TicketRoute | null }>('routes:forTicket', {
        ticketId,
      }),
  },
  drafts: {
    list: (projectId: string) => invoke<TicketDraft[]>('drafts:list', { projectId }),
    accept: (projectId: string, draftId: string) =>
      invoke<Ticket | null>('drafts:accept', { projectId, draftId }),
    update: (projectId: string, draftId: string, patch: Record<string, unknown>) =>
      invoke<TicketDraft | null>('drafts:update', { projectId, draftId, patch }),
    reject: (projectId: string, draftId: string, reason = '') =>
      invoke<boolean>('drafts:reject', { projectId, draftId, reason }),
  },
  agents: {
    list: (projectId: string) => invoke<Agent[]>('agents:list', { projectId }),
    stop: (agentId: string) => invoke<boolean>('agents:stop', { agentId }),
    /** Pick a stalled teammate back up, resuming its session rather than starting cold. */
    restart: (agentId: string) =>
      invoke<{ ok: boolean; reason?: string }>('agents:restart', { agentId }),
    create: (input: {
      projectId: string
      name: string
      role: string
      provider: string
      model: string
      effort?: string | null
      instructions?: string
    }) => invoke<Agent>('agents:create', input),
    update: (projectId: string, agentId: string, patch: Record<string, unknown>) =>
      invoke<Agent | null>('agents:update', { projectId, agentId, patch }),
    remove: (projectId: string, agentId: string) =>
      invoke<boolean>('agents:delete', { projectId, agentId }),
    /** Zero every counter on this project. History stays; only the numbers restart. */
    resetUsage: (projectId: string) => invoke<number>('agents:resetUsage', { projectId }),
    /** Straight into a live teammate's stdin. The Pilot is told, but not asked. */
    message: (projectId: string, agentId: string, text: string) =>
      invoke<boolean>('agents:message', { projectId, agentId, text }),
  },
  questions: {
    listOpen: (projectId: string) => invoke<Question[]>('questions:listOpen', { projectId }),
    /** Open questions per project — what the sidebar badges the projects you are not looking at with. */
    counts: () => invoke<Record<string, number>>('questions:counts'),
    answer: (projectId: string, questionId: string, answer: string) =>
      invoke<boolean>('questions:answer', { projectId, questionId, answer }),
    /**
     * Hand it to the Pilot. The question stays open and you can still answer it yourself —
     * whoever gets there first wins.
     */
    askPilot: (projectId: string, questionId: string) =>
      invoke<boolean>('questions:askPilot', { projectId, questionId }),
  },
  git: {
    /** Local git only: where you are, what the agents have, what is unpushed. Works offline. */
    overview: (projectId: string) => invoke<BranchOverview | null>('git:overview', { projectId }),
    /** Pushes the BASE branch. Agent branches never leave the machine. */
    push: (projectId: string) =>
      invoke<{ ok: boolean; pushed?: number; reason?: string }>('git:push', { projectId }),
    /** Read-only, and only when you ask. Absent rather than broken without `gh`. */
    github: (projectId: string) => invoke<GhStatus | null>('git:github', { projectId }),
    worktrees: (projectId: string) => invoke<WorktreeInfo[]>('git:worktrees', { projectId }),
    removeWorktree: (projectId: string, path: string) =>
      invoke<{ removed: boolean; reason?: string }>('git:removeWorktree', { projectId, path }),
    /**
     * Squash-merges locally. `setAside` puts your own unsaved work to one side for the merge
     * and hands it straight back — never done without you asking for it.
     */
    merge: (projectId: string, ticketId: string, setAside = false) =>
      invoke<{ ok: boolean; sha?: string; reason?: string; conflicts?: string[] }>('git:merge', {
        projectId,
        ticketId,
        setAside,
      }),
  },
  epics: {
    list: (projectId: string) => invoke<Epic[]>('epics:list', { projectId }),
    /** Turns the breakdown into real tickets. Nothing exists until this is called. */
    accept: (projectId: string, epicId: string, pieces?: EpicPiece[]) =>
      invoke<Ticket[]>('epics:accept', { projectId, epicId, pieces }),
    reject: (projectId: string, epicId: string, reason = '') =>
      invoke<boolean>('epics:reject', { projectId, epicId, reason }),
  },
  hires: {
    list: (projectId: string) => invoke<HireProposal[]>('hires:list', { projectId }),
    accept: (
      projectId: string,
      hireId: string,
      overrides?: { name?: string; model?: string; instructions?: string },
    ) => invoke<Agent>('hires:accept', { projectId, hireId, overrides }),
    reject: (projectId: string, hireId: string, reason = '') =>
      invoke<boolean>('hires:reject', { projectId, hireId, reason }),
  },
  findings: {
    /** Everything still outstanding across the project — drives the board badges. */
    list: (projectId: string) => invoke<Finding[]>('findings:list', { projectId }),
    forTicket: (ticketId: string) => invoke<Finding[]>('findings:forTicket', { ticketId }),
  },
  memory: {
    search: (projectId: string, query: string) =>
      invoke<MemoryEntry[]>('memory:search', { projectId, query }),
    /** Rebuild the index from the markdown files. They are the source of truth. */
    /** The digest every agent loads on spawn. Empty string when there is none. */
    digest: (projectId: string) => invoke<string>('memory:digest', { projectId }),
    resync: (projectId: string) => invoke<number>('memory:resync', { projectId }),
    curate: (projectId: string) => invoke<boolean>('memory:curate', { projectId }),
    openFolder: (projectId: string, file = '') =>
      invoke<boolean>('memory:openFolder', { projectId, file }),
  },
  comms: {
    list: (projectId: string) => invoke<Comm[]>('comms:list', { projectId }),
    /** Say something to the Pilot out of band. Not a broadcast — there is no such channel. */
    tellPilot: (projectId: string, body: string) =>
      invoke<boolean>('pilot:tell', { projectId, body }),
  },
  settings: {
    /** Where the Claude binary is, when it is not on PATH. Empty means "find it yourself". */
    claudeBinary: () => invoke<string | null>('settings:claudeBinary'),
    setClaudeBinary: (path: string) => invoke<boolean>('settings:setClaudeBinary', { path }),
  },
  /**
   * Updates. Looking, downloading and installing are three separate acts, and only the first
   * happens on its own — once, at launch.
   */
  /** Sign off on a gated step so the build may start. See RouteStep.gate. */
  gates: {
    approve: (projectId: string, ticketId: string) =>
      invoke<{ ok: boolean; reason?: string }>('routes:approveGate', { projectId, ticketId }),
  },
  attachments: {
    /** An attached image as a data URL, or null if it is not one we will inline. */
    data: (path: string) => invoke<string | null>('attachments:data', { path }),
  },
  /** Dev servers running against a ticket's worktree. See engine/preview.ts. */
  preview: {
    start: (ticketId: string) =>
      invoke<{ ok: boolean; reason?: string; preview?: PreviewInfo }>('preview:start', { ticketId }),
    stop: (ticketId: string) => invoke<{ ok: boolean }>('preview:stop', { ticketId }),
    list: (projectId: string) => invoke<PreviewInfo[]>('preview:list', { projectId }),
  },
  environments: {
    list: (projectId: string) => invoke<Environment[]>('environments:list', { projectId }),
    save: (input: {
      projectId: string
      name: string
      cmd: string
      confirm?: boolean
      position?: number
    }) => invoke<Environment>('environments:save', input),
    remove: (envId: string) => invoke<boolean>('environments:delete', { envId }),
  },
  deployments: {
    list: (projectId: string) => invoke<Deployment[]>('deployments:list', { projectId }),
    /** The confirmation the Pilot's `deploy` tool cannot give itself. */
    run: (envId: string, ticketId?: string | null) =>
      invoke<{ ok: boolean; reason?: string; deployment?: Deployment }>('deploy:run', {
        envId,
        ticketId: ticketId ?? null,
      }),
  },
  update: {
    /** The running build, from package.json via Electron. */
    version: () => invoke<string>('update:version'),
    state: () => invoke<UpdateState>('update:state'),
    check: () => invoke<UpdateState>('update:check'),
    download: () => invoke<UpdateState>('update:download'),
  },
  system: {
    doctor: () => invoke<DoctorReport>('system:doctor'),
    openExternal: (url: string) => invoke<boolean>('system:openExternal', { url }),
    revealInExplorer: (path: string) => invoke<boolean>('system:revealInExplorer', { path }),
  },
  window: {
    minimize: () => invoke<boolean>('window:minimize'),
    maximize: () => invoke<boolean>('window:maximize'),
    close: () => invoke<boolean>('window:close'),
  },
  /**
   * The real filesystem path of a dropped `File`.
   *
   * `File.path` was removed from Electron's renderer; `webUtils.getPathForFile` is the
   * supported replacement and it only works here in the preload. Returns null for anything
   * without one — a drop from a browser, say — rather than throwing into a drop handler.
   */
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  bus: {
    /** Returns an unsubscribe function. */
    subscribe: (fn: (batch: BusBatch) => void): (() => void) => {
      const listener = (_e: unknown, batch: BusBatch): void => fn(batch)
      ipcRenderer.on('bus:event', listener)
      return () => ipcRenderer.off('bus:event', listener)
    },
    /** Clicking an OS notification asks the window to open the project it came from. */
    onRevealProject: (fn: (projectId: string) => void): (() => void) => {
      const listener = (_e: unknown, projectId: string): void => fn(projectId)
      ipcRenderer.on('vibepilot:reveal-project', listener)
      return () => ipcRenderer.off('vibepilot:reveal-project', listener)
    },
    /** Where a pending app update has got to. Only ever fires in the installed build. */
    onUpdate: (fn: (state: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, state: UpdateState): void => fn(state)
      ipcRenderer.on('vibepilot:update', listener)
      return () => ipcRenderer.off('vibepilot:update', listener)
    },
  },
}

export type VibePilotApi = typeof api

contextBridge.exposeInMainWorld('vibepilot', api)
