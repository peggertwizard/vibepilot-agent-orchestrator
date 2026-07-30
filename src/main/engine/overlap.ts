import { changedFiles } from '../git/worktree'
import { getProject } from '../db/repos/projects'
import { listTickets } from '../db/repos/tickets'
import { acceptedRoute } from '../db/repos/routes'
import { activeStep } from '@shared/types'
import type { Ticket } from '@shared/types'

/**
 * Which files the work in flight is already touching.
 *
 * #1, #3 and #4 all edited `src/content/preise-defaults.ts`. #3 was branched before #4 landed,
 * so merging #3 afterwards would have brought back the AGB line and the 10 GB that #4 had just
 * removed. The Pilot diagnosed that correctly — *after* creating it — and then asked the user
 * to sort it out.
 *
 * It was not a misjudgement. The Pilot is told the board as titles and lanes and is never told
 * which files anything is touching, even though every ticket has a real branch and
 * `changedFiles` has existed since the ticket detail pane was built. It was being asked to
 * avoid a collision it could not see.
 */

export interface LiveTouch {
  ticketNumber: number
  title: string
  files: string[]
}

/**
 * A per-turn cache.
 *
 * `git diff --name-only` per live worktree is cheap but not free, and a Pilot turn can ask
 * this several times. Short-lived deliberately: a stale answer here is a missed collision.
 */
const cache = new Map<string, { at: number; value: LiveTouch[] }>()
const TTL_MS = 10_000

/** Everything with a worktree and unfinished work in it. */
export async function liveTouches(projectId: string): Promise<LiveTouch[]> {
  const hit = cache.get(projectId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  const project = getProject(projectId)
  if (!project) return []

  const candidates = listTickets(projectId).filter(
    (t) => t.worktreePath && t.mergeState !== 'merged' && !!activeStep(acceptedRoute(t.id)),
  )

  const out: LiveTouch[] = []
  for (const t of candidates) {
    const files = await changedFiles(t.worktreePath!, project.defaultBaseBranch)
    if (files.length === 0) continue
    out.push({ ticketNumber: t.number, title: t.title, files: files.map((f) => f.path) })
  }

  cache.set(projectId, { at: Date.now(), value: out })
  return out
}

/**
 * File paths named anywhere in a ticket's own text.
 *
 * A ticket that has not started has no diff, so there is nothing to compare — the only thing
 * available before work begins is what the ticket and its briefs *say*. This catches the
 * common case (the Pilot names the file it intends to change, because it has just read it)
 * and misses the case where nobody says the path out loud. That residue is the prompt's job.
 */
export function pathsMentionedIn(text: string): string[] {
  const out = new Set<string>()
  // A slash, a dot, an extension: enough to be a path and not enough to be a sentence.
  for (const m of text.matchAll(/[\w./@-]*[\w-]+\/[\w./-]+\.\w{1,5}/g)) {
    out.add(m[0].replace(/^[./]+/, ''))
  }
  return [...out]
}

export interface Collision {
  with: LiveTouch
  files: string[]
}

/**
 * Would starting this ticket edit a file something else is already editing?
 *
 * Compared by suffix rather than equality, because a brief says `src/content/preise-defaults.ts`
 * and the diff says the same thing relative to the repo root — but one of them may carry a
 * leading `./` or the project folder's name.
 */
export async function collisionsFor(
  ticket: Ticket,
  extraText = '',
): Promise<Collision[]> {
  const mentioned = pathsMentionedIn(`${ticket.title}\n${ticket.body}\n${extraText}`)
  if (mentioned.length === 0) return []

  const touches = await liveTouches(ticket.projectId)
  const out: Collision[] = []
  for (const t of touches) {
    if (t.ticketNumber === ticket.number) continue
    const shared = t.files.filter((f) =>
      mentioned.some((m) => f === m || f.endsWith(`/${m}`) || m.endsWith(`/${f}`)),
    )
    if (shared.length > 0) out.push({ with: t, files: shared })
  }
  return out
}

/** For the board summary in the Pilot's prompt. Empty string when nothing is in flight. */
export function renderTouches(touches: LiveTouch[]): string {
  if (touches.length === 0) return ''
  const seen = new Map<string, number[]>()
  for (const t of touches) {
    for (const f of t.files) seen.set(f, [...(seen.get(f) ?? []), t.ticketNumber])
  }
  return touches
    .map((t) => {
      const lines = t.files.slice(0, 8).map((f) => {
        const others = (seen.get(f) ?? []).filter((n) => n !== t.ticketNumber)
        // The whole point of showing this. One marked line beats a paragraph of advice.
        return `      ${f}${others.length ? `   ← also #${others.join(', #')}` : ''}`
      })
      return `  #${t.ticketNumber} ${t.title}\n    touching:\n${lines.join('\n')}`
    })
    .join('\n')
}
