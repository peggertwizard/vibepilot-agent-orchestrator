import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'

/**
 * A small markdown renderer for model output.
 *
 * Models write markdown whether or not you ask them to, and v1 rendered every reply as plain
 * text — so `**text**` appeared literally and a bulleted list read as a wall of asterisks.
 *
 * Deliberately hand-written rather than a library:
 *
 *  - **No new dependency.** The whole renderer is ~4kB of the bundle; `react-markdown` plus
 *    remark is ~120kB for a feature used on one kind of string.
 *  - **No HTML, ever.** This returns React elements. There is no `dangerouslySetInnerHTML`
 *    anywhere in it, so a model emitting `<img onerror=...>` produces the literal text — not
 *    an injection. Model output is untrusted input that has passed through a web page and a
 *    filesystem, and this is the one place it lands in the DOM.
 *  - **It covers what models actually emit**: bold, italic, inline code, fenced code,
 *    headings, bullet and numbered lists, blockquotes, links, and horizontal rules. Tables
 *    and footnotes are deliberately out — rare in chat, and expensive to do properly.
 *
 * Anything it does not understand falls through as plain text, which is exactly the old
 * behaviour. It cannot render less than v1 did.
 */

/**
 * Memoised on the text, because parsing is the expensive part and the text almost never
 * changes.
 *
 * The message list re-renders on anything: a teammate's status line moving, a token arriving
 * in a *different* agent's stream, a ticket changing lane. Every one of those re-parsed all
 * three hundred messages in the transcript from scratch, on the renderer's only thread —
 * which is what puts "vibePilot is not responding" on the title bar of a long session, and
 * why it happened during streaming rather than at rest.
 *
 * `memo` on identical props is what makes that a no-op instead of a full parse.
 */
export const Markdown = memo(function Markdown({
  text,
  style,
}: {
  text: string
  style?: React.CSSProperties
}) {
  const content = useMemo(() => blocks(text), [text])
  return (
    <div className="selectable" style={{ ...style }}>
      {content}
    </div>
  )
})

/* ── block level ──────────────────────────────────────────────────────────── */

