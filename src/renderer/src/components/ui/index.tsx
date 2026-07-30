import type { CSSProperties, ReactNode } from 'react'
import { STEP_LABEL, type RouteStep } from '@shared/types'
import { LogoMark } from './Logo'

/* ── Button ───────────────────────────────────────────────────────────────── */

type ButtonKind = 'primary' | 'outline' | 'ghost' | 'danger'

export function Button({
  children,
  kind = 'outline',
  height = 28,
  disabled,
  onClick,
  title,
  style,
  full,
}: {
  children: ReactNode
  kind?: ButtonKind
  height?: number
  disabled?: boolean
  onClick?: () => void
  title?: string
  style?: CSSProperties
  full?: boolean
}) {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height,
    padding: `0 ${Math.round(height * 0.38)}px`,
    borderRadius: 'var(--radius-md)',
    fontSize: 11.5,
    fontWeight: 500,
    lineHeight: 1,
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    color: 'var(--ink-2)',
    width: full ? '100%' : undefined,
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background .12s, border-color .12s, color .12s',
    ...style,
  }
  const kinds: Record<ButtonKind, CSSProperties> = {
    primary: {
      background: 'var(--accent)',
      borderColor: 'var(--accent)',
      color: 'var(--color-neutral-100)',
      fontWeight: 600,
    },
    outline: {},
    ghost: { background: 'transparent', borderColor: 'transparent', color: 'var(--muted)' },
    danger: { borderColor: 'var(--danger)', color: 'var(--danger)', background: 'transparent' },
  }
  return (
    <button
      className="no-drag"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ ...base, ...kinds[kind] }}
      onMouseEnter={(e) => {
        if (disabled) return
        const s = e.currentTarget.style
        if (kind === 'primary') s.background = 'var(--color-accent-700)'
        else if (kind === 'danger') s.background = 'var(--warn-soft)'
        else s.borderColor = 'var(--color-accent-400)'
      }}
      onMouseLeave={(e) => {
        const s = e.currentTarget.style
        s.background = (kinds[kind].background as string) ?? 'var(--surface)'
        s.borderColor = (kinds[kind].borderColor as string) ?? 'var(--line)'
      }}
    >
      {children}
    </button>
  )
}

/* ── Tag ──────────────────────────────────────────────────────────────────── */

export function Tag({
  children,
  tone = 'neutral',
  style,
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
  style?: CSSProperties
  /** A tag is three or four characters. Whatever it cannot say goes here. */
  title?: string
}) {
  const tones: Record<string, CSSProperties> = {
    neutral: { background: 'var(--warn-soft)', color: 'var(--muted)' },
    accent: {
      background: 'var(--accent-soft)',
      color: 'var(--accent-ink)',
      border: '1px solid color-mix(in oklab, var(--accent) 35%, white)',
    },
    ok: { background: 'var(--ok-soft)', color: 'var(--color-accent-800)' },
    warn: { background: 'var(--warn-soft)', color: 'var(--warn)' },
    danger: { background: 'var(--warn-soft)', color: 'var(--danger)' },
  }
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1.5px 5px',
        borderRadius: 'var(--radius-md)',
        font: '500 9px var(--font-heading)',
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...tones[tone],
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/* ── Avatar ───────────────────────────────────────────────────────────────── */

const AVATAR_PALETTE = [
  ['var(--color-accent-500)', 'var(--color-neutral-100)'],
  ['var(--color-accent-300)', 'var(--color-accent-900)'],
  ['var(--color-accent-700)', 'var(--color-neutral-100)'],
  ['var(--color-neutral-400)', 'var(--color-neutral-900)'],
  ['var(--color-neutral-300)', 'var(--color-neutral-800)'],
  ['var(--color-neutral-500)', 'var(--color-neutral-100)'],
] as const

/** Stable colour per agent id — same agent is always the same colour across panes. */
export function avatarColors(seed: string, isPilot = false): readonly [string, string] {
  if (isPilot) return ['var(--color-accent-800)', 'var(--color-neutral-100)'] as const
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!
}

export function Avatar({
  initials,
  seed,
  size = 22,
  isPilot = false,
  dim = false,
}: {
  initials: string
  seed: string
  size?: number
  isPilot?: boolean
  dim?: boolean
}) {
  const [bg, fg] = avatarColors(seed, isPilot)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 'var(--radius-sm)',
        background: bg,
        color: fg,
        font: `500 ${Math.max(7, Math.round(size * 0.42))}px var(--font-heading)`,
        letterSpacing: '.02em',
        opacity: dim ? 0.45 : 1,
      }}
    >
      {isPilot ? <LogoMark size={Math.round(size * 0.58)} style={{ color: fg }} /> : initials.toUpperCase()}
    </span>
  )
}



