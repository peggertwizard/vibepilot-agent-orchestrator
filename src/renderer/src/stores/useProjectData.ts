import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusBatch } from '@shared/events'
import type {
  Agent,
  Comm,
  Epic,
  Finding,
  HireProposal,
  Message,
  Question,
  Ticket,
  TicketDraft,
  TicketRoute,
} from '@shared/types'

export interface LiveText {
  agentId: string
  text: string
  thinking: string
  toolLine: string | null
  /**
   * Summarising the conversation to fit. It takes 30 seconds to five minutes with nothing
   * else on the wire, so without saying so the app looks hung at the one moment killing the
   * agent is most tempting and most costly.
   */
  compacting: boolean
}

/**
 * One thing an agent did, for the watch drawer.
 *
 * Held in memory only. `agent_events` exists in the schema with the right indexes and has
 * never been written to; deciding whether that history is worth maintaining forever is a
 * decision to make after someone has used this twice, not before. A ring of ~200 rows is
 * about 100 KB for a completed fifteen-minute run, which is nothing.
 */
export interface ActivityRow {
  id: string
  at: number
  kind: 'tool' | 'text' | 'thinking' | 'lifecycle'
  /** Tool name, or a lifecycle word like "started". */
  label: string
  /** Tool input, assistant text, or the reason a run ended. */
  detail?: string
  /** Tool output, once it comes back. */
  output?: string
  isError?: boolean
  durationMs?: number | null
  /** Set on rows produced by you typing into the drawer, so they read differently. */
  fromUser?: boolean
}

/** Enough to answer "what is it doing now", not enough to become a schema. */
const ACTIVITY_CAP = 200

export interface ProjectData {
  messages: Message[]
  tickets: Ticket[]
  /** Live routes only — proposed and accepted. Superseded ones stay in the DB. */
  routes: TicketRoute[]
  /** Unresolved review findings across the project. */
  findings: Finding[]
  /** Teammates the Pilot wants to hire, waiting on you. */
  hires: HireProposal[]
  /** Proposed and live epics. */
  epics: Epic[]
  drafts: TicketDraft[]
  agents: Agent[]
  questions: Question[]
  comms: Comm[]
  /**
   * In-flight assistant text, keyed by agent.
   *
   * This used to be a single slot. When the Pilot and a teammate streamed at the same time
   * each overwrote the other, and `messages:changed` cleared the whole buffer — so the Pilot
   * finishing a turn wiped a teammate's in-flight output. That was the entire reason you
   * could never see what anyone was doing.
   */
  live: Record<string, LiveText>
  /** Recent activity per agent, for the watch drawer. Memory only. */
  activity: Record<string, ActivityRow[]>
  quotaResetsAt: number | null
  /** What the CLI said was limited, e.g. which tier. Null when it said nothing useful. */
  quotaStatus: string | null
  refresh: () => void
}

/**
 * One subscription for the whole project view.
 *
 * Streaming deltas are held in component state only — they are display, not truth. When a
 * turn completes the main process writes the assembled message and pushes
 * `messages:changed`, at which point we refetch and drop the live buffer. That means there
 * is exactly one source of truth (SQLite) and no reconciliation logic.
 */
