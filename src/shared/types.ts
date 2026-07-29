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

export type Lane = 'backlog' | 'todo' | 'in_progress' | 'done'
export const LANES: readonly Lane[] = ['backlog', 'todo', 'in_progress', 'done'] as const
export const LANE_LABEL: Record<Lane, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
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

/** Statuses that mean the agent is actively holding a concurrency slot. */
export const LIVE_STATUSES: readonly AgentStatus[] = [
  'starting',
  'thinking',
  'working',
  'waiting_on_you',
] as const

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
export function isValidModel(id: string): boolean {
  return MODEL_OPTIONS.some((m) => m.id === id) || isPinnedModel(id)
}

export function providerForModel(id: string): ProviderId {
  return MODEL_OPTIONS.find((m) => m.id === id)?.provider ?? 'claude'
}

/** What to show on a chip before the CLI has told us what it resolved to. */
export function modelLabel(id: string): string {
  const opt = MODEL_OPTIONS.find((m) => m.id === id)
  if (opt) return opt.label
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
export const CODEX_LIMITATIONS = [
  'no live streaming — you see its work only when a turn finishes',
  'no sub-agents, so it cannot run its own checks',
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
  /** Null follows `MAX_REVIEW_PASSES`. */
  reviewPasses: number | null
  /** Per project, because a throwaway repo and a business project want different tiers. */
  pilotModel: string | null
  pilotEffort: EffortLevel | null
  /** The backstop under the per-ticket budgets. Null means none. */
  spendCeilingUsd: number | null
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
  status: 'proposed' | 'active' | 'done' | 'rejected'
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
 * How many tokens this agent has actually put through a model.
 *
 * Every distinct token, counted once: what was sent, what came back, and what was newly added
 * to the cache. Cache **reads** are excluded, because they are the same conversation being
 * re-sent on every API call — a 115k context read back across 27 round-trips reports 3.1M
 * cache reads that are 115k of content, not 3.1M of it.
 *
 * This was previously a *weighted* figure (`out × 5`, `cacheRead × 0.1`, `cacheWrite × 2`),
 * which is a fair proxy for what usage costs against a rate limit — but it was labelled "tok",
 * and a cost proxy wearing a token label is just a wrong number. It read 645k for an agent
 * whose real throughput was 136k. Claude Code's own display uses the same convention this now
 * does, which is why a turn there reads 1.6k rather than the whole re-sent conversation.
 *
 * The weighted figure still exists as `weightedTokens` for the places that genuinely mean
 * "what did this cost me".
 */
export function totalTokens(a: Pick<Agent, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'>): number {
  return a.tokensIn + a.tokensOut + a.tokensCacheWrite
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
    `${n(a.tokensIn)} sent · ${n(a.tokensOut)} written back · ${n(a.tokensCacheWrite)} added to cache\n` +
    `= ${n(totalTokens(a))} tokens\n\n` +
    `Not counted: ${n(a.tokensCacheRead)} cache reads — the same conversation re-sent on every ` +
    `call, so counting it would count the same content over and over.`
  )
}

export interface Ticket {
  id: string
  projectId: string
  number: number
  title: string
  body: string
  lane: Lane
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
  /** Commits this branch has that the base does not. Zero means nothing to merge. */
  ahead: number
  behind: number
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
