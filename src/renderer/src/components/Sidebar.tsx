import type { Project } from '@shared/types'
import { Icon } from './ui/Icon'

/**
 * Someone on this project is stopped, waiting for you.
 *
 * Deliberately the accent rather than a warning colour: it is not an error, it is a person
 * standing still. It carries a count because two blocked teammates is a different situation
 * from one, and it is worth being able to tell at a glance.
 */
function WaitingBadge({ n }: { n: number }) {
  return (
    <span
      title={`${n} question${n === 1 ? '' : 's'} waiting on you`}
      className="tnum"
      style={{
        flex: 'none',
        minWidth: 15,
        height: 15,
        padding: '0 4px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--accent)',
        color: 'var(--color-neutral-100)',
        font: '600 10px var(--font-heading)',
        lineHeight: 1,
      }}
    >
      {n}
    </span>
  )
}

export function Sidebar({
  projects,
  questionCounts,
  activeId,
  onSelect,
  onAdd,
  onOpenSettings,
}: {
  projects: Project[]
  /** Open questions per project id. The reason a blocked teammate elsewhere is visible at all. */
  questionCounts: Record<string, number>
  activeId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onOpenSettings: () => void
}) {
  return (
    <aside
      style={{
        width: 230,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--paper)',
        borderRight: '1px solid var(--line)',
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '14px 14px 8px',
          gap: 8,
        }}
      >
        <span className="cap" style={{ flex: 1 }}>
          Projects
        </span>
        <button
          onClick={onAdd}
          title="Add a project"
          aria-label="Add a project"
          style={{
            width: 20,
            height: 20,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface)',
            color: 'var(--muted)',
            lineHeight: 1,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-accent-400)')}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
        >
          <Icon name="add" size={13} />
        </button>
      </header>

      <div className="scroll-y" style={{ flex: 1, padding: '0 8px', minHeight: 0 }}>
        {projects.length === 0 && (
          <p
            style={{
              margin: '4px 6px',
              fontSize: 11,
              lineHeight: 1.6,
              color: 'var(--faint)',
            }}
          >
            Nothing here yet. Add a git repository to get started.
          </p>
        )}

        {projects.map((p) => {
          const on = p.id === activeId
          const waiting = questionCounts[p.id] ?? 0
          return on ? (
            <div
              key={p.id}
              style={{
                borderRadius: 'var(--radius-md)',
                background: 'var(--tint)',
                padding: 2,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <button
                onClick={() => onSelect(p.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  width: '100%',
                  height: 'var(--row)',
                  padding: '0 8px',
                  border: 'none',
                  background: 'transparent',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--accent)',
                    flex: 'none',
                  }}
                />
                <span className="ellip" style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
                  {p.name}
                </span>
                {waiting > 0 && <WaitingBadge n={waiting} />}
              </button>
              {/*
                Settings for the project you are looking at, where you are looking at it. The
                footer gear is still there, but it is a long way from the thing it configures.
              */}
              <button
                onClick={onOpenSettings}
                title={`Settings for ${p.name}`}
                aria-label={`Settings for ${p.name}`}
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '0 6px 0 0',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                <Icon name="settings" size={12} />
              </button>
            </div>
          ) : (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              title={p.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                width: '100%',
                height: 30,
                padding: '0 8px',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--line-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-accent-400)',
                  flex: 'none',
                }}
              />
              <span className="ellip" style={{ flex: 1, fontSize: 12.5 }}>
                {p.name}
              </span>
              {waiting > 0 && <WaitingBadge n={waiting} />}
            </button>
          )
        })}
      </div>

      <footer
        style={{
          borderTop: '1px solid var(--line)',
          padding: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/*
          An account card lived here reading "ME · Local · your claude subscription". Every
          string in it was a hardcoded literal — no props, no state, no IPC, no row in the
          database. It was a stripped-down copy of the design comp's user card, whose
          "Accounts & models" section was never built, and vibePilot has no account concept at
          all. The gear was the only live part of it, so the gear is what stayed.
        */}
        <button
          onClick={onOpenSettings}
          title={activeId ? 'Settings' : 'Open a project to change its settings'}
          aria-label="Settings"
          disabled={!activeId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            width: '100%',
            height: 28,
            padding: '0 8px',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            textAlign: 'left',
            fontSize: 12,
            color: activeId ? 'var(--ink-2)' : 'var(--faint)',
            cursor: activeId ? 'pointer' : 'default',
          }}
          onMouseEnter={(e) => {
            if (activeId) e.currentTarget.style.background = 'var(--line-2)'
          }}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="settings" size={14} color={activeId ? 'var(--muted)' : 'var(--faint)'} />
          Settings
        </button>
      </footer>
    </aside>
  )
}
