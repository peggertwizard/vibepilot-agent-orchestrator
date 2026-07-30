import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/events'
import type { AgentRole, EscalationLevel, ProviderId, StepKind } from '@shared/types'
import {
  BUDGET_HARD_MULTIPLE,
  STEP_BLURB,
  STEP_BUDGET_USD,
  STEP_LABEL,
  activeStep,
  configuredChecks,
  effortDefaultFor,
  escalationRule,
  roleDef,
  routeSummary,
} from '@shared/types'
import { bus } from '../bus'
import { id, now } from '../db'
import { enqueueWrite, flushWrites } from '../db/writer'
import {
  getAgent,
  setAgentSession,
  setAgentStatus,
  setAgentStatusLine,
} from '../db/repos/agents'
import { addMessage } from '../db/repos/messages'
import { getProject } from '../db/repos/projects'
import { listFindings, renderFindings } from '../db/repos/findings'
import { acceptedRoute } from '../db/repos/routes'
import { getTicket, updateTicket } from '../db/repos/tickets'
import { ensureWorktree, diffStat } from '../git/worktree'
import { mcpServer } from '../mcp/server'
import { memoryPreamble, readRules } from './context'
import { manager } from './manager'
import { decideCarry } from './carry'
import { branchGroupFor } from './grouping'
import { noteSessionChange } from './session'
import { summariseTool } from './status'
import { pilot } from './pilot'
import type { LaunchSpec } from '../providers/types'

/**
 * Launching a teammate: worktree, prompt, process, and the notice path back to the Pilot.
 *
 * The Pilot's `spawn_agent` tool returns in milliseconds; everything here happens after,
 * asynchronously. Creating a worktree on a large repo takes seconds, and blocking the
 * Pilot's tool call on it would serialise the fleet and burn its context on transcripts.
 */

export interface SpawnInput {
  projectId: string
  agentId: string
  name: string
  role: AgentRole
  provider: ProviderId
  model: string
  ticketId: string
  brief: string
  pilotAgentId: string
  /**
   * Pick up where it left off instead of starting cold.
   *
   * Set when the user restarts a stalled teammate. `markAllStalledOnBoot` marks everyone
   * interrupted by a close, and its comment claimed the UI "offers a restart instead" — it
   * did not, so closing the app mid-work ended that work permanently, with the worktree and
   * the session id both sitting there unused. This is the flag that spends them.
   */
  resumeSessionId?: string | null
}

