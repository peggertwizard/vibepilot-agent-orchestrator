import type { Agent, Epic, HireProposal, Question, Ticket, TicketRoute } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { buildNeedsYouItems } from '../src/renderer/src/components/NeedsYouPopover'

/**
 * The list behind the "Needs you" button.
 *
 * Its job is to be the *only* answer to "what is waiting on me", which the app previously
 * spread across five places and counted in a sixth. Two properties matter enough to pin down:
 * the order (a teammate stopped mid-run outranks a hire that can wait a week) and the two
 * derivations that are wrong in ways no screenshot reveals — which routes are actually parked
 * at a gate, and which merges are really the same merge.
 */

const ticket = (over: Partial<Ticket>): Ticket =>
  ({
    id: 't', projectId: 'p', number: 1, title: 'A ticket', body: '',
    lane: 'todo', stuck: false, laneBecause: '', waitingFor: [], stage: null,
    needsPlanning: false, readyToMerge: false, mergeState: 'none', conflictFiles: [],
    assigneeAgentId: null, branch: null, worktreePath: null, headSha: null, sizeNote: null,
    dependsOn: [], backlogRank: null, budgetUsd: null, epicId: null, doneAt: null,
    archivedAt: null, createdAt: 1, updatedAt: 1,
    ...over,
  }) as Ticket

const route = (over: Partial<TicketRoute>): TicketRoute =>
  ({
    id: 'r', projectId: 'p', ticketId: 't', status: 'accepted', rationale: 'because',
    proposedByAgentId: null, steps: [], createdAt: 1, updatedAt: 1,
    ...over,
  }) as TicketRoute

const step = (over: Record<string, unknown>): TicketRoute['steps'][number] =>
  ({ id: 's', kind: 'build', status: 'pending', assigneeAgentId: null, note: null,
     brief: null, gate: false, model: null, effort: null, ...over }) as TicketRoute['steps'][number]

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: 'a', projectId: 'p', name: 'Sam', role: 'builder', provider: 'claude', model: 'sonnet',
    effort: null, isPilot: false, isRoster: true, ephemeral: false, status: 'idle',
    statusLine: null, resolvedModel: null, sessionId: null, instructions: null,
    avatarInitials: 'SA', createdAt: 1, updatedAt: 1,
    ...over,
  }) as Agent

const build = (over: Partial<Parameters<typeof buildNeedsYouItems>[0]>) =>
  buildNeedsYouItems({
    questions: [], tickets: [], routes: [], drafts: [], epics: [], hires: [], agents: [],
    render: {
      question: () => null, gate: () => null, split: () => null,
      route: () => null, draft: () => null, stuck: () => null,
    },
    renderHire: () => null,
    ...over,
  })

describe('what counts as waiting on you', () => {
  /*
   * The bug that made the popover necessary: the Pilot asked two questions as chat prose. A
   * real `ask_user` question has to be impossible to miss, and impossible to scroll past.
   */
  it('puts a blocking question above everything else', () => {
    const items = build({
      questions: [{ id: 'q1', agentId: 'a', question: 'Redeploy after upgrade?' } as Question],
      hires: [{ id: 'h1', name: 'Robin', why: 'needs a reviewer' } as HireProposal],
      agents: [agent({})],
    })
    expect(items[0]?.kind).toBe('question')
    expect(items.at(-1)?.kind).toBe('hire')
  })

  it('names who is stopped, so answering feels like unblocking someone', () => {
    const items = build({
      questions: [{ id: 'q1', agentId: 'a', question: 'Which name?' } as Question],
      agents: [agent({ id: 'a', name: 'Robin' })],
    })
    expect(items[0]?.summary).toContain('Robin')
  })
})

