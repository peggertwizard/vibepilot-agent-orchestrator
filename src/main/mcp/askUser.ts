import { bus } from '../bus'
import { answerQuestion, getQuestion } from '../db/repos/messages'
import { setAgentStatus } from '../db/repos/agents'
import { flushWrites } from '../db/writer'
import type { RunBinding, ToolResult } from './tools'

/**
 * The blocking-question problem.
 *
 * `ask_user` has to wait for a human, but MCP clients time tool calls out. If the timeout
 * fires, the agent gets an opaque failure and — in practice — barrels ahead on a guess,
 * which is the exact outcome asking was meant to prevent.
 *
 * So we never let it time out. We wait on a SOFT timeout comfortably under the client
 * limit; if no answer arrives we return **success** with `status: "pending"` and tell the
 * agent to call `await_answer`. It can loop indefinitely without the transport ever
 * failing, and each loop is a chance for it to reconsider and proceed on a stated
 * assumption instead.
 */

/**
 * Half the ten-minute per-server ceiling set in `argv.ts`.
 *
 * This used to be 90 seconds against a 60-second transport timeout — the wait was longer than
 * the thing waiting for it, so the design never once worked as written. Half the ceiling means
 * it survives the ceiling being halved.
 *
 * The number matters for cost, not just correctness: every loop is a full model turn on the
 * teammate's entire context, spent doing nothing. Five minutes per loop buys the same patience
 * for a fifth of the turns.
 */
const SOFT_TIMEOUT_MS = 300_000

/** After this many loops the agent should stop burning turns and park the ticket. */
const MAX_LOOPS = 20

interface Waiter {
  runId: string
  loops: number
  resolve: (answer: string) => void
  /** Give up without an answer — the timer is cleared and the caller returns "pending". */
  cancel: () => void
}

class AskUserGate {
  private waiters = new Map<string, Waiter>()

  async wait(questionId: string, b: RunBinding, isContinuation = false): Promise<ToolResult> {
    const q = getQuestion(questionId)
    if (!q) {
      return {
        content: [{ type: 'text', text: `No such question: ${questionId}.` }],
        structuredContent: { ok: false },
      }
    }

    // Already answered while we were away (e.g. the process restarted).
    if (q.status === 'answered' && q.answer) {
      return this.answered(q.answer, q.answeredBy ?? 'user', b)
    }
    if (q.status === 'cancelled' || q.status === 'orphaned') {
      return {
        content: [
          {
            type: 'text',
            text: 'That question is no longer open. Use your best judgement and note the assumption.',
          },
        ],
        structuredContent: { ok: true, status: 'dismissed' },
      }
    }

    /*
     * `background` means what it says.
     *
     * This field has been in the schema since the first version and was completely dead —
     * `ask_user` blocked unconditionally, so an agent that explicitly said "this is not urgent,
     * I can carry on" was parked anyway. Honouring it is the only mode where a question costs
     * nothing while it waits.
     */
    if (q.urgency === 'background' && !isContinuation) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Noted and put in front of the user. You said this is not blocking, so carry on ' +
              'with what you can do without the answer. Call await_answer with this question_id ' +
              'when you reach the point where you actually need it.',
          },
        ],
        structuredContent: { ok: true, status: 'pending', question_id: questionId },
      }
    }

    const existing = this.waiters.get(questionId)
    const loops = (existing?.loops ?? 0) + (isContinuation ? 1 : 0)

    if (loops >= MAX_LOOPS) {
      this.waiters.delete(questionId)
      return {
        content: [
          {
            type: 'text',
            text:
              'Still no answer after a long wait. Stop waiting: either proceed on an explicit ' +
              'assumption and say clearly what you assumed, or mark the ticket blocked and move on.',
          },
        ],
        structuredContent: { ok: true, status: 'abandoned', question_id: questionId },
      }
    }

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), SOFT_TIMEOUT_MS)
      const done = (a: string | null): void => {
        clearTimeout(timer)
        resolve(a)
      }

      this.waiters.set(questionId, {
        runId: b.runId,
        loops,
        resolve: (a: string) => done(a),
        cancel: () => done(null),
      })
    })

    if (answer !== null) {
      this.waiters.delete(questionId)
      const fresh = getQuestion(questionId)
      return this.answered(answer, fresh?.answeredBy ?? 'user', b)
    }

    return {
      content: [
        {
          type: 'text',
          text:
            'No answer yet. Call await_answer with this question_id to keep waiting. If waiting ' +
            'is not worth it, proceed on a clearly stated assumption.',
        },
      ],
      structuredContent: { ok: true, status: 'pending', question_id: questionId },
    }
  }

  /**
   * The single entry point for answering a question: persists the answer AND unblocks a
   * waiting agent. Both must happen together — an answer that is stored but never delivered
   * strands the agent, and one that is delivered but never stored vanishes on restart.
   *
   * Returns true when an agent was actually waiting.
   */
  deliver(questionId: string, answer: string, by: 'user' | 'pilot' = 'user'): boolean {
    const before = getQuestion(questionId)
    if (!before || before.status !== 'open') return false

    answerQuestion(questionId, answer, by)
    flushWrites()

    const w = this.waiters.get(questionId)
    if (!w) return false
    this.waiters.delete(questionId)
    w.resolve(answer)
    return true
  }

  /**
   * The process died while we were waiting.
   *
   * Nothing will ever consume an answer to these, so release the promise rather than leaving a
   * timer and a closure alive for five minutes per orphaned question. Pair this with
   * `orphanQuestionsForAgent` so the card disappears too — a live card whose answer goes
   * nowhere is worse than no card.
   */
  abandon(runId: string): void {
    for (const [qid, w] of this.waiters) {
      if (w.runId !== runId) continue
      this.waiters.delete(qid)
      w.cancel()
    }
  }

  private answered(answer: string, by: 'user' | 'pilot', b: RunBinding): ToolResult {
    setAgentStatus(b.agentId, 'working', null)
    bus.emitDomain({ type: 'agents:changed', projectId: b.projectId })

    /*
     * Say who answered.
     *
     * This was a flat "The user answered" no matter what, which becomes a lie the moment the
     * Pilot can answer on your behalf. The distinction is load-bearing: an answer no human has
     * seen should be treated as reversible, and a teammate can only do that if it knows.
     */
    const preface =
      by === 'pilot'
        ? 'The Pilot answered on your behalf — the user has not seen this. Treat it as a ' +
          'reasonable default rather than a decision, and say you assumed it in your report. ' +
          'The answer:'
        : 'The user answered:'

    return {
      content: [{ type: 'text', text: `${preface} ${answer}` }],
      structuredContent: { ok: true, status: 'answered', answer, answered_by: by },
    }
  }
}

export const askUserGate = new AskUserGate()
