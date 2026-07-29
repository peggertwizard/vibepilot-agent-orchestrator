import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/src/components/ui/Markdown'

/**
 * Models write markdown whether or not you ask them to, and v1 rendered it as plain text.
 *
 * The security tests here are the important ones: this is the single place untrusted model
 * output reaches the DOM, and the whole reason the renderer is hand-written is that it can
 * only ever produce React elements — never HTML.
 */
const html = (md: string): string => renderToStaticMarkup(<Markdown text={md} />)

describe('Markdown', () => {
  it('renders the emphasis models actually emit', () => {
    expect(html('**bold**')).toContain('<strong')
    expect(html('__bold__')).toContain('<strong')
    expect(html('*italic*')).toContain('<em')
    expect(html('_italic_')).toContain('<em')
    expect(html('~~gone~~')).toContain('line-through')
  })

  it('does not read **bold** as two italics', () => {
    const out = html('**bold**')
    expect(out).toContain('<strong')
    expect(out).not.toContain('<em')
  })

  it('leaves inline code alone', () => {
    const out = html('use `a * b` here')
    expect(out).toContain('<code')
    // The asterisk inside backticks must not become emphasis.
    expect(out).not.toContain('<em')
    expect(out).toContain('a * b')
  })

  it('renders fenced code without parsing its contents', () => {
    const out = html('```ts\nconst a = **b**\n```')
    expect(out).toContain('<pre')
    expect(out).not.toContain('<strong')
    expect(out).toContain('const a = **b**')
  })

  it('survives an unclosed fence rather than swallowing the rest', () => {
    expect(() => html('```\nnever closed')).not.toThrow()
    expect(html('```\nnever closed')).toContain('never closed')
  })

  it('renders both kinds of list, and headings', () => {
    expect(html('- one\n- two')).toContain('<ul')
    expect(html('1. one\n2. two')).toContain('<ol')
    expect(html('## Heading')).toContain('Heading')
  })

  it('renders blockquotes and rules', () => {
    expect(html('> quoted')).toContain('<blockquote')
    expect(html('---')).toContain('<hr')
  })

  /* ── the reason this is hand-written ──────────────────────────────────────── */

  it('NEVER emits model-authored HTML', () => {
    const out = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>')
    // No tag is ever opened. The word "onerror" DOES appear — as escaped text inside a
    // span, which is the correct rendering of those characters and is inert. Asserting its
    // absence would be testing the wrong thing; what matters is that no `<` survives
    // unescaped, because that is what turns text into markup.
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;img')
    expect(out).toContain('&lt;script&gt;')
    // Everything the model wrote is inside a text node, not an attribute.
    expect(out).toMatch(/<span style="white-space:pre-wrap">&lt;img[^<]*&lt;\/script&gt;<\/span>/)
  })

  it('refuses a javascript: link but keeps its text', () => {
    const out = html('[click me](javascript:alert(1))')
    expect(out).not.toContain('href')
    expect(out).toContain('click me')
  })

  it('renders an http link as a link', () => {
    const out = html('[docs](https://example.com/x)')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('docs')
  })

  it('does not hang on pathological input', () => {
    const nasty = '*'.repeat(5000) + '`'.repeat(5000) + '['.repeat(2000)
    const start = Date.now()
    expect(() => html(nasty)).not.toThrow()
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('passes plain prose through unchanged, newlines and all', () => {
    const out = html('line one\nline two')
    expect(out).toContain('line one')
    expect(out).toContain('line two')
    expect(out).toContain('pre-wrap')
  })

  it('renders an empty string without throwing', () => {
    expect(() => html('')).not.toThrow()
  })
})

describe('numbered lists that are spaced out', () => {
  /**
   * The Pilot writes a blank line between list items whenever the items are longer than a few
   * words. The parser stopped the list at the first blank line, so each item became its own
   * `<ol>` and every one of them started again at 1 — on screen, "1. Birth / 1. Ongoing
   * memory / 1. Truth", followed by a sentence reading "3, then 1, then 2" that referred to
   * numbers nobody could see.
   */
  it('keeps one list when items are separated by a blank line', () => {
    const out = html('1. Birth — put things here\n\n2. Ongoing memory\n\n3. Truth')
    // One list, not three. That is the whole bug.
    expect(out.match(/<ol/g) ?? []).toHaveLength(1)
    expect(out.match(/<li/g) ?? []).toHaveLength(3)
    expect(out).toContain('Birth')
    expect(out).toContain('Ongoing memory')
    expect(out).toContain('Truth')
  })

  it('does the same for bullets', () => {
    const out = html('- one\n\n- two\n\n- three')
    expect(out.match(/<ul/g) ?? []).toHaveLength(1)
    expect(out.match(/<li/g) ?? []).toHaveLength(3)
  })

  it('still ends the list when real prose follows', () => {
    const out = html('1. one\n2. two\n\nThis is a paragraph.')
    expect(out.match(/<ol/g) ?? []).toHaveLength(1)
    expect(out.match(/<li/g) ?? []).toHaveLength(2)
    expect(out).toContain('This is a paragraph.')
  })

  it('does not swallow a heading that comes after a blank line', () => {
    const out = html('1. one\n\n## Next section')
    expect(out.match(/<li/g) ?? []).toHaveLength(1)
    expect(out).toContain('Next section')
  })

  it('keeps tight lists tight', () => {
    const out = html('1. one\n2. two\n3. three')
    expect(out.match(/<ol/g) ?? []).toHaveLength(1)
    expect(out.match(/<li/g) ?? []).toHaveLength(3)
  })
})
