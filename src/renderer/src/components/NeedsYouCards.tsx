import { useState } from 'react'
import type { Agent, Ticket } from '@shared/types'
import { Button } from './ui'

/**
 * The two decisions that had no card of their own.
 *
 * A sign-off gate lived on a ticket card you had to find and open. A teammate that stopped
 * lived in the right-hand rail, as a status line with a restart button beside it — a place you
 * only look once you already suspect something is wrong. Both are one press, and both now have
 * somewhere to be pressed from the list of things waiting on you.
 */

/** Approve a parked build. The plan is already written; this is the decision it was written for. */
export function GateCard({ ticket, projectId }: { ticket: Ticket; projectId: string }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const approve = async (): Promise<void> => {
    setBusy(true)
    setFailed(null)
    try {
      const r = await window.vibepilot.gates.approve(projectId, ticket.id)
      // A refusal is information, not a dead button — the usual one is "the plan is still
      // running", which is exactly what you want to be told rather than left guessing at.
      if (!r.ok) setFailed(r.reason ?? 'It could not be approved.')
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'It could not be approved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 9 }}>
      <span className="meta" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
        Approving starts the build. Open the ticket first if you want to read the plan it wrote.
      </span>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <Button kind="primary" height={27} disabled={busy} onClick={() => void approve()}>
          {busy ? 'Approving…' : 'Approve the build'}
        </Button>
        {failed && (
          <span className="meta" style={{ color: 'var(--caution)', whiteSpace: 'normal' }}>
            {failed}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A teammate that stopped and stayed stopped.
 *
 * `heal.ts` has already spent its one automatic attempt by the time anything reaches here, so
 * this is deliberately a person's press rather than another retry — and it resumes the session
 * rather than starting cold, so nothing already committed in the worktree is redone.
 */
export function StuckCard({ agent }: { agent: Agent }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const restart = async (): Promise<void> => {
    setBusy(true)
    setFailed(null)
    try {
      const r = await window.vibepilot.agents.restart(agent.id)
      if (!r.ok) setFailed(r.reason ?? 'It could not be restarted.')
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'It could not be restarted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 9 }}>
      <span className="meta" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
        vibePilot already tried once. Restarting picks the session up where it stopped — nothing
        it had finished is done again.
      </span>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <Button kind="primary" height={27} disabled={busy} onClick={() => void restart()}>
          {busy ? 'Restarting…' : `Restart ${agent.name}`}
        </Button>
        {failed && (
          <span className="meta" style={{ color: 'var(--caution)', whiteSpace: 'normal' }}>
            {failed}
          </span>
        )}
      </div>
    </div>
  )
}
