import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Drive colon, both slashes, and dots — every separator Claude Code flattens to a hyphen.
 *
 * Built with `RegExp` rather than a literal because this file is edited by scripts that mangle
 * backslash escapes, and a silently-wrong character class here would put the lookup in a
 * directory that never exists, which reads as "no conversation" for every session on the
 * machine. Spelled out, it cannot be collapsed by accident.
 */
const SEPARATORS = new RegExp('[:\\\\/.]', 'g')

/**
 * Does this conversation actually exist?
 *
 * Resuming was built on trust: whatever session id was recorded got passed to `--resume`, and
 * if the CLI had never created that conversation the launch died with *"No conversation found
 * with session ID: …"*. The failed run then recorded another id, the next restart resumed that,
 * and the agent was wedged for good — the only cure anyone found was deleting the teammate and
 * adding it back, which worked precisely because it threw the run history away.
 *
 * Trust is unnecessary: the conversations are files. Claude Code keeps them under
 * `~/.claude/projects/<cwd with separators flattened>/<session-id>.jsonl`, verified against a
 * real install — the directory for worktree 5 held exactly one conversation, and the id
 * vibePilot kept trying to resume was not it.
 *
 * So this is asked before every resume. A missing file means a cold start, which always works:
 * the branch, the commits and the brief are all still there to read. Being wrong in the other
 * direction costs a whole agent.
 */
export function conversationExists(cwd: string, sessionId: string): boolean {
  if (!cwd || !sessionId) return false
  try {
    return existsSync(join(conversationDir(cwd), `${sessionId}.jsonl`))
  } catch {
    return false
  }
}

/**
 * Where Claude Code files a directory's conversations.
 *
 * The name is the absolute path with every separator — drive colon, both slashes, and dots —
 * replaced by a hyphen. `C:\Users\you\AppData\Roaming\vibepilot\wt\<project>\5` becomes
 * `C--Users-you-AppData-Roaming-vibepilot-wt-<project>-5`, which is what is on disk.
 */
export function conversationDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(SEPARATORS, '-'))
}
