import { spawn } from 'node:child_process'
import type { CheckKind, ProjectChecks } from '@shared/types'
import { CHECK_LABEL, configuredChecks } from '@shared/types'

/**
 * Running the project's own checks, and reporting what actually happened.
 *
 * Verification used to be prose: a rule file told the agent *"the project's tests pass,
 * typecheck and lint are clean"*, and nothing anywhere checked whether that had happened. An
 * agent that says it verified and one that did are indistinguishable on that evidence.
 *
 * The plan asked whether vibePilot should run these or hand them to the agent, and the answer
 * turns out to be both, which is why this lives behind a tool. **vibePilot** spawns them, so
 * the exit code is a fact rather than a claim. The **agent** gets the output, so it can read
 * the failure and fix it. Trust and verify, without having to choose.
 */

/** Long enough for a real test suite; short enough that a hung watcher does not wedge a run. */
const TIMEOUT_MS = 10 * 60 * 1000

/** Enough of the tail to see what broke, without pasting a whole build log into a prompt. */
const OUTPUT_TAIL = 4000

export interface CheckResult {
  kind: CheckKind
  cmd: string
  ok: boolean
  exitCode: number | null
  durationMs: number
  /** The tail of stdout+stderr, interleaved as the process wrote them. */
  output: string
  timedOut: boolean
}

/**
 * Run one command in `cwd`.
 *
 * `shell: true` is deliberate and safe *here specifically*: the command is a string the user
 * typed into their own settings, not model output, and it has to be — `npm test && npm run
 * lint` is a legitimate thing to configure. Everywhere model-supplied text reaches a command
 * line, vibePilot spawns without a shell and quotes explicitly (see providers/process/spawn).
 */
export async function runCommand(cmd: string, cwd: string): Promise<Omit<CheckResult, 'kind'>> {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        cmd,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: out.length > OUTPUT_TAIL ? `…\n${out.slice(-OUTPUT_TAIL)}` : out,
        timedOut,
      })
    }

    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    })

    const timer = setTimeout(() => {
      child.kill()
      finish(null, true)
    }, TIMEOUT_MS)

    const collect = (c: Buffer): void => {
      out += c.toString()
      // Bound memory as it arrives: a build log can be tens of megabytes and we only ever
      // want the end of it.
      if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    child.on('error', (e: Error) => {
      out += `\n${e.message}`
      finish(null, false)
    })
    child.on('close', (code) => finish(code, false))
  })
}

/**
 * Run every check this project has configured, in order, in the given working directory.
 *
 * Sequential, and it does not stop at the first failure: knowing that typecheck AND tests are
 * broken is worth more than one turn than finding out one at a time.
 */
export async function runChecks(checks: ProjectChecks, cwd: string): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const { kind, cmd } of configuredChecks(checks)) {
    out.push({ kind, ...(await runCommand(cmd, cwd)) })
  }
  return out
}

/** What the agent reads back. Failures first and in full; passes as one line each. */
export function renderChecks(results: CheckResult[]): string {
  if (results.length === 0) {
    return 'This project has no checks configured, so there was nothing to run.'
  }

  const lines: string[] = []
  for (const r of results) {
    const label = `${CHECK_LABEL[r.kind]} (\`${r.cmd}\`)`
    if (r.ok) {
      lines.push(`- ${label}: passed in ${Math.round(r.durationMs / 1000)}s`)
      continue
    }
    lines.push(
      r.timedOut
        ? `- ${label}: **timed out** after 10 minutes`
        : `- ${label}: **failed** (exit ${r.exitCode ?? 'unknown'})`,
    )
    if (r.output.trim()) lines.push('', '```', r.output.trim(), '```', '')
  }

  const failed = results.filter((r) => !r.ok).length
  lines.push(
    '',
    failed === 0
      ? 'Everything the project checks passed. That is a real result, not a claim — vibePilot ran them.'
      : `${failed} of ${results.length} failed. Fix them and run this again; do not report the ` +
          `ticket as done while any of them is red.`,
  )
  return lines.join('\n')
}
