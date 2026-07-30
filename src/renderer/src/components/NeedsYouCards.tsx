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


/**
 * The project folder is standing somewhere else.
 *
 * Reported for a long time and repairable by nobody — the app knew, said so in a tooltip, and
 * left the git to you. Two presses now, in the order that cannot lose anything:
 *
 *   1. If the branch you are on has commits the base does not, land them. Switching first
 *      would take that work out of view — still there in git, and gone from the folder every
 *      dev server is watching, which is the same surprise in the opposite direction.
 *   2. Then put the folder back.
 *
 * The second button is deliberately not offered while the first is outstanding. An app that
 * hands you two buttons and lets you pick the one that hides your work has not helped.
 */
export function BranchCard({
  here,
  base,
  ahead,
  projectId,
}: {
  here: string
  base: string
  /** Commits on `here` that `base` does not have. */
  ahead: number
  projectId: string
}) {
  const [busy, setBusy] = useState<'land' | 'switch' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const run = async (
    which: 'land' | 'switch',
    fn: () => Promise<{ ok: boolean; reason?: string }>,
  ): Promise<void> => {
    setBusy(which)
    setFailed(null)
    try {
      const r = await fn()
      if (!r.ok) setFailed(r.reason ?? 'It did not work.')
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'It did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 9 }}>
      <span className="meta" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
        Teammates branch from this folder, merges land in it, and anything watching it — a dev
        server, a container — shows whatever it holds. So it wants to sit on <code>{base}</code>.
      </span>

      {ahead > 0 ? (
        <>
          <span className="meta" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
            First, though: <code>{here}</code> has{' '}
            <strong>
              {ahead} {ahead === 1 ? 'commit' : 'commits'}
            </strong>{' '}
            that {base} does not. Land {ahead === 1 ? 'it' : 'them'} and nothing goes out of
            view when the folder moves.
          </span>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              kind="primary"
              height={27}
              disabled={busy !== null}
              onClick={() => void run('land', () => window.vibepilot.git.mergeCurrent(projectId))}
            >
              {busy === 'land' ? 'Merging…' : `Merge ${here} into ${base}`}
            </Button>
            <span className="meta" style={{ color: 'var(--faint)' }}>
              Local only — nothing is pushed.
            </span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            kind="primary"
            height={27}
            disabled={busy !== null}
            onClick={() => void run('switch', () => window.vibepilot.git.checkoutBase(projectId))}
          >
            {busy === 'switch' ? 'Switching…' : `Put the folder back on ${base}`}
          </Button>
          <span className="meta" style={{ color: 'var(--faint)' }}>
            <code>{here}</code> and its commits stay exactly where they are.
          </span>
        </div>
      )}

      {failed && (
        <span className="meta" style={{ color: 'var(--caution)', whiteSpace: 'normal' }}>
          {failed}
        </span>
      )}
    </div>
  )
}
