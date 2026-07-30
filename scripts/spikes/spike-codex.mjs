/**
 * Codex spike — capture the real `codex exec --json` event taxonomy.
 *
 * Only `agent_message` was ever observed on the wire when the plan was written; the rest of
 * the `item.*` shapes were inferred. An adapter built on inferred event names is an adapter
 * that breaks silently on the first turn that does something interesting, so this drives a
 * real process through: a shell command, a file edit, and an error, and records every
 * distinct event type it sees.
 *
 *   node scripts/spikes/spike-codex.mjs
 *
 * Writes docs/architecture/01-codex-spike.md. Nothing else in the app depends on it.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'vp-codex-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'greet.js'), 'export function greet() {\n  return "hello"\n}\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

/**
 * Resolve the binary ourselves.
 *
 * FINDING: `shell: true` is not an option. Windows concatenates argv without escaping under
 * a shell, so a multi-word prompt arrives as separate arguments and codex rejects it with
 * "unexpected argument". Without a shell, Node does not apply PATHEXT, so `codex` alone is
 * not found either. The adapter must resolve the absolute path once and spawn it directly.
 */
const CODEX = (() => {
  const candidates = [
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.codex', 'bin', 'codex'),
  ]
  return candidates.find((c) => existsSync(c)) ?? 'codex'
})()

/** Run one turn, return every parsed JSONL line plus anything that failed to parse. */
function run(cwd, prompt, extraArgs = [], timeoutMs = 180_000) {
  return new Promise((resolve) => {
    // The prompt goes over stdin, not argv. Quoting a multi-line prompt through a Windows
    // command line is a losing game, and `codex exec` reads stdin when no prompt argument
    // is given. The adapter should do the same.
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...extraArgs]
    const child = spawn(CODEX, args, { windowsHide: true })
    child.stdin.write(prompt)
    child.stdin.end()

    const events = []
    const unparsed = []
    let stderr = ''
    let buf = ''

    const timer = setTimeout(() => child.kill(), timeoutMs)

    child.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          events.push(JSON.parse(t))
        } catch {
          // Non-JSON on stdout is itself a finding: it means a naive NDJSON reader breaks.
          unparsed.push(t)
        }
      }
    })
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ events, unparsed, stderr, code, args })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ events, unparsed, stderr: String(e), code: null, args })
    })
  })
}

/** A stable shape key: the type, plus the item type when there is one. */
function key(e) {
  const t = e.type ?? e.msg?.type ?? '(no type)'
  const item = e.item?.type ?? e.item?.item_type
  return item ? `${t} / ${item}` : t
}

function summarise(events) {
  const seen = new Map()
  for (const e of events) {
    const k = key(e)
    if (!seen.has(k)) seen.set(k, { count: 0, sample: e })
    seen.get(k).count++
  }
  return seen
}

const cases = [
  {
    name: 'plain answer',
    prompt: 'Reply with exactly the word: pong. Do not run anything.',
    args: ['-s', 'read-only'],
  },
  {
    name: 'shell command',
    prompt: 'Run `git status --short` and tell me what it printed. Nothing else.',
    args: ['-s', 'read-only'],
  },
  {
    name: 'file edit',
    prompt:
      'Add an exported function farewell() to src/greet.js that returns the string "goodbye". ' +
      'Do not commit. Do not ask questions.',
    args: ['-s', 'workspace-write'],
  },
  {
    name: 'command that fails',
    prompt: 'Run `git checkout does-not-exist` and tell me what the error was.',
    args: ['-s', 'read-only'],
  },
]

const repo = scratchRepo()
console.log(`scratch repo: ${repo}\n`)

const results = []
for (const c of cases) {
  process.stdout.write(`running: ${c.name} ... `)
  const r = await run(repo, c.prompt, c.args)
  const seen = summarise(r.events)
  console.log(`${r.events.length} events, ${seen.size} distinct, exit ${r.code}`)
  results.push({ ...c, ...r, seen })
}

/* ── resume: does a thread id come back, and can it be continued? ─────────────── */
const threadIds = new Set()
for (const r of results) {
  for (const e of r.events) {
    for (const k of ['thread_id', 'session_id', 'conversation_id', 'id']) {
      const v = e[k] ?? e.msg?.[k]
      if (typeof v === 'string' && /^[0-9a-f-]{16,}$/i.test(v)) threadIds.add(`${k}=${v}`)
    }
  }
}

const allTypes = new Map()
for (const r of results) {
  for (const [k, v] of r.seen) {
    const cur = allTypes.get(k) ?? { count: 0, sample: v.sample, cases: new Set() }
    cur.count += v.count
    cur.cases.add(r.name)
    allTypes.set(k, cur)
  }
}

const lines = [
  '# Codex spike — the real `codex exec --json` wire',
  '',
  `Captured against **codex-cli ${(() => {
    try {
      return execFileSync('codex', ['--version'], { windowsHide: true }).toString().trim()
    } catch {
      return 'unknown'
    }
  })()}**, driving a real process through four cases.`,
  '',
  'This exists because the plan for a Codex adapter was written having only ever observed',
  '`agent_message` on the wire. Everything else was inferred, and an adapter built on',
  'inferred event names breaks silently on the first interesting turn.',
  '',
  '## Event types observed',
  '',
  '| Event | Count | Seen in |',
  '|---|---|---|',
  ...[...allTypes.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `| \`${k}\` | ${v.count} | ${[...v.cases].join(', ')} |`),
  '',
  '## Samples',
  '',
]

for (const [k, v] of allTypes) {
  lines.push(`### \`${k}\``, '', '```json', JSON.stringify(v.sample, null, 2).slice(0, 1400), '```', '')
}

lines.push(
  '## Per-case notes',
  '',
  ...results.flatMap((r) => [
    `### ${r.name}`,
    '',
    `- exit code: \`${r.code}\``,
    `- events: ${r.events.length}`,
    `- non-JSON lines on stdout: ${r.unparsed.length}` +
      (r.unparsed.length ? ` — **a naive NDJSON reader would break here**` : ''),
    ...(r.unparsed.length ? ['', '```', ...r.unparsed.slice(0, 5), '```'] : []),
    ...(r.stderr.trim() ? ['', 'stderr:', '```', r.stderr.trim().slice(0, 800), '```'] : []),
    '',
  ]),
  '## Session identity',
  '',
  threadIds.size
    ? `Candidate resume handles seen on the wire:\n\n${[...threadIds].map((t) => `- \`${t}\``).join('\n')}`
    : 'No stable id was observed on the wire. Without one, `codex exec resume` cannot be driven ' +
      'programmatically and a Codex teammate has no memory between turns.',
  '',
  '## Did the file edit actually land?',
  '',
  existsSync(join(repo, 'src', 'greet.js')) &&
  readFileSync(join(repo, 'src', 'greet.js'), 'utf8').includes('farewell')
    ? 'Yes — `workspace-write` wrote to the scratch repo.'
    : 'No. Either the sandbox blocked it or the model declined.',
  '',
)

const out = join(ROOT, 'docs', 'architecture', '01-codex-spike.md')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`\nwrote ${out}`)
console.log(`distinct event types: ${allTypes.size}`)