export async function launchTeammate(input: SpawnInput): Promise<void> {
  const project = getProject(input.projectId)
  const ticket = getTicket(input.ticketId)
  if (!project || !ticket) {
    /*
     * A dead end: an `error` status with no message, no notice to the Pilot, and nothing that
     * would ever move it again. The board showed an agent stopped for no stated reason and
     * the only way out was noticing it yourself.
     */
    const why = !project ? 'its project was removed' : 'its ticket was deleted'
    setAgentStatus(input.agentId, 'error', `Could not start — ${why}`)
    addMessage({
      projectId: input.projectId,
      agentId: input.agentId,
      authorType: 'system',
      kind: 'error',
      body: `${input.name} could not start: ${why}. Nothing is running for this work.`,
    })
    flushWrites()
    bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
    bus.emitDomain({ type: 'messages:changed', projectId: input.projectId })
    pilot.notify(
      input.projectId,
      `${input.name} could not start because ${why}. Nothing is running. Say one line to the ` +
        `user about it — do not silently reassign the work.`,
    )
    return
  }

  setAgentStatus(input.agentId, 'starting', 'Preparing a worktree')
  bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })

  let worktree: Awaited<ReturnType<typeof ensureWorktree>>
  try {
    /*
     * One branch per thing that must land together, not per ticket.
     *
     * Three tickets from one request used to mean three branches, three worktrees and three
     * merges — and worse, the branches were cut from the base at different times, so merging
     * them in sequence brought back what the earlier one had removed. Tickets in one
     * dependency chain now share a worktree keyed on the lowest number in the group.
     */
    const group = branchGroupFor(ticket.id) ?? { number: ticket.number, title: ticket.title }
    worktree = await ensureWorktree({
      projectPath: project.path,
      ticketNumber: group.number,
      title: group.title,
      baseBranch: project.defaultBaseBranch,
    })
  } catch (e) {
    const why = (e as Error).message.split('\n')[0] ?? 'unknown error'
    setAgentStatus(input.agentId, 'error', 'Could not create a worktree')
    addMessage({
      projectId: input.projectId,
      agentId: input.agentId,
      authorType: 'system',
      kind: 'error',
      body: `${input.name} could not start: creating a git worktree for #${ticket.number} failed — ${why}`,
    })
    flushWrites()
    bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
    bus.emitDomain({ type: 'messages:changed', projectId: input.projectId })
    pilot.notify(
      input.projectId,
      `${input.name} could not start on #${ticket.number}: the worktree could not be created (${why}). ` +
        `Do not retry blindly — tell the user.`,
    )
    return
  }

  // `stage` is deliberately not set here — it mirrors the active route step and is written
  // only by the route repo. Setting it from two places is how the board starts lying.
  updateTicket(ticket.id, {
    branch: worktree.branch,
    worktreePath: worktree.path,
    assigneeAgentId: input.agentId,
    lane: 'in_progress',
  })
  bus.emitDomain({ type: 'tickets:changed', projectId: input.projectId })

  const route = acceptedRoute(ticket.id)
  const step = activeStep(route)

  /*
   * The bridge has to be up before we can tell an agent where it is.
   *
   * `mcpServer.url` throws when nothing is listening, and this function never started it — it
   * relied on the Pilot having launched first, which is true on the ordinary path and false on
   * every other one: restarting a stalled teammate after an app restart, a queued launch
   * draining on resume, or a route auto-starting before anyone has spoken to the Pilot. Those
   * all failed with "MCP server not listening" and left the teammate in `error` with a message
   * that reads like a broken install.
   *
   * Idempotent — it returns the port it already bound.
   */
  await mcpServer.listen()

  const runId = id()
  const sessionId = randomUUID()

  /*
   * Cold start, or pick up what this teammate already knows?
   *
   * Decided here rather than by the caller, so every launch path gets the same answer. An
   * explicit `resumeSessionId` — the stalled-agent restart — still wins: that one is not a
   * judgement about relatedness, it is resuming the very work that was interrupted.
   */
  const carry = input.resumeSessionId
    ? { sessionId: input.resumeSessionId, why: 'Restarted: resuming the interrupted session.' }
    : await decideCarry({
        projectId: input.projectId,
        agentId: input.agentId,
        role: input.role,
        ticket,
        brief: input.brief,
      })
  const token = mcpServer.mintToken({
    runId,
    agentId: input.agentId,
    projectId: input.projectId,
    ticketId: ticket.id,
    role: input.role,
  })

  const def = roleDef(input.role)

  /*
   * Two numbers doing two different jobs.
   *
   * The soft one is briefed in words and is what actually shapes behaviour — the model reads
   * it, plus the CLI's own per-turn `USD budget: …` reminder, and paces itself.
   *
   * The hard one is `--max-budget-usd`, and it is a guillotine: it fires after the cost is
   * credited, aborts mid-turn, and discards any tool call the model just requested. The turn
   * that crosses the line is paid for in full regardless — measured at $0.0955 against a
   * $0.0001 cap. So it sits well above the target and should almost never fire.
   */
  const softBudget = ticket.budgetUsd ?? STEP_BUDGET_USD[step?.kind ?? 'build']
  const hardBudget = Math.round(softBudget * BUDGET_HARD_MULTIPLE * 100) / 100

  const me = getAgent(input.agentId)

  const spec: LaunchSpec = {
    runId,
    provider: input.provider,
    maxBudgetUsd: hardBudget,
    /*
     * The step's own choice wins over the teammate's default.
     *
     * Picking Opus for one hard ticket used to rewrite the roster row, making that teammate an
     * Opus teammate for every ticket afterwards — and two live tickets sharing one person
     * fought over a single value. The override lives on the step, so it is scoped to the work
     * it was chosen for.
     */
    effort: step?.effort ?? me?.effort ?? effortDefaultFor(input.role),
    agentId: input.agentId,
    projectId: input.projectId,
    ticketId: ticket.id,
    parentAgentId: input.pilotAgentId,
    cwd: worktree.path,
    addDirs: [],
    model: step?.model ?? input.model,
    appendSystemPrompt: buildTeammatePrompt({
      name: input.name,
      role: input.role,
      projectPath: project.path,
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      ticketBody: ticket.body,
      branch: worktree.branch,
      baseBranch: project.defaultBaseBranch,
      brief: input.brief,
      stepKind: step?.kind ?? 'build',
      /*
       * Read from the worktree the plan step committed it to — the same worktree this agent
       * is about to work in, since a ticket keeps one.
       */
      planMd: readPlanMd(worktree.path),
      stepNote: step?.note ?? null,
      budgetUsd: softBudget,
      pass: step?.passes ?? 1,
      routeLine: route ? routeSummary(route.steps) : null,
      instructions: me?.instructions ?? '',
      projectId: input.projectId,
      escalation: project.escalation,
      checks: configuredChecks(project.checks),
      findings: renderFindings(listFindings(ticket.id)),
      memory: memoryPreamble({
        projectId: input.projectId,
        projectPath: project.path,
        agentName: input.name,
        // Scope the recall to the work in hand, not the whole store.
        task: `${ticket.title} ${ticket.body} ${input.brief}`,
      }),
    }),
    permissionMode: 'bypassPermissions',
    // Only if you have said this folder is trusted. See migration 017.
    trustProjectSettings: project.settingsTrusted,
    disallowedTools: def?.denyTools.length ? def.denyTools : undefined,
    mcp: { url: mcpServer.url, token },
    sessionId,
    // Resume only works from the same cwd the session was created in, which is why the
    // worktree is reused above rather than cut fresh.
    resumeSessionId: carry.sessionId,
  }

  // Persist the resume handle and the worktree BEFORE spawning: a crash before the first
  // system/init must still leave something recoverable.
  setAgentSession(input.agentId, sessionId, worktree.path)
  enqueueWrite(
    `INSERT INTO agent_runs
       (id, agent_id, project_id, ticket_id, provider, session_id, resumed_from, cwd, started_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    runId,
    input.agentId,
    input.projectId,
    ticket.id,
    'claude',
    sessionId,
    // `resumed_from` has been in the schema since 001 and was written only by the Pilot.
    // It is the audit surface for whether a carry decision was right.
    carry.sessionId,
    worktree.path,
    now(),
  )

  // Say it out loud. A teammate that starts already knowing things, for reasons nobody can
  // see, is the version of this feature that gets blamed for a mistake it did not make.
  addMessage({
    projectId: input.projectId,
    agentId: input.agentId,
    authorType: 'system',
    kind: 'notice',
    body: `${input.name} on #${ticket.number}: ${
      carry.sessionId ? 'carrying context' : 'starting fresh'
    } — ${carry.why}`,
  })
  flushWrites()

  subscribeTeammate(input, runId, ticket.number, project.path, project.defaultBaseBranch, worktree.branch)

  await manager.launchNow(spec, { text: input.brief, channel: 'user' })
}

function subscribeTeammate(
  input: SpawnInput,
  runId: string,
  ticketNumber: number,
  projectPath: string,
  baseBranch: string,
  branch: string,
): void {
  const off = bus.onAgent((e: AgentEvent) => {
    if (e.agentId !== input.agentId) return

    switch (e.type) {
      case 'agent:started':
        setAgentStatus(input.agentId, 'working', 'Getting oriented')
        setAgentSession(input.agentId, e.sessionId)
        bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
        break

      case 'agent:tool:start':
        setAgentStatusLine(input.agentId, summariseTool(e.name))
        bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
        break

      // Agent totals are persisted centrally in engine/telemetry.ts; this is the per-turn
      // audit row.
      case 'agent:cost':
        enqueueWrite(
          `INSERT INTO usage_events
             (id, project_id, agent_id, run_id, ticket_id, provider, model, input_tokens,
              output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id(), input.projectId, input.agentId, runId, input.ticketId, 'claude', e.model,
          e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens,
          e.costUsd, e.costSource, now(),
        )
        break

      case 'agent:done': {
        enqueueWrite(
          'UPDATE agent_runs SET ended_at = ?, terminal_reason = ? WHERE id = ?',
          now(), e.terminal, runId,
        )
        noteSessionChange(input.projectId, input.agentId, e.sessionId)

        /*
         * Running out of budget is not finishing.
         *
         * The step is NOT done, and the process is effectively gone: it stays alive but
         * answers every subsequent prompt in milliseconds with a frozen budget error while
         * still holding the agent's slot. So stop it properly, mark the agent blocked rather
         * than idle, and tell the Pilot the truth — including that raising the budget means a
         * new process, because the cap is fixed at spawn.
         */
        if (e.terminal === 'budget') {
          setAgentStatus(input.agentId, 'blocked', 'Ran out of budget')
          addMessage({
            projectId: input.projectId,
            agentId: input.agentId,
            authorType: 'system',
            kind: 'error',
            body:
              `${input.name} (#${ticketNumber}) ran out of budget and stopped. ` +
              `Their worktree and any commits are intact.`,
          })
          flushWrites()
          void manager.stop(input.agentId, 'budget exhausted').catch(() => undefined)
          bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
          bus.emitDomain({ type: 'messages:changed', projectId: input.projectId })
          pilot.notify(
            input.projectId,
            `${input.name} hit the spend limit on #${ticketNumber} and stopped. The step is ` +
              `NOT finished and their process is gone. Their worktree is intact, so nothing is ` +
              `lost. Tell the user what was done and ask whether to give it more budget — that ` +
              `means starting a fresh run, so say so — or to narrow the ticket instead.`,
          )
          off()
          break
        }

        setAgentStatus(input.agentId, 'idle', e.summary ?? 'Finished')
        flushWrites()
        bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })

        // The Pilot never sees the raw stream — only this summary. That is what keeps its
        // context from exploding as the fleet grows.
        void notifyPilotOfCompletion(input, ticketNumber, projectPath, baseBranch, branch, e.summary ?? e.resultText)
        off()
        break
      }

      case 'agent:error': {
        setAgentStatus(
          input.agentId,
          e.reason === 'stalled' ? 'stalled' : 'error',
          e.message.slice(0, 120),
        )
        addMessage({
          projectId: input.projectId,
          agentId: input.agentId,
          authorType: 'system',
          kind: 'error',
          body: `${input.name} (#${ticketNumber}) stopped: ${e.message}`,
        })
        enqueueWrite(
          'UPDATE agent_runs SET ended_at = ?, terminal_reason = ? WHERE id = ?',
          now(), e.reason, runId,
        )
        flushWrites()
        bus.emitDomain({ type: 'agents:changed', projectId: input.projectId })
        bus.emitDomain({ type: 'messages:changed', projectId: input.projectId })
        pilot.notify(
          input.projectId,
          `${input.name} stopped working on #${ticketNumber}: ${e.message}. ` +
            `Its worktree is intact. Decide whether to reassign, adjust the ticket, or ask the user.`,
        )
        off()
        break
      }
    }
  })
}

