/** Domain types shared between main, preload and renderer. No runtime imports. */

export type ProviderId = 'claude' | 'codex'

/**
 * What a ticket can be made to go through.
 *
 * v1 had a fixed four-stage pipeline every ticket walked. That is over-process applied
 * uniformly — "it was always going through planning building testing verifying testing
 * building 50 screenshots". These are the steps a route can be *composed of*; which ones a
 * given ticket gets is a judgement the Pilot makes per ticket. A short route is one
 * available answer, not the preferred one: the point is that the route fits the work.
 */
export type StepKind = 'research' | 'plan' | 'build' | 'review'
export const STEP_KINDS: readonly StepKind[] = ['research', 'plan', 'build', 'review'] as const
export const STEP_LABEL: Record<StepKind, string> = {
  research: 'Research',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
}
export const STEP_BLURB: Record<StepKind, string> = {
  research: 'Find something out and report back. No code is written.',
  plan: 'Work out the approach and surface the open questions before anyone codes.',
  build: 'Do the work, and check it runs.',
  review: 'Independent eyes on finished work. Cannot edit — reports so the builder fixes.',
}

/**
 * What a step is expected to cost, in notional list-price dollars.
 *
 * The Pilot proposes a real number per ticket; these are only where it starts from. Keyed on
 * step kind rather than model because $3 buys ~25 Opus cycles, ~45 Sonnet or ~130 Haiku — one
 * set of numbers works across every tier with no tuning matrix.
 *
 * These are the SOFT figure: the number the agent is told, in words, in its brief. The hard
 * `--max-budget-usd` cap sits at BUDGET_HARD_MULTIPLE above it, because a budget stop is a
 * guillotine — it aborts mid-turn, discards any tool calls in flight, and the crossing turn is
 * paid in full regardless. A cap set at the target turns every budget event into lost work.
 */
export const STEP_BUDGET_USD: Record<StepKind, number> = {
  research: 3,
  plan: 3,
  build: 12,
  review: 4,
}

/**
 * How far above the briefed target the hard cap sits.
 *
 * Measured: a $0.0001 cap still spent $0.0955 on a single Opus turn with a warm cache. The
 * real ceiling is always "budget + one expensive turn", so the cap needs headroom or it fires
 * on work that was about to finish.
 */
export const BUDGET_HARD_MULTIPLE = 2

/** A step never reached, currently being worked, finished, or sent back by a reviewer. */
export type StepStatus = 'pending' | 'active' | 'done' | 'rework'

export interface RouteStep {
  id: string
  kind: StepKind
  assigneeAgentId: string | null
  status: StepStatus
  /** >1 means it came back from review. Shown as `pass N` on the card. */
  passes: number
  /** Why this step exists. Shown to the user — an unjustified step is a smell. */
  note: string | null
  /**
   * The prompt this step's assignee will actually receive.
   *
   * Written by the Pilot when it proposes the route, and shown on the presentation card
   * BEFORE anything spawns. This is the highest-leverage thing on that card: it is where you
   * catch "find one small task" inviting a survey, rather than after it has cost $7.
   */
  brief: string | null
  /**
   * Stop before this step and wait for the user.
   *
   * The question this exists for: *"if a ticket is sitting in the backlog but has a plan to
   * it, could it really not start already?"* The answer is that the **plan** can start and the
   * **build** must wait — and until now there was no way to say that. `completeActiveStep`
   * advanced from step to step unconditionally, so "plan it, I approve, then build" could only
   * be expressed by not starting the route at all. The planning phase, which is safe and is
   * precisely what makes the sign-off decision possible, sat unstarted.
   *
   * Research and plan steps are safe: they read, they think, they write a document into a
   * worktree. Nothing reaches your base branch, nothing deploys, and the whole step costs a
   * few dollars. So the safe prefix runs, and the route parks here with the plan in front of
   * you — which is a far better moment to be asked than before anyone had looked at anything.
   */
  gate?: boolean
  /**
   * Model and effort **for this step only**.
   *
   * Both pickers on the route card used to write straight to the roster row, so choosing Opus
   * for one tricky ticket quietly made that teammate an Opus teammate for ever — *"changing
   * the builder's model and effort in a specific task should not change the default for other
   * tasks"*. It also meant two live tickets sharing one teammate fought over a single setting.
   *
   * Null means "use whatever that teammate is set to", which is what the roster is for.
   */
  model?: string | null
  effort?: EffortLevel | null
}

export type RouteStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded'

export interface TicketRoute {
  id: string
  ticketId: string
  projectId: string
  status: RouteStatus
  rationale: string
  proposedByAgentId: string | null
  /** True when vibePilot applied it without asking — the trivial single-build case. */
  autoAccepted: boolean
  steps: RouteStep[]
  createdAt: number
  updatedAt: number
}

/** The active step, or null when the route is finished or not yet accepted. */
export function activeStep(route: TicketRoute | null | undefined): RouteStep | null {
  if (!route) return null
  return route.steps.find((s) => s.status === 'active' || s.status === 'rework') ?? null
}

/** How far through the route this ticket is, for a progress read at a glance. */
export function routeProgress(route: TicketRoute | null | undefined): { done: number; total: number } {
  if (!route) return { done: 0, total: 0 }
  return { done: route.steps.filter((s) => s.status === 'done').length, total: route.steps.length }
}

/** A one-line rendering of a route: "Research → Build → Review". */
export function routeSummary(steps: Pick<RouteStep, 'kind'>[]): string {
  return steps.map((s) => STEP_LABEL[s.kind]).join(' → ') || '—'
}

/**
 * `waiting` is the lane whose absence made the board lie.
 *
 * A ticket the teammate has finished is not in progress and is not done — it is waiting on
 * you to merge it. With nowhere to put that, `mark_ready_to_merge` had to choose between two
 * false statements and chose "In progress". See `shared/board.ts`.
 */
export type Lane = 'backlog' | 'todo' | 'in_progress' | 'waiting' | 'done'
export const LANES: readonly Lane[] = ['backlog', 'todo', 'in_progress', 'waiting', 'done'] as const
export const LANE_LABEL: Record<Lane, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting for you',
  done: 'Done',
}

export type MergeState = 'none' | 'cpd_running' | 'conflict' | 'ready' | 'merged' | 'failed'

/** `must` blocks, `should` is a real objection, `nit` is taste. */
export type FindingSeverity = 'must' | 'should' | 'nit'

export interface Finding {
  id: string
  ticketId: string
  projectId: string
  pass: number
  byAgentId: string | null
  severity: FindingSeverity
  summary: string
  detail: string
  file: string | null
  line: number | null
  resolvedAt: number | null
  createdAt: number
}

/**
 * Three passes, then it goes to you.
 *
 * A reviewer and a builder can disagree indefinitely, and each round costs a full turn from
 * both. Past this point the disagreement is the problem, not the code.
 */
export const MAX_REVIEW_PASSES = 3

export type AgentStatus =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'thinking'
  | 'working'
  | 'waiting_on_you'
  | 'paused'
  | 'blocked'
  | 'stalled'
  | 'error'
  | 'done'

