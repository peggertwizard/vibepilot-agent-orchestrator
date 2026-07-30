/**
 * Turns a raw tool call into one line a human can read at a glance.
 *
 * This is what the Agents panel and the collapsible tool log show, so it should read like
 * a colleague narrating what they just did — "read bus.ts (240 lines)", not
 * "Read(file_path=...)".
 */

interface ToolMeta {
  numFiles?: unknown
  numLines?: unknown
  totalMatches?: unknown
  filenames?: unknown
  durationMs?: unknown
  [k: string]: unknown
}

export function summariseTool(name: string, meta: ToolMeta = {}, isError = false): string {
  if (isError) return `${verb(name)} failed`

  const n = (k: string): number | null => (typeof meta[k] === 'number' ? (meta[k] as number) : null)
  const files = Array.isArray(meta['filenames']) ? (meta['filenames'] as string[]) : []
  const first = files[0] ? base(files[0]) : null

  switch (name) {
    case 'Read': {
      const lines = n('numLines')
      return first
        ? `read ${first}${lines ? ` (${lines} lines)` : ''}`
        : `read a file${lines ? ` (${lines} lines)` : ''}`
    }
    case 'Edit':
    case 'MultiEdit':
      return first ? `edited ${first}` : 'edited a file'
    case 'Write':
      return first ? `wrote ${first}` : 'wrote a file'
    case 'Glob': {
      const count = n('numFiles')
      return count === null ? 'searched for files' : `found ${count} file${count === 1 ? '' : 's'}`
    }
    case 'Grep': {
      const m = n('totalMatches')
      return m === null ? 'searched the code' : `${m} match${m === 1 ? '' : 'es'}`
    }
    case 'Bash':
      return 'ran a command'
    case 'Task':
      return 'delegated to a sub-agent'
    case 'WebFetch':
    case 'WebSearch':
      return 'looked something up'
    case 'TodoWrite':
      return 'updated its plan'
    default:
      if (name.startsWith('mcp__vibepilot__')) {
        return 'vibePilot: ' + name.slice('mcp__vibepilot__'.length).replace(/_/g, ' ')
      }
      if (name.startsWith('mcp__')) {
        return name.split('__').slice(1).join(' ').replace(/_/g, ' ')
      }
      return name
  }
}

function verb(name: string): string {
  switch (name) {
    case 'Read':
      return 'read'
    case 'Write':
      return 'write'
    case 'Edit':
    case 'MultiEdit':
      return 'edit'
    case 'Bash':
      return 'command'
    default:
      return name
  }
}

function base(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Compact elapsed time: 42s, 3m, 1h12m. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}