/* ── Tabs ─────────────────────────────────────────────────────────────────── */

export interface TabDef<T extends string> {
  id: T
  label: string
  count?: number | null
  dot?: boolean
  badge?: number | null
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  variant = 'underline',
}: {
  tabs: TabDef<T>[]
  active: T
  onChange: (id: T) => void
  variant?: 'underline' | 'caps'
}) {
  const caps = variant === 'caps'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--line)',
        marginBottom: -1,
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: caps ? 'center' : undefined,
              gap: 5,
              flex: caps ? 1 : undefined,
              height: caps ? 47 : 34,
              padding: caps ? 0 : '0 11px',
              border: 'none',
              background: 'transparent',
              borderBottom: `2px solid ${on ? 'var(--ink)' : 'transparent'}`,
              color: on ? 'var(--ink)' : 'var(--muted)',
              font: caps
                ? '500 10px var(--font-heading)'
                : `500 12.5px var(--font-body)`,
              letterSpacing: caps ? '.07em' : undefined,
              textTransform: caps ? 'uppercase' : undefined,
            }}
          >
            {t.label}
            {t.count != null && (
              <span className="meta tnum" style={{ fontSize: 9.5 }}>
                {t.count}
              </span>
            )}
            {t.dot && (
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--accent)',
                }}
              />
            )}
            {t.badge != null && t.badge > 0 && (
              <span
                className="tnum"
                style={{
                  minWidth: 15,
                  height: 15,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 0,
                  background: 'var(--ok)',
                  color: 'var(--color-neutral-100)',
                  font: '500 9px var(--font-heading)',
                  padding: '0 3px',
                }}
              >
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ── Route marker ─────────────────────────────────────────────────────────── */

/**
 * A ticket's route, as dots.
 *
 * v1 drew a fixed four-dot pipeline on every card, which was a lie the moment routes became
 * per-ticket: a research ticket has one dot, a migration has three. The number of dots IS
 * the information — a card with one dot is a small job, and you can see that at a glance
 * across the whole board.
 *
 * Filled = done · tinted outline = where it is now · hollow = ahead · dashed = sent back.
 */
export function RouteMarker({
  steps,
  showLabel = true,
}: {
  steps: RouteStep[]
  showLabel?: boolean
}) {
  if (steps.length === 0) {
    return (
      <span className="meta" style={{ color: 'var(--faint)' }} title="No route decided yet">
        unrouted
      </span>
    )
  }
  const doneCount = steps.filter((s) => s.status === 'done').length
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {steps.map((s, i) => {
        const now = s.status === 'active' || s.status === 'rework'
        const size = now ? 8 : 7
        return (
          <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {i > 0 && (
              <span
                style={{
                  width: 7,
                  height: 1,
                  background:
                    s.status === 'pending'
                      ? 'var(--color-neutral-300)'
                      : 'var(--color-accent-500)',
                }}
              />
            )}
            <span
              title={`${STEP_LABEL[s.kind]}${s.passes > 1 ? ` · pass ${s.passes}` : ''}${
                s.note ? ` — ${s.note}` : ''
              }`}
              style={{
                width: size,
                height: size,
                border: `1px ${s.status === 'rework' ? 'dashed' : 'solid'} ${
                  s.status === 'pending'
                    ? 'var(--color-neutral-400)'
                    : s.status === 'rework'
                      ? 'var(--danger)'
                      : now
                        ? 'var(--accent)'
                        : 'var(--color-accent-700)'
                }`,
                background:
                  s.status === 'done'
                    ? 'var(--color-accent-700)'
                    : now
                      ? 'var(--color-accent-200)'
                      : 'transparent',
              }}
            />
          </span>
        )
      })}
      {showLabel && (
        <span
          style={{
            marginLeft: 8,
            font: '400 8.5px var(--font-heading)',
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
          }}
        >
          {doneCount}/{steps.length}
        </span>
      )}
    </span>
  )
}

/* ── Context / quota meter ────────────────────────────────────────────────── */

export function Meter({
  pct,
  label,
  right,
  width,
}: {
  pct: number
  label?: string
  right?: ReactNode
  width?: number
}) {
  const p = Math.max(0, Math.min(100, pct))
  // Thresholds match the comp: accent below 60, caution to 90, danger above.
  const color = p >= 91 ? 'var(--danger)' : p >= 60 ? 'var(--caution)' : 'var(--accent)'
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: width ?? '100%' }}>
      {label && (
        <span
          style={{
            font: '400 8.5px var(--font-heading)',
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          flex: 1,
          height: 3,
          background: 'var(--color-neutral-300)',
          position: 'relative',
          minWidth: 20,
        }}
      >
        <span
          style={{ position: 'absolute', inset: 0, width: `${p}%`, background: color }}
        />
      </span>
      <span className="tnum" style={{ font: '500 9.5px var(--font-heading)', color }}>
        {Math.round(p)}%
      </span>
      {right}
    </span>
  )
}