/**
 * Statuses that mean the agent is holding a concurrency slot.
 *
 * `waiting_on_you` belongs here: the process is alive with its context loaded, so the slot is
 * genuinely occupied and letting someone else in would oversubscribe the cap.
 */
export const LIVE_STATUSES: readonly AgentStatus[] = [
  'starting',
  'thinking',
  'working',
  'waiting_on_you',
] as const

/**
 * Statuses that mean the agent is actually doing something.
 *
 * Deliberately **not** the same list, and this is why: the agents rail counted "N working"
 * off `LIVE_STATUSES`, so a teammate blocked on a question read as working while a
 * budget-exhausted `blocked` one read as idle — both wrong, in opposite directions, on the
 * one strip whose entire job is telling you what is happening.
 *
 * Holding a slot and doing work are different questions. The gate asks the first, every
 * screen asks the second, and sharing a constant between them meant one of them was always
 * being answered incorrectly.
 */
export const WORKING_STATUSES: readonly AgentStatus[] = ['starting', 'thinking', 'working'] as const

/** Alive, but the next move is yours. Counted separately because it is your queue, not theirs. */
export const NEEDS_YOU_STATUSES: readonly AgentStatus[] = ['waiting_on_you', 'blocked'] as const

/**
 * Roles, deliberately few.
 *
 * v1 had Scout/Planner/Implementer/Reviewer/Tester as fixed pipeline stages. That is a human
 * org chart applied to something that is not a human org: it forces a handoff per stage,
 * each costing a ~5s cold start and ~4k cache-creation tokens, and each losing everything
 * the previous agent had learned. A Builder owns a ticket end to end instead.
 *
 * Specialists exist only where the work is genuinely different in kind.
 */
export type AgentRole = 'pilot' | 'builder' | 'reviewer' | 'scout' | 'specialist'

export const ROLES: readonly Exclude<AgentRole, 'pilot'>[] = [
  'builder',
  'reviewer',
  'scout',
  'specialist',
] as const

export interface RoleDef {
  id: Exclude<AgentRole, 'pilot'>
  name: string
  blurb: string
  /** Tools this role may never use, on top of the global policy. */
  denyTools: string[]
  /** Shown as a starting point when you create one of these. */
  suggestedInstructions: string
}

export const ROLE_DEFS: readonly RoleDef[] = [
  {
    id: 'builder',
    name: 'Builder',
    blurb:
      'Owns a ticket end to end — decisions, code, tests — in its own worktree. Most work ' +
      'needs exactly one of these and nothing else.',
    denyTools: [],
    suggestedInstructions:
      'Finish the ticket properly: make the change, make it work, and prove it works before ' +
      'you say it does. Match the surrounding code rather than importing your own style.',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    blurb:
      'Fresh eyes on finished work. Cannot edit — it reports what it found so the builder ' +
      'fixes it. The one handoff worth paying for.',
    denyTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    suggestedInstructions:
      'Read the change as someone who did not write it. Say specifically what is wrong and ' +
      'where. If it is fine, say so briefly rather than inventing concerns.',
  },
  {
    id: 'scout',
    name: 'Scout',
    blurb:
      'Cheap breadth. Searches a large codebase and reports back so a builder does not burn ' +
      'its context on greps. Never changes a file.',
    denyTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    suggestedInstructions:
      'Answer the question asked, with file paths and line numbers. Do not speculate beyond ' +
      'what you actually read.',
  },
  {
    id: 'specialist',
    name: 'Specialist',
    blurb:
      'Whatever you need that the others are not — copywriting, data, docs. Define it with ' +
      'instructions.',
    denyTools: [],
    suggestedInstructions: '',
  },
] as const

export function roleDef(role: AgentRole): RoleDef | null {
  return ROLE_DEFS.find((r) => r.id === role) ?? null
}

/**
 * Models are chosen explicitly per agent — there is deliberately no default.
 * Rate limits are the real concurrency cap, so a silent default is how you
 * stall the whole board without knowing why.
 *
 * We store ALIASES, not pinned model ids. `claude --model opus` always resolves to the
 * current Opus, so this list never goes stale — and the CLI tells us in `system/init.model`
 * what it actually resolved to, which is what the UI displays. Hardcoding ids is how v1
 * ended up offering models that did not exist.
 */
export interface ModelOption {
  /** Alias passed to --model. Resolves to the latest model in that tier. */
  id: string
  label: string
  provider: ProviderId
}

/*
 * Names only.
 *
 * These used to carry a `note` apiece — 'the workhorse', 'deepest reasoning · heaviest on quota',
 * 'fast and cheap · for breadth, not depth'. Three problems with that. It was opinion presented
 * as specification, in the slot where the model's actual identity belongs. It could not be kept
 * true, because the alias points at whatever ships next. And Fable's note went as far as naming
 * an exact id from a string literal — the precise mistake the comment above warns about, sitting
 * eight lines below it.
 *
 * What the user wants to know is which model this is and which exact version is running. The
 * first is the label; the second is only knowable once the CLI has told us, so it is shown when
 * known and left out when not.
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: 'opus', label: 'Opus', provider: 'claude' },
  { id: 'sonnet', label: 'Sonnet', provider: 'claude' },
  { id: 'fable', label: 'Fable', provider: 'claude' },
  { id: 'haiku', label: 'Haiku', provider: 'claude' },
  { id: 'codex', label: 'Codex', provider: 'codex' },
] as const

/**
 * How hard an agent thinks — the CLI's `--effort`, which vibePilot never passed.
 *
 * `ultracode` is listed separately rather than as a synonym for `xhigh` because it does
 * something xhigh does not: it is xhigh **plus a standing instruction to orchestrate
 * sub-agents**. A teammate on ultracode may fan out its own fleet on one ticket. That is real
 * power on hard work and also the fastest way to multiply a ticket's cost, so it is offered,
 * never defaulted, and always visible before anything spawns.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'ultracode' | 'max'

export interface EffortOption {
  id: EffortLevel
  label: string
  note: string
}

/**
 * The CLI's five levels, in the CLI's own order, then ultracode.
 *
 * Checked against the shipped binary rather than assumed. The canonical list is
 * `["low","medium","high","xhigh","max"]` — **max is the top of the ladder and ultracode is not
 * on it at all**. Ultracode is a separate switch the binary describes as "xhigh effort plus
 * standing dynamic-workflow orchestration", gated behind an xhigh-capable model.
 *
 * So it sits after max, past a divider: not because it thinks harder than max, but because it is
 * a different kind of thing — the same reasoning as xhigh, plus permission to fan out. Listing it
 * mid-ladder implied an ordering that does not exist.
 */
export const EFFORT_OPTIONS: readonly EffortOption[] = [
  { id: 'low', label: 'Low', note: 'least thinking, fastest' },
  { id: 'medium', label: 'Medium', note: 'the working default' },
  { id: 'high', label: 'High', note: 'thinks before acting' },
  { id: 'xhigh', label: 'Extra high', note: 'thinks longer · not on every model' },
  { id: 'max', label: 'Max', note: 'the most thinking the model will do' },
  {
    id: 'ultracode',
    label: 'Ultracode',
    note: 'extra high, and it may run its own sub-agents · can multiply the cost',
  },
] as const

