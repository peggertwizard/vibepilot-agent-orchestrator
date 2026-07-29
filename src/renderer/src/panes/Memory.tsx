import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemoryCategory, MemoryEntry, Project } from '@shared/types'
import { MEMORY_CATEGORY_BLURB } from '@shared/types'
import { Button, Empty, Input, SectionRule, Tag } from '../components/ui'
import { Markdown } from '../components/ui/Markdown'

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  architecture: 'Architecture',
  convention: 'Conventions',
  gotcha: 'Gotchas',
  decision: 'Decisions',
  glossary: 'Glossary',
  lesson: 'Agent lessons',
}

const ORDER: MemoryCategory[] = [
  'architecture',
  'convention',
  'gotcha',
  'decision',
  'glossary',
  'lesson',
]

/**
 * What the project knows.
 *
 * The important thing this screen communicates is that it is a *view*, not the store. The
 * store is markdown in the repo — hence "Open folder" and "Rebuild index" sitting in plain
 * sight rather than an edit button. Editing happens in your editor, in git, in a diff.
 */
export function Memory({ project }: { project: Project }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<'idle' | 'resync' | 'curate'>('idle')
  const [note, setNote] = useState<string | null>(null)
  /** The summary injected into every agent's prompt. Empty string when there is none. */
  const [digest, setDigest] = useState('')

  const load = useCallback(
    (q: string) => {
      void window.vibepilot.memory.search(project.id, q).then(setEntries)
    },
    [project.id],
  )

  useEffect(() => {
    load('')
    void window.vibepilot.memory.digest(project.id).then(setDigest)
    const off = window.vibepilot.bus.subscribe((batch) => {
      if (batch.domain.some((d) => d.type === 'memory:changed' && d.projectId === project.id)) {
        load(query)
        void window.vibepilot.memory.digest(project.id).then(setDigest)
      }
    })
    return off
  }, [project.id, load, query])

  const grouped = useMemo(() => {
    const m = new Map<MemoryCategory, MemoryEntry[]>()
    for (const e of entries) {
      const arr = m.get(e.category) ?? []
      arr.push(e)
      m.set(e.category, arr)
    }
    return m
  }, [entries])

  const resync = async (): Promise<void> => {
    setBusy('resync')
    const n = await window.vibepilot.memory.resync(project.id)
    setBusy('idle')
    setNote(`Rebuilt from the files: ${n} ${n === 1 ? 'entry' : 'entries'}.`)
  }

  const curate = async (): Promise<void> => {
    setBusy('curate')
    setNote('Curating — merging duplicates and rewriting the digest. This takes a minute.')
    const ok = await window.vibepilot.memory.curate(project.id)
    setBusy('idle')
    setNote(ok ? 'Curation finished.' : 'Curation is already running.')
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 20px',
          borderBottom: '1px solid var(--line-2)',
          flex: 'none',
        }}
      >
        <div style={{ flex: 1, maxWidth: 340 }}>
          <Input
            value={query}
            onChange={(v) => {
              setQuery(v)
              load(v)
            }}
            height={28}
            placeholder="Search what this project knows"
          />
        </div>
        <div style={{ flex: 1 }} />
        <Button height={26} onClick={() => void window.vibepilot.memory.openFolder(project.id)}>
          Open folder
        </Button>
        <Button height={26} disabled={busy !== 'idle'} onClick={() => void resync()}>
          {busy === 'resync' ? 'Rebuilding…' : 'Rebuild index'}
        </Button>
        <Button
          kind="primary"
          height={26}
          disabled={busy !== 'idle'}
          onClick={() => void curate()}
        >
          {busy === 'curate' ? 'Curating…' : 'Curate'}
        </Button>
      </div>

      <div
        style={{
          padding: '8px 20px',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span className="meta" style={{ color: 'var(--faint)' }}>
          {note ??
            'Stored as markdown in .vibepilot/memory/ — edit it there and press Rebuild index. ' +
              'This list is a view; the files are the truth.'}
        </span>
      </div>

      {/*
        The digest, above the entries.
        This tab used to list entries only — a `## ` section inside a category file — so a
        project whose `_digest.md` held real, hard-won knowledge still read "Nothing remembered
        yet". That is the file every agent loads on spawn, which makes it the single most
        important thing in here and the last thing that should be invisible.
      */}
      {digest && !query && (
        <div style={{ flex: 'none', padding: '0 20px 14px' }}>
          <SectionRule label="Loaded by every teammate" />
          <div
            className="selectable"
            style={{
              marginTop: 8,
              padding: '11px 13px',
              border: '1px solid var(--line)',
              background: 'var(--paper)',
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            <Markdown text={digest} />
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <Empty
          title={query ? 'Nothing matches that' : digest ? 'No separate notes yet' : 'Nothing remembered yet'}
          hint={
            query
              ? 'Try fewer words — search is over the text of every entry.'
              : digest
                ? 'The summary above is what every teammate reads. Individual notes appear here as they work — traps they hit, conventions they had to infer, decisions and why.'
                : 'Teammates write here as they work: traps they hit, conventions they had to infer, decisions and why. Feedback you give the Pilot about a teammate lands here too.'
          }
        />
      ) : (
        <div className="scroll-y" style={{ flex: 1, padding: '0 20px 20px', minHeight: 0 }}>
          {ORDER.filter((c) => grouped.has(c)).map((cat) => (
            <div key={cat} style={{ marginBottom: 18 }}>
              <SectionRule label={CATEGORY_LABEL[cat]} count={grouped.get(cat)!.length} />
              <div style={{ font: '400 10px var(--font-heading)', color: 'var(--faint)', margin: '5px 0 8px' }}>
                {MEMORY_CATEGORY_BLURB[cat]}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {grouped.get(cat)!.map((e) => (
                  <EntryCard key={e.id} entry={e} projectId={project.id} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EntryCard({ entry, projectId }: { entry: MemoryEntry; projectId: string }) {
  const [open, setOpen] = useState(false)
  const fromUser = entry.source === 'user'

  return (
    <div
      style={{
        border: `1px solid ${fromUser ? 'var(--color-accent-400)' : 'var(--line)'}`,
        background: 'var(--surface)',
        padding: 'var(--cardpad)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        {/* User feedback is the one thing here that cannot be re-derived from the code, so
            it is the one thing marked. */}
        {fromUser && <Tag tone="accent">from you</Tag>}
        {entry.agentScope && !fromUser && <Tag>{entry.agentScope}</Tag>}
        {entry.supersededBy && <Tag tone="warn">superseded</Tag>}
        <div style={{ flex: 1 }} />
        <button
          title="Show in the file it lives in"
          onClick={() => void window.vibepilot.memory.openFolder(projectId, entry.file)}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--faint)',
            font: '400 9.5px var(--font-heading)',
            letterSpacing: '.06em',
            padding: 2,
          }}
        >
          {entry.file}
        </button>
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          border: 'none',
          background: 'transparent',
          textAlign: 'left',
          padding: 0,
          fontSize: 12.5,
          fontWeight: 500,
          lineHeight: 1.45,
          color: 'var(--ink)',
          cursor: 'pointer',
        }}
      >
        {entry.title}
      </button>

      {open && (
        <div
          className="selectable"
          style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}
        >
          {entry.body}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="meta" style={{ color: 'var(--faint)' }}>
          {entry.author ? `${entry.author} · ` : ''}
          {new Date(entry.createdAt).toLocaleDateString()}
          {entry.hitCount > 0 ? ` · used ${entry.hitCount}×` : ''}
        </span>
        {entry.concerns.length > 0 && (
          <span className="meta ellip" style={{ color: 'var(--faint)', maxWidth: 320 }}>
            {entry.concerns.join(' · ')}
          </span>
        )}
      </div>
    </div>
  )
}
