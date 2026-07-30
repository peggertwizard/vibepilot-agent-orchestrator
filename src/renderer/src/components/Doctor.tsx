import type { DoctorReport } from '@shared/types'
import { Blueprint } from './ui/Blueprint'
import { Button } from './ui'

/**
 * Shown automatically when the toolchain is broken. It is also the place the app states
 * plainly how it talks to Claude — that is a design decision worth being loud about, not
 * an implementation detail to bury.
 */
export function Doctor({ report, onClose }: { report: DoctorReport; onClose: () => void }) {
  const ok = report.problems.length === 0
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'grid',
        placeItems: 'center',
        padding: '52px 24px',
        background: 'color-mix(in srgb, var(--color-neutral-900) 34%, transparent)',
      }}
      onClick={onClose}
    >
      <Blueprint
        style={{
          width: 'min(560px, 100%)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-lg)',
          padding: 16,
        }}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <h2 style={{ font: '600 15px var(--font-heading)', margin: 0 }}>
              {ok ? 'Everything checks out' : 'Something needs fixing'}
            </h2>
            <span className="meta">system check</span>
          </div>

          {report.problems.length > 0 && (
            <ul
              style={{
                margin: '10px 0',
                paddingLeft: 0,
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {report.problems.map((p) => (
                <li
                  key={p}
                  className="selectable"
                  style={{
                    borderLeft: '2px solid var(--danger)',
                    paddingLeft: 10,
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: 'var(--ink-2)',
                  }}
                >
                  {p}
                </li>
              ))}
            </ul>
          )}

          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '5px 14px',
              margin: '12px 0 0',
              fontSize: 11.5,
            }}
          >
            <Row k="Claude" v={report.claudeVersion ?? 'not found'} />
            <Row k="Binary" v={report.claudeBinary ?? '—'} mono />
            <Row k="Launch" v={report.claudeKind ?? '—'} />
            <Row k="Git" v={report.gitVersion ?? 'not found'} />
            <Row k="Database" v={report.dbPath} mono />
            <Row k="Worktrees" v={report.worktreeRoot} mono />
          </dl>

          <p
            style={{
              margin: '14px 0 0',
              padding: '9px 11px',
              background: 'var(--accent-soft)',
              border: '1px solid color-mix(in oklab, var(--accent) 22%, white)',
              fontSize: 11.5,
              lineHeight: 1.6,
              color: 'var(--accent-ink)',
            }}
          >
            vibePilot runs <strong>your own</strong> Claude Code binary as a subprocess. It never
            reads, stores or transmits your credentials — Claude Code authenticates itself, exactly
            as it does in a terminal.
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <Button kind="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Blueprint>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="cap" style={{ paddingTop: 2 }}>
        {k}
      </dt>
      <dd
        className={`selectable ellip${mono ? ' mono' : ''}`}
        style={{ margin: 0, color: 'var(--ink-2)' }}
        title={v}
      >
        {v}
      </dd>
    </>
  )
}
