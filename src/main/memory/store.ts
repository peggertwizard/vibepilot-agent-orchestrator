import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { MemoryCategory, MemorySource } from '@shared/types'
import { MEMORY_CATEGORY_BLURB } from '@shared/types'
import { vibepilotConfigDir } from '../paths'

/**
 * Memory, stored as markdown files.
 *
 * Files are the source of truth and SQLite is a derived index — that separation is the
 * decision the whole design turns on. You can open `.vibepilot/memory/gotchas.md` in an
 * editor, delete a paragraph that has gone stale, and the next sync agrees with you. A
 * vector store cannot be argued with; a file can.
 *
 * ## Format
 *
 * One `##` heading per entry, with provenance in an HTML comment beneath it:
 *
 *     ## node:sqlite is absent from module.builtinModules
 *     <!-- vp source=agent author=Dana at=2026-07-28 files=src/main/db/index.ts -->
 *
 *     It is `isBuiltin()` true but missing from the list, so bundlers try to bundle it.
 *
 * The comment is invisible when rendered, survives hand-editing, and is optional — an entry
 * a human types by hand with no comment at all still indexes fine.
 */

export interface ParsedEntry {
  slug: string
  title: string
  body: string
  source: MemorySource
  author: string | null
  at: number | null
  concerns: string[]
  ticket: string | null
  superseded: boolean
}

export interface MemoryFile {
  /** Relative to the memory dir, POSIX separators. `project/gotchas.md`, `agents/dana.md`. */
  path: string
  heading: string
  entries: ParsedEntry[]
}

export function memoryDir(projectPath: string): string {
  return join(vibepilotConfigDir(projectPath), 'memory')
}

const PROJECT_FILES: Array<{ file: string; heading: string; category: MemoryCategory }> = [
  { file: 'project/architecture.md', heading: 'Architecture', category: 'architecture' },
  { file: 'project/conventions.md', heading: 'Conventions', category: 'convention' },
  { file: 'project/gotchas.md', heading: 'Gotchas', category: 'gotcha' },
  { file: 'project/decisions.md', heading: 'Decisions', category: 'decision' },
  { file: 'project/glossary.md', heading: 'Glossary', category: 'glossary' },
]

export const DIGEST_FILE = '_digest.md'

/** Create the tree with its headings, so a human opening it sees what goes where. */
export function ensureMemoryDirs(projectPath: string): void {
  const root = memoryDir(projectPath)
  mkdirSync(join(root, 'project'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })

  for (const f of PROJECT_FILES) {
    const p = join(root, f.file)
    if (!existsSync(p)) {
      writeFileSync(p, `# ${f.heading}\n\n${MEMORY_CATEGORY_BLURB[f.category]}\n`, 'utf8')
    }
  }
  const digest = join(root, DIGEST_FILE)
  if (!existsSync(digest)) {
    writeFileSync(
      digest,
      '# Digest\n\n' +
        'Maintained by the curator. Deliberately small — every agent loads this on every\n' +
        'spawn, so it competes with the context window for room. Everything else is reached\n' +
        'on demand with `recall`.\n',
      'utf8',
    )
  }
}

export function categoryFile(category: MemoryCategory, agentName?: string | null): string {
  if (category === 'lesson') {
    return `agents/${slugify(agentName ?? 'unassigned')}.md`
  }
  return PROJECT_FILES.find((f) => f.category === category)!.file
}

export function categoryOfFile(path: string): MemoryCategory {
  const hit = PROJECT_FILES.find((f) => f.file === path)
  return hit ? hit.category : 'lesson'
}

/** `agents/dana.md` -> `dana`. Null for project files. */
export function agentScopeOfFile(path: string): string | null {
  return path.startsWith('agents/') ? basename(path, '.md') : null
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'entry'
  )
}

/* ── parsing ─────────────────────────────────────────────────────────────────── */

const META = /^<!--\s*vp\s+(.*?)\s*-->$/

function parseMeta(line: string): Partial<ParsedEntry> | null {
  const m = META.exec(line.trim())
  if (!m) return null
  const out: Partial<ParsedEntry> = {}
  // key=value pairs, values may be quoted or comma-joined. Deliberately forgiving: a human
  // editing this by hand should not be able to break the parse, only lose a field.
  for (const [, k, v] of m[1]!.matchAll(/(\w+)=("[^"]*"|[^\s]+)/g)) {
    const val = v!.replace(/^"|"$/g, '')
    switch (k) {
      case 'source':
        if (val === 'user' || val === 'agent' || val === 'curator') out.source = val
        break
      case 'author':
        out.author = val
        break
      case 'at': {
        const t = Date.parse(val)
        if (!Number.isNaN(t)) out.at = t
        break
      }
      case 'files':
        out.concerns = val.split(',').map((f) => f.trim()).filter(Boolean)
        break
      case 'ticket':
        out.ticket = val
        break
      case 'superseded':
        out.superseded = val === 'true'
        break
    }
  }
  return out
}

export function parseMemoryFile(path: string, text: string): MemoryFile {
  const lines = text.split(/\r?\n/)
  const heading = lines.find((l) => l.startsWith('# '))?.slice(2).trim() ?? path
  const entries: ParsedEntry[] = []

  let cur: ParsedEntry | null = null
  let body: string[] = []
  const flush = (): void => {
    if (!cur) return
    cur.body = body.join('\n').trim()
    if (cur.title) entries.push(cur)
    body = []
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush()
      const title = line.slice(3).trim()
      cur = {
        slug: slugify(title),
        title,
        body: '',
        source: 'agent',
        author: null,
        at: null,
        concerns: [],
        ticket: null,
        superseded: false,
      }
      continue
    }
    if (!cur) continue
    const meta = body.length === 0 ? parseMeta(line) : null
    if (meta) {
      Object.assign(cur, meta)
      continue
    }
    body.push(line)
  }
  flush()

  // Two entries with the same title in one file would collide on id. Later wins, but keep
  // both readable by suffixing — silently dropping someone's memory is worse.
  const seen = new Map<string, number>()
  for (const e of entries) {
    const n = seen.get(e.slug) ?? 0
    seen.set(e.slug, n + 1)
    if (n > 0) e.slug = `${e.slug}-${n + 1}`
  }
  return { path, heading, entries }
}