const P: React.CSSProperties = { margin: '0 0 0.65em' }
const LAST: React.CSSProperties = { margin: 0 }

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  const push = (n: ReactNode): void => {
    out.push(n)
  }

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code. Everything inside is literal — no inline parsing, which is the point.
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!), i++
      i++ // closing fence, or end of input if the model never closed it
      push(
        <pre
          key={key++}
          className="mono scroll-y"
          style={{
            margin: '0 0 0.65em',
            padding: '8px 10px',
            background: 'var(--color-neutral-100)',
            border: '1px solid var(--line-2)',
            fontSize: 11.5,
            lineHeight: 1.5,
            // Wide code must scroll inside its own box; the message column must not.
            overflowX: 'auto',
            maxHeight: 320,
          }}
          data-lang={lang || undefined}
        >
          {body.join('\n')}
        </pre>,
      )
      continue
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      push(<hr key={key++} style={{ border: 0, borderTop: '1px solid var(--line-2)', margin: '0.8em 0' }} />)
      i++
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      push(
        <div
          key={key++}
          style={{
            font: `600 ${[15, 14, 13, 12.5][level - 1]}px var(--font-heading)`,
            color: 'var(--ink)',
            margin: '0.7em 0 0.35em',
          }}
        >
          {inline(heading[2]!)}
        </div>,
      )
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      push(
        <blockquote
          key={key++}
          style={{
            margin: '0 0 0.65em',
            paddingLeft: 10,
            borderLeft: '2px solid var(--line)',
            color: 'var(--muted)',
          }}
        >
          {blocks(body.join('\n'))}
        </blockquote>,
      )
      continue
    }

    const bullet = /^\s*[-*+]\s+/.test(line)
    const numbered = /^\s*\d+[.)]\s+/.test(line)
    if (bullet || numbered) {
      const items: string[] = []
      const re = bullet ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/
      /**
       * A blank line between items does not end the list.
       *
       * This loop used to stop at the first blank line, so a **loose** list — items separated
       * by blank lines, which is what the Pilot writes whenever the items are more than a few
       * words — became one `<ol>` per item, and every one of them started again at 1. On
       * screen: "1. Birth … 1. Ongoing memory … 1. Truth", followed by a sentence saying
       * "3, then 1, then 2" that referred to numbers nobody could see.
       *
       * CommonMark treats a single blank line between items as loose-list formatting rather
       * than a list terminator. Two blank lines end it.
       */
      let loose = false
      while (i < lines.length) {
        if (re.test(lines[i]!)) {
          let item = lines[i]!.replace(re, '')
          i++
          // A wrapped continuation line belongs to the item above it.
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !re.test(lines[i]!)) {
            item += ` ${lines[i]!.trim()}`
            i++
          }
          items.push(item)
          continue
        }

        // One blank line, and another item after it: still the same list.
        if (lines[i]!.trim() === '' && re.test(lines[i + 1] ?? '')) {
          loose = true
          i++
          continue
        }
        break
      }

      const Tag = bullet ? 'ul' : 'ol'
      push(
        <Tag key={key++} style={{ margin: '0 0 0.65em', paddingLeft: 18 }}>
          {items.map((it, n) => (
            // Loose lists get the spacing the author asked for by leaving the blank lines in.
            <li key={n} style={{ margin: loose ? '0 0 0.55em' : '0 0 0.2em' }}>
              {inline(it)}
            </li>
          ))}
        </Tag>,
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    // A paragraph runs to the next blank line or the next block construct.
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*```/.test(lines[i]!) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i++
    }
    if (para.length) {
      push(
        <p key={key++} style={i >= lines.length ? LAST : P}>
          {inline(para.join('\n'))}
        </p>,
      )
    }
  }

  return out
}

/* ── inline level ─────────────────────────────────────────────────────────── */

/**
 * One pass, longest-marker-first, so `**bold**` is never mistaken for two italics.
 *
 * Inline code is matched before everything else and its contents are never re-parsed —
 * otherwise `` `a * b` `` would sprout an italic.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/

function inline(src: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = []
  let rest = src
  let key = 0
  // Bounded, so a pathological string cannot spin here.
  let guard = 0

  while (rest && guard++ < 400) {
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) break

    if (m.index > 0) out.push(text(rest.slice(0, m.index), key++))
    const tok = m[0]
    rest = rest.slice(m.index + tok.length)

    if (tok.startsWith('`')) {
      out.push(
        <code
          key={key++}
          className="mono"
          style={{
            background: 'var(--color-neutral-100)',
            border: '1px solid var(--line-2)',
            padding: '0 3px',
            fontSize: '0.92em',
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      )
      continue
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
    if (link) {
      const href = link[2]!
      // Only http(s). A `javascript:` or `file:` href from a model is not a link we open.
      const safe = /^https?:\/\//i.test(href)
      out.push(
        safe ? (
          <a
            key={key++}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              void window.vibepilot.system.openExternal(href)
            }}
            style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}
          >
            {link[1]}
          </a>
        ) : (
          <span key={key++}>{link[1]}</span>
        ),
      )
      continue
    }

    const inner = (s: string): ReactNode[] => (depth < 3 ? inline(s, depth + 1) : [s])

    if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <strong key={key++} style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {inner(tok.slice(2, -2))}
        </strong>,
      )
    } else if (tok.startsWith('~~')) {
      out.push(
        <span key={key++} style={{ textDecoration: 'line-through', opacity: 0.7 }}>
          {inner(tok.slice(2, -2))}
        </span>,
      )
    } else {
      out.push(<em key={key++}>{inner(tok.slice(1, -1))}</em>)
    }
  }

  if (rest) out.push(text(rest, key++))
  return out
}

/** Preserve the newlines inside a paragraph — models use them meaningfully. */
function text(s: string, key: number): ReactNode {
  return (
    <span key={key} style={{ whiteSpace: 'pre-wrap' }}>
      {s}
    </span>
  )
}
