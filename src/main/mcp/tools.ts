import { z } from 'zod'
import type { AgentRole } from '@shared/types'
import {
  MAX_REVIEW_PASSES,
  MODEL_OPTIONS,
  STEP_LABEL,
  configuredChecks,
  isValidModel,
  activeStep,
  routeSummary,
} from '@shared/types'
import { commitsAhead } from '../git/branches'
import { hasLanded } from '../git/repo'
import { lastChecksFor, recordChecks, renderChecks, runChecks, runCommand } from '../engine/checks'
import { bus } from '../bus'
import {
  findAgentByName,
  getAgent,
  listAgents,
  listRoster,
  setAgentStatus,
  setAgentStatusLine,
  updateAgent,
} from '../db/repos/agents'
import { launchTeammate } from '../engine/teammate'
import { relaunchAssignee } from '../engine/heal'
import * as gate from '../engine/gate'
import { collisionsFor } from '../engine/overlap'
import { autoMergeFinished } from '../engine/autoMerge'
import { findEnvironment, listEnvironments, recordDeployment } from '../db/repos/environments'
import { manager } from '../engine/manager'
import { pilot } from '../engine/pilot'
import { routing } from '../engine/routing'
import { addComm, addMessage, addQuestion, getQuestion } from '../db/repos/messages'
import { notifyUser } from '../notify'
import { addFindings, renderFindings, resolveFindings } from '../db/repos/findings'
import {
  acceptedRoute,
  assignStep,
  completeActiveStep,
  proposeRoute,
  proposedRoute,
  reworkTo,
  setBacklogOrder,
} from '../db/repos/routes'
import {
  createDraft,
  createTicket,
  getTicket,
  getTicketByNumber,
  updateTicket,
  getDraft,
  resolveDraft,
} from '../db/repos/tickets'
import { proposeSplit, unmetDependencies } from '../db/repos/epics'
import { proposeHire } from '../db/repos/hires'
import { getProject } from '../db/repos/projects'
import { flushWrites } from '../db/writer'
import { recall, recordFeedback, remember, renderForPrompt } from '../memory'
import { curator } from '../memory/curator'
import { askUserGate } from './askUser'

export interface RunBinding {
  runId: string
  agentId: string
  projectId: string
  ticketId: string | null
  role: AgentRole
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * A denial is a RESULT, not an error.
 *
 * A JSON-RPC error makes a model retry blindly — it has no idea what went wrong, so it does
 * the same thing again. A successful result carrying an explanation makes it route
 * correctly: "that ticket isn't yours, DM Dana" produces a DM, not a retry loop.
 */
const deny = (reason: string): ToolResult => ({
  content: [{ type: 'text', text: reason }],
  structuredContent: { ok: false, reason },
})

const okResult = (text: string, data: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: { ok: true, ...data },
})

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  availableTo: (role: AgentRole) => boolean
  schema: z.ZodTypeAny
  run: (args: Record<string, unknown>, b: RunBinding) => Promise<ToolResult> | ToolResult
}

const anyone = (): boolean => true
const pilotOnly = (role: AgentRole): boolean => role === 'pilot'

/** " · ProjectName", or nothing. Notifications arrive with no context otherwise. */
function projectName(projectId: string): string {
  const p = getProject(projectId)
  return p ? ` · ${p.name}` : ''
}

/**
 * The last `run_checks` result per agent, so `mark_ready_to_merge` can say what really happened
 * rather than repeat what it was told. In memory on purpose: it is evidence about *this run*,
 * and a result from a previous process says nothing about the code as it stands now.
 */
/* `lastChecks` moved to engine/checks.ts — auto-merge needs the same answer, and two copies
 * of "did the checks pass" is one too many. */

/**
 * Agents that have called `remember` this run.
 *
 * The brief has always said memory matters and never said that `remember` was the mechanism,
 * so a teammate that had just found a real bug wrote a README about the memory folder instead
 * and the finding died with its final report. Prompt wording alone did not hold, and this is
 * the same shape of fix as the file-overlap refusal: something the model has to handle rather
 * than a paragraph it can skim.
 *
 * In memory rather than the database on purpose — the question is "during this run", and a
 * process restart is a new run with a fresh context that has learned nothing yet.
 */
const remembered = new Set<string>()

/* ─────────────────────────────────────────────────────────────────────────── */

const proposeTicketSchema = z.object({
  title: z.string().min(3).max(120),
  body: z.string().max(20_000).default(''),
  lane: z.enum(['backlog', 'todo', 'in_progress']).default('backlog'),
  needs_planning: z.boolean().default(false),
  owner_hint: z.string().max(60).nullish(),
  size_note: z.string().max(80).nullish(),
  replaces: z.string().max(80).nullish(),
  depends_on: z.array(z.number().int()).default([]),
})