export function readMemoryFile(projectPath: string, rel: string): MemoryFile | null {
  const p = join(memoryDir(projectPath), rel)
  if (!existsSync(p)) return null
  return parseMemoryFile(rel, readFileSync(p, 'utf8'))
}

/** Every memory file in the tree, digest excluded — the digest is a summary, not entries. */
export function listMemoryFiles(projectPath: string): string[] {
  const root = memoryDir(projectPath)
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const sub of ['project', 'agents']) {
    const dir = join(root, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) out.push(`${sub}/${f}`)
    }
  }
  return out.sort()
}

export function readDigest(projectPath: string): string {
  const p = join(memoryDir(projectPath), DIGEST_FILE)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

export function writeDigest(projectPath: string, body: string): void {
  ensureMemoryDirs(projectPath)
  writeFileSync(join(memoryDir(projectPath), DIGEST_FILE), body, 'utf8')
}

/* ── writing ─────────────────────────────────────────────────────────────────── */

function renderEntry(e: {
  title: string
  body: string
  source: MemorySource
  author: string | null
  at: number
  concerns: string[]
  ticket: string | null
  superseded?: boolean
}): string {
  const bits = [`source=${e.source}`]
  if (e.author) bits.push(`author=${e.author.replace(/\s+/g, '_')}`)
  bits.push(`at=${new Date(e.at).toISOString().slice(0, 10)}`)
  if (e.concerns.length) bits.push(`files=${e.concerns.join(',')}`)
  if (e.ticket) bits.push(`ticket=${e.ticket}`)
  if (e.superseded) bits.push('superseded=true')
  return `## ${e.title}\n<!-- vp ${bits.join(' ')} -->\n\n${e.body.trim()}\n`
}

/**
 * Append or replace an entry, keeping the file readable.
 *
 * Same title in the same file means the same entry, so re-remembering something updates it
 * rather than accumulating near-duplicates the curator then has to merge.
 */
export function upsertEntry(
  projectPath: string,
  rel: string,
  entry: {
    title: string
    body: string
    source: MemorySource
    author: string | null
    concerns?: string[]
    ticket?: string | null
  },
): { slug: string; created: boolean } {
  ensureMemoryDirs(projectPath)
  const p = join(memoryDir(projectPath), rel)
  const slug = slugify(entry.title)

  const rendered = renderEntry({
    title: entry.title,
    body: entry.body,
    source: entry.source,
    author: entry.author,
    at: Date.now(),
    concerns: entry.concerns ?? [],
    ticket: entry.ticket ?? null,
  })

  if (!existsSync(p)) {
    mkdirSync(join(p, '..'), { recursive: true })
    const heading = agentScopeOfFile(rel)
      ? `# ${agentScopeOfFile(rel)}\n\nWhat this teammate has learned. Loaded on every spawn.\n`
      : `# ${rel}\n`
    writeFileSync(p, `${heading}\n${rendered}`, 'utf8')
    return { slug, created: true }
  }

  const text = readFileSync(p, 'utf8')
  const parsed = parseMemoryFile(rel, text)
  const existing = parsed.entries.find((e) => e.slug === slug)

  if (!existing) {
    writeFileSync(p, `${text.replace(/\s*$/, '')}\n\n${rendered}`, 'utf8')
    return { slug, created: true }
  }

  // Rebuild the whole file rather than splicing: splicing markdown by offset is how you end
  // up with a file that no longer parses.
  const head = text.split(/\r?\n/).slice(0, firstEntryLine(text)).join('\n').replace(/\s*$/, '')
  const body = parsed.entries
    .map((e) =>
      e.slug === slug
        ? rendered
        : renderEntry({
            title: e.title,
            body: e.body,
            source: e.source,
            author: e.author,
            at: e.at ?? Date.now(),
            concerns: e.concerns,
            ticket: e.ticket,
            superseded: e.superseded,
          }),
    )
    .join('\n')
  writeFileSync(p, `${head}\n\n${body}`, 'utf8')
  return { slug, created: false }
}

function firstEntryLine(text: string): number {
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith('## '))
  return i < 0 ? lines.length : i
}

/** Rewrite a file wholesale. The curator's only write path. */
export function writeEntries(
  projectPath: string,
  rel: string,
  heading: string,
  entries: Array<{
    title: string
    body: string
    source: MemorySource
    author: string | null
    at: number
    concerns: string[]
    ticket: string | null
    superseded?: boolean
  }>,
): void {
  ensureMemoryDirs(projectPath)
  const p = join(memoryDir(projectPath), rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `# ${heading}\n\n${entries.map(renderEntry).join('\n')}`, 'utf8')
}