/* ── Input ────────────────────────────────────────────────────────────────── */

export function Input({
  value,
  onChange,
  placeholder,
  height = 30,
  autoFocus,
  onEnter,
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  height?: number
  autoFocus?: boolean
  onEnter?: () => void
  style?: CSSProperties
}) {
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter()
      }}
      style={{
        width: '100%',
        height,
        padding: '0 9px',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-neutral-100)',
        color: 'var(--ink)',
        font: 'inherit',
        fontSize: 12.5,
        outline: 'none',
        ...style,
      }}
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
    />
  )
}

/* ── Section caption with rule ────────────────────────────────────────────── */

export function SectionRule({ label, count }: { label: string; count?: number | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span className="cap">{label}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      {count != null && (
        <span className="meta tnum">{count}</span>
      )}
    </div>
  )
}

/* ── Empty state ──────────────────────────────────────────────────────────── */

export function Empty({
  title,
  hint,
  action,
  icon,
}: {
  title: string
  hint?: string
  action?: ReactNode
  /** Optional mark above the title. Used on the first-run screen. */
  icon?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--muted)',
      }}
    >
      {icon && <div style={{ marginBottom: 6 }}>{icon}</div>}
      <div style={{ font: '600 13px var(--font-heading)', color: 'var(--ink-2)' }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 11.5, lineHeight: 1.55, maxWidth: 340, color: 'var(--faint)' }}>
          {hint}
        </div>
      )}
      {action}
    </div>
  )
}

/**
 * The phases a ticket goes through, with who and on what model.
 *
 * *"the ticket goes through different phases right? planning building verification, 3 agents
 * with 3 different models. sometimes no plan is needed sometimes no verification... this should
 * be very clear and a nice visual."*
 *
 * `RouteMarker` is the compact form — dots, for a dense board column. This is the readable one,
 * for the ticket panel and the proposal card, where the question is "what is actually going to
 * happen to this, and who does it" rather than "how far along is it".
 *
 * The route already varies per ticket, so a one-phase ticket honestly shows one marker. v1 drew
 * Plan/Build/Verify on everything whether or not those steps existed, which is how a typo fix
 * came to look like it needed a committee.
 */
export function PhaseStrip({
  steps,
  nameFor,
  modelFor,
}: {
  steps: RouteStep[]
  nameFor: (agentId: string | null) => string | null
  modelFor: (agentId: string | null) => string | null
}) {
  if (steps.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {steps.map((s, i) => {
        const now = s.status === 'active' || s.status === 'rework'
        const done = s.status === 'done'
        const who = nameFor(s.assigneeAgentId)
        const model = modelFor(s.assigneeAgentId)
        return (
          <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && (
              <span className="meta" style={{ color: 'var(--faint)' }}>
                →
              </span>
            )}
            <span
              title={s.note ?? undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 5,
                padding: '2px 7px',
                border: `1px ${s.status === 'rework' ? 'dashed' : 'solid'} ${
                  now ? 'var(--accent)' : 'var(--line)'
                }`,
                background: done
                  ? 'var(--ok-soft)'
                  : now
                    ? 'var(--accent-soft)'
                    : 'transparent',
                // Ahead of where we are: present, but clearly not yet.
                opacity: s.status === 'pending' ? 0.65 : 1,
              }}
            >
              <span
                className="cap"
                style={{ color: now ? 'var(--accent-ink)' : 'var(--ink-2)' }}
              >
                {STEP_LABEL[s.kind]}
              </span>
              {who && <span style={{ fontSize: 11, fontWeight: 500 }}>{who}</span>}
              {model && (
                <span className="meta" style={{ color: 'var(--faint)' }}>
                  {model}
                </span>
              )}
              {/* The one thing on this strip that is a decision rather than a description. */}
              {s.gate && s.status === 'pending' && (
                <span className="meta" style={{ color: 'var(--warn)' }}>
                  · your sign-off
                </span>
              )}
              {s.passes > 1 && (
                <span className="meta" style={{ color: 'var(--warn)' }}>
                  · pass {s.passes}
                </span>
              )}
            </span>
          </span>
        )
      })}
    </div>
  )
}