async function notifyPilotOfCompletion(
  input: SpawnInput,
  ticketNumber: number,
  projectPath: string,
  baseBranch: string,
  branch: string,
  summary: string | null | undefined,
): Promise<void> {
  const agent = getAgent(input.agentId)
  const stat = agent?.worktreePath ? await diffStat(agent.worktreePath, baseBranch) : null
  void projectPath

  const bits = [`${input.name} finished its turn on #${ticketNumber}.`]
  if (summary?.trim()) bits.push(summary.trim())
  if (stat) {
    bits.push(
      `Branch ${branch}: ${stat.commits} commit${stat.commits === 1 ? '' : 's'}, ` +
        `${stat.files} file${stat.files === 1 ? '' : 's'}, +${stat.insertions} −${stat.deletions}.`,
    )
  }
  bits.push(
    'It is idle now. If the work is done, check it and tell the user; if not, send it another instruction with message_agent.',
  )
  pilot.notify(input.projectId, bits.join('\n'))
}

function buildTeammatePrompt(input: {
  name: string
  role: AgentRole
  projectPath: string
  ticketNumber: number
  ticketTitle: string
  ticketBody: string
  branch: string
  baseBranch: string
  brief: string
  stepKind: StepKind
  /** The plan step's `plan.md`, when a previous step wrote one. */
  planMd: string | null
  stepNote: string | null
  pass: number
  /** The soft target, in notional list-price dollars. The hard cap sits above it. */
  budgetUsd: number
  routeLine: string | null
  instructions: string
  projectId: string
  /** How readily this project wants a question to reach the user. */
  escalation: EscalationLevel
  /** The commands `run_checks` will run. Empty means this project has configured none. */
  checks: Array<{ kind: string; cmd: string }>
  findings: string
  memory: string
}): string {
  const def = roleDef(input.role)
  const rules = readRules(input.projectPath)

  const parts: string[] = [
    `# You are ${input.name}, a ${def?.name ?? input.role} on this project`,
    '',
    def?.blurb ?? '',
    '',
    '## Your ticket',
    '',
    `**#${input.ticketNumber} — ${input.ticketTitle}**`,
    '',
    input.ticketBody || '(no further description)',
    '',
    '## Your step',
    '',
    // Every ticket carries its own route. Telling the agent which step it holds — and which
    // it does NOT — is what stops a researcher from writing code and a builder from
    // wandering into work someone else owns.
    `This ticket's route is **${input.routeLine ?? STEP_LABEL[input.stepKind]}**. You have the ` +
      `**${STEP_LABEL[input.stepKind]}** step${input.pass > 1 ? `, pass ${input.pass}` : ''}.`,
    '',
    STEP_BLURB[input.stepKind],
    ...(input.stepNote ? ['', `Why this step is on the route: ${input.stepNote}`] : []),
    '',
    'Do that step and nothing beyond it. When it is finished call `advance_step` with what ' +
      'you found or did — that is what moves the ticket on and what the user reads.',
    '',
    /*
     * The soft budget, said in words.
     *
     * The CLI does inject a `USD budget: $x/$y; $z remaining` reminder every turn, so the model
     * can already pace itself — but it is terse, unrounded, and easy to read past. This is the
     * lever that actually shapes behaviour; the hard --max-budget-usd cap above it only stops.
     *
     * This exists because a research run that was asked to "find one small task" made 72 tool
     * calls over 15 minutes and wrote 35,000 words to recommend a one-sentence change.
     */
    `## What you can spend`,
    '',
    `You have roughly **$${input.budgetUsd.toFixed(2)}** of model spend for this whole ` +
      `assignment, and you can see what is left in the budget reminder on each turn. Pace ` +
      `yourself against it and wrap up with what you have before it runs out — an answer ` +
      `delivered inside the budget is worth more than a better one that never arrives.`,
    '',
    'Concretely: do not explore beyond what the step asks for. If one page or one file answers ' +
      'the question, stop there rather than reading the repository to be thorough. Cost grows ' +
      'faster than linearly with the number of tool calls, because each one re-reads the whole ' +
      'conversation.',
    ...(input.stepKind === 'research'
      ? [
          '',
          'This is a research step: **write no code**. The answer is the deliverable. Give file ' +
            'paths and line numbers, and do not speculate past what you actually read.',
        ]
      : []),
    ...(input.pass > 1 && input.findings
      ? [
          '',
          '### What came back from review',
          '',
          input.findings,
          '',
          'Fix exactly these. `must` blocks, `should` is a real objection, `nit` is taste and ' +
            'you may disagree — say so rather than silently ignoring it. Do not take the ' +
            'opportunity to change anything else.',
        ]
      : []),
    ...(input.stepKind === 'review'
      ? [
          '',
          'You are reviewing, not fixing. **You cannot edit files** — that is deliberate, ' +
            'because the builder still has the context and you do not. Read the diff against ' +
            'the base branch, run it if you can, and report with file and line.',
          '',
          'If it is fine, call `advance_step` and say so briefly. Do not invent concerns to ' +
            'look useful. If it is not, call `review_failed` with specifics — it goes straight ' +
            'back to the same builder, who is still running.',
        ]
      : []),
    '',
    '## Where you are working',
    '',
    `You are in an isolated git worktree on branch \`${input.branch}\`, cut from ` +
      `\`${input.baseBranch}\`. Your current directory IS that worktree — everything you do ` +
      'here is invisible to the rest of the project until a human merges it. Work freely; ' +
      'you cannot break anyone else.',
    '',
    'Commit your work as you go. Do not push, do not merge, do not switch branches.',
  ]

  if (input.stepKind === 'plan') {
    parts.push(
      '',
      '## Plan, do not build',
      '',
      'Work out the approach and surface the open questions BEFORE any code changes. If a ' +
        'decision is hard to undo, use `ask_user` rather than guessing. Write the approach to ' +
        '`plan.md` in this worktree and commit it — whoever builds this next will read it.',
    )
  }

  /*
   * Hand the plan to whoever builds it.
   *
   * The plan step was told to write `plan.md` and nothing ever pointed the builder at it. It
   * was merely *present* in the worktree — which relies on the next agent thinking to look for
   * a file nobody mentioned. Naming it is the difference between a plan that shaped the work
   * and a plan that was written and ignored.
   */
  if (input.stepKind !== 'plan' && input.planMd) {
    parts.push(
      '',
      '## The plan for this ticket',
      '',
      'Someone planned this before you, and the user approved that plan. Follow it. If you ' +
        'disagree with part of it, say so and explain why rather than quietly doing something ' +
        'else — they signed off on this shape specifically.',
      '',
      input.planMd.slice(0, 12_000),
    )
  }

  if (input.instructions.trim()) {
    // The user wrote these for this specific teammate. They sit after the project rules but
    // before the ticket, because they describe who this agent is, not what it is doing now.
    parts.push('', '## How you work', '', input.instructions.trim())
  }

  if (rules.length) {
    parts.push('', '## Project rules', '', 'These are binding.', '')
    for (const r of rules) parts.push(`### ${r.name}`, '', r.body, '')
  }

  if (input.memory) {
    parts.push('', '---', '', input.memory)
  }

  parts.push(
    '',
    '## Working with the team',
    '',
    'You have vibePilot tools:',
    '',
    `- \`advance_step\` — finish your step on #${input.ticketNumber} and hand on. Your report ` +
      'goes here.',
    '- `ask_user` — ask the human. Blocking by default; `urgency: "background"` records the ' +
      'question and lets you carry on, then `await_answer` when you actually need it.',
    '- `dm_agent` — ask a colleague, or `dm_agent` with `to: "pilot"` to reach the Pilot.',
    '- `shoutout` — tell everyone something that changes what they should do.',
    '- `recall` — search what this project already knows before working it out yourself.',
    '- `remember` — write down anything that would have saved you time if you had known it.',
    ...(input.stepKind === 'review'
      ? ['- `review_failed` — send it back with a fix list, to the builder who is still running.']
      : []),
    `- \`mark_ready_to_merge\` — when #${input.ticketNumber} is built, tested and committed.`,
    '',
    '- `run_checks` — run this project\'s own checks in your worktree. **vibePilot runs them, ' +
      'not you**, so the result is evidence rather than a claim, and you get the output to ' +
      'work from.',
    '',
    'You can only touch your own ticket. Report honestly: if tests fail, say so with the ' +
      'output. Never claim something passed that you did not see pass.',
    ...(input.checks.length
      ? [
          '',
          '## How this project is checked',
          '',
          'The user has told vibePilot how to check this repo:',
          '',
          ...input.checks.map((c) => `- **${c.kind}** — \`${c.cmd}\``),
          '',
          'Call `run_checks` before you say the work is done. It runs all of them and hands you ' +
            'the real exit codes and output. Saying a ticket is finished without having run it ' +
            'is visible to the user on the ticket, so there is nothing to gain by skipping it.',
        ]
      : []),
    '',
    '## Asking',
    '',
    escalationRule(input.escalation, false),
    '',
    'The user may hand your question to the Pilot rather than answer it. If the answer comes ' +
      'back marked as the Pilot\'s, no human has seen it — take it, but treat it as a default ' +
      'you were given rather than a decision that was made, and say so in your report.',
    '',
    '## Right now',
    '',
    input.brief,
  )

  return parts.join('\n')
}

/** The plan a previous step wrote, if any. Absent and unreadable mean the same thing here. */
function readPlanMd(worktreePath: string): string | null {
  try {
    const p = join(worktreePath, 'plan.md')
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}
