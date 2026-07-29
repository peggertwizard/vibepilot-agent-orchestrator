import {
  ChevronRight,
  Minus,
  Square,
  X,
  Settings2,
  Plus,
  GitBranch,
  GitMerge,
  FileText,
  CircleDot,
  OctagonX,
  TriangleAlert,
  CornerDownLeft,
  ArrowDownToLine,
  type LucideIcon,
} from 'lucide-react'

/**
 * All icons come from Lucide at strokeWidth 1.5 — the design system's own mandate. Nothing
 * here is hand-drawn in CSS: the shapes v1 used were inconsistent in weight and optical size
 * and read as improvised next to Barlow Condensed.
 */
const REGISTRY = {
  chevron: ChevronRight,
  minimise: Minus,
  maximise: Square,
  close: X,
  settings: Settings2,
  add: Plus,
  branch: GitBranch,
  merge: GitMerge,
  files: FileText,
  status: CircleDot,
  // A pending app update. Down-to-line rather than a plain arrow: this is "install", not
  // "scroll down".
  download: ArrowDownToLine,
  stop: OctagonX,
  warn: TriangleAlert,
  // The Enter-key glyph, as a real icon. The composer used a literal '⏎', which renders
  // in whatever the system font decides and sat at the wrong optical weight next to Barlow.
  return: CornerDownLeft,
  // 'Stop generating' is a filled square by convention. `stop` (OctagonX) is a stop SIGN
  // and reads as an error, which stopping a turn deliberately is not.
  halt: Square,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof REGISTRY

export function Icon({
  name,
  size = 14,
  color = 'currentColor',
  style,
}: {
  name: IconName
  size?: number
  color?: string
  style?: React.CSSProperties
}) {
  const Cmp = REGISTRY[name]
  return (
    <Cmp
      size={size}
      strokeWidth={1.5}
      color={color}
      style={{ display: 'block', flex: 'none', ...style }}
      aria-hidden
    />
  )
}
