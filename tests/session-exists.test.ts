import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conversationDir, conversationExists } from '../src/main/providers/claude/session'

/**
 * Resuming used to be an act of faith.
 *
 * Whatever session id was recorded got passed to `--resume`, and if the CLI had never created
 * that conversation the launch died with "No conversation found with session ID: …". The failed
 * run then recorded another id, the next restart resumed that one, and the agent was wedged for
 * good. The only cure anyone found was deleting the teammate and adding it back — which worked
 * because it threw the run history away, not because anything had been repaired.
 *
 * None of that trust is necessary. The conversations are files on disk.
 */
describe('knowing whether a conversation exists before resuming it', () => {
  it('builds the path Claude Code actually uses', () => {
    // Verified against a real install: every separator — drive colon, slashes, dots — becomes a
    // hyphen, and this exact directory is on disk for vibePilot's worktree 5.
    const wt = ['C:', 'Users', 'you', 'AppData', 'Roaming', 'vibepilot', 'wt', 'abc123', '5']
    expect(conversationDir(wt.join('\\'))).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        'C--Users-you-AppData-Roaming-vibepilot-wt-abc123-5',
      ),
    )
  })

  it('finds a conversation that is there, and does not invent one that is not', () => {
    const cwd = ['C:', 'vp-test', 'session-check'].join('\\')
    mkdirSync(conversationDir(cwd), { recursive: true })
    writeFileSync(join(conversationDir(cwd), 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), '{}\n')

    expect(conversationExists(cwd, 'aaaaaaaa-1111-2222-3333-444444444444')).toBe(true)
    // The exact shape of the bug: an id that nothing ever created.
    expect(conversationExists(cwd, 'bbbbbbbb-5555-6666-7777-888888888888')).toBe(false)
  })

  /**
   * Every uncertain answer is `false`.
   *
   * A cold start always works — the branch, the commits and the brief are all still there to
   * read. A resume of something that is not there costs the whole agent.
   */
  it('says no rather than guessing', () => {
    expect(conversationExists('', 'anything')).toBe(false)
    expect(conversationExists(['C:', 'nowhere'].join('\\'), '')).toBe(false)
    expect(conversationExists(['C:', 'does', 'not', 'exist'].join('\\'), 'aaaa-bbbb')).toBe(false)
  })
})
