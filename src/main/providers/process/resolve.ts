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

/**
 * One cache per CLI. Keyed by name because the ladder is now shared: resolving Codex must not
 * evict the Claude entry, and neither may answer for the other.
 */
const cached = new Map<string, Resolved>()
const cachedShimMtime = new Map<string, number>()

export function clearResolveCache(): void {
  cached.clear()
  cachedShimMtime.clear()
}

/**
 * Find a CLI the way a CLI has to be found on Windows.
 *
 * Written for Claude and then left there, while Codex made do with five hardcoded paths and
 * therefore could not be found at all after `npm i -g @openai/codex` — that install lands as a
 * `.cmd` shim, which is exactly the case the ladder below exists to handle and the case a list
 * of absolute paths can never cover.
 *
 * The order is the order of confidence: what the user told us, then a known installer's
 * location, then PATH, then npm's own idea of where it puts things.
 */
export async function resolveCli(
  name: string,
  wellKnown: string[],
  settingKey: 'claudeBinaryPath' | 'codexBinaryPath',
): Promise<Resolved | null> {
  const hit = cached.get(name)
  if (hit && hit.kind !== 'node') return hit
  if (hit && hit.kind === 'node' && shimUnchanged(name)) return hit

  const keep = (r: Resolved): Resolved => {
    cached.set(name, r)
    return r
  }

  /*
   * 1. Explicit override always wins — but not being able to *read* it must not stop the
   * search. `getSetting` throws when the database is not open, and the rungs below need no
   * database at all, so letting that escape would turn "settings unavailable" into "you have
   * no Claude and no Codex installed".
   */
  let override: string | null = null
  try {
    override = getSetting(settingKey)
  } catch {
    /* no settings to consult; the ladder still works */
  }
  if (override && existsSync(override)) return keep(classify(name, override, 'settings override'))

  // 2. Where the official installer puts it.
  for (const candidate of wellKnown) {
    if (candidate && existsSync(candidate)) return keep(classify(name, candidate, 'well-known path'))
  }

  // 3. PATH, honouring PATHEXT so .EXE is preferred over .CMD.
  const onPath = findOnPath(name)
  if (onPath) return keep(classify(name, onPath, 'PATH'))

  // 4. npm global prefix.
  try {
    const { stdout } = await pExecFile('npm', ['config', 'get', 'prefix'], {
      windowsHide: true,
      shell: false,
    })
    const prefix = stdout.trim()
    for (const candidate of [join(prefix, `${name}.cmd`), join(prefix, 'bin', name)]) {
      if (existsSync(candidate)) return keep(classify(name, candidate, 'npm global prefix'))
    }
  } catch {
    /* npm not present; nothing more to try */
  }

  return null
}

export async function resolveClaude(): Promise<Resolved | null> {
  return resolveCli(
    'claude',
    [join(homedir(), '.local', 'bin', 'claude.exe'), join(homedir(), '.local', 'bin', 'claude')],
    'claudeBinaryPath',
  )
}

/**
 * Codex, through the same ladder.
 *
 * The well-known list is only the first rung now, not the whole search — which is what turns
 * "vibePilot cannot find Codex" from a dead end into a case PATH or npm covers.
 */
export async function resolveCodex(): Promise<Resolved | null> {
  return resolveCli(
    'codex',
    [
      join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      join(homedir(), '.codex', 'bin', 'codex.exe'),
      join(homedir(), '.codex', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ],
    'codexBinaryPath',
  )
}

function shimUnchanged(name: string): boolean {
  const hit = cached.get(name)
  if (!hit) return false
  try {
    return statSync(hit.file).mtimeMs === cachedShimMtime.get(name)
  } catch {
    return false
  }
}

function classify(name: string, file: string, source: string): Resolved {
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
        cachedShimMtime.set(name, statSync(file).mtimeMs)
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
