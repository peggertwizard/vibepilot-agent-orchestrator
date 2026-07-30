import { describe, expect, it } from 'vitest'
import { buildClaudeArgv } from '../src/main/providers/claude/argv'
import type { LaunchSpec } from '../src/main/providers/types'
import {
  EFFORT_LADDER_LENGTH,
  EFFORT_OPTIONS,
  effortDefaultFor,
  effortNoteFor,
  isValidEffort,
  prettyModel,
  supportsEffort,
} from '../src/shared/types'

/**
 * How hard an agent thinks.
 *
 * The CLI has taken `--effort low|medium|high|xhigh|max` all along and vibePilot passed none
 * of it — a case-insensitive grep for `effort` across the whole of `src/` returned nothing.
 * These tests exist so that stays fixed.
 */

function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    runId: 'r1',
    provider: 'claude',
    agentId: 'a1',
    projectId: 'p1',
    ticketId: null,
    parentAgentId: null,
    cwd: process.cwd(),
    addDirs: [],
    model: 'sonnet',
    appendSystemPrompt: '',
    permissionMode: 'bypassPermissions',
    mcp: null,
    sessionId: '11111111-1111-1111-1111-111111111111',
    ...over,
  }
}

describe('effort reaches the CLI', () => {
  it('passes --effort as a flag, so it lands in the recorded argv', () => {
    const args = buildClaudeArgv(spec({ effort: 'high' }))
    const i = args.indexOf('--effort')
    expect(i, 'the flag should be present').toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('high')
  })

  it('passes nothing when no level is set, so the CLI keeps its own default', () => {
    expect(buildClaudeArgv(spec()).includes('--effort')).toBe(false)
    expect(buildClaudeArgv(spec({ effort: null })).includes('--effort')).toBe(false)
  })

  /**
   * `--effort ultracode` only aliases to xhigh. The part that matters — a standing instruction
   * to orchestrate sub-agents — lives in a session setting, and `--settings` composes with the
   * `--setting-sources project` vibePilot already passes.
   */
  it('sends ultracode as a session setting, not as an effort level', () => {
    const args = buildClaudeArgv(spec({ effort: 'ultracode' }))
    expect(args.includes('--effort')).toBe(false)
    const i = args.indexOf('--settings')
    expect(i).toBeGreaterThan(-1)
    expect(JSON.parse(args[i + 1]!)).toEqual({ ultracode: true })
  })

  it('still composes with the settings-source flag', () => {
    const args = buildClaudeArgv(spec({ effort: 'ultracode', trustProjectSettings: true }))
    const i = args.indexOf('--setting-sources')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('project')
  })
})

/**
 * The trust gate on a project's own `.claude/settings.json`.
 *
 * Those settings can define SessionStart hooks that shell out, and every spawn path uses
 * `bypassPermissions`, so loading them for any folder on disk turned `git clone` into code
 * execution. Verified against CLI 2.1.220: with `--setting-sources project` a hook in a
 * brand-new directory fired at spawn with no prompt; with an empty list it did not.
 *
 * Note what is NOT safe: omitting the flag entirely falls back to loading user, project and
 * local together — strictly worse than what we started with. The empty list is the safe value,
 * which is why this asserts on it rather than on absence.
 */
