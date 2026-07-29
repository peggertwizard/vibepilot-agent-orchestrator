import { useEffect, useState } from 'react'
import type { BranchOverview, Project, UpdateState } from '@shared/types'
import { Icon } from './ui/Icon'
import { LogoWordmark } from './ui/Logo'

export function TitleBar({
  project,
  branches,
  onOpenDoctor,
}: {
  project: Project | null
  /** Read from git. Null before the first read, or when the path is not a repository. */
  branches: BranchOverview | null
  onOpenDoctor: () => void
}) {
  /*
   * The chip conflated two different things.
   *
   * It rendered `defaultBaseBranch` — a string written once when the project was added and
   * never looked at again — so a repository checked out on another branch had a chip
   * confidently disagreeing with it. Two branches matter and they are not the same: the one you
   * are *on*, and the one merges *land in*.
   *
   * Showing the divergence is right. *Following* HEAD would be worse than the bug, because it
   * would silently retarget where every merge goes the moment you check something else out.
   */
  const base = project?.defaultBaseBranch ?? null
  const here = branches?.current ?? null
  const diverged = !!base && !!here && here !== base

  return (
    <div
      className="drag"
      style={{
        height: 34,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid var(--line)',
        background: 'var(--paper)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 12px', minWidth: 0 }}>
        {/* The wordmark carries the name, so the text label beside it was saying it twice. */}
        <LogoWordmark size={13} style={{ color: 'var(--ink)', flex: 'none' }} />
        <span style={{ width: 1, height: 12, background: 'var(--line)' }} />
        <span
          className="ellip no-drag"
          onDoubleClick={onOpenDoctor}
          title={
            project
              ? `${project.path}\nMerges land in: ${base}` +
                (diverged ? `\nYou are checked out on: ${here}` : '')
              : 'No project open'
          }
          style={{
            font: '400 10.5px var(--font-heading)',
            color: 'var(--muted)',
            minWidth: 0,
          }}
        >
          {project ? `${project.name} · ${base}` : 'no project'}
          {diverged && (
            <span style={{ color: 'var(--accent)' }} title={`HEAD is on ${here}, not ${base}`}>
              {' '}
              · on {here}
            </span>
          )}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <UpdateChip />

      <div className="no-drag" style={{ display: 'flex', height: '100%' }}>
        <WinBtn label="Minimise" onClick={() => void window.vibepilot.window.minimize()}>
          <Icon name="minimise" size={14} />
        </WinBtn>
        <WinBtn label="Maximise" onClick={() => void window.vibepilot.window.maximize()}>
          <Icon name="maximise" size={11} />
        </WinBtn>
        <WinBtn label="Close" danger onClick={() => void window.vibepilot.window.close()}>
          <Icon name="close" size={14} />
        </WinBtn>
      </div>
    </div>
  )
}

/**
 * A new version, mentioned rather than announced.
 *
 * Deliberately not a dialog. An update is never urgent enough to interrupt someone mid-thought,
 * and a modal that appears over a running board would be exactly the kind of thing that makes an
 * app feel like it is managing you. This sits in the corner until it is convenient.
 *
 * Nothing is shown while checking, and nothing is shown on failure: a failed check means you
 * carry on with the perfectly good copy you already have, which is not news.
 */
function UpdateChip() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })

  useEffect(() => window.vibepilot.bus.onUpdate(setState), [])

  if (state.phase !== 'ready' && state.phase !== 'downloading') return null

  const ready = state.phase === 'ready'
  const label = ready ? `Update to ${state.version}` : `Downloading update · ${state.percent}%`

  return (
    <button
      className="no-drag"
      disabled={!ready}
      // Closing is the install: the app drains its agents, saves, installs, and reopens itself.
      onClick={() => ready && void window.vibepilot.window.close()}
      title={
        ready
          ? `Version ${state.version} is downloaded.\n\nClicking closes vibePilot, installs it and opens it again. ` +
            `Anything running is stopped cleanly first, and your projects, tickets and history are untouched.`
          : 'A new version is downloading in the background. Nothing is interrupted.'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        alignSelf: 'center',
        marginRight: 8,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--line)',
        background: ready ? 'var(--tint)' : 'transparent',
        color: ready ? 'var(--accent)' : 'var(--muted)',
        font: '400 10px var(--font-heading)',
        cursor: ready ? 'pointer' : 'default',
      }}
    >
      <Icon name="download" size={11} />
      {label}
    </button>
  )
}

function WinBtn({
  children,
  onClick,
  danger,
  label,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
  label: string
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 44,
        height: '100%',
        border: 'none',
        background: 'transparent',
        color: 'var(--ink-2)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background .1s, color .1s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? 'var(--danger)' : 'var(--tint)'
        if (danger) e.currentTarget.style.color = 'var(--color-neutral-100)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--ink-2)'
      }}
    >
      {children}
    </button>
  )
}
