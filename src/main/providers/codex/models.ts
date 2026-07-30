import { statSync } from 'node:fs'
import type { CodexModel } from '@shared/types'
import { createNdjsonReader } from '../process/ndjson'
import { resolveCodex } from '../process/resolve'
import { spawnCli } from '../process/spawn'

/**
 * Ask the installed Codex which models it has.
 *
 * **Nothing about OpenAI's model line-up is written down in vibePilot**, and that is the whole
 * point of this file. The alternative was a hardcoded list, which is the one thing the model
 * layer here has always refused to do — the Claude side stores aliases (`opus`, `sonnet`) for
 * exactly this reason, and Codex has no aliases to store. A list typed into a source file names
 * models that will be renamed, retired and superseded, and it goes stale silently: the picker
 * keeps offering `gpt-5.4` long after it stops existing, and the failure arrives as a rejected
 * launch rather than a missing entry.
 *
 * `codex app-server` is the JSON-RPC service the Codex desktop app talks to, and it answers
 * `model/list` with the real thing — id, display name, description, which reasoning efforts
 * each model actually supports, and which is the default. It comes out of the binary the user
 * has installed, so it is correct by construction and updates when they update Codex.
 *
 * Three turns and out: `initialize`, the `notifications/initialized` acknowledgement it waits
 * for, then the question. The process is short-lived and touches nothing.
 */

/** Codex's own effort vocabulary. Ours matches it except for the last one. */
const EFFORT_ALIASES: Record<string, string> = { ultracode: 'ultra' }

/** vibePilot's `EffortLevel` as Codex spells it. */
export function codexEffort(level: string): string {
  return EFFORT_ALIASES[level] ?? level
}

interface WireModel {
  id?: unknown
  displayName?: unknown
  description?: unknown
  hidden?: unknown
  isDefault?: unknown
  defaultReasoningEffort?: unknown
  supportedReasoningEfforts?: unknown
}

/**
 * Parse a `model/list` reply.
 *
 * Separated from the spawning so it can be tested against a captured real response rather than
 * a guess at the shape. Everything is treated as untrusted: a future codex-cli may add fields,
 * rename them, or drop the ones read here, and the honest outcome then is fewer models in the
 * picker — never a crash on the path that decides whether a teammate can be hired.
 */
export function parseModelList(reply: unknown): CodexModel[] {
  const data = (reply as { result?: { data?: unknown } })?.result?.data
  if (!Array.isArray(data)) return []

  const out: CodexModel[] = []
  for (const raw of data as WireModel[]) {
    const id = typeof raw?.id === 'string' ? raw.id : null
    if (!id) continue
    // Hidden means the CLI does not offer it either. Deliberately trusted rather than
    // second-guessed — it is how OpenAI retires a model without breaking anyone's config.
    if (raw.hidden === true) continue

    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((e) => (e as { reasoningEffort?: unknown })?.reasoningEffort)
          .filter((e): e is string => typeof e === 'string')
      : []

    out.push({
      id,
      label: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
      description: typeof raw.description === 'string' ? raw.description : '',
      efforts,
      defaultEffort:
        typeof raw.defaultReasoningEffort === 'string' ? raw.defaultReasoningEffort : null,
      isDefault: raw.isDefault === true,
    })
  }
  return out
}

/** Cached against the binary it was read from, so updating Codex re-reads the list. */
let cache: { key: string; models: CodexModel[] } | null = null

export function clearCodexModelCache(): void {
  cache = null
}

const PROBE_TIMEOUT_MS = 20_000

export async function codexModels(): Promise<CodexModel[]> {
  const bin = await resolveCodex()
  if (!bin) return []

  let key = bin.file
  try {
    key = `${bin.file}:${statSync(bin.file).mtimeMs}`
  } catch {
    /* an unreadable stat is not a reason to skip the probe */
  }
  if (cache?.key === key) return cache.models

  const models = await probe(bin).catch(() => [])
  // Only a real answer is worth remembering. Caching an empty list would make one failed probe
  // — a CLI mid-update, a machine under load — look like "you have no models" until restart.
  if (models.length > 0) cache = { key, models }
  return models
}

async function probe(bin: Awaited<ReturnType<typeof resolveCodex>>): Promise<CodexModel[]> {
  if (!bin) return []

  return new Promise<CodexModel[]>((resolve) => {
    let done = false
    const finish = (models: CodexModel[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      resolve(models)
    }

    const timer = setTimeout(() => finish([]), PROBE_TIMEOUT_MS)

    let proc: ReturnType<typeof spawnCli>
    try {
      proc = spawnCli(bin, ['app-server'], { cwd: process.cwd() })
    } catch {
      clearTimeout(timer)
      resolve([])
      return
    }

    const reader = createNdjsonReader({
      onValue: (v) => {
        // Only our request id matters. The app-server also pushes unsolicited notifications
        // (remote-control status, and whatever a later version adds), which are not replies.
        if ((v as { id?: unknown })?.id === 2) finish(parseModelList(v))
      },
      onGarbage: () => undefined,
      onOverflow: () => finish([]),
    })

    proc.stdout?.on('data', (c: Buffer) => reader.push(c))
    proc.stdout?.on('end', () => reader.end())
    proc.on('error', () => finish([]))
    proc.on('close', () => finish([]))

    const say = (msg: unknown): void => {
      try {
        proc.stdin?.write(`${JSON.stringify(msg)}\n`)
      } catch {
        /* the close handler settles it */
      }
    }

    say({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'vibepilot', title: 'vibePilot', version: '1' } },
    })
    say({ jsonrpc: '2.0', method: 'notifications/initialized' })
    say({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })
    // stdin stays open: closing it makes the app-server exit before it has answered.
  })
}