describe('a project folder is not trusted by default', () => {
  it('loads no settings at all unless the folder has been trusted', () => {
    const args = buildClaudeArgv(spec())

    expect(args, 'the flag must still be present').toContain('--setting-sources=')
    expect(args.indexOf('--setting-sources'), 'never the two-token form').toBe(-1)
    expect(args, 'the project must not be a source').not.toContain('project')
  })

  it('loads the project settings once you have said the folder is trusted', () => {
    const args = buildClaudeArgv(spec({ trustProjectSettings: true }))
    const i = args.indexOf('--setting-sources')

    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('project')
    expect(args).not.toContain('--setting-sources=')
  })

  it('treats an explicit false the same as saying nothing', () => {
    expect(buildClaudeArgv(spec({ trustProjectSettings: false }))).toContain('--setting-sources=')
  })

  /**
   * The order is the CLI's own, read out of the shipped binary: `["low","medium","high","xhigh",
   * "max"]`. Max is the top of the ladder. Ultracode is not on the ladder at all — the binary
   * calls it "xhigh effort plus standing dynamic-workflow orchestration" — so it comes after,
   * past a divider, rather than being slotted in above xhigh as though it outranked max.
   */
  it('offers the levels in the order the CLI defines, with ultracode after them', () => {
    expect(EFFORT_OPTIONS.map((o) => o.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ])
    expect(EFFORT_OPTIONS.slice(0, EFFORT_LADDER_LENGTH).map((o) => o.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(EFFORT_OPTIONS[EFFORT_LADDER_LENGTH]!.id, 'ultracode sits past the divider').toBe(
      'ultracode',
    )
    for (const o of EFFORT_OPTIONS) expect(isValidEffort(o.id)).toBe(true)
    expect(isValidEffort('banana')).toBe(false)
  })
})

describe('role defaults', () => {
  it('starts a Scout low and a Reviewer high', () => {
    // A Scout does breadth search, where thinking is not the bottleneck. A Reviewer has the
    // one job where missing something IS the failure.
    expect(effortDefaultFor('scout')).toBe('low')
    expect(effortDefaultFor('reviewer')).toBe('high')
    expect(effortDefaultFor('builder')).toBe('medium')
    expect(effortDefaultFor('pilot')).toBe('medium')
  })
})

/**
 * Which models take an effort setting at all.
 *
 * Read out of the shipped CLI, not assumed. The binary gates effort on an explicit list of models
 * that accept **no** level — not merely the top ones. Haiku 4.5 is on it, which is why the picker
 * greys out for Haiku rather than warning about only the top three.
 *
 * The old list here was wrong both ways: it barred `opus-4-5` and `opus-4-6`, which the CLI does
 * not bar, and it let `sonnet-4-5` through, which the CLI does bar.
 */
describe('levels a model will actually honour', () => {
  it('knows Haiku takes no level at all', () => {
    expect(supportsEffort('haiku'), 'the alias resolves to claude-haiku-4-5 today').toBe(false)
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
    expect(supportsEffort('claude-haiku-4-5-20251001')).toBe(false)

    // Every level, not just the expensive end — that was the bug.
    for (const o of EFFORT_OPTIONS) {
      expect(effortNoteFor('haiku', o.id), `haiku at ${o.id}`).toMatch(/no thinking levels/i)
    }
  })

  it('matches the CLI list rather than the one we guessed', () => {
    // On the CLI's list.
    expect(supportsEffort('claude-sonnet-4-5')).toBe(false)
    expect(supportsEffort('claude-opus-4-0')).toBe(false)
    expect(supportsEffort('claude-3-5-sonnet')).toBe(false)
    // Not on it, though the old hardcoded list barred them.
    expect(supportsEffort('claude-opus-4-5')).toBe(true)
    expect(supportsEffort('claude-opus-4-6')).toBe(true)
    expect(supportsEffort('claude-opus-5')).toBe(true)
  })

  it('says nothing where there is nothing to say', () => {
    expect(effortNoteFor('opus', 'xhigh')).toBeNull()
    expect(effortNoteFor('claude-opus-5', 'max')).toBeNull()
    expect(effortNoteFor('sonnet', 'medium')).toBeNull()
  })

  it('warns about what ultracode actually costs, on a model that can run it', () => {
    const note = effortNoteFor('opus', 'ultracode')
    expect(note).toMatch(/sub-agents/i)
    expect(note, 'the cost is the point of the warning').toMatch(/multiply/i)
  })
})

/**
 * An alias echoed back is not a resolved version.
 *
 * Codex never reports a model, so the adapter stored the alias it was handed and telemetry wrote
 * it to `resolved_model` anyway — making the chip claim a confirmed version it never had.
 */
describe('showing the exact model', () => {
  it('shows the version once the CLI reports one', () => {
    expect(prettyModel('claude-opus-5[1m]')).toBe('Opus 5 · 1M')
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('does not dress an alias up as a resolved version', () => {
    expect(prettyModel('codex', 'codex')).toBe('Codex')
    expect(prettyModel('opus', 'opus')).toBe('Opus')
    expect(prettyModel(null, 'sonnet')).toBe('Sonnet')
  })
})