describe('routes parked at a sign-off', () => {
  it('offers the approval once the plan is done and the build is gated', () => {
    const items = build({
      tickets: [ticket({ id: 't8', number: 8, title: 'Versioned rules' })],
      routes: [
        route({
          ticketId: 't8',
          steps: [
            step({ id: 's1', kind: 'plan', status: 'done' }),
            step({ id: 's2', kind: 'build', status: 'pending', gate: true }),
          ],
        }),
      ],
    })
    const gate = items.find((i) => i.kind === 'gate')
    expect(gate?.title).toContain('#8')
    expect(gate?.go?.ticketId).toBe('t8')
  })

  /*
   * Both halves of the derivation matter. Offering "approve the build" while the plan is still
   * running asks you to sign off on a document that does not exist yet — and `approveGate`
   * would refuse anyway, so the button would be a lie twice over.
   */
  it('stays quiet while the step before the gate is still running', () => {
    const items = build({
      tickets: [ticket({ id: 't8', number: 8 })],
      routes: [
        route({
          ticketId: 't8',
          steps: [
            step({ id: 's1', kind: 'plan', status: 'active' }),
            step({ id: 's2', kind: 'build', status: 'pending', gate: true }),
          ],
        }),
      ],
    })
    expect(items.some((i) => i.kind === 'gate')).toBe(false)
  })

  it('ignores an ungated route, which needs nothing from you', () => {
    const items = build({
      tickets: [ticket({ id: 't8', number: 8 })],
      routes: [
        route({
          ticketId: 't8',
          steps: [
            step({ id: 's1', kind: 'plan', status: 'done' }),
            step({ id: 's2', kind: 'build', status: 'pending', gate: false }),
          ],
        }),
      ],
    })
    expect(items.some((i) => i.kind === 'gate')).toBe(false)
  })
})

describe('merges', () => {
  /*
   * Two tickets, one branch, one squash-merge — and until now, two identical "Merge into main"
   * buttons above two identical branch names. Pressing either lands both; pressing the second
   * does nothing, and nothing on screen said so.
   */
  it('is one entry for one branch, however many tickets are on it', () => {
    const items = build({
      tickets: [
        ticket({ id: 't7', number: 7, title: 'Rules into the template', readyToMerge: true, branch: 'vp/7-rules' }),
        ticket({ id: 't8', number: 8, title: 'Versioned package', readyToMerge: true, branch: 'vp/7-rules' }),
      ],
    })
    const merges = items.filter((i) => i.kind === 'merge')
    expect(merges).toHaveLength(1)
    expect(merges[0]?.title).toContain('#7')
    expect(merges[0]?.title).toContain('#8')
    expect(merges[0]?.summary).toContain('one merge')
  })

  it('keeps unrelated branches apart', () => {
    const items = build({
      tickets: [
        ticket({ id: 't1', number: 1, readyToMerge: true, branch: 'vp/1-a' }),
        ticket({ id: 't2', number: 2, readyToMerge: true, branch: 'vp/2-b' }),
      ],
    })
    expect(items.filter((i) => i.kind === 'merge')).toHaveLength(2)
  })
})

describe('teammates that stopped', () => {
  it('offers a restart for a stalled assignee', () => {
    const items = build({
      tickets: [ticket({ id: 't1', number: 1, assigneeAgentId: 'a' })],
      agents: [agent({ id: 'a', name: 'Sam', status: 'stalled', statusLine: 'The model call failed.' })],
    })
    const stuck = items.find((i) => i.kind === 'stuck')
    expect(stuck?.title).toContain('Sam')
    expect(stuck?.summary).toContain('model call failed')
  })

  it('says nothing about an idle teammate with no work', () => {
    const items = build({ agents: [agent({ status: 'idle' })] })
    expect(items).toEqual([])
  })
})

describe('the count and the list', () => {
  /*
   * The header used to sum questions + drafts + routes + merges + hires while the tray
   * rendered splits it never counted. The number on the button and the number of things behind
   * it could differ, which makes the number worse than no number.
   */
  it('counts exactly what it shows, splits included', () => {
    const items = build({
      epics: [{ id: 'e1', title: 'Three pieces', summary: 'a breakdown', pieces: [1, 2, 3] } as unknown as Epic],
      tickets: [ticket({ id: 't1', number: 1, readyToMerge: true, branch: 'vp/1' })],
    })
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.kind)).toEqual(['split', 'merge'])
  })
})
