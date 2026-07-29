import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { getSetting } from '../../db/repos/settings'

const pExecFile = promisify(execFile)

/**
 * How to launch a CLI, resolved once and cached.
 *
 * `kind: 'node'` is the interesting one. Node >= 18.20 refuses to spawn `.cmd`/`.bat`
 * without `shell: true` (the CVE-2024-27980 mitigation) and returns EINVAL. We must never
 * set `shell: true` — a ticket title containing `&` would become command injection — so
 * instead we unwrap the npm shim: pull the `cli.js` path out of the batch file and run
 * node on it directly.
 */
export interface Resolved {
  kind: 'exe' | 'cmd' | 'node'
  file: string
  /** Prepended to argv. Empty for 'exe'. */
  prefix: string[]
  source: string
}

let cached: Resolved | null = null
let cachedShimMtime = 0

export function clearResolveCache(): void {
  cached = null
}

export async function resolveClaude(): Promise<Resolved | null> {
  if (cached && cached.kind !== 'node') return cached
  if (cached && cached.kind === 'node' && shimUnchanged()) return cached

  // 1. Explicit override always wins.
  const override = getSetting('claudeBinaryPath')
  if (override && existsSync(override)) {
    cached = classify(override, 'settings override')
    return cached
  }

  // 2. Native install — the current default on Windows.
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    join(homedir(), '.local', 'bin', 'claude'),
  ]) {
    if (existsSync(candidate)) {
      cached = classify(candidate, 'native install (~/.local/bin)')
      return cached
    }
  }

  // 3. PATH, honouring PATHEXT so .EXE is preferred over .CMD.
  const onPath = findOnPath('claude')
  if (onPath) {
    cached = classify(onPath, 'PATH')
    return cached
  }

  // 4. npm global prefix.
  try {
    const { stdout } = await pExecFile('npm', ['config', 'get', 'prefix'], {
      windowsHide: true,
      shell: false,
    })
    const prefix = stdout.trim()
    for (const candidate of [join(prefix, 'claude.cmd'), join(prefix, 'bin', 'claude')]) {
      if (existsSync(candidate)) {
        cached = classify(candidate, 'npm global prefix')
        return cached
      }
    }
  } catch {
    /* npm not present; nothing more to try */
  }

  return null
}

function shimUnchanged(): boolean {
  if (!cached) return false
  try {
    return statSync(cached.file).mtimeMs === cachedShimMtime
  } catch {
    return false
  }
}

function classify(file: string, source: string): Resolved {
  if (!/\.(cmd|bat)$/i.test(file)) {
    return { kind: 'exe', file, prefix: [], source }
  }

  // Try to unwrap the npm shim so we can spawn node.exe directly and keep shell:false.
  try {
    const text = readFileSync(file, 'utf8')
    const m =
      text.match(/"%dp0%\\(.+?\.js)"/i) ??
      text.match(/"\$basedir\/(.+?\.js)"/i) ??
      text.match(/([\w@./\\-]+\.js)/)
    if (m?.[1]) {
      const dir = file.replace(/[\\/][^\\/]+$/, '')
      const script = join(dir, m[1].replace(/\//g, '\\'))
      if (existsSync(script)) {
        cachedShimMtime = statSync(file).mtimeMs
        return { kind: 'node', file: process.execPath, prefix: [script], source: `${source} (shim unwrapped)` }
      }
    }
  } catch {
    /* fall through to the cmd path */
  }

  // Last resort: run it through cmd.exe with our own quoting. See spawn.ts.
  const comspec = process.env['COMSPEC'] ?? 'cmd.exe'
  return { kind: 'cmd', file: comspec, prefix: ['/d', '/s', '/c', file], source }
}

function findOnPath(name: string): string | null {
  const paths = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT')
          .split(';')
          .filter(Boolean)
          // .EXE before .CMD: the native binary avoids the shim problem entirely.
          .sort((a, b) => (a.toUpperCase() === '.EXE' ? -1 : b.toUpperCase() === '.EXE' ? 1 : 0))
      : ['']
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export async function probeVersion(r: Resolved): Promise<string | null> {
  try {
    const { stdout } = await pExecFile(r.file, [...r.prefix, '--version'], {
      windowsHide: true,
      shell: false,
      timeout: 20_000,
    })
    return stdout.trim().split('\n')[0]?.trim() ?? null
  } catch {
    return null
  }
}