/** Where the CLI's real ladder stops and ultracode begins. Used to draw the divider. */
export const EFFORT_LADDER_LENGTH = 5

/**
 * Where a role starts.
 *
 * A Scout is doing breadth search where thinking is not the bottleneck; a Reviewer has the one
 * job where missing something *is* the failure. Null on the agent row means "use this", so
 * these can be retuned without overwriting anyone's explicit choice.
 */
export function effortDefaultFor(role: AgentRole): EffortLevel {
  switch (role) {
    case 'scout':
      return 'low'
    case 'reviewer':
      return 'high'
    default:
      return 'medium'
  }
}

export function isValidEffort(v: string): v is EffortLevel {
  return EFFORT_OPTIONS.some((e) => e.id === v)
}

/**
 * Models that support no effort level at all.
 *
 * Read out of the shipped CLI rather than guessed. The binary gates effort on an explicit list,
 * and every model on it refuses *all* levels — not merely the top ones:
 *
 *     claude-3-*, claude-opus-4-0, claude-opus-4-1, claude-sonnet-4-0,
 *     claude-sonnet-4-5, claude-haiku-4-5
 *
 * The previous list here was wrong in both directions. It barred `opus-4-5` and `opus-4-6`, which
 * are not on the CLI's list, and it missed `sonnet-4-5`, which is. It also treated Haiku as
 * merely lacking the top levels, when in fact it accepts none — so the picker offered six levels
 * for a model that honours zero of them, and warned about only three.
 */