const createTaskSchema = proposeTicketSchema
// `stage` is deliberately absent: the stage is a mirror of the active route step, so letting
// an agent set it directly would let the board disagree with the route.
const updateStatusSchema = z.object({
  ticket: z.number().int(),
  lane: z.enum(['backlog', 'todo', 'in_progress', 'done']).optional(),
  note: z.string().max(500).optional(),
})
const proposeRouteSchema = z.object({
  ticket: z.number().int(),
  steps: z
    .array(
      z.object({
        kind: z.enum(['research', 'plan', 'build', 'review']),
        note: z.string().max(300).nullish(),
        assignee: z.string().max(60).nullish(),
        brief: z.string().max(12_000).nullish(),
        /** Stop before this step and wait for the user. See `RouteStep.gate`. */
        needs_signoff: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(6),
  rationale: z.string().min(1).max(600),
  // Default true: vibePilot decides. False is the escape hatch for a ticket where the
  // Pilot genuinely cannot tell which shape fits — then, and only then, it asks.
  confident: z.boolean().default(true),
  // Null means "use the default for the step kind". A number here is the Pilot's own
  // judgement about how big this particular piece of work is.
  budget_usd: z.number().min(0.5).max(200).nullish(),
})
const advanceStepSchema = z.object({
  ticket: z.number().int(),
  result: z.string().min(1).max(8000),
})
const backlogOrderSchema = z.object({
  order: z.array(z.number().int()).min(1).max(200),
  rationale: z.string().max(600).default(''),
})
const dmSchema = z.object({
  to: z.string().min(1).max(60),
  text: z.string().min(1).max(8000),
})
const shoutSchema = z.object({
  text: z.string().min(1).max(4000),
  severity: z.enum(['info', 'warn', 'blocker']).default('info'),
})
const askSchema = z.object({
  question: z.string().min(1).max(2000),
  choices: z.array(z.string().max(80)).max(6).default([]),
  urgency: z.enum(['blocking', 'background']).default('blocking'),
  context: z.string().max(4000).nullish(),
})
const awaitSchema = z.object({ question_id: z.string().min(1) })
const statusSchema = z.object({ one_line: z.string().min(1).max(120) })
const answerQSchema = z.object({
  question_id: z.string().min(1),
  answer: z.string().min(1).max(8000),
})
const escalateQSchema = z.object({
  question_id: z.string().min(1),
  what_i_checked: z.string().min(1).max(4000),
  recommendation: z.string().max(2000).nullish(),
})
const readySchema = z.object({
  /** Said out loud rather than assumed, so "nothing to record" is a claim someone made. */
  nothing_to_remember: z.boolean().optional(),
  ticket: z.number().int(),
  summary: z.string().min(1).max(4000),
  test_evidence: z.string().max(8000).nullish(),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
})
const assignSchema = z.object({
  agent: z.string().min(1).max(40),
  ticket: z.number().int(),
  brief: z.string().min(1).max(12_000),
})
const suggestHireSchema = z.object({
  name: z.string().min(1).max(40),
  role: z.enum(['builder', 'reviewer', 'scout', 'specialist']),
  model: z.string().min(1),
  why: z.string().min(1).max(600),
  instructions: z.string().max(8000).default(''),
  ticket: z.number().int().nullish(),
})
const updateTeammateSchema = z.object({
  agent: z.string().min(1).max(60),
  instructions: z.string().max(20_000).optional(),
  model: z.string().min(1).optional(),
  why: z.string().min(1).max(600),
})
const proposeSplitSchema = z.object({
  title: z.string().min(3).max(140),
  short_label: z.string().min(1).max(20),
  summary: z.string().min(1).max(2000),
  pieces: z
    .array(
      z.object({
        title: z.string().min(3).max(120),
        body: z.string().max(8000).default(''),
        depends_on: z.array(z.number().int().min(0)).max(10).default([]),
        size_note: z.string().max(80).nullish(),
      }),
    )
    .min(2)
    .max(15),
})
const messageAgentSchema = z.object({
  agent: z.string().min(1).max(60),
  text: z.string().min(1).max(8000),
})
const extendTicketSchema = z.object({
  ticket: z.number().int().positive(),
  addition: z.string().min(1).max(4000),
})
const deploySchema = z.object({
  environment: z.string().min(1).max(60),
  ticket: z.number().int().positive().optional(),
})
const restartStepSchema = z.object({
  ticket: z.number().int().positive(),
  why: z.string().max(400).optional(),
})
const rememberSchema = z.object({
  category: z.enum(['architecture', 'convention', 'gotcha', 'decision', 'glossary', 'lesson']),
  title: z.string().min(3).max(120),
  body: z.string().min(1).max(6000),
  files: z.array(z.string().max(300)).max(20).default([]),
})
const recallSchema = z.object({
  query: z.string().min(2).max(2000),
  agent: z.string().max(60).nullish(),
  limit: z.number().int().min(1).max(20).default(8),
})
const feedbackSchema = z.object({
  agent: z.string().min(1).max(60),
  lesson: z.string().min(3).max(4000),
  title: z.string().max(120).nullish(),
})
const reviewFailedSchema = z.object({
  ticket: z.number().int(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['must', 'should', 'nit']).default('should'),
        summary: z.string().min(3).max(300),
        detail: z.string().max(2000).default(''),
        file: z.string().max(300).nullish(),
        line: z.number().int().positive().nullish(),
      }),
    )
    .min(1)
    .max(30),
  verdict: z.string().min(1).max(2000),
})

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'propose_ticket',
    description:
      'Propose a ticket for the user to accept. This does NOT create a ticket — it shows the ' +
      'user a draft card they can edit, accept or reject. Use this for anything the user ' +
      'asked for. Never create work on their behalf without showing it first.',
    schema: proposeTicketSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Add dark mode toggle".' },
        body: { type: 'string', description: 'What needs doing and why. Markdown is fine.' },
        lane: { type: 'string', enum: ['backlog', 'todo', 'in_progress'] },
        needs_planning: {
          type: 'boolean',
          description: 'True when this should go through a planning stage before anyone writes code.',
        },
        owner_hint: { type: 'string', description: 'Which teammate or role should take it, if you have a view.' },
        size_note: {
          type: 'string',
          description:
            'How long this takes AN AGENT, not a human developer. That distinction is the whole ' +
            'point of the field: a wording change on one page is minutes, not "half a day". ' +
            'Most tickets are minutes. e.g. "~10 min", "under an hour", "a couple of hours". ' +
            'Omit it rather than guess.',
        },
        depends_on: { type: 'array', items: { type: 'number' }, description: 'Ticket numbers this depends on.' },
        replaces: {
          type: 'string',
          description:
            'The draft_id of a proposal still waiting on the user, when this is a REVISION of ' +
            'it rather than a new piece of work. That old card then disappears instead of ' +
            'sitting beside this one. Use it whenever the user told you to change a ticket you ' +
            'have already shown them. Leave it out when you are proposing something different.',
        },
      },
    },
    run: (raw, b) => {
      const a = proposeTicketSchema.parse(raw)

      /*
       * A revision replaces what it revises.
       *
       * Without this a correction produced two cards for one piece of work, and the only way
       * to clear the old one was Discard — which told the Pilot the idea had been turned down.
       * Two corrections in a row therefore read to it as two rejections, and it stopped
       * proposing and started asking. The user had never rejected anything.
       */
      let replaced: string | null = null
      if (a.replaces) {
        const old = getDraft(a.replaces)
        if (old && old.projectId === b.projectId && old.status === 'pending') {
          resolveDraft(a.replaces, 'superseded')
          replaced = old.title
        }
      }

      const draft = createDraft({
        projectId: b.projectId,
        proposedByAgentId: b.agentId,
        title: a.title,
        body: a.body,
        lane: a.lane,
        needsPlanning: a.needs_planning,
        ownerHint: a.owner_hint ?? null,
        sizeNote: a.size_note ?? null,
        dependsOn: a.depends_on,
      })
      bus.emitDomain({ type: 'drafts:changed', projectId: b.projectId })
      return okResult(
        `Draft shown to the user: "${a.title}". It is not a ticket yet — they need to accept it. ` +
          `Do not assume the work is queued.` +
          (replaced ? ` This replaced the earlier draft "${replaced}", which is no longer shown.` : ''),
        { draft_id: draft.id, status: 'awaiting_confirmation', replaced_draft: a.replaces ?? null },
      )
    },
  },

  {
    name: 'create_task',
    description:
      'Create a ticket directly, skipping user confirmation. Only for work you are breaking ' +
      'out of a ticket the user already accepted. For anything the user asked for, use ' +
      'propose_ticket instead.',
    schema: createTaskSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        lane: { type: 'string', enum: ['backlog', 'todo', 'in_progress'] },
        needs_planning: { type: 'boolean' },
        size_note: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'number' } },
      },
    },
    run: (raw, b) => {
      const a = createTaskSchema.parse(raw)
      const t = createTicket({
        projectId: b.projectId,
        title: a.title,
        body: a.body,
        lane: a.lane,
        needsPlanning: a.needs_planning,
        sizeNote: a.size_note ?? null,
        dependsOn: a.depends_on,
      })
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      return okResult(`Created ticket #${t.number}: ${t.title}`, { ticket: t.number, id: t.id })
    },
  },

  {
    name: 'update_task_status',
    description:
      'Move a ticket between lanes. You may only touch the ticket you are assigned to, unless ' +
      'you are the Pilot. To move through the ticket\'s route, use advance_step instead — the ' +
      'stage shown on the board is derived from the route, not set by hand.',
    schema: updateStatusSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['ticket'],
      properties: {
        ticket: { type: 'number', description: 'Ticket number, e.g. 12.' },
        lane: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'done'] },
        note: { type: 'string', description: 'One line on what changed. Shown to the user.' },
      },
    },
    run: (raw, b) => {
      const a = updateStatusSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket} in this project.`)

      if (b.role !== 'pilot' && t.assigneeAgentId !== b.agentId) {
        const owner = t.assigneeAgentId ? getAgent(t.assigneeAgentId) : null
        return deny(
          `Ticket #${a.ticket} is not yours${owner ? ` — it belongs to ${owner.name}` : ''}. ` +
            `You can only update the ticket you were assigned. Use dm_agent to ask about it.`,
        )
      }

      updateTicket(t.id, { lane: a.lane })
      if (a.note) {
        addMessage({
          projectId: b.projectId,
          agentId: b.agentId,
          authorType: 'system',
          kind: 'notice',
          body: `#${t.number} · ${a.note}`,
        })
        bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
      }
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      return okResult(`#${t.number} updated.`, { ticket: t.number })
    },
  },

  {
    name: 'propose_route',
    description:
      'Decide how THIS ticket should be handled: an ordered list of steps. There is no fixed ' +
      'pipeline and no default shape — read the ticket, look at the code if you need to, and ' +
      'choose the route that actually fits the work. This is your judgement to make.\n\n' +
      'Fit the route to the ticket. A question needs no builder; a risky migration deserves ' +
      'planning. Do not add a step you cannot give a reason for — every handoff costs a cold ' +
      'start and loses what the last agent learned.\n\n' +
      // Whether a review step exists is NOT the Pilot's call. The rule comes from the user's
      // sensitivity setting and is generated into the system prompt; this description used to
      // carry a third, contradicting copy of the old "a visual change earns a review" line,
      // complete with a worked example telling it to review a dark-mode toggle.
      'Whether to include a `review` step is NOT your judgement — your instructions carry the ' +
      'rule the user set, and it is the only test. Do not add one because something feels ' +
      'important or is visible on screen.\n\n' +
      'Worked examples (the review steps below assume the rule permits one):\n' +
      '  "Fix the typo in the footer"         -> [build]\n' +
      '  "Which file handles session expiry?" -> [research]            (no code at all)\n' +
      '  "Change 10 GB to 5 GB on the card"   -> [build]               (wording; no reviewer)\n' +
      '  "Migrate auth to the new provider"   -> [plan, build, review] (schema + access)\n\n' +
      'NOTHING STARTS UNTIL THE USER PRESSES START. This puts a card in front of them ' +
      'showing the route, who does each step, on what model, for how much, and the exact ' +
      'brief each person will receive. Write that brief properly — it is the thing they ' +
      'read to catch a job that is about to be more expensive than it needs to be. ' +
      'Set `confident: false` when you genuinely cannot tell which shape is right; the card ' +
      'then leads with your question instead of with Start.',
    schema: proposeRouteSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['ticket', 'steps', 'rationale'],
      properties: {
        ticket: { type: 'number' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                enum: ['research', 'plan', 'build', 'review'],
                description:
                  'research: find something out and report — no code. plan: work out the ' +
                  'approach first. build: do the work and check it runs. review: independent ' +
                  'eyes, cannot edit.',
              },
              note: { type: 'string', description: 'Why this step is here. Shown to the user.' },
              needs_signoff: {
                type: 'boolean',
                description:
                  'Stop before this step and wait for the user to approve it. Use when they ' +
                  'said something needs their sign-off before it is built. Everything BEFORE ' +
                  'this step still runs immediately — so put the gate on `build` and leave ' +
                  '`plan` open, and they get to decide with the plan in front of them instead ' +
                  'of before anyone has looked at anything.',
              },
              assignee: {
                type: 'string',
                description:
                  'Who does it. Name someone from the roster — the card shows them and the ' +
                  'user starts them with one click. Leave empty only if nobody fits.',
              },
              brief: {
                type: 'string',
                description:
                  'The prompt this person will actually receive, written in full. Be ' +
                  'specific about scope and about what NOT to do: "look at the live page; ' +
                  'do not read the repo unless the page raises a question you cannot answer ' +
                  'from it" costs a fraction of "find one small task". The user reads this ' +
                  'before anything runs.',
              },
            },
          },
        },
        rationale: {
          type: 'string',
          description: 'One line: why this shape fits this ticket. The user reads this.',
        },
        confident: {
          type: 'boolean',
          description:
            'Default true — you are sure, so the card is a one-click Start. Set false when ' +
            'you cannot tell which shape is right and need the user to choose. Either way ' +
            'nothing runs until they say so.',
        },
        budget_usd: {
          type: 'number',
          description:
            'What this ticket is worth spending, in dollars. Judge it from the work, not from ' +
            'a habit: reading one page and reporting back is not the same size as rewriting a ' +
            'flow. The assignee is told this number and paces itself against it, and a hard ' +
            'stop sits at twice it. Omit to use the default for the step kind ' +
            '(research $3, plan $3, review $4, build $12). The user can change it.',
        },
      },
    },
    run: async (raw, b) => {
      const a = proposeRouteSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)

      /*
       * Refuse a route onto a file something else is already editing.
       *
       * Prompt guidance did not hold: the instructions said to avoid collisions and #1, #3
       * and #4 all landed on `preise-defaults.ts` anyway. A denial the Pilot has to handle
       * is a different kind of instruction from a paragraph it may skim, and this is the one
       * case where being mechanical is strictly better than being clever.
       */
      const collisions = await collisionsFor(
        t,
        a.steps.map((s) => `${s.note ?? ''} ${s.brief ?? ''}`).join('\n'),
      )
      if (collisions.length > 0) {
        const c = collisions[0]!
        return deny(
          `#${t.number} would edit ${c.files.join(', ')}, which #${c.with.ticketNumber} ` +
            `("${c.with.title}") is editing right now. Two branches on one file cannot be ` +
            `merged in either order — whichever lands second brings back what the first ` +
            `removed.\n\n` +
            `Do one of these instead:\n` +
            `- \`extend_ticket\` on #${c.with.ticketNumber} — add this to the work already ` +
            `running. Usually right for a small change.\n` +
            `- Wait until #${c.with.ticketNumber} is merged, and say so to the user in one line.\n\n` +
            `Do not propose this route again unchanged.`,
        )
      }

      const steps = a.steps.map((s) => {
        const who = s.assignee ? findAgentByName(b.projectId, s.assignee) : null
        return {
          kind: s.kind,
          note: s.note ?? null,
          assigneeAgentId: who?.id ?? null,
          brief: s.brief ?? null,
          gate: s.needs_signoff ?? false,
        }
      })
      const unknown = a.steps.filter((s) => s.assignee && !findAgentByName(b.projectId, s.assignee))
      if (unknown.length) {
        return deny(
          `No teammate called "${unknown[0]!.assignee}". Propose the route without an assignee ` +
            `and spawn someone, or use a name from the roster.`,
        )
      }

      if (a.budget_usd != null) updateTicket(t.id, { budgetUsd: a.budget_usd })

      proposeRoute({
        ticketId: t.id,
        projectId: b.projectId,
        steps,
        rationale: a.rationale,
        proposedByAgentId: b.agentId,
      })
      flushWrites()

      bus.emitDomain({ type: 'routes:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      /*
       * A card that needs pressing is something waiting on the user, and nothing said so unless
       * they happened to be looking at the window. Questions notified; a route that stops all
       * work on a ticket until Start is pressed did not.
       */
      notifyUser({
        projectId: b.projectId,
        title: `#${t.number} is ready to start${projectName(b.projectId)}`,
        body: `${t.title} — ${routeSummary(steps)}. Nothing runs until you press Start.`,
      })

      /*
       * Start it now, if the project is set to.
       *
       * Read fresh rather than passed in: the route was just written, and this is the moment
       * the decision is actually made. `maybeAutoStart` owns every reason not to.
       */
      const fresh = proposedRoute(t.id)
      const autoStarted = fresh ? routing.maybeAutoStart(fresh, a.confident !== false) : false
      if (autoStarted) {
        return okResult(
          `#${t.number} has started: ${routeSummary(steps)}. The user did not have to press ` +
            `anything — tell them in one short line what is now running and why. Nothing has ` +
            `been merged or deployed; they can stop or change it from the card.`,
          { ticket: t.number, route: routeSummary(steps), status: 'started' },
        )
      }

      const named = steps.filter((s) => s.assigneeAgentId).length
      return okResult(
        `#${t.number} is on screen for the user: ${routeSummary(steps)}` +
          (named ? `, with ${named === steps.length ? 'everyone' : 'some steps'} assigned` : '') +
          `. Nothing has started. They press Start and vibePilot launches whoever you named — ` +
          `you do not need to call assign_teammate afterwards. ` +
          (a.confident
            ? `Say in one short line what you proposed and why. Do not restate the card.`
            : `Ask them the one question you could not answer yourself.`),
        { ticket: t.number, route: routeSummary(steps), status: 'awaiting_confirmation' },
      )
    },
  },

  {
    name: 'advance_step',
    description:
      'Finish your current step on a ticket and hand on to the next one, if there is a next ' +
      'one. Only the assignee of the active step may call this. If the route ends here, the ' +
      'ticket is done and the user is told.',
    schema: advanceStepSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['ticket', 'result'],
      properties: {
        ticket: { type: 'number' },
        result: {
          type: 'string',
          description:
            'What you actually found or did. For a research step this IS the answer — write ' +
            'it in full, it is what the user reads.',
        },
      },
    },
    run: async (raw, b) => {
      const a = advanceStepSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)

      const route = acceptedRoute(t.id)
      if (!route) {
        return deny(
          `#${a.ticket} has no accepted route, so there is no step to advance. The Pilot has ` +
            `to propose one first.`,
        )
      }
      const cur = activeStep(route)
      if (!cur) return deny(`Every step on #${a.ticket} is already finished.`)
      if (b.role !== 'pilot' && cur.assigneeAgentId && cur.assigneeAgentId !== b.agentId) {
        const owner = getAgent(cur.assigneeAgentId)
        return deny(
          `The ${STEP_LABEL[cur.kind]} step on #${a.ticket} belongs to ${owner?.name ?? 'someone else'}, ` +
            `not you.`,
        )
      }

      // Finishing a build step means the fix list was worked. Close it out so the next
      // reviewer sees a clean slate rather than re-reporting what was already fixed.
      if (cur.kind === 'build') resolveFindings(t.id, cur.passes)

      const out = completeActiveStep(t.id)
      if (!out) return deny(`Could not advance #${a.ticket}.`)

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'agent',
        kind: 'notice',
        body: `#${t.number} · ${STEP_LABEL[cur.kind]} finished\n\n${a.result}`,
      })
      /*
       * Parked for a sign-off. Not complete, and emphatically not ready to merge — the work so
       * far is a plan document, and marking it ready would try to merge that as the feature.
       */
      if (out.gated) {
        addMessage({
          projectId: b.projectId,
          agentId: null,
          authorType: 'system',
          kind: 'notice',
          body:
            `#${t.number} is waiting for your sign-off before the ` +
            `${STEP_LABEL[out.next!.kind]} step starts. The plan is on the ticket.`,
        })
        notifyUser({
          projectId: b.projectId,
          title: `#${t.number} needs your sign-off`,
          body: `${t.title} — planning is done; approve it to start building.`,
        })
        flushWrites()
        bus.emitDomain({ type: 'routes:changed', projectId: b.projectId })
        bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
        bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
        return okResult(
          `#${t.number} is parked for the user's sign-off before ${STEP_LABEL[out.next!.kind]}. ` +
            `Tell them in one short line what the plan concluded and what you need approved. ` +
            `Do not start building.`,
        )
      }

      if (out.routeComplete) {
        /*
         * Done means the route finished. It does not mean the work landed.
         *
         * This used to write `lane: 'done'` and stop, which jumped the merge queue entirely —
         * ticket #1 sits in Done with a branch, a worktree, a NULL head_sha and nothing in the
         * UI pointing at it. Ready was empty not because it was broken but because
         * `mark_ready_to_merge` had never been called once and this path went round it.
         *
         * The gate is `rev-list --count base..branch`, not the agent's word for it. Commits
         * either exist or they do not; a research route with an empty diff has nothing to merge
         * and belongs straight in Done, and one that produced code belongs in front of you.
         *
         * The fix for that was `lane: 'in_progress'`, which traded one false statement for
         * another and put a finished ticket in the In progress column. Neither is written now:
         * `readyToMerge` is the fact, and the Waiting for you lane is derived from it in
         * `shared/board.ts`. No caller picks a lane any more.
         */
        const project = getProject(b.projectId)
        /*
         * Content, not commit count.
         *
         * `rev-list --count base..branch` answers a bookkeeping question, and a squash merge
         * makes it the wrong one: the changes are copied into the base as one new commit, the
         * originals stay on the branch, and the count keeps reporting them long after every
         * line has landed. A ticket whose work was already on the base was declared ready to
         * merge on the strength of that number, and sat in Waiting for you for ever.
         */
        const unlanded =
          project && t.branch
            ? !(await hasLanded(project.path, project.defaultBaseBranch, t.branch))
            : false
        const commits =
          project && t.branch
            ? await commitsAhead(project.path, project.defaultBaseBranch, t.branch)
            : 0

        if (unlanded) {
          updateTicket(t.id, { readyToMerge: true, mergeState: 'ready' })

          /*
           * Land it, if the project says so.
           *
           * This is where the queue of merge buttons used to begin. Every finished ticket
           * stopped here and waited, so a chain of three became three waits — and #8, which
           * depended on them, waited on all of it.
           *
           * `autoMergeFinished` owns every reason not to, and stops loudly when it stops.
           */
          const landed = await autoMergeFinished(t.id)
          if (!landed) {
            addMessage({
              projectId: b.projectId,
              agentId: b.agentId,
              authorType: 'system',
              kind: 'notice',
              body:
                `#${t.number} finished its route with ${commits} commit${commits === 1 ? '' : 's'} ` +
                `on \`${t.branch}\`. It is waiting for you on the Branches tab.`,
            })
          }
        } else {
          updateTicket(t.id, { lane: 'done' })
        }

        // Release the person, not just the step.
        //
        // Teammate processes never exit on their own, so without this the roster deadlocks
        // after everyone's first ticket: the guard above sees a live run forever and nobody
        // can be assigned again.
        //
        // Route completion, not step completion — `review_failed` sends rework back to the
        // *same* builder and `message_agent` needs that process alive with its context. That
        // is the whole point of the rework design.
        const assignee = cur.assigneeAgentId
        if (assignee && manager.forAgent(assignee)) {
          void manager
            .stop(assignee, `#${t.number} finished`)
            .catch(() => undefined)
            .then(() => bus.emitDomain({ type: 'agents:changed', projectId: b.projectId }))
        }
      }
      flushWrites()
      bus.emitDomain({ type: 'routes:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      /*
       * Research has to end in something you can act on.
       *
       * The failure this fixes: a researcher was asked to "find one small task", spent 15
       * minutes and $7.28, wrote an excellent 35,000-word report — and created nothing.
       * `ticket_drafts` was empty. The whole point of the request was to end with a task.
       */
      if (cur.kind === 'research') {
        pilot.notify(
          b.projectId,
          `Research on #${t.number} finished:\n\n${a.result.slice(0, 4000)}\n\n` +
            `If there is a concrete piece of work in that, call \`propose_ticket\` now with the ` +
            `finding as the body — one ticket, the smallest useful one, not a wishlist. If ` +
            `there genuinely is not, say so in one line and propose nothing. Either way, tell ` +
            `the user what was found in plain words.`,
        )
      } else {
        routing.announceStep(b.projectId, t.number, t.id)
      }

      return out.next
        ? okResult(
            `${STEP_LABEL[cur.kind]} on #${t.number} is done. Next up: ${STEP_LABEL[out.next.kind]}. ` +
              `The Pilot has been told — you do not need to hand over yourself.`,
            { ticket: t.number, next: out.next.kind },
          )
        : okResult(
            `#${t.number} has finished its route. Nothing else is queued for it.`,
            { ticket: t.number, next: null },
          )
    },
  },

  {
    name: 'set_backlog_order',
    description:
      'Say what order the backlog should be worked in. The backlog is not a queue — creating ' +
      'a ticket does not mean starting it. Use this to put what matters first, and revisit ' +
      'it when things change.',
    schema: backlogOrderSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['order'],
      properties: {
        order: {
          type: 'array',
          items: { type: 'number' },
          description: 'Ticket numbers, most important first.',
        },
        rationale: { type: 'string', description: 'One line on why this order.' },
      },
    },
    run: (raw, b) => {
      const a = backlogOrderSchema.parse(raw)
      const missing = a.order.filter((n) => !getTicketByNumber(b.projectId, n))
      if (missing.length) return deny(`No such ticket: ${missing.map((n) => `#${n}`).join(', ')}.`)

      setBacklogOrder(b.projectId, a.order)
      if (a.rationale) {
        addMessage({
          projectId: b.projectId,
          agentId: b.agentId,
          authorType: 'agent',
          kind: 'notice',
          body: `Backlog order: ${a.order.map((n) => `#${n}`).join(' → ')}\n\n${a.rationale}`,
        })
        bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
      }
      flushWrites()
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      return okResult(`Backlog reordered: ${a.order.map((n) => `#${n}`).join(' → ')}.`)
    },
  },

  {
    name: 'update_teammate',
    description:
      "Rewrite a teammate's standing instructions — the text prepended to every turn they " +
      'take. Use this when the user asks you to change how someone works.\n\n' +
      'This is NOT the same as `record_feedback`. Feedback appends a lesson to their memory; ' +
      'this replaces the brief they were hired with. When the user says "make their ' +
      'instructions better", they mean this one.\n\n' +
      'You may not rename someone, change their role, or remove them — those are the ' +
      "user's. Send the FULL replacement text: it overwrites, it does not append.",
    schema: updateTeammateSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['agent', 'why'],
      properties: {
        agent: { type: 'string', description: 'Teammate name.' },
        instructions: {
          type: 'string',
          description:
            'The complete replacement text, in the second person. Be specific about what ' +
            'they take on, what they hand back, and how they report.',
        },
        model: {
          type: 'string',
          description: 'Only when the user asked to re-tier them. An alias or a full name.',
        },
        why: { type: 'string', description: 'One line for the user on what you changed.' },
      },
    },
    run: (raw, b) => {
      const a = updateTeammateSchema.parse(raw)
      const target = findAgentByName(b.projectId, a.agent)
      if (!target) {
        const names = listRoster(b.projectId).map((x) => x.name).join(', ')
        return deny(`No teammate called "${a.agent}". The roster is: ${names || 'empty'}.`)
      }
      if (target.isPilot) {
        return deny('Your own brief is `.vibepilot/pilot.md`, and it belongs to the user.')
      }
      if (a.model && !isValidModel(a.model)) {
        return deny(`"${a.model}" is not a model I can use.`)
      }
      if (a.instructions === undefined && a.model === undefined) {
        return deny('Nothing to change — pass instructions, a model, or both.')
      }

      const hadNone = !target.instructions.trim()
      updateAgent(target.id, { instructions: a.instructions, model: a.model })
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId: b.projectId })

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'system',
        kind: 'notice',
        body:
          `${target.name} updated — ${a.why}` +
          (a.instructions !== undefined && hadNone ? ' They had no instructions before.' : ''),
      })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      // A new brief does not retroactively apply to a turn already in flight, so tell them
      // now. Otherwise the change looks like it did nothing until their next spawn.
      const live =
        a.instructions !== undefined &&
        manager.send(target.id, {
          text:
            '<vibepilot-notice>\nYour standing instructions were rewritten. From here on:\n\n' +
            `${a.instructions}\n</vibepilot-notice>`,
          channel: 'system-notice',
        })

      return okResult(
        `${target.name} updated. It applies to every turn they take from now on` +
          `${live ? ', and they were told mid-task' : ''}.`,
        {
          agent: target.name,
          changed_instructions: a.instructions !== undefined,
          delivered_live: !!live,
        },
      )
    },
  },

  {
    name: 'propose_split',
    description:
      'Break a large request into linked tickets that can be worked in parallel.\n\n' +
      'This creates NOTHING. It puts a breakdown in front of the user to argue with — merge ' +
      'two, drop one, reorder — and only then do the tickets exist. Splitting is a ' +
      'conversation, so talk it through in your reply as well as calling this.\n\n' +
      'Worth splitting when you can see **three or more genuinely separable pieces**: things ' +
      'a different person could work on at the same time without tripping over each other. ' +
      'Below that it is just extra cards. Use `depends_on` for real ordering constraints ' +
      'only — a piece with a dependency cannot start, so a spurious one serialises work that ' +
      'could have run in parallel.',
    schema: proposeSplitSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['title', 'short_label', 'summary', 'pieces'],
      properties: {
        title: { type: 'string', description: 'The whole request, in a line.' },
        short_label: {
          type: 'string',
          description: 'Two or three words. Printed on every child card, so keep it short.',
        },
        summary: {
          type: 'string',
          description: 'How you see the shape of it. The user reads this and pushes back.',
        },
        pieces: {
          type: 'array',
          minItems: 2,
          maxItems: 15,
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              body: { type: 'string', description: 'What this piece covers, and what it does not.' },
              depends_on: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Zero-based positions in THIS list that must finish first. Leave empty ' +
                  'when a piece can start immediately.',
              },
              size_note: { type: 'string' },
            },
          },
        },
      },
    },
    run: (raw, b) => {
      const a = proposeSplitSchema.parse(raw)
      const bad = a.pieces.findIndex((p, i) =>
        p.depends_on.some((n) => n >= a.pieces.length || n === i),
      )
      if (bad >= 0) {
        return deny(
          `Piece ${bad + 1} depends on a position that is not in the list (or on itself). ` +
            `Positions are zero-based indexes into \`pieces\`.`,
        )
      }

      const epic = proposeSplit({
        projectId: b.projectId,
        title: a.title,
        shortLabel: a.short_label,
        summary: a.summary,
        proposedByAgentId: b.agentId,
        pieces: a.pieces.map((p) => ({
          title: p.title,
          body: p.body,
          dependsOnIndexes: p.depends_on,
          sizeNote: p.size_note ?? null,
        })),
      })
      flushWrites()
      bus.emitDomain({ type: 'epics:changed', projectId: b.projectId })

      const parallel = a.pieces.filter((p) => p.depends_on.length === 0).length
      return okResult(
        `Breakdown shown to the user: ${a.pieces.length} pieces, ${parallel} of which could ` +
          `start straight away. No tickets exist yet — talk them through it and wait.`,
        { epic_id: epic.id, pieces: a.pieces.length, status: 'awaiting_confirmation' },
      )
    },
  },

  {
    name: 'review_failed',
    description:
      'Send a ticket back to whoever built it, with a fix list. Use this instead of ' +
      'advance_step when the work is not right.\n\n' +
      'This does NOT create a new ticket and does NOT hire a replacement — the same builder ' +
      'is messaged, because it still has the whole problem in its head and a fresh agent ' +
      'would pay a cold start to re-learn it.\n\n' +
      'Be specific: file and line where you can. Mark severity honestly — `must` blocks, ' +
      '`should` is a real objection, `nit` is taste. If the work is fine, say so with ' +
      'advance_step rather than inventing concerns to look useful.',
    schema: reviewFailedSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['ticket', 'findings', 'verdict'],
      properties: {
        ticket: { type: 'number' },
        findings: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['summary'],
            properties: {
              severity: { type: 'string', enum: ['must', 'should', 'nit'] },
              summary: { type: 'string', description: 'One line. What is wrong.' },
              detail: { type: 'string', description: 'Why, and what would be right.' },
              file: { type: 'string' },
              line: { type: 'number' },
            },
          },
        },
        verdict: { type: 'string', description: 'A sentence or two for the user.' },
      },
    },
    run: (raw, b) => {
      const a = reviewFailedSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)

      const route = acceptedRoute(t.id)
      if (!route) return deny(`#${a.ticket} has no route, so there is nothing to send back.`)
      const cur = activeStep(route)
      if (!cur || cur.kind !== 'review') {
        return deny(
          `#${a.ticket} is not on a review step${cur ? ` — it is on ${STEP_LABEL[cur.kind]}` : ''}. ` +
            `You can only fail a review you are conducting.`,
        )
      }
      if (b.role !== 'pilot' && cur.assigneeAgentId && cur.assigneeAgentId !== b.agentId) {
        return deny(`The review of #${a.ticket} is not yours to conduct.`)
      }

      // Which build step comes back, and how many times it already has.
      const build = [...route.steps].reverse().find((s) => s.kind === 'build')
      if (!build) {
        return deny(
          `#${a.ticket} has no build step to send back to. Report to the Pilot with dm_agent ` +
            `instead.`,
        )
      }

      const findings = addFindings({
        ticketId: t.id,
        projectId: b.projectId,
        pass: build.passes,
        byAgentId: b.agentId,
        items: a.findings,
      })
      const list = renderFindings(findings)

      // Three passes and it becomes the user's call. A reviewer and a builder can disagree
      // forever, and each round costs a full turn from both. Per project now rather than a
      // module constant: some repos want one pass and some want more.
      /*
       * 0 means unlimited, and `??` does not catch it — 0 is not nullish, so the limit became
       * literally zero and the FIRST failed review escalated with "has hit the 0-pass limit".
       * The setting labelled Unlimited delivered the opposite of unlimited.
       */
      const configuredPasses = getProject(b.projectId)?.reviewPasses
      const limit =
        configuredPasses === 0
          ? Number.POSITIVE_INFINITY
          : (configuredPasses ?? MAX_REVIEW_PASSES)
      if (build.passes >= limit) {
        addMessage({
          projectId: b.projectId,
          agentId: b.agentId,
          authorType: 'agent',
          kind: 'error',
          body:
            `#${t.number} has failed review ${build.passes} times. Stopping rather than going ` +
            `round again — this needs you.\n\n${a.verdict}\n\n${list}`,
        })
        flushWrites()
        bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
        bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
        pilot.notify(
          b.projectId,
          `#${t.number} has now failed review ${build.passes} times. I have stopped the loop and ` +
            `put it to the user. Do not send it back again — tell them what the disagreement is.`,
        )
        return okResult(
          `Recorded, but #${t.number} has hit the ${limit}-pass limit, so it went to ` +
            `the user instead of back to the builder.`,
          { ticket: t.number, escalated: true, findings: findings.length },
        )
      }

      reworkTo(t.id, 'build')
      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'agent',
        kind: 'notice',
        body: `#${t.number} · review failed (pass ${build.passes})\n\n${a.verdict}\n\n${list}`,
      })
      flushWrites()
      bus.emitDomain({ type: 'routes:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      // Re-message rather than respawn. This is the whole point of the design.
      const builder = build.assigneeAgentId ? getAgent(build.assigneeAgentId) : null
      const delivered =
        builder &&
        manager.send(builder.id, {
          text:
            `<vibepilot-notice>\nYour work on #${t.number} came back from review. Fix exactly ` +
            `these and then call advance_step again.\n\n${a.verdict}\n\n${list}\n</vibepilot-notice>`,
          channel: 'system-notice',
        })

      if (!delivered) {
        pilot.notify(
          b.projectId,
          `#${t.number} failed review and went back to its build step, but ` +
            `${builder ? `${builder.name} is no longer running` : 'nobody is assigned'}. ` +
            `The findings are on the ticket. Put someone on it.`,
        )
      }

      return okResult(
        `#${t.number} is back with ${builder?.name ?? 'the build step'}` +
          `${delivered ? ' and they have the fix list now' : ' — but nobody is running, so the Pilot was told'}. ` +
          `Pass ${build.passes + 1}.`,
        { ticket: t.number, findings: findings.length, pass: build.passes + 1, delivered: !!delivered },
      )
    },
  },

  {
    name: 'remember',
    description:
      'Write something down for whoever works on this project next — including a future you, ' +
      'after your context has reset.\n\n' +
      'Worth remembering: a trap that cost you an hour, a convention you had to infer, a ' +
      'decision and why it went that way, a piece of domain vocabulary. NOT worth ' +
      'remembering: anything re-derivable in ten seconds by reading the code, or a summary ' +
      'of what you just did — that is what the ticket is for.\n\n' +
      'This writes a markdown file in the repo that a human can read and edit. Name the ' +
      'files it concerns, so it can be flagged when they change.',
    schema: rememberSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['category', 'title', 'body'],
      properties: {
        category: {
          type: 'string',
          enum: ['architecture', 'convention', 'gotcha', 'decision', 'glossary', 'lesson'],
          description:
            'architecture: how it is put together. convention: how we do things here. ' +
            'gotcha: a trap. decision: what was chosen and why. glossary: vocabulary. ' +
            'lesson: something YOU learned — goes in your own file.',
        },
        title: { type: 'string', description: 'A statement, not a topic. Re-using a title updates that entry.' },
        body: { type: 'string' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo paths this is about. Used to spot it going stale later.',
        },
      },
    },
    run: (raw, b) => {
      const a = rememberSchema.parse(raw)
      const project = getProject(b.projectId)
      if (!project) return deny('This project no longer exists.')
      const me = getAgent(b.agentId)

      const out = remember({
        projectId: b.projectId,
        projectPath: project.path,
        category: a.category,
        title: a.title,
        body: a.body,
        author: me?.name ?? null,
        agentName: me?.name ?? null,
        concerns: a.files,
        ticket: b.ticketId,
      })
      remembered.add(b.agentId)
      bus.emitDomain({ type: 'memory:changed', projectId: b.projectId })
      curator.maybeRun(b.projectId, 'volume')

      return okResult(
        `${out.created ? 'Written to' : 'Updated in'} .vibepilot/memory/${out.file}.`,
        { file: out.file, slug: out.slug, created: out.created },
      )
    },
  },

  {
    name: 'recall',
    description:
      'Search what this project already knows before working something out from scratch. ' +
      'Your own lessons are already in your prompt; this reaches everything else, including ' +
      'other teammates\' files. Worth a call before a non-trivial change, and whenever ' +
      'something surprises you — the surprise may already be written down.',
    schema: recallSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you are trying to find out. Plain words.' },
        agent: { type: 'string', description: "Restrict to one teammate's own file." },
        limit: { type: 'number' },
      },
    },
    run: (raw, b) => {
      const a = recallSchema.parse(raw)
      const hits = recall(b.projectId, a.query, {
        limit: a.limit,
        onlyScope: a.agent ?? null,
      })
      if (hits.length === 0) {
        return okResult(
          `Nothing recorded about that. If you work it out, write it down with \`remember\`.`,
          { hits: 0 },
        )
      }
      return okResult(renderForPrompt(hits), { hits: hits.length })
    },
  },

  {
    name: 'record_feedback',
    description:
      "The user told you something about how a teammate works — that they did not like how " +
      'something was worded, or want it done differently next time. Put it in that ' +
      "teammate's own memory so it is in their prompt the next time they spawn.\n\n" +
      'This is the highest-value thing you can write down: it is the one thing that cannot ' +
      'be worked out by reading the code. It never expires and the curator will not touch it. ' +
      'Write the lesson in the second person, as an instruction they can act on.',
    schema: feedbackSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['agent', 'lesson'],
      properties: {
        agent: { type: 'string', description: 'Teammate name.' },
        lesson: {
          type: 'string',
          description:
            'What to do differently, in their words-to-be. "Keep button labels to one word — ' +
            'the user found \'Submit your details\' fussy." Not "the user disliked the copy".',
        },
        title: { type: 'string' },
      },
    },
    run: (raw, b) => {
      const a = feedbackSchema.parse(raw)
      const project = getProject(b.projectId)
      if (!project) return deny('This project no longer exists.')
      const target = findAgentByName(b.projectId, a.agent)
      if (!target) {
        const names = listAgents(b.projectId).map((x) => x.name).join(', ')
        return deny(`No teammate called "${a.agent}". On this project: ${names || 'nobody yet'}.`)
      }

      const out = recordFeedback({
        projectId: b.projectId,
        projectPath: project.path,
        agentName: target.name,
        lesson: a.lesson,
        title: a.title ?? undefined,
        ticket: b.ticketId,
      })
      bus.emitDomain({ type: 'memory:changed', projectId: b.projectId })

      // If they are running right now, they should not have to wait for a respawn to hear it.
      const live = manager.send(target.id, {
        text: `<vibepilot-notice>\nThe user gave feedback on your work: ${a.lesson}\n\nThis is now in your memory permanently. Apply it from here on.\n</vibepilot-notice>`,
        channel: 'system-notice',
      })

      return okResult(
        `Recorded against ${target.name} in .vibepilot/memory/${out.file}. It is in their prompt ` +
          `from now on${live ? ', and they have been told right now' : ''}.`,
        { agent: target.name, file: out.file, delivered_live: live },
      )
    },
  },

  {
    name: 'dm_agent',
    description:
      'Send a direct message to one teammate by name, or to the Pilot. It reaches them ' +
      'immediately if they are working, and is refused if they are not — so a message is ' +
      'never quietly lost. Use it to ask what someone already knows rather than re-deriving it.',
    schema: dmSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['to', 'text'],
      properties: {
        to: { type: 'string', description: 'Teammate name, or "pilot".' },
        text: { type: 'string' },
      },
    },
    run: (raw, b) => {
      const a = dmSchema.parse(raw)
      const target =
        a.to.toLowerCase() === 'pilot'
          ? listAgents(b.projectId).find((x) => x.isPilot)
          : findAgentByName(b.projectId, a.to)
      if (!target) {
        const names = listAgents(b.projectId).map((x) => x.name).join(', ')
        return deny(`No teammate called "${a.to}". Currently on this project: ${names || 'nobody yet'}.`)
      }
      const me = getAgent(b.agentId)
      const from = me?.name ?? 'A teammate'

      /*
       * Actually deliver it.
       *
       * This tool used to write a row and return "Message sent." — the description claimed
       * "They see it on their next turn" and nothing ever did. `comms` had zero rows because
       * no agent keeps using a channel that does nothing, and the Comms tab looked broken
       * when the delivery underneath it had simply never been built.
       *
       * A tool that lies about having acted is worse than a missing tool, because the model
       * believes it and stops looking for another way.
       */
      const delivered = target.isPilot
        ? (pilot.notify(b.projectId, `${from} says: ${a.text}`), true)
        : manager.send(target.id, { text: `${from} says: ${a.text}`, channel: 'system-notice' })

      if (!delivered) {
        return deny(
          `${target.name} is not running, so there is nobody to receive that. Either do it ` +
            `yourself, or tell the Pilot and let them decide whether to start ${target.name}.`,
        )
      }

      addComm({
        projectId: b.projectId,
        kind: 'dm',
        fromAgentId: b.agentId,
        toAgentId: target.id,
        body: a.text,
        ticketId: b.ticketId,
      })
      flushWrites()
      bus.emitDomain({ type: 'comms:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
      return okResult(`Delivered to ${target.name}.`, { to: target.name })
    },
  },

  {
    name: 'shoutout',
    description:
      'Broadcast to everyone working on this project. Use sparingly — for things that change ' +
      "what others should do. Severity 'blocker' also interrupts the Pilot.",
    schema: shoutSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'warn', 'blocker'] },
      },
    },
    run: (raw, b) => {
      const a = shoutSchema.parse(raw)
      const me = getAgent(b.agentId)
      const from = me?.name ?? 'A teammate'
      const line = `${from} told the team${a.severity !== 'info' ? ` (${a.severity})` : ''}: ${a.text}`

      // Fan out to every live teammate, and always to the Pilot — it is the one that has to
      // decide whether a blocker changes the plan.
      let reached = 0
      for (const other of listAgents(b.projectId)) {
        if (other.id === b.agentId || other.isPilot) continue
        if (manager.send(other.id, { text: line, channel: 'system-notice' })) reached++
      }
      pilot.notify(
        b.projectId,
        a.severity === 'blocker'
          ? `${line}

This is flagged as a blocker. Decide whether it changes what anyone ` +
              `else should be doing, and tell the user if it does.`
          : line,
      )

      addComm({
        projectId: b.projectId,
        kind: 'shoutout',
        fromAgentId: b.agentId,
        severity: a.severity,
        body: a.text,
        ticketId: b.ticketId,
      })
      flushWrites()
      bus.emitDomain({ type: 'comms:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
      return okResult(
        reached > 0
          ? `Sent to the Pilot and ${reached} teammate${reached === 1 ? '' : 's'} who are working.`
          : `Sent to the Pilot. Nobody else is working right now.`,
        { severity: a.severity, reached },
      )
    },
  },

  {
    /*
     * The status line was the name of the last tool called. Literally `bash` — a debug readout
     * in the place a person looks to find out what is going on. Nothing could summarise a tool
     * call into intent without guessing; the agent already knows, so this asks it.
     */
    name: 'status',
    description:
      'Say what you are doing, in one short sentence, in plain words — "reading the routing ' +
      'code", not "bash". It shows in the app as your status until you say something else. ' +
      'Call it when you start something that will take more than a few seconds, and when what ' +
      'you are waiting for changes. Not on every tool call: that is noise and it costs a turn.',
    schema: statusSchema,
    /*
     * The Pilot only.
     *
     * A teammate's status line is the name of its last tool, and that is right for a teammate:
     * in the watch drawer you are looking at the work, and "ran a command" is what you want.
     * Offering this to teammates would give them a tool whose effect the next tool call wipes
     * out a second later — worse than not having it.
     */
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['one_line'],
      properties: {
        one_line: {
          type: 'string',
          description: 'One sentence. No tool names, no markdown, no trailing full stop needed.',
        },
      },
    },
    run: (raw, b) => {
      const a = statusSchema.parse(raw)
      setAgentStatusLine(b.agentId, a.one_line.trim())
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId: b.projectId })
      return okResult('Noted.')
    },
  },

  {
    name: 'ask_user',
    description:
      'Ask the human a question and wait for their answer. Use this when a decision is hard to ' +
      'undo, changes what you build, or you genuinely cannot tell what they want. Do not use it ' +
      'for things you can determine by reading the code.',
    schema: askSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'One clear question. Not a list.' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 6 concrete options. Offering options gets you a faster answer.',
        },
        urgency: { type: 'string', enum: ['blocking', 'background'] },
        context: { type: 'string', description: 'What you found that led to the question.' },
      },
    },
    run: async (raw, b) => {
      const a = askSchema.parse(raw)
      const q = addQuestion({
        projectId: b.projectId,
        agentId: b.agentId,
        ticketId: b.ticketId,
        question: a.question,
        context: a.context ?? null,
        choices: a.choices,
        urgency: a.urgency,
      })
      // A background question does not park the agent — it keeps working, so saying it is
      // waiting on you would be wrong on the roster and wrong in the status line.
      if (a.urgency === 'blocking') {
        setAgentStatus(b.agentId, 'waiting_on_you', a.question.slice(0, 120))
      }
      flushWrites()

      /*
       * Ring the doorbell.
       *
       * Until this existed the only signal was a card in the Messages list of whichever project
       * happened to be open, so a question raised anywhere else — or while the window was
       * minimised — was silent while the asker burned turns waiting.
       */
      const project = getProject(b.projectId)
      const me = getAgent(b.agentId)
      notifyUser({
        projectId: b.projectId,
        title: `${me?.name ?? 'A teammate'} needs an answer${project ? ` · ${project.name}` : ''}`,
        body: a.question,
      })
      bus.emitAgent({
        seq: bus.nextSeq(),
        ts: Date.now(),
        projectId: b.projectId,
        agentId: b.agentId,
        runId: b.runId,
        ticketId: b.ticketId,
        type: 'agent:question',
        questionId: q.id,
        prompt: a.question,
        choices: a.choices,
        blocking: a.urgency === 'blocking',
      })
      bus.emitDomain({ type: 'questions:changed', projectId: b.projectId })
      return askUserGate.wait(q.id, b)
    },
  },

  {
    name: 'await_answer',
    description:
      'Continue waiting for an answer to a question you already asked. Call this when ask_user ' +
      'returned status "pending".',
    schema: awaitSchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['question_id'],
      properties: { question_id: { type: 'string' } },
    },
    run: async (raw, b) => {
      const a = awaitSchema.parse(raw)
      const q = getQuestion(a.question_id)
      // A background question left the agent working; the moment it decides to wait, the
      // roster should say so.
      if (q?.status === 'open') setAgentStatus(b.agentId, 'waiting_on_you', q.question.slice(0, 120))
      return askUserGate.wait(a.question_id, b, true)
    },
  },

  /*
   * The ladder: a teammate's question can reach the Pilot before it reaches the user.
   *
   * Both tools work on the ORIGINAL question row. Minting a second one would strand the
   * teammate, which is parked on the first id and will never hear about a replacement.
   */
  {
    name: 'answer_question',
    description:
      'Answer a question the user passed to you, on their behalf. Use it when the ticket, the ' +
      "user's earlier messages, the code or project memory already settle it. The teammate is " +
      'told the answer came from you and not from a human, so they treat it as reversible. If ' +
      'you cannot defend the answer, use escalate_question instead.',
    schema: answerQSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['question_id', 'answer'],
      properties: {
        question_id: { type: 'string' },
        answer: { type: 'string', description: 'A direct answer, not a discussion of it.' },
      },
    },
    run: (raw, b) => {
      const a = answerQSchema.parse(raw)
      const q = getQuestion(a.question_id)
      if (!q) return deny(`No such question: ${a.question_id}.`)
      if (q.projectId !== b.projectId) return deny('That question belongs to another project.')
      if (q.status !== 'open') {
        return deny(
          q.answeredBy === 'user'
            ? 'The user answered that one themselves while you were thinking. Nothing to do.'
            : `That question is already ${q.status}. Nothing to do.`,
        )
      }

      const project = getProject(b.projectId)
      if (project && project.escalation === 'ask_me') {
        return deny(
          'This project is set to "Ask me": the user wants to decide these themselves. Research ' +
            'it and call escalate_question with what you found instead.',
        )
      }

      const asker = getAgent(q.agentId)
      const delivered = askUserGate.deliver(a.question_id, a.answer, 'pilot')
      bus.emitDomain({ type: 'questions:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      return okResult(
        delivered
          ? `Answered on the user's behalf; ${asker?.name ?? 'the teammate'} is unblocked.`
          : `Recorded, but ${asker?.name ?? 'the asker'} is no longer waiting — the run ended. ` +
              `Do not assume the work continued.`,
        { delivered },
      )
    },
  },

  {
    name: 'escalate_question',
    description:
      'Put a question back to the user because it is a genuine judgement call — taste, scope, ' +
      'money, anything hard to undo. You must say what you already checked; that is what turns ' +
      'this from passing the parcel into work the user does not have to repeat.',
    schema: escalateQSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['question_id', 'what_i_checked'],
      properties: {
        question_id: { type: 'string' },
        what_i_checked: {
          type: 'string',
          description:
            'The files, messages and memory you looked at, and what they did and did not settle.',
        },
        recommendation: {
          type: 'string',
          description: 'What you would do, if you have a view. Optional — say nothing rather than guess.',
        },
      },
    },
    run: (raw, b) => {
      const a = escalateQSchema.parse(raw)
      const q = getQuestion(a.question_id)
      if (!q) return deny(`No such question: ${a.question_id}.`)
      if (q.projectId !== b.projectId) return deny('That question belongs to another project.')
      if (q.status !== 'open') return deny(`That question is already ${q.status}. Nothing to do.`)

      const asker = getAgent(q.agentId)
      const body = [
        `**${asker?.name ?? 'A teammate'} asked:** ${q.question}`,
        '',
        `I looked into it and this one is yours. What I checked: ${a.what_i_checked}`,
        a.recommendation ? `\nIf it helps: ${a.recommendation}` : '',
      ].join('\n')

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        runId: b.runId,
        authorType: 'agent',
        kind: 'text',
        body,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'questions:changed', projectId: b.projectId })

      const project = getProject(b.projectId)
      notifyUser({
        projectId: b.projectId,
        title: `The Pilot needs you to decide${project ? ` · ${project.name}` : ''}`,
        body: q.question,
      })

      return okResult(
        'Back to the user, with your research attached. The question card is still live — they ' +
          'answer it there, and the teammate is unblocked the moment they do.',
      )
    },
  },

  {
    /*
     * Verification stops being prose.
     *
     * The rule file said "the project's tests pass" and nothing checked whether that had
     * happened, so an agent that verified and one that said it did looked identical. vibePilot
     * runs the commands, which makes the exit code a fact; the agent gets the output, which is
     * what lets it fix the failure. Both halves, rather than choosing one.
     */
    name: 'run_checks',
    description:
      "Run this project's own checks — typecheck, lint, tests, build — in your worktree, and " +
      'get back what really happened. vibePilot runs them, not you, so the result is evidence ' +
      'rather than a claim. Run this before you say a ticket is done. If nothing is configured ' +
      'it says so, and you should check the work some other way and describe how.',
    schema: z.object({}),
    availableTo: anyone,
    inputSchema: { type: 'object', properties: {} },
    run: async (_raw, b) => {
      const project = getProject(b.projectId)
      if (!project) return deny('That project no longer exists.')

      const me = getAgent(b.agentId)
      // Their worktree, not the project root: the whole point is checking the work in hand,
      // and a teammate's changes are not in the main tree until you merge.
      const cwd = me?.worktreePath ?? project.path

      const results = await runChecks(project.checks, cwd)
      recordChecks(b.agentId, results)

      const failed = results.filter((r) => !r.ok).length
      return okResult(renderChecks(results), {
        ran: results.length,
        failed,
        passed: results.length > 0 && failed === 0,
        results: results.map((r) => ({ kind: r.kind, ok: r.ok, exit_code: r.exitCode })),
      })
    },
  },

  {
    name: 'mark_ready_to_merge',
    description:
      'Declare your ticket finished: built, tested, committed in your worktree. This puts it in ' +
      'front of the user for review — it does not merge anything.',
    schema: readySchema,
    availableTo: anyone,
    inputSchema: {
      type: 'object',
      required: ['ticket', 'summary'],
      properties: {
        ticket: { type: 'number' },
        summary: {
          type: 'string',
          description: 'Plain language: what changed and what the user should look at.',
        },
        test_evidence: { type: 'string', description: 'Test output, counts, anything that proves it works.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        nothing_to_remember: {
          type: 'boolean',
          description:
            'Set only after being asked. Means: you considered what a future teammate would ' +
            'want from this work and there was genuinely nothing. Fine for a typo; ' +
            'suspicious after a long debugging session.',
        },
      },
    },
    run: async (raw, b) => {
      const a = readySchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)
      if (b.role !== 'pilot' && t.assigneeAgentId !== b.agentId) {
        return deny(`Ticket #${a.ticket} is not yours to finish.`)
      }

      /*
       * Did the work land where vibePilot is looking?
       *
       * A teammate once finished a migration fix by committing into a different repository
       * and a stray temp folder, while the branch vibePilot was tracking stayed empty. The
       * ticket reported FILES TOUCHED (1) — brain/lessons-learned.md. Nothing checked, so
       * "ready to merge" was true about a branch with nothing on it.
       *
       * `rev-list --count base..branch` is the same gate route completion already uses.
       * Commits either exist or they do not; the agent's word for it is not evidence.
       */
      /*
       * Did anything get written down?
       *
       * Asked once. A second call after the agent has said "nothing worth recording" would be
       * nagging, and the honest answer for a typo fix genuinely is nothing — so the refusal
       * carries the escape hatch in the same breath, and takes the agent at its word after.
       */
      if (b.role !== 'pilot' && !remembered.has(b.agentId) && !a.nothing_to_remember) {
        return deny(
          `Before finishing: did you learn anything a future teammate would want?\n\n` +
            `A trap, a convention you had to infer, a decision and why, something you got ` +
            `wrong. Call \`remember\` with the right category and then call this again.\n\n` +
            `If there genuinely was nothing — which is a fine answer for a small change — ` +
            `call this again with \`nothing_to_remember: true\` and say so in your summary.`,
        )
      }

      const proj = getProject(b.projectId)
      if (proj && t.branch) {
        /*
         * "Is there work here the base does not have?" — content, not commit count. Counting
         * commits answers a different question and gets it wrong in the expensive direction: a
         * branch whose work had already been squashed into the base still counted three
         * commits, was waved through, and produced a merge card that could never succeed.
         */
        if (await hasLanded(proj.path, proj.defaultBaseBranch, t.branch)) {
          return deny(
            `\`${t.branch}\` has nothing on it that is not already on ` +
              `${proj.defaultBaseBranch}, so there is nothing to merge. Either nothing was ` +
              `committed, or your work is not where vibePilot is looking.\n\n` +
              `Check that you are in your own worktree${t.worktreePath ? ` (\`${t.worktreePath}\`)` : ''} ` +
              `and on \`${t.branch}\`, then commit there. If you edited files somewhere else, ` +
              `move those changes across before calling this again.`,
          )
        }
      }
      /*
       * What the checks actually said, attached to the claim.
       *
       * Not a refusal. A misconfigured command must not be able to trap a finished ticket, and
       * the user is the one reviewing this anyway — what they need is to see, on the ticket,
       * whether anything was really run and whether it was green.
       */
      const project = getProject(b.projectId)
      const configured = project ? configuredChecks(project.checks) : []
      const ran = lastChecksFor(b.agentId)
      let verdict = ''
      if (configured.length > 0) {
        if (!ran || ran.length === 0) {
          verdict =
            `\n\n**Checks: not run.** This project has ${configured.length} configured ` +
            `(${configured.map((c) => c.kind).join(', ')}) and none of them were run for this.`
        } else {
          const failed = ran.filter((r) => !r.ok)
          verdict = failed.length
            ? `\n\n**Checks: ${failed.length} failing** — ${failed.map((r) => r.kind).join(', ')}.`
            : `\n\n**Checks: all ${ran.length} passed**, run by vibePilot.`
        }
      }

      updateTicket(t.id, { readyToMerge: true, mergeState: 'ready' })

      // Finished work waiting on a decision from you. This did not announce itself either.
      notifyUser({
        projectId: b.projectId,
        title: `#${t.number} is ready to merge${projectName(b.projectId)}`,
        body: t.title,
      })

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'agent',
        kind: 'notice',
        body:
          `#${t.number} is ready to merge.\n\n${a.summary}` +
          `${a.test_evidence ? `\n\n${a.test_evidence}` : ''}${verdict}`,
      })
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      const nudge =
        configured.length > 0 && !ran
          ? ` You did not run \`run_checks\` — the user will see that. Run it and say what it said.`
          : ''
      return okResult(`#${t.number} is now waiting for the user to review and merge.${nudge}`, {
        ticket: t.number,
      })
    },
  },

  {
    name: 'assign_teammate',
    description:
      'Put a teammate from the roster onto the active step of a ticket. They get their own ' +
      'git worktree, so parallel work never collides.\n\n' +
      'This is how work starts. You cannot create teammates — the user decides who is on ' +
      'this project. If nobody on the roster fits, use `suggest_hire` and wait for them to ' +
      'approve it.',
    schema: assignSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['agent', 'ticket', 'brief'],
      properties: {
        agent: { type: 'string', description: 'A name from the roster.' },
        ticket: { type: 'number', description: 'The ticket they will work.' },
        brief: {
          type: 'string',
          description:
            'What you want done, in full. They cannot see this conversation — everything ' +
            'they need must be here.',
        },
      },
    },
    run: async (raw, b) => {
      const a = assignSchema.parse(raw)

      const who = findAgentByName(b.projectId, a.agent)
      if (!who) {
        const roster = listRoster(b.projectId).map((x) => `${x.name} (${x.role})`).join(', ')
        return deny(
          `Nobody on this project is called "${a.agent}". The roster is: ${roster || 'empty'}. ` +
            `Use suggest_hire if you need someone new.`,
        )
      }
      if (who.isPilot) return deny('You cannot assign yourself to a ticket. You coordinate.')

      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}. Create one first.`)

      if (t.assigneeAgentId && t.assigneeAgentId !== who.id) {
        const owner = getAgent(t.assigneeAgentId)
        if (owner && owner.status !== 'error' && owner.status !== 'done') {
          return deny(
            `#${a.ticket} is already with ${owner.name}. Use message_agent to give them more ` +
              `instructions, or pick a different ticket.`,
          )
        }
      }
      // A roster member is one person: they cannot be on two tickets at once, any more than
      // a colleague could.
      //
      // Ask the process table, not the status column. `status` is 'idle' between turns — set
      // the moment a turn ends, while the ticket is still very much theirs — so a status check
      // passed happily and let four tickets launch four processes under two identities. The
      // live-run table cannot drift, needs no extra writes, and is empty after a restart by
      // construction.
      const busy = manager.isBusy(who.id)
      if (busy && who.currentTicketId !== t.id) {
        const other = who.currentTicketId ? getTicket(who.currentTicketId) : null
        const free = listAgents(b.projectId)
          .filter((x) => !x.isPilot && x.isRoster && !manager.isBusy(x.id))
          .map((x) => x.name)
        return deny(
          `${who.name} is already working${other ? ` on #${other.number}` : ''} and one person ` +
            `takes one ticket at a time. ` +
            (free.length
              ? `${free.join(', ')} ${free.length === 1 ? 'is' : 'are'} free.`
              : `Nobody is free — #${t.number} waits, or you can suggest_hire.`),
        )
      }

      const route = acceptedRoute(t.id)
      if (!route) {
        return deny(
          `#${a.ticket} has no accepted route yet, so nobody should be working on it. Call ` +
            `propose_route first — and remember a question only needs a \`research\` step, not ` +
            `a builder.`,
        )
      }
      const step = activeStep(route)
      if (!step) return deny(`Every step on #${a.ticket} is finished. There is nothing to assign.`)

      // `depends_on` existed in v1 and was never read, so the board would happily show a
      // ticket as startable when the thing it builds on had not been written yet.
      const blocked = unmetDependencies(b.projectId, t.id)
      if (blocked.length) {
        return deny(
          `#${a.ticket} is waiting on ${blocked.map((n) => `#${n}`).join(', ')}, which ` +
            `${blocked.length === 1 ? 'is' : 'are'} not done. Start ${blocked.length === 1 ? 'that' : 'those'} first.`,
        )
      }

      // A reviewer reviewing its own build is not a review. This is the one role constraint
      // worth enforcing in code rather than hoping a prompt holds.
      const built = route.steps.find((s) => s.kind === 'build')
      if (step.kind === 'review' && built?.assigneeAgentId === who.id) {
        return deny(
          `${who.name} built #${a.ticket}, so they cannot review it — the point of a review ` +
            `step is eyes that did not write the code. Assign someone else.`,
        )
      }

      assignStep(t.id, step.id, who.id)
      setAgentStatus(who.id, 'queued', `Starting #${t.number}`)
      flushWrites()
      bus.emitDomain({ type: 'agents:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'routes:changed', projectId: b.projectId })

      // Return NOW. Worktree creation takes seconds on a real repo; making the Pilot wait
      // would serialise the fleet and burn its context on a transcript-sized tool result.
      // Through the gate: the concurrency cap and the pause both live there, and calling
      // launchTeammate directly is what made the cap decorative for so long.
      gate.submit({
        projectId: b.projectId,
        agentId: who.id,
        run: () =>
          launchTeammate({
            projectId: b.projectId,
            agentId: who.id,
            name: who.name,
            role: who.role,
            provider: who.provider,
            model: who.model,
            ticketId: t.id,
            brief: a.brief,
            pilotAgentId: b.agentId,
          }).catch((e: Error) => {
            setAgentStatus(who.id, 'error', e.message.slice(0, 120))
            bus.emitDomain({ type: 'agents:changed', projectId: b.projectId })
          }),
      })

      return okResult(
        `${who.name} is starting on the ${STEP_LABEL[step.kind]} step of #${t.number}, in their ` +
          `own worktree. You will be told when they finish or get stuck — do not poll.`,
        { agent_id: who.id, status: 'queued', ticket: t.number, step: step.kind },
      )
    },
  },

  {
    name: 'suggest_hire',
    description:
      'Propose a new teammate. The user approves it — you cannot add someone yourself.\n\n' +
      'Suggest a hire when the roster genuinely has a gap: nobody who can review, nobody ' +
      'suited to copy, or everyone is busy and the work is worth another process. Do not ' +
      'suggest one per ticket — a teammate persists and accumulates its own memory, so a ' +
      'throwaway hire wastes the thing that makes them worth having.',
    schema: suggestHireSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['name', 'role', 'model', 'why'],
      properties: {
        name: { type: 'string', description: 'A short human name, e.g. "Dana".' },
        role: {
          type: 'string',
          enum: ['builder', 'reviewer', 'scout', 'specialist'],
          description:
            'builder: owns a ticket end to end. reviewer: fresh eyes, cannot edit. scout: ' +
            'cheap search, cannot edit. specialist: defined by its own instructions.',
        },
        model: {
          type: 'string',
          description:
            'An alias — ' +
            MODEL_OPTIONS.map((m) => m.id).join(', ') +
            ' — which always resolves to the latest in that tier. Sonnet for most work; ' +
            'Haiku for reading and searching; Opus only when the problem genuinely needs ' +
            'it. You may also pin an exact version, e.g. "claude-opus-4-8", when the user ' +
            'has asked for a specific model.',
        },
        why: { type: 'string', description: 'The gap this fills. The user reads this and decides.' },
        instructions: {
          type: 'string',
          description: 'How this person should work. Prepended to every turn they take.',
        },
        ticket: { type: 'number', description: 'The ticket that prompted it, if any.' },
      },
    },
    run: (raw, b) => {
      const a = suggestHireSchema.parse(raw)
      if (!isValidModel(a.model)) {
        return deny(
          `"${a.model}" is not a model I can use. Either an alias — ` +
            `${MODEL_OPTIONS.map((m) => m.id).join(', ')} — or a full name like ` +
            `"claude-opus-4-8".`,
        )
      }
      if (findAgentByName(b.projectId, a.name)) {
        return deny(`There is already a teammate called "${a.name}". Assign them instead.`)
      }
      const t = a.ticket ? getTicketByNumber(b.projectId, a.ticket) : null
      if (a.ticket && !t) return deny(`There is no ticket #${a.ticket}.`)

      const h = proposeHire({
        projectId: b.projectId,
        proposedByAgentId: b.agentId,
        name: a.name,
        role: a.role,
        model: a.model,
        instructions: a.instructions,
        why: a.why,
        ticketId: t?.id ?? null,
      })
      flushWrites()
      bus.emitDomain({ type: 'hires:changed', projectId: b.projectId })

      return okResult(
        `Suggested hiring ${a.name} (${a.role}, ${a.model}). The user has to approve it — ` +
          `nobody exists yet and nothing has started. Carry on with what you can do meanwhile.`,
        { hire_id: h.id, status: 'awaiting_confirmation' },
      )
    },
  },

  {
    name: 'message_agent',
    description:
      'Give a running teammate another instruction. It arrives as their next turn. Use this ' +
      'instead of spawning a second agent for the same ticket.',
    schema: messageAgentSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['agent', 'text'],
      properties: {
        agent: { type: 'string', description: 'Teammate name.' },
        text: { type: 'string' },
      },
    },
    run: (raw, b) => {
      const a = messageAgentSchema.parse(raw)
      const target = findAgentByName(b.projectId, a.agent)
      if (!target) return deny(`No teammate called "${a.agent}".`)

      const delivered = manager.send(target.id, {
        text: `<vibepilot-notice>\nThe Pilot says: ${a.text}\n</vibepilot-notice>`,
        channel: 'system-notice',
      })
      if (!delivered) {
        return deny(
          `${target.name} is not running any more (status: ${target.status}). Its worktree is ` +
            `intact — spawn a replacement on the same ticket if the work needs continuing.`,
        )
      }
      addComm({
        projectId: b.projectId,
        kind: 'dm',
        fromAgentId: b.agentId,
        toAgentId: target.id,
        body: a.text,
      })
      bus.emitDomain({ type: 'comms:changed', projectId: b.projectId })
      return okResult(`Passed to ${target.name}; it will pick it up on its next turn.`)
    },
  },

  {
    name: 'extend_ticket',
    description:
      'Add something to a ticket that already exists, instead of making a new one. Use this ' +
      'whenever the user asks for something that belongs to work already under way — a second ' +
      'change to the same file, a correction, "also do X". If a teammate is working on it they ' +
      'are told immediately and it becomes part of what they are doing. ' +
      'ALWAYS prefer this to `propose_ticket` when the work overlaps something live: two tickets ' +
      'editing the same files at the same time is how you get conflicting branches. ' +
      'Needs no approval — the user said it, so it is already decided.',
    schema: extendTicketSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['ticket', 'addition'],
      properties: {
        ticket: { type: 'number', description: 'Ticket number, e.g. 4.' },
        addition: {
          type: 'string',
          description:
            'What is being added, in the user\'s own terms. One or two sentences. This is ' +
            'appended to the ticket and sent to whoever is working on it.',
        },
      },
    },
    run: (raw, b) => {
      const a = extendTicketSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)
      if (t.archivedAt) {
        return deny(
          `#${a.ticket} is archived, so there is nothing to extend. Propose a new ticket instead.`,
        )
      }

      /*
       * Appended, not replaced. The original wording is what the user asked for first and is
       * often what a reviewer checks against — losing it to make room for an addition would
       * quietly rewrite history.
       */
      const line = `\n\n**Also:** ${a.addition.trim()}`
      updateTicket(t.id, { body: `${t.body}${line}`.trim() })

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'system',
        kind: 'notice',
        body: `#${t.number} grew: ${a.addition.trim()}`,
      })

      /*
       * Tell whoever is on it. The turn queue holds this until their current turn finishes, so
       * it can never land mid-edit — they hear it at the next safe point rather than being
       * interrupted or made to wait for the whole step.
       */
      const route = acceptedRoute(t.id)
      const step = route?.steps.find((s) => s.status === 'active' || s.status === 'rework')
      const who = step?.assigneeAgentId ? getAgent(step.assigneeAgentId) : null
      const told =
        who &&
        manager.send(who.id, {
          text:
            `<vibepilot-notice>\nThe user has added this to the ticket you are working on:\n\n` +
            `${a.addition.trim()}\n\n` +
            `Treat it as part of the same job. If it contradicts what you have already done, ` +
            `the newer instruction wins — say so and change it rather than doing both.\n` +
            `</vibepilot-notice>`,
          channel: 'system-notice',
        })

      flushWrites()
      bus.emitDomain({ type: 'tickets:changed', projectId: b.projectId })
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      return okResult(
        told
          ? `Added to #${t.number}. ${who!.name} is on it and will pick it up on their next turn — ` +
              `do not create a ticket for this.`
          : `Added to #${t.number}. Nobody is working on it right now, so it is part of the ` +
              `ticket for whoever picks it up.`,
      )
    },
  },

  {
    name: 'restart_step',
    description:
      'Pick a stalled step back up. Use when a ticket\'s active step has nobody running it — ' +
      'the assignee died, the app was closed mid-work, or a launch was lost. It resumes the ' +
      'same teammate in the same worktree with its context intact, so it does not redo what ' +
      'it has already done. Safe to call: it refuses if the step is actually running.',
    schema: restartStepSchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['ticket'],
      properties: {
        ticket: { type: 'number' },
        why: { type: 'string', description: 'One line, for the log. What had stopped.' },
      },
    },
    run: (raw, b) => {
      const a = restartStepSchema.parse(raw)
      const t = getTicketByNumber(b.projectId, a.ticket)
      if (!t) return deny(`There is no ticket #${a.ticket}.`)

      const route = acceptedRoute(t.id)
      const step = activeStep(route)
      if (!step) return deny(`#${t.number} has no active step, so there is nothing to restart.`)
      if (!step.assigneeAgentId) {
        return deny(
          `#${t.number}'s ${STEP_LABEL[step.kind]} step has nobody on it. Use assign_teammate — ` +
            `there is no session to resume.`,
        )
      }

      const who = getAgent(step.assigneeAgentId)
      if (!who) return deny(`#${t.number}'s assignee no longer exists. Assign somebody else.`)
      /*
       * Only refuse while a turn is genuinely in flight.
       *
       * This read `forAgent`, which for Codex stays true from first launch to explicit stop.
       * So `restart_step` answered "nothing is stuck, leave it alone" about a teammate that had
       * produced no file and no commit and was not running — and it was one of three tools that
       * all refused for the same reason, leaving the ticket recoverable only by hand.
       */
      if (manager.isBusy(who.id)) {
        return deny(`${who.name} is running right now. Nothing is stuck — leave it alone.`)
      }
      if (gate.isQueued(who.id)) {
        return deny(`${who.name} is already queued to start. It goes when a slot frees.`)
      }

      /*
       * The point of the whole tool is that this is a **resume**: a cold start would re-read
       * the codebase and repeat work already sitting committed in the worktree, which is why
       * the session id and the worktree are persisted before spawn. `relaunchAssignee` owns
       * that, and owns the `.catch` this call site used to be missing — without it a failed
       * relaunch left the teammate frozen at `queued` and invisible to every later check.
       */
      relaunchAssignee({
        agentId: who.id,
        ticketId: t.id,
        brief: step.brief,
        because: 'Restarting a stalled step',
        pilotAgentId: b.agentId,
      })

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'system',
        kind: 'notice',
        body: `#${t.number} restarted: ${who.name} is picking up ${STEP_LABEL[step.kind]}${
          a.why ? ` — ${a.why}` : ''
        }.`,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      return okResult(
        `${who.name} is resuming ${STEP_LABEL[step.kind]} on #${t.number}, with its previous ` +
          `session. Say one short line to the user about what had stopped and that it is moving.`,
      )
    },
  },


  {
    name: 'deploy',
    description:
      'Send the current base branch to a configured environment. The environments are the ' +
      'user\'s — you cannot invent one. An environment marked as needing confirmation will ' +
      'REFUSE and tell you to ask; that includes production, at every autonomy setting, ' +
      'because a deploy is the one thing here that reaches other people. ' +
      'Deploy what has been merged, not what is sitting in a worktree.',
    schema: deploySchema,
    availableTo: pilotOnly,
    inputSchema: {
      type: 'object',
      required: ['environment'],
      properties: {
        environment: { type: 'string', description: 'Its name, e.g. "dev" or "production".' },
        ticket: { type: 'number', description: 'What this is deploying, if it is one ticket.' },
      },
    },
    run: async (raw, b) => {
      const a = deploySchema.parse(raw)
      const project = getProject(b.projectId)
      if (!project) return deny('That project no longer exists.')

      const env = findEnvironment(b.projectId, a.environment)
      if (!env) {
        const have = listEnvironments(b.projectId)
        return deny(
          have.length === 0
            ? `This project has no environments configured. The user sets them up in ` +
                `Settings — say so rather than trying to run a deploy command yourself.`
            : `There is no environment called "${a.environment}". There is: ` +
                `${have.map((e) => e.name).join(', ')}.`,
        )
      }

      /*
       * The gate. Deliberately a refusal rather than a prompt: `ask_user` would block this
       * tool call for as long as the user took to answer, and a deploy is not something to
       * agree to inside a tool result. The Pilot asks in the conversation, and the user
       * presses the button on the Deploy panel.
       */
      if (env.confirm) {
        return deny(
          `"${env.name}" needs the user to confirm, so it cannot be deployed from here. Tell ` +
            `them in one line what would go out and ask them to press Deploy. This is not a ` +
            `setting you can work around.`,
        )
      }

      const ticket = a.ticket ? getTicketByNumber(b.projectId, a.ticket) : null
      const startedAt = Date.now()
      // Same mechanism as run_checks: deploying is that, with a different list and a gate.
      const res = await runCommand(env.cmd, project.path)
      const record = recordDeployment({
        projectId: b.projectId,
        environmentId: env.id,
        environment: env.name,
        ticketId: ticket?.id ?? null,
        byAgentId: b.agentId,
        ok: res.ok,
        exitCode: res.exitCode,
        output: res.output,
        startedAt,
      })

      addMessage({
        projectId: b.projectId,
        agentId: b.agentId,
        authorType: 'system',
        kind: res.ok ? 'notice' : 'error',
        body: res.ok
          ? `Deployed to ${env.name}${ticket ? ` (#${ticket.number})` : ''}.`
          : `Deploy to ${env.name} failed (exit ${res.exitCode}).\n\n\`\`\`\n${res.output}\n\`\`\``,
      })
      flushWrites()
      bus.emitDomain({ type: 'messages:changed', projectId: b.projectId })

      return res.ok
        ? okResult(`Deployed to ${env.name}. Say so in one line.`, { deployment: record.id })
        : deny(
            `The deploy to ${env.name} failed with exit ${res.exitCode}. Do not retry it ` +
              `blindly — read the output and say what went wrong.\n\n${res.output}`,
          )
    },
  },

]

const BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]))

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  binding: RunBinding,
): Promise<ToolResult> {
  const tool = BY_NAME.get(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  if (!tool.availableTo(binding.role)) {
    return deny(`Only the Pilot can use ${name}. Ask it to do this for you with dm_agent.`)
  }
  try {
    return await tool.run(args, binding)
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issue = e.issues[0]
      throw new Error(
        `${name}: ${issue?.path.join('.') ?? 'argument'} — ${issue?.message ?? 'invalid'}`,
      )
    }
    return deny(`${name} failed: ${(e as Error).message}`)
  }
}

/** Exposed for `tools/list`, which must not leak the zod schema or the handler. */
export function publicToolDefs(role: AgentRole) {
  return TOOL_DEFS.filter((t) => t.availableTo(role)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

export function ticketRefFor(binding: RunBinding): string | null {
  if (!binding.ticketId) return null
  const t = getTicket(binding.ticketId)
  return t ? `#${t.number}` : null
}
