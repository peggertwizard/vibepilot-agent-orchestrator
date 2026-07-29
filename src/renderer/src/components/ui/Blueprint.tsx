import type { CSSProperties, MouseEvent, ReactNode } from 'react'

/**
 * The design system's signature frame: a hairline box with `+` registration marks drawn
 * *outside* each corner. Square, transparent, wireframe — never soften it into a rounded card.
 */
export function Blueprint({
  children,
  style,
  className,
  onClick,
}: {
  children: ReactNode
  style?: CSSProperties
  className?: string
  /** Receives the event, so a modal panel can stop the backdrop's click. */
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={`blueprint${className ? ' ' + className : ''}`}
      style={style}
      onClick={onClick}
    >
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  )
}

/** Three staggered bars — the universal "this agent is working" signal. */
export function WorkingBars({ style }: { style?: CSSProperties }) {
  return (
    <span className="vp-bars" style={style} aria-label="working">
      <i />
      <i />
      <i />
    </span>
  )
}

/** A pulsing dot — the universal "this needs you" signal. */
export function NeedsYouDot({ size = 5, color = 'var(--accent)' }: { size?: number; color?: string }) {
  return (
    <span
      className="vp-blink"
      aria-label="needs you"
      style={{
        display: 'block',
        width: size,
        height: size,
        borderRadius: 'var(--radius-sm)',
        background: color,
        flex: 'none',
      }}
    />
  )
}