const NO_EFFORT_MODELS = [
  'claude-3-',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const

/** What the aliases resolve to today, for the models that accept no effort. */
const NO_EFFORT_ALIASES: Record<string, string> = { haiku: 'claude-haiku-4-5' }

/**
 * Whether asking this model to think harder does anything.
 *
 * Pass the resolved id where it is known; the alias is accepted as a fallback and answered for
 * whatever that alias resolves to *today*, which is the honest scope of the answer.
 *
 * The CLI **silently downgrades** rather than erroring, and the result envelope carries no effort
 * field, so an unsupported level is invisible at every layer — you would simply pay for a setting
 * that did nothing. Hence saying so up front.
 */
export function supportsEffort(model: string | null | undefined): boolean {
  if (!model) return true
  const m = model.toLowerCase()
  const resolved = NO_EFFORT_ALIASES[m] ?? m
  return !NO_EFFORT_MODELS.some((p) => resolved.includes(p))
}

/**
 * The plain-language warning, or null when there is nothing to warn about.
 *
 * Two separate cases, deliberately worded differently: a model that takes no effort setting at
 * all, and ultracode asking for a fan-out the model cannot reach.
 */
export function effortNoteFor(model: string, effort: EffortLevel): string | null {
  const name = modelLabel(model)
  if (!supportsEffort(model)) {
    return `${name} has no thinking levels — this setting will not change anything it does.`
  }
  if (effort === 'ultracode') {
    return `Ultracode runs at extra high and lets ${name} start its own sub-agents. That can multiply what one ticket costs.`
  }
  return null
}

/**
 * A pinned model id, e.g. `claude-opus-4-8` or `claude-fable-5[1m]`.
 *
 * Aliases are the right default — they never go stale, and v1's hardcoded ids ended up
 * offering models that did not exist. But an alias always means *latest*, so there is no way
 * to say "this teammate stays on 4.8 while I check something". `--model` takes a full name as
 * well as an alias, so the escape hatch costs nothing but was never wired up.
 *
 * Deliberately permissive about the version part and strict about the prefix: a typo should
 * fail here rather than reaching the CLI, but a model released next month should not.
 */
export const PINNED_MODEL_RE = /^claude-[a-z]+-[a-z0-9-]+(\[\d+[km]\])?$/i

export function isPinnedModel(id: string): boolean {
  return PINNED_MODEL_RE.test(id.trim())
}

/** Anything `--model` will accept: one of our aliases, or a full model name. */
/**
 * How a specific Codex model is stored: `codex:gpt-5.6-sol`.
 *
 * The prefix is what keeps provider detection **structural**. A teammate's model is one string,
 * and `providerForModel` decided the provider by finding that string in `MODEL_OPTIONS` — which
 * works only while the list contains every possible answer. Discovered Codex ids are by
 * definition not in that list, so a teammate on `gpt-5.6-sol` would have been launched through
 * the Claude adapter. Prefixing means the provider is read off the value itself and cannot be
 * wrong, whatever OpenAI names things next.
 */
export const CODEX_PREFIX = 'codex:'

/**
 * Codex's name for a reasoning effort, in vibePilot's vocabulary.
 *
 * The two ladders are the same one — low, medium, high, xhigh, max — except at the top, where
 * Codex says `ultra` and vibePilot says `ultracode`. Neither borrowed the idea from the other,
 * and the CLI's own description of `ultra` ("maximum reasoning with automatic task delegation")
 * is what `ultracode` has always meant here, so this is a rename and nothing more.
 */
export function vpEffort(codex: string): string {
  return codex === 'ultra' ? 'ultracode' : codex
}

/** The bare id to hand `codex exec -m`, or null when no specific model was chosen. */
export function codexModelId(id: string): string | null {
  return id.startsWith(CODEX_PREFIX) ? id.slice(CODEX_PREFIX.length) || null : null
}

export function isValidModel(id: string): boolean {
  return MODEL_OPTIONS.some((m) => m.id === id) || !!codexModelId(id) || isPinnedModel(id)
}

export function providerForModel(id: string): ProviderId {
  if (id.startsWith(CODEX_PREFIX)) return 'codex'
  return MODEL_OPTIONS.find((m) => m.id === id)?.provider ?? 'claude'
}

/** What to show on a chip before the CLI has told us what it resolved to. */
export function modelLabel(id: string): string {
  const opt = MODEL_OPTIONS.find((m) => m.id === id)
  if (opt) return opt.label
  // A Codex model names itself honestly — there is no alias to resolve later, so this is
  // already the exact thing that runs.
  const codex = codexModelId(id)
  if (codex) return codex
  return isPinnedModel(id) ? prettyModel(id) : id
}

/**
 * What a Codex teammate cannot do.
 *
 * Verified against codex-cli 0.145.0 — see docs/architecture/01-codex-spike.md. Two things
 * the earlier plan asserted turned out to be wrong when actually checked: Codex DOES report
 * token usage (just not dollars, which we do not show anyway), and its OS sandbox does NOT
 * work on Windows — the helper binary is not shipped, so the launch fails and the command
 * runs unsandboxed. The sandbox was supposed to be its one advantage over Claude.
 */
/**
 * A Codex model, as the installed CLI describes itself.
 *
 * Deliberately not a constant anywhere in this file. Every other model list here is a set of
 * *aliases* (`opus`, `sonnet`) chosen precisely so it cannot name a version that stops
 * existing; Codex has no aliases, so the equivalent guarantee is to never write the list down
 * and ask the binary instead. See `providers/codex/models.ts`.
 */
export interface CodexModel {
  /** Passed to `codex exec -m`. */
  id: string
  /** What Codex calls it: "GPT-5.6-Sol". */
  label: string
  description: string
  /** The reasoning efforts this particular model accepts — they differ between models. */
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}

/*
 * What is actually true of a Codex teammate.
 *
 * Two edits, in opposite directions, both because the list had drifted from the CLI.
 *
 * **"no sub-agents" is gone.** Codex's `ultra` effort is documented by the CLI itself as
 * "maximum reasoning with automatic task delegation", and `codex doctor` reports real
 * `subagent:thread_spawn` sessions. Warning someone off a capability that exists is the same
 * kind of wrong as promising one that does not.
 *
 * **And the list never mentioned the thing that mattered.** Until now a Codex teammate had no
 * connection to vibePilot's own tools at all: it could do the work and had no way to say so,
 * so its route step sat `active` for ever and every ticket it touched became a stuck one. Four
 * honest annoyances were listed and the disqualifying fault was not. That is fixed rather than
 * documented — the tools are attached now — which is why no line here replaces it.
 */
export const CODEX_LIMITATIONS = [
  'no live streaming — you see its work only when a turn finishes',
  'no context-window reporting, so there is no meter for it',
  're-sends its instructions every turn, so long work costs more than it looks',
] as const

/** Default when nothing else is known. Used only for the Pilot's first run. */
export const DEFAULT_MODEL = 'sonnet'

/**
 * Turn whatever the CLI reported back into something readable.
 * e.g. "claude-opus-5[1m]" -> "Opus 5 · 1M", "claude-haiku-4-5-20251001" -> "Haiku 4.5"
 */
export function prettyModel(resolved: string | null | undefined, fallbackAlias?: string): string {
  /*
   * An alias echoed back is not a resolution.
   *
   * Codex never reports a model, so the adapter stores the alias it was handed and telemetry
   * writes it into `resolved_model` regardless — which made the chip read 'Codex' as though the
   * CLI had confirmed a version. The same thing happens for Claude whenever a `system/init` frame
   * arrives without a model field. Treat it as still unknown rather than inventing a fact.
   */
  const resolvedId = resolved && !MODEL_OPTIONS.some((m) => m.id === resolved) ? resolved : null
  if (!resolvedId) {
    const opt = MODEL_OPTIONS.find((m) => m.id === (resolved ?? fallbackAlias))
    return opt?.label ?? fallbackAlias ?? resolved ?? 'unknown'
  }
  const ctx = /\[(\d+m)\]/i.exec(resolvedId)?.[1]
  const base = resolvedId
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  const parts = base.split('-')
  const family = parts.shift() ?? base
  const version = parts.join('.')
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return [version ? `${name} ${version}` : name, ctx ? ctx.toUpperCase() : null]
    .filter(Boolean)
    .join(' · ')
}

/** Compact token counts: 1234 -> "1.2k", 1_450_000 -> "1.45M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export interface Project {
  id: string
  name: string
  path: string
  gitRemote: string | null
  defaultBaseBranch: string
  maxConcurrentAgents: number
  /** How readily a teammate's question reaches you rather than the Pilot. */
  escalation: EscalationLevel
  /**
   * Whether this folder's own `.claude/settings.json` is honoured.
   *
   * Off by default, and deliberately so. Those settings can carry hooks that shell out at
   * session start, and agents spawn with permissions bypassed — so trusting any folder that
   * happens to be on disk turns `git clone` into code execution. Interactive Claude Code asks
   * before trusting a directory; headless spawning never gets that dialog, so this is it.
   */
  settingsTrusted: boolean
  /**
   * How this project is checked.
   *
   * Verification used to be prose — a rule file saying "the project's tests pass" and nothing
   * checking whether that happened. Named commands make the claim checkable: `run_checks`
   * executes them and reports real exit codes, so an agent that says it verified and one that
   * did are no longer indistinguishable.
   */
  checks: ProjectChecks
  /** One command and a plain note. Never run without you asking. */
  deployCmd: string | null
  deployNote: string | null
  /** Null follows `MAX_REVIEW_PASSES`. 0 means keep going until it passes. */
  reviewPasses: number | null
  /**
   * When a route earns a reviewer: 1 (never) to 10 (always).
   *
   * Replaces a sentence of prose the Pilot had to interpret — "something visual, risky, or hard
   * to undo earns a reviewer" — under which a pricing card is visual, so a one-word copy change
   * was given a second agent and a second bill. A number the user sets cannot be reasoned
   * around, and each step is a strict superset of the one below it.
   */
  reviewSensitivity: number
  /**
   * Hold the launch queue shut.
   *
   * Pause means one thing: **do not start the next ticket**. It does not stop, interrupt or
   * touch anything already running — those finish normally. It is the counterweight to
   * `autoStart`, and it is deliberately the only control in the app with that name.
   */
  launchPaused: boolean
  /** Whether work may begin without you pressing Start. See migration 019. */
  autoStart: AutoStart
  /** Whether finished work merges into the base branch without you. See migration 022. */
  autoMerge: AutoMerge
  /**
   * How many days a finished ticket stays on the board before it archives itself.
   *
   * Zero means never — the board keeps everything, which is what the app did before migration
   * 024. Archiving is not deleting: the ticket stays readable behind the Archive toggle.
   */
  autoArchiveDays: number
  /** Per project, because a throwaway repo and a business project want different tiers. */
  pilotModel: string | null
  pilotEffort: EffortLevel | null
  /** The backstop under the per-ticket budgets. Null means none. */
  spendCeilingUsd: number | null
  /**
   * How to run this project's dev server, with `{port}` substituted.
   *
   * Run in the *worktree*, so a finished ticket can be looked at before it is merged. Null
   * means previews are unavailable for this project, which is a legitimate state — plenty of
   * projects have nothing to serve.
   */
  previewCmd: string | null
  /**
   * The last rate-limit state the CLI reported.
   *
   * Written on every `rate_limit_event` and never read by anything — the row mapper did not
   * even select it — so a board that stalled overnight came back with no explanation. It is the
   * only honest quota signal Anthropic exposes, and a stalled board with no reason is the worst
   * version of this.
   */
  rateLimitStatus: string | null
  rateLimitResetsAt: number | null
  ticketSeq: number
  /** When the startup scan proposed a starting team. Null means it hasn't run. */
  bootstrappedAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * Epic colours, as CSS custom properties rather than hex.
 *
 * The spine has to read in both themes and sit beside a design system built on one accent.
 * A colour the model chose would do neither, so it picks an index and the theme owns the
 * actual value.
 */
export const EPIC_COLOURS = [
  'var(--epic-1)',
  'var(--epic-2)',
  'var(--epic-3)',
  'var(--epic-4)',
  'var(--epic-5)',
  'var(--epic-6)',
] as const

export function epicColour(index: number): string {
  return EPIC_COLOURS[((index % EPIC_COLOURS.length) + EPIC_COLOURS.length) % EPIC_COLOURS.length]!
}

/** A piece of a proposed breakdown. Not a ticket until you say so. */
export interface EpicPiece {
  title: string
  body: string
  /** Positions within this proposal that must finish first. Becomes `dependsOn`. */
  dependsOnIndexes: number[]
  sizeNote: string | null
}

export interface Epic {
  id: string
  projectId: string
  title: string
  shortLabel: string
  colourIndex: number
  summary: string
  /**
   * `superseded` is the conversation moving on, which is a different fact from `rejected` —
   * one is a decision you made, the other is one the discussion made for you. A new split
   * proposal supersedes any open one, so two breakdowns of the same request can never sit on
   * the board waiting to both be accepted.
   */
  status: 'proposed' | 'active' | 'done' | 'rejected' | 'superseded'
  proposedByAgentId: string | null
  /** Populated only while `proposed`. Once accepted, the tickets are the epic. */
  pieces: EpicPiece[]
  createdAt: number
  updatedAt: number
}

/**
 * A teammate the Pilot wants to hire, waiting on you.
 *
 * The Pilot can no longer create teammates on its own. It proposes; you decide who exists.
 */
export interface HireProposal {
  id: string
  projectId: string
  proposedByAgentId: string | null
  name: string
  role: Exclude<AgentRole, 'pilot'>
  provider: ProviderId
  model: string
  instructions: string
  /** Why this person, in the Pilot's words. Shown on the card. */
  why: string
  fromBootstrap: boolean
  ticketId: string | null
  status: 'pending' | 'hired' | 'rejected'
  agentId: string | null
  createdAt: number
}

export interface Agent {
  id: string
  projectId: string
  parentAgentId: string | null
  name: string
  role: AgentRole
  avatarInitials: string
  provider: ProviderId
  model: string
  /** How hard it thinks. Null means "use the default for this role". */
  effort: EffortLevel | null
  isPilot: boolean
  ephemeral: boolean
  /** Persistent roster member you created, vs. spawned for one ticket. */
  isRoster: boolean
  /** Free-form, prepended to every turn this teammate takes. */
  instructions: string
  status: AgentStatus
  statusLine: string | null
  currentTicketId: string | null
  sessionId: string | null
  worktreePath: string | null
  stoppedReason: string | null
  startedAt: number | null
  lastEventAt: number | null
  costUsd: number
  /** What the CLI resolved our alias to, e.g. "claude-sonnet-5". Null until it starts. */
  resolvedModel: string | null
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  /** Context headroom from the last completed turn. Null until one completes. */
  contextUsed: number | null
  contextMax: number | null
  createdAt: number
  updatedAt: number
}

/**
 * Weights that turn the four raw usage fields into one comparable figure, in
 * input-token-equivalents — the unit a rate limit actually counts.
 *
 * Verified against a recorded cost_usd to seven decimal places and identical
 * across Opus 5, Sonnet 4.6 and Haiku 4.5. Cache writes are 2x because Claude
 * Code uses the 1-hour TTL, not the 5-minute one (which would be 1.25x).
 */
export const TOKEN_WEIGHTS = { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 2 } as const

/**
 * Tokens, as Claude itself counts them: what was sent, and what came back.
 *
 * Neither cache figure is included, and both exclusions are deliberate.
 *
 * **Cache reads** are the same conversation re-sent on every API call. A 115k context read back
 * across 27 round-trips reports 3.1M cache reads that are 115k of content, not 3.1M of it.
 *
 * **Cache writes** are that context being *stored*, not work anyone did — an artifact of how
 * the conversation is kept warm between calls. Including them made a four-paragraph reply read
 * 11k when Claude's own display, for a comparable turn, says under 3k.
 *
 * This figure has now been wrong three times, each for a different reason: first a raw sum of
 * all four fields (740k for one reply), then a cost-weighted total still labelled "tok" (645k
 * for an agent that had written 21k), then in + out + cacheWrite. Matching the convention the
 * user already reads elsewhere is the only definition that stops the number being surprising.
 *
 * The weighted figure survives as `weightedTokens` for the places that genuinely mean "what
 * did this cost me against my rate limit" — which is a real question, just not this one.
 */
export function totalTokens(a: Pick<Agent, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'>): number {
  return a.tokensIn + a.tokensOut
}

/**
 * What that usage is worth against a rate limit, in input-token-equivalents.
 *
 * Verified against a recorded `cost_usd` to seven decimal places and identical across Opus 5,
 * Sonnet 4.6 and Haiku 4.5. Use where the question is cost. Never label the result "tokens".
 */
export function weightedTokens(
  a: Pick<Agent, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'>
): number {
  return Math.round(
    a.tokensIn * TOKEN_WEIGHTS.in +
      a.tokensOut * TOKEN_WEIGHTS.out +
      a.tokensCacheRead * TOKEN_WEIGHTS.cacheRead +
      a.tokensCacheWrite * TOKEN_WEIGHTS.cacheWrite
  )
}

/** The raw four, for a tooltip that explains what the figure does and does not include. */
export function tokenBreakdown(
  a: Pick<Agent, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'>
): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  return (
    `${n(a.tokensIn)} sent · ${n(a.tokensOut)} written back = ${n(totalTokens(a))} tokens\n\n` +
    `Not counted, because neither is work done:\n` +
    `· ${n(a.tokensCacheRead)} cache reads — the conversation re-sent on every call\n` +
    `· ${n(a.tokensCacheWrite)} cache writes — that conversation being stored between calls`
  )
}

