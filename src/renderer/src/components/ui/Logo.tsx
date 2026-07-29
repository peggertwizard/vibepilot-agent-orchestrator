import mark from '../../assets/brand/mark.svg?raw'
import wordmark from '../../assets/brand/wordmark.svg?raw'

/**
 * The vibePilot marks.
 *
 * Inlined rather than loaded as an `<img>` so they inherit `currentColor` — the design
 * system is monochrome plus one accent, and a logo that stays black while the rest of the
 * chrome shifts is the thing that makes an app look assembled rather than designed. It also
 * means one file works in both themes instead of two.
 *
 * The source SVGs carry no `fill` of their own, so a single `fill="currentColor"` on the
 * root element colours the whole mark.
 */

function Inline({
  svg,
  size,
  style,
  title,
}: {
  svg: string
  size: number
  style?: React.CSSProperties
  title?: string
}) {
  return (
    <span
      role="img"
      aria-label={title ?? 'vibePilot'}
      title={title}
      // The SVG has a viewBox and no width/height, so it fills its box at any aspect ratio.
      style={{ display: 'inline-flex', height: size, lineHeight: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** The bare mark. Square-ish; use where space is tight. */
export function LogoMark({
  size = 16,
  style,
}: {
  size?: number
  style?: React.CSSProperties
}) {
  return <Inline svg={mark} size={size} style={{ width: size * (3752.71 / 3505.17), ...style }} />
}

/** Mark plus wordmark. Wide — give it room or it reads as a smudge. */
export function LogoWordmark({
  size = 20,
  style,
}: {
  size?: number
  style?: React.CSSProperties
}) {
  return (
    <Inline svg={wordmark} size={size} style={{ width: size * (3577.34 / 1014.13), ...style }} />
  )
}