export function useProjectData(projectId: string | null): ProjectData {
  const [messages, setMessages] = useState<Message[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [routes, setRoutes] = useState<TicketRoute[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [hires, setHires] = useState<HireProposal[]>([])
  const [epics, setEpics] = useState<Epic[]>([])
  const [drafts, setDrafts] = useState<TicketDraft[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [comms, setComms] = useState<Comm[]>([])
  const [live, setLive] = useState<Record<string, LiveText>>({})
  const [activity, setActivity] = useState<Record<string, ActivityRow[]>>({})
  const [quotaResetsAt, setQuotaResetsAt] = useState<number | null>(null)
  const [quotaStatus, setQuotaStatus] = useState<string | null>(null)
  const pid = useRef(projectId)
  pid.current = projectId

  const refresh = useCallback(() => {
    if (!projectId) return
    const api = window.vibepilot
    void api.messages.list(projectId).then(setMessages)
    void api.tickets.list(projectId).then(setTickets)
    void api.routes.list(projectId).then(setRoutes)
    void api.findings.list(projectId).then(setFindings)
    void api.hires.list(projectId).then(setHires)
    void api.epics.list(projectId).then(setEpics)
    void api.drafts.list(projectId).then(setDrafts)
    void api.agents.list(projectId).then(setAgents)
    void api.questions.listOpen(projectId).then(setQuestions)
    void api.comms.list(projectId).then(setComms)

    /*
     * Rate-limit state survives a restart.
     *
     * The CLI's `rate_limit_event` has always been written to the project row and never read
     * back — the row mapper did not even select it — so a board that stalled overnight came
     * back this morning with no explanation for why nothing was moving. Reading it here is the
     * difference between "vibePilot is broken" and "your window resets at 09:00".
     */
    void api.projects.get(projectId).then((p) => {
      if (!p) return
      // Only if it is still in the future: an expired reset time is history, not a warning.
      setQuotaResetsAt(p.rateLimitResetsAt && p.rateLimitResetsAt > Date.now() ? p.rateLimitResetsAt : null)
    })
  }, [projectId])

  useEffect(() => {
    setMessages([])
    setTickets([])
    setRoutes([])
    setFindings([])
    setHires([])
    setEpics([])
    setDrafts([])
    setAgents([])
    setQuestions([])
    setComms([])
    setLive({})
    setActivity({})
    refresh()
  }, [projectId, refresh])

  useEffect(() => {
    const off = window.vibepilot.bus.subscribe((batch: BusBatch) => {
      applyEvents(batch, setLive, setActivity)

      for (const d of batch.domain) {
        if ('projectId' in d && d.projectId !== pid.current) continue
        switch (d.type) {
          case 'messages:changed':
            // Only the Pilot's stream becomes a chat message; clearing the whole buffer here
            // is what used to wipe a teammate's in-flight output whenever the Pilot finished.
            // The per-agent slots are cleared by their own agent:done instead.
            if (pid.current) void window.vibepilot.messages.list(pid.current).then(setMessages)
            break
          case 'tickets:changed':
            if (pid.current) void window.vibepilot.tickets.list(pid.current).then(setTickets)
            break
          case 'routes:changed':
            if (pid.current) {
              void window.vibepilot.routes.list(pid.current).then(setRoutes)
              // A route only moves for a reason, and half those reasons are a failed review.
              void window.vibepilot.findings.list(pid.current).then(setFindings)
            }
            break
          case 'drafts:changed':
            if (pid.current) void window.vibepilot.drafts.list(pid.current).then(setDrafts)
            break
          case 'agents:changed':
            if (pid.current) void window.vibepilot.agents.list(pid.current).then(setAgents)
            break
          case 'hires:changed':
            if (pid.current) void window.vibepilot.hires.list(pid.current).then(setHires)
            break
          case 'epics:changed':
            if (pid.current) void window.vibepilot.epics.list(pid.current).then(setEpics)
            break
          case 'questions:changed':
            if (pid.current) void window.vibepilot.questions.listOpen(pid.current).then(setQuestions)
            break
          case 'comms:changed':
            if (pid.current) void window.vibepilot.comms.list(pid.current).then(setComms)
            break
          case 'quota:changed':
            setQuotaResetsAt(d.resetsAt)
            // The CLI says WHAT was limited, not just when it clears. That string was
            // written on every rate-limit event and rendered nowhere.
            setQuotaStatus(d.status || null)
            break
          case 'projects:changed':
            // Handled in App, which owns the project list. Nothing to refetch here.
            break
        }
      }
    })
    return off
  }, [])

  return {
    messages,
    tickets,
    routes,
    findings,
    hires,
    epics,
    drafts,
    agents,
    questions,
    comms,
    live,
    activity,
    quotaResetsAt,
    quotaStatus,
    refresh,
  }
}

let rowSeq = 0

function applyEvents(
  batch: BusBatch,
  setLive: React.Dispatch<React.SetStateAction<Record<string, LiveText>>>,
  setActivity: React.Dispatch<React.SetStateAction<Record<string, ActivityRow[]>>>,
): void {
  const push = (agentId: string, row: Omit<ActivityRow, 'id' | 'at'>): void =>
    setActivity((cur) => {
      const list = cur[agentId] ?? []
      const next = [...list, { ...row, id: `r${++rowSeq}`, at: Date.now() }]
      return { ...cur, [agentId]: next.slice(-ACTIVITY_CAP) }
    })

  for (const e of batch.events) {
    // Maintenance passes (the startup scan, the memory curator) are real Claude processes
    // that emit on the shared bus, but they have no agent row and are not a conversation.
    // Without this they populate the live buffer, and the app shows a "Pilot" that does not
    // exist yet streaming raw JSON into the chat.
    if (e.agentId.startsWith('bootstrap:') || e.agentId.startsWith('curator:')) continue
    const slot = (cur: Record<string, LiveText>): LiveText =>
      cur[e.agentId] ?? {
        agentId: e.agentId,
        text: '',
        thinking: '',
        toolLine: null,
        compacting: false,
      }

    switch (e.type) {
      case 'agent:started':
        push(e.agentId, { kind: 'lifecycle', label: 'started' })
        break

      case 'agent:text':
        // Something you typed, echoed into the transcript so Send leaves a trace.
        if (e.fromUser) {
          if (e.final) push(e.agentId, { kind: 'text', label: 'you said', detail: e.final, fromUser: true })
          break
        }
        if (e.delta) {
          setLive((cur) => {
            const s = slot(cur)
            return { ...cur, [e.agentId]: { ...s, text: s.text + e.delta } }
          })
        }
        if (e.final) push(e.agentId, { kind: 'text', label: 'said', detail: e.final })
        break

      case 'agent:thinking':
        if (e.phase === 'compacting') {
          setLive((cur) => ({ ...cur, [e.agentId]: { ...slot(cur), compacting: true } }))
          push(e.agentId, { kind: 'lifecycle', label: 'compacting' })
        } else if (e.delta) {
          setLive((cur) => {
            const s = slot(cur)
            return { ...cur, [e.agentId]: { ...s, thinking: s.thinking + e.delta } }
          })
        }
        break

      case 'agent:tool:start':
        setLive((cur) => ({ ...cur, [e.agentId]: { ...slot(cur), toolLine: e.name } }))
        // The streaming stub arrives first with no input; the real one follows. Recording
        // both would double every tool call in the drawer.
        if (e.input !== undefined) {
          push(e.agentId, {
            kind: 'tool',
            label: e.name,
            detail: typeof e.input === 'string' ? e.input : JSON.stringify(e.input, null, 2),
          })
        }
        break

      case 'agent:tool:end':
        setActivity((cur) => {
          const list = cur[e.agentId] ?? []
          // Attach the output to the most recent matching call rather than adding a row —
          // a call and its result are one thing that happened, not two.
          for (let i = list.length - 1; i >= 0; i--) {
            const r = list[i]!
            if (r.kind === 'tool' && r.label === e.name && r.output === undefined) {
              const next = [...list]
              next[i] = { ...r, output: e.raw ?? e.summary, isError: e.isError, durationMs: e.durationMs }
              return { ...cur, [e.agentId]: next }
            }
          }
          return cur
        })
        break

      case 'agent:degraded':
        // The boundary is the end of the pause: the summary exists and work resumes.
        if (e.reason === 'compacted') {
          setLive((cur) => ({ ...cur, [e.agentId]: { ...slot(cur), compacting: false } }))
          push(e.agentId, { kind: 'lifecycle', label: 'compacted', detail: e.detail })
        }
        break

      case 'agent:done':
        setLive((cur) => {
          const { [e.agentId]: _gone, ...rest } = cur
          return rest
        })
        push(e.agentId, { kind: 'lifecycle', label: e.terminal === 'budget' ? 'out of budget' : 'finished' })
        break

      case 'agent:error':
        setLive((cur) => {
          const { [e.agentId]: _gone, ...rest } = cur
          return rest
        })
        push(e.agentId, { kind: 'lifecycle', label: 'stopped', detail: e.message, isError: true })
        break
    }
  }
}