export interface Ticket {
  id: string
  projectId: string
  number: number
  title: string
  body: string
  /**
   * Derived, never trusted from storage. `listTickets` stamps this from `derivePlacement`
   * before anything sees a ticket, so the column a card sits in is recomputed from the route
   * and the live processes on every read rather than patched by whoever happened to touch
   * the ticket last. The stored value survives only as the user's backlog/to-do preference.
   */
  lane: Lane
  /** Derived with `lane`: the step is active and nothing is running it. */
  stuck: boolean
  /** Derived with `lane`: one sentence explaining the placement, for the card's tooltip. */
  laneBecause: string
  /**
   * Derived: which of `dependsOn` have **not** landed yet.
   *
   * The card used to print every dependency as "after #6, #7" and never update it, so a ticket
   * whose blockers had all merged still read as waiting. And when #7 finished before #6, the
   * card gave no clue that #6 was the one holding things up. Empty means nothing is in the way.
   */
  waitingFor: number[]
  /** Mirror of the active route step. The route is the truth; this is derived. */
  stage: StepKind | null
  needsPlanning: boolean
  readyToMerge: boolean
  mergeState: MergeState
  conflictFiles: string[]
  assigneeAgentId: string | null
  branch: string | null
  worktreePath: string | null
  headSha: string | null
  sizeNote: string | null
  dependsOn: number[]
  /** The Pilot's proposed position in the backlog. Null sorts last. */
  backlogRank: number | null
  /**
   * What this ticket is allowed to spend, in notional list-price dollars. Null means "use the
   * default for the step kind". The Pilot proposes a number; you can change it.
   */
  budgetUsd: number | null
  /** Set when this ticket is one piece of a larger request. */
  epicId: string | null
  /**
   * When this ticket became finished. Null while it is not.
   *
   * Separate from `updatedAt`, which moves for a rename or a branch pointer, and from
   * `archivedAt`, which is the *consequence* rather than the clock. Cleared if the ticket
   * comes back out of Done — it has not been finished for three days, it is not finished.
   */
  doneAt: number | null
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TicketDraft {
  id: string
  projectId: string
  proposedByAgentId: string | null
  title: string
  body: string
  lane: Lane
  needsPlanning: boolean
  ownerHint: string | null
  sizeNote: string | null
  dependsOn: number[]
  status: 'pending' | 'created' | 'parked' | 'rejected'
  ticketId: string | null
  createdAt: number
}

export type MessageKind = 'text' | 'notice' | 'draft' | 'tool_summary' | 'interrupted' | 'error'

export interface ToolSummary {
  toolUseId: string
  name: string
  summary: string
  durationMs: number | null
  isError: boolean
  /**
   * Set when this came from a sub-agent — Claude Code's own `Task` tool, running inside the
   * teammate's session. Rendered indented. There is deliberately no `agents` row for one:
   * vibePilot agents are OS processes, and a CLI sub-agent is not.
   */
  subagentOf?: string | null
  /** What was passed in, stringified and capped. Shown when a step is expanded. */
  input?: string
  /** What came back, capped head+tail so a failure message at the end survives. */
  output?: string
  truncated?: boolean
}

/**
 * What one reply cost.
 *
 * The whole turn — every tool cycle and every sub-agent inside it — not just the final
 * text. That is the number worth showing, because that is what was actually spent to
 * produce the thing you are reading.
 */
export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface Message {
  id: string
  projectId: string
  agentId: string | null
  authorType: 'user' | 'agent' | 'system'
  kind: MessageKind
  body: string
  toolSummaries: ToolSummary[]
  attachments: Attachment[]
  /** Null when the turn was killed before it reported — not zero. */
  usage: MessageUsage | null
  createdAt: number
}

export interface Attachment {
  name: string
  mediaType: string
  /** Path under userData; images are re-read at send time, never inlined into the DB. */
  path: string
  bytes: number
}

export interface Comm {
  id: string
  projectId: string
  kind: 'dm' | 'shoutout'
  fromAgentId: string | null
  toAgentId: string | null
  severity: 'info' | 'warn' | 'blocker'
  body: string
  ticketId: string | null
  readAt: number | null
  createdAt: number
}

export interface Question {
  id: string
  projectId: string
  agentId: string
  ticketId: string | null
  question: string
  context: string | null
  choices: string[]
  urgency: 'blocking' | 'background'
  status: 'open' | 'answered' | 'orphaned' | 'cancelled'
  answer: string | null
  /**
   * Who supplied the answer. The teammate is told, because "the Pilot decided this on your
   * behalf and no human has seen it" and "the user said so" deserve different confidence.
   */
  answeredBy: 'user' | 'pilot' | null
  /** When you handed it to the Pilot. The question stays open; you can still answer it. */
  pilotAskedAt: number | null
  askedAt: number
  answeredAt: number | null
}

/**
 * How readily a question reaches you.
 *
 * A scratch repo and a live business site want different answers, so this is per project. It
 * changes exactly two things: one threshold in the prompt, and whether a teammate is allowed to
 * carry on working instead of blocking. Deliberately the smallest thing that implements a real
 * preference — a dial with three settings and no hidden behaviour.
 */
/**
 * The four checks, in the order you would run them.
 *
 * Fixed keys rather than a free list: each one means something specific to the prompts and to
 * the review step, and "whatever the user typed" would mean nothing to either.
 */
export interface ProjectChecks {
  test: string | null
  typecheck: string | null
  lint: string | null
  build: string | null
}

export const CHECK_KINDS = ['typecheck', 'lint', 'test', 'build'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

export const CHECK_LABEL: Record<CheckKind, string> = {
  typecheck: 'Typecheck',
  lint: 'Lint',
  test: 'Test',
  build: 'Build',
}

/** The configured checks, in run order, skipping the ones this project has not set. */
export function configuredChecks(checks: ProjectChecks): Array<{ kind: CheckKind; cmd: string }> {
  return CHECK_KINDS.flatMap((kind) => {
    const cmd = checks[kind]?.trim()
    return cmd ? [{ kind, cmd }] : []
  })
}

/**
 * Everything one ticket knows about itself.
 *
 * The body, the route rationale, per-step assignee and effort, the branch, the worktree and the
 * cost were all recorded and rendered nowhere — clicking a ticket did nothing at all, and the
 * only editable field on a ticket anywhere in the app was which lane it sat in.
 */
export interface TicketDetail {
  ticket: Ticket
  accepted: TicketRoute | null
  proposed: TicketRoute | null
  findings: Finding[]
  /** From the diff, which is the only honest source — teammates never record their tool calls. */
  files: Array<{ status: string; path: string }>
  commitsAhead: number
  /**
   * The plan step's `plan.md`, if it wrote one.
   *
   * A plan step has always been told to write and commit this file, and nothing checked for
   * it, showed it, or handed it to the builder — so the document that justifies the whole
   * extra step existed only on a disk nobody looked at. It is what you read before approving
   * a gated build.
   */
  planMd: string | null
  spend: {
    costUsd: number
    tokensIn: number
    tokensOut: number
    tokensCacheRead: number
    tokensCacheWrite: number
    turns: number
  }
}

/* ── branches ─────────────────────────────────────────────────────────────── */

export interface BranchLine {
  name: string
  /**
   * Commits this branch has that the base does not.
   *
   * **Not a test for whether anything is left to merge** — see `landed`. vibePilot merges by
   * squashing, so a branch that landed perfectly keeps its own commits and this keeps counting
   * them for ever. It is honest about commits and says nothing about content.
   */
  ahead: number
  behind: number
  /**
   * Every line of this branch is already on the base.
   *
   * The question `ahead` was wrongly used to answer. Content, not bookkeeping: a squashed merge
   * copies the changes across as a new commit rather than carrying the originals, so `ahead`
   * stays positive on a branch with nothing left to give. Five dead branches read as unmerged
   * work in the panel because of it.
   */
  landed: boolean
}

export interface RemoteState {
  /** e.g. `origin/main`, or null when the base branch has never been pushed. */
  upstream: string | null
  ahead: number
  behind: number
}

/**
 * Where all the work is, read from local git.
 *
 * No network anywhere in this: it answers "where am I and what have my agents got" whether or
 * not a remote exists, and vibePilot's own repository has none, so that is not hypothetical.
 */
export interface BranchOverview {
  /** What the repository is actually checked out on. */
  current: string | null
  /** Where merges land. A stored setting, not a reading of the repo. */
  base: string
  /** True when you are standing somewhere other than the base branch. */
  diverged: boolean
  /** Commits on `current` that `base` does not have. Zero when they are the same branch. */
  currentAhead: number
  /** Null when there is no `origin` — Push is then absent rather than broken. */
  remote: RemoteState | null
  ticketBranches: BranchLine[]
  /**
   * Your own unsaved work, by name.
   *
   * Read before you press Merge rather than after it fails. An empty list means merging is one
   * uneventful press; a non-empty one is the whole explanation for why it is not, and vibePilot
   * offers to set these aside and put them back.
   */
  unsaved: string[]
  /**
   * Files git is not tracking at all, split out from `unsaved`.
   *
   * These are usually not yours in any meaningful sense: a tool that dropped `.claude/skills/`
   * into the folder, a build artefact, something nobody has got round to ignoring. They only
   * obstruct a merge if the incoming work adds the same path, so listing them as "your unsaved
   * work" made the merge look blocked by four folders the user had never touched.
   */
  untracked: string[]
}

export interface GhStatus {
  available: boolean
  reason?: string
  pullRequests: Array<{ number: number; title: string; branch: string; state: string }>
  runs: Array<{ name: string; status: string; conclusion: string; branch: string }>
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  ticketNumber: number | null
  ticketTitle: string | null
  /** Merged or archived: the work exists somewhere other than this copy. */
  safeToRemove: boolean
  bytes: number
}

/**
 * Whether work may begin without a button press.
 *
 * Deliberately separate from `EscalationLevel`. That one answers "how much may an agent
 * decide for itself once it is running"; this answers "may it start at all". Wanting the
 * first without the second is an entirely reasonable position, and folding them into one
 * control would make one of them unsettable.
 */
export type AutoStart = 'never' | 'simple' | 'always'

export const AUTO_START_OPTIONS: ReadonlyArray<{
  id: AutoStart
  label: string
  blurb: string
}> = [
  {
    id: 'never',
    label: 'Ask me first',
    blurb: 'Every route waits on the Start button. Nothing runs until you press it.',
  },
  {
    id: 'simple',
    label: 'Start the simple ones',
    blurb:
      'One step, one person, no reviewer, and the Pilot sure of it — that starts. Anything ' +
      'longer or less certain waits for you.',
  },
  {
    id: 'always',
    label: 'Just run it',
    blurb:
      'Work starts as soon as it is decided. Merging, deploying, an unmet dependency and the ' +
      'spend ceiling still stop and ask — those are the irreversible ones.',
  },
]

/**
 * When finished work merges into the base branch by itself.
 *
 * Separate from `autoStart` because they are different risks. Starting spends money and can be
 * stopped; merging changes your base branch — but *locally*, inspectably, and revertably. What
 * genuinely cannot be undone is push (leaves the machine) and deploy (reaches other people),
 * and both of those stay behind buttons at every setting here.
 */
export type AutoMerge = 'off' | 'green' | 'always'

export const AUTO_MERGE_OPTIONS: ReadonlyArray<{
  id: AutoMerge
  label: string
  blurb: string
}> = [
  {
    id: 'off',
    label: 'I merge everything myself',
    blurb: 'Finished work waits on the Branches tab until you press Merge.',
  },
  {
    id: 'green',
    label: 'Merge when the checks pass',
    blurb:
      'A finished ticket whose configured checks passed lands on your base branch on its own, ' +
      'and says so. Conflicts, empty branches and your own unsaved work still stop and ask.',
  },
  {
    id: 'always',
    label: 'Merge when the work is done',
    blurb:
      'The same, without requiring checks — for projects that have none configured. Anything ' +
      'that cannot be merged cleanly still stops.',
  },
]

export type EscalationLevel = 'ask_me' | 'balanced' | 'ship_it'

export const DEFAULT_ESCALATION: EscalationLevel = 'balanced'

export const ESCALATION_OPTIONS: ReadonlyArray<{
  id: EscalationLevel
  label: string
  blurb: string
}> = [
  {
    id: 'ask_me',
    label: 'Ask me',
    blurb: 'Anything ambiguous comes to you. The Pilot answers nothing on your behalf.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'The Pilot answers what it can from context. Judgement calls reach you.',
  },
  {
    id: 'ship_it',
    label: 'Just get on with it',
    blurb: 'Decide, record the assumption, and surface it in the done report. Nothing blocks.',
  },
]

export function isValidEscalation(v: string): v is EscalationLevel {
  return ESCALATION_OPTIONS.some((o) => o.id === v)
}

/** The paragraph an agent reads. One source, so the Pilot and a teammate cannot disagree. */
export function escalationRule(level: EscalationLevel, forPilot: boolean): string {
  if (forPilot) {
    switch (level) {
      case 'ask_me':
        return (
          'This project is set to **Ask me**. When a teammate hands you a question, do not ' +
          'answer it yourself — research it and call `escalate_question` so the user decides ' +
          'with your findings in front of them.'
        )
      case 'ship_it':
        return (
          'This project is set to **Just get on with it**. Answer questions yourself with ' +
          '`answer_question` wherever you can defend the answer. Escalate only when being ' +
          'wrong would be expensive and hard to undo.'
        )
      default:
        return (
          'This project is set to **Balanced**. Answer with `answer_question` when the ticket, ' +
          "the user's earlier messages or project memory already settle it. Use " +
          '`escalate_question` for genuine judgement calls — taste, scope, anything ' +
          'irreversible — and say what you checked.'
        )
    }
  }
  switch (level) {
    case 'ask_me':
      return (
        'This project is set to **Ask me**. When you are unsure, ask — the user would rather ' +
        'be interrupted than have you guess.'
      )
    case 'ship_it':
      return (
        'This project is set to **Just get on with it**. Do not block on questions. Decide, ' +
        'write down the assumption you made, and put it in your done report so it can be ' +
        'corrected afterwards. If you must ask, use `urgency: "background"` and keep working.'
      )
    default:
      return (
        'This project is set to **Balanced**. Work out what you can from the code and the ' +
        'ticket. Ask only when the decision changes what you build and you genuinely cannot ' +
        'tell — and prefer `urgency: "background"` so you are not idle while you wait.'
      )
  }
}

/**
 * Memory categories map one-to-one onto files under `.vibepilot/memory/`, which is what
 * makes "the files are the truth" literally true rather than aspirational: the category is
 * not stored anywhere independent of the file the entry lives in.
 */
export type MemoryCategory =
  | 'architecture'
  | 'convention'
  | 'gotcha'
  | 'decision'
  | 'glossary'
  | 'lesson'

export const MEMORY_FILES: Record<MemoryCategory, string> = {
  architecture: 'project/architecture.md',
  convention: 'project/conventions.md',
  gotcha: 'project/gotchas.md',
  decision: 'project/decisions.md',
  glossary: 'project/glossary.md',
  // `lesson` is per-agent; the file is agents/<name>.md, resolved at write time.
  lesson: 'agents',
}

export const MEMORY_CATEGORY_BLURB: Record<MemoryCategory, string> = {
  architecture: 'How this codebase is put together.',
  convention: 'How we do things here.',
  gotcha: 'Traps and non-obvious behaviour.',
  decision: 'What was chosen and why.',
  glossary: 'Domain and product vocabulary.',
  lesson: "Something one teammate learned, kept in that teammate's own file.",
}

/** Where an entry came from. `user` outranks the rest and is never expired. */
export type MemorySource = 'agent' | 'user' | 'curator'

export interface MemoryEntry {
  id: string
  projectId: string
  category: MemoryCategory
  title: string
  body: string
  /** Path relative to `.vibepilot/memory/`. Where to go and edit this by hand. */
  file: string
  slug: string
  source: MemorySource
  author: string | null
  /** The teammate whose own file this is. Null for project-wide memory. */
  agentScope: string | null
  /** Repo files this entry is about — the handle on staleness. */
  concerns: string[]
  supersededBy: string | null
  needsReview: boolean
  ticketId: string | null
  hitCount: number
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

/** Quota state derived from `rate_limit_event`. Drives the meter in the right panel. */
export interface QuotaState {
  status: string
  rateLimitType: string | null
  resetsAt: number | null
  isUsingOverage: boolean
  overageStatus: string | null
}

export interface DoctorReport {
  claudeBinary: string | null
  claudeVersion: string | null
  claudeKind: 'exe' | 'cmd' | 'node' | null
  /**
   * Codex, reported the same way — and absent is a normal answer, never a problem.
   *
   * Listed because "why can't I pick a Codex model?" had no answer inside the app. The model
   * list is read from the binary, so a Codex that cannot be found or cannot be asked produces
   * an empty picker and no explanation. `codexModels` is how many it offered.
   */
  codexBinary: string | null
  codexVersion: string | null
  codexModels: number | null
  gitVersion: string | null
  /**
   * The GitHub CLI, if it is there. Null is a normal answer, not a problem — everything
   * vibePilot does is local, and the GitHub section is absent rather than broken without it.
   */
  ghVersion: string | null
  mcpPort: number | null
  dbPath: string
  worktreeRoot: string
  problems: string[]
}

/**
 * Where a pending application update has got to.
 *
 * Shared because the main process drives it and the renderer has to say something truthful about
 * it. `error` is deliberately not alarming in the UI: no network and no published release both
 * land here, and neither means anything is wrong with the copy you are running.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none'; checkedAt: number }
  /** Found, and waiting for you. Nothing has been downloaded. */
  | { phase: 'available'; version: string; notes: string | null }
  | { phase: 'downloading'; percent: number; version: string }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; reason: string }

/**
 * When a route earns a reviewer.
 *
 * One ladder, used twice: the Settings slider renders `label`, and the Pilot's prompt is built
 * from `rule`. Keeping both off the same array is the point — the previous arrangement had the
 * criterion written only in the prompt, so the screen could not tell you what it would do and
 * the two could not be checked against each other.
 *
 * Each level is a strict superset of the one below, which is what makes a slider an honest
 * control: moving up only ever adds triggers, never swaps them.
 */
export const REVIEW_LADDER: ReadonlyArray<{
  level: number
  /** The slider's own label. Two or three words. */
  label: string
  /** Completes "a reviewer is added when the work…". */
  when: string
  /** Why this rung sits where it does, so the ladder explains its own ordering. */
  why: string
}> = [
  { level: 1, label: 'Never', when: '—', why: 'You review everything yourself.' },
  {
    level: 2,
    label: 'Destroys data',
    when: 'can delete or overwrite something with no way back',
    why: 'The only mistakes that are truly permanent.',
  },
  {
    level: 3,
    label: 'Changes the database',
    when: 'adds, renames or drops columns and tables',
    why: 'Hard to reverse once real data is in it.',
  },
  {
    level: 4,
    label: 'Touches money or access',
    when: 'changes logins, payments, permissions or keys',
    why: "Wrong here becomes other people's problem.",
  },
  {
    level: 5,
    label: 'Goes out to real users',
    // "Deploys" means the TICKET runs a release — not "the file is user-visible". Under the
    // looser reading every web change qualifies, which is exactly how a copy edit ended up
    // with its own reviewer.
    when: 'deploys or releases as part of this ticket',
    why: 'Customers see it before you do.',
  },
  {
    level: 6,
    label: 'Fails quietly',
    when: 'changes background jobs, scheduled tasks, caching or error handling',
    why: 'Breaks without telling anyone; you find out days later.',
  },
  {
    level: 7,
    label: 'Adds new logic',
    when: 'builds genuinely new functionality with real decisions in it',
    why: 'You would have to actually test it to know it works.',
  },
  {
    level: 8,
    label: 'Spreads wide',
    when: 'edits many files at once — a rename or refactor across the codebase',
    why: 'Each edit simple, blast radius large.',
  },
  {
    level: 9,
    label: 'Only shows on screen',
    when: 'changes layout, styling or new UI',
    why: 'You would spot it, but only by opening the page.',
  },
  {
    level: 10,
    label: 'Everything',
    when: 'is anything at all, including copy, wording and a single changed value',
    why: 'Nothing ships without a second pair of eyes.',
  },
] as const

export const DEFAULT_REVIEW_SENSITIVITY = 5

export function clampSensitivity(level: number): number {
  return Math.min(10, Math.max(1, Math.round(level || DEFAULT_REVIEW_SENSITIVITY)))
}

/**
 * The rule the Pilot is given, built from the level the user chose.
 *
 * Generated rather than written, so the screen and the prompt cannot disagree about what the
 * app will do — the previous version had the criterion only in the prompt, where nobody could
 * see it and nothing could check it.
 */
export function reviewRuleFor(level: number): string {
  const n = clampSensitivity(level)
  if (n === 1) {
    return 'Never add a `review` step. The user reviews everything themselves.'
  }
  if (n === 10) {
    return 'Add a `review` step to every build, whatever the work is.'
  }

  const triggers = REVIEW_LADDER.filter((r) => r.level >= 2 && r.level <= n).map((r) => r.when)
  const notYet = REVIEW_LADDER.filter((r) => r.level > n && r.level < 10).map((r) => r.when)

  return [
    'Add a `review` step ONLY when the work does one of these:',
    ...triggers.map((t) => `- ${t}`),
    '',
    'It does NOT earn a reviewer merely because it:',
    ...notYet.map((t) => `- ${t}`),
    '',
    'The principle, if a case is not listed: a reviewer is for what cannot be checked by',
    'looking. The user reads their own screen and will catch a wording or layout mistake',
    'faster than a second agent would. Do not add one because something feels important,',
    'or is customer-facing, or is "visual" — those are not the test.',
  ].join('\n')
}

/** How many teammates may run at once before the rate limit becomes the real cap. */
export const CONCURRENCY_WARN_ABOVE = 3

/** A place finished work can be sent. See migration 020. */
export interface Environment {
  id: string
  projectId: string
  name: string
  cmd: string
  /**
   * Ask before running.
   *
   * Not a preference for production. A deploy is the one action in the app that reaches
   * people other than you, so it stops and asks at every autonomy level — including "just
   * run it".
   */
  confirm: boolean
  position: number
  createdAt: number
}

export interface Deployment {
  id: string
  projectId: string
  environmentId: string | null
  environment: string
  ticketId: string | null
  byAgentId: string | null
  ok: boolean
  exitCode: number | null
  output: string
  startedAt: number
  finishedAt: number
}

/** A dev server running against one ticket's worktree. */
export interface PreviewInfo {
  ticketId: string
  port: number
  url: string
  startedAt: number
  log: string
}
