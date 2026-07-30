import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A crash in the renderer would otherwise leave a blank window with no explanation, which
 * is the least debuggable outcome possible. Show what broke and offer a way back.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; stack: string | null }
> {
  override state: { error: Error | null; stack: string | null } = { error: null, stack: null }

  static getDerivedStateFromError(error: Error) {
    return { error, stack: null }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[vibePilot] renderer crashed:', error, info.componentStack)
    this.setState({ error, stack: info.componentStack ?? null })
  }

  override render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 32,
          background: 'var(--surface)',
          overflow: 'auto',
        }}
      >
        <h1 style={{ font: '600 20px var(--font-heading)', margin: 0 }}>Something broke</h1>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.6 }}>
          The interface hit an error it could not recover from. Your agents and data are
          unaffected — everything lives in SQLite, not in this window.
        </p>
        <pre
          className="selectable mono"
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--color-neutral-100)',
            border: '1px solid var(--line)',
            color: 'var(--danger)',
            whiteSpace: 'pre-wrap',
            maxWidth: '100%',
            overflowX: 'auto',
          }}
        >
          {error.message}
          {stack ? '\n' + stack : ''}
        </pre>
        <div>
          <button
            onClick={() => window.location.reload()}
            style={{
              height: 30,
              padding: '0 14px',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent)',
              color: 'var(--color-neutral-100)',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
