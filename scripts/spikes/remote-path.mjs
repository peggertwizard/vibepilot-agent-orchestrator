#!/usr/bin/env node
/**
 * Is a mounted remote project usable?
 *
 * Plan 27 offers three architectures for working on a project that lives on another machine.
 * Two of them are large — running the agent over SSH means a runner abstraction at every
 * command site, comparable in size to the original process layer. The third costs nothing:
 * mount the remote filesystem and point vibePilot at the path, because everything downstream
 * is ordinary `fs` and `execFile` calls that do not care what is behind the path.
 *
 * The plan's own recommendation is to measure that before building anything, *because it may
 * end the plan*. This is the measurement.
 *
 * Usage:
 *   node scripts/spikes/remote-path.mjs <path-to-a-git-repo>
 *
 * Run it once against a local repo for a baseline, then against the same project over a
 * mount (sshfs, an SMB share, a mapped drive). The ratio between the two is the answer.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (!target || !existsSync(target)) {
  console.error('usage: node scripts/spikes/remote-path.mjs <path-to-a-git-repo>')
  process.exit(1)
}

const ms = (fn) => {
  const t0 = process.hrtime.bigint()
  let error = null
  try {
    fn()
  } catch (e) {
    error = e.message.split('\n')[0]
  }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, error }
}

const git = (args, cwd = target) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

console.log(`\n  target: ${target}`)
console.log(`  ${'─'.repeat(64)}`)

const results = []
const measure = (label, fn) => {
  const r = ms(fn)
  results.push({ label, ...r })
  const time = r.error ? 'FAILED' : `${r.ms.toFixed(0)} ms`
  console.log(`  ${label.padEnd(40)} ${time.padStart(12)}`)
  if (r.error) console.log(`  ${''.padEnd(40)} ${r.error}`)
}

// The operations vibePilot actually performs, in the order it performs them.
measure('stat the folder', () => statSync(target))
measure('list the top level', () => readdirSync(target))
measure('git rev-parse --show-toplevel', () => git(['rev-parse', '--show-toplevel']))
measure('git status --porcelain', () => git(['status', '--porcelain']))
measure('git rev-list --count HEAD', () => git(['rev-list', '--count', 'HEAD']))
measure('git log -50 --oneline', () => git(['log', '-50', '--oneline']))
measure('git diff --name-only HEAD~1', () => git(['diff', '--name-only', 'HEAD~1']))

/*
 * The one that matters most. Every ticket cuts a worktree, and this is where a network mount
 * is at its worst: git has to read the whole object store to populate the working tree.
 *
 * Note what this reveals about the current design — worktrees live under LOCALAPPDATA, not
 * beside the project, so the working tree is local while the object store stays remote. Every
 * subsequent git command in that worktree still crosses the network.
 */
const wt = join(mkdtempSync(join(tmpdir(), 'vp-spike-')), 'wt')
const branch = `vp-spike-${Date.now()}`
measure('git worktree add (a real ticket start)', () => git(['worktree', 'add', '-b', branch, wt]))

if (existsSync(wt)) {
  measure('git status inside the worktree', () => git(['status', '--porcelain'], wt))
  measure('git worktree remove', () => git(['worktree', 'remove', '--force', wt]))
  try {
    git(['branch', '-D', branch])
  } catch {
    /* already gone with the worktree */
  }
  rmSync(join(wt, '..'), { recursive: true, force: true })
}

const total = results.reduce((n, r) => n + r.ms, 0)
console.log(`  ${'─'.repeat(64)}`)
console.log(`  ${'total'.padEnd(40)} ${`${total.toFixed(0)} ms`.padStart(12)}\n`)

console.log('  How to read this:')
console.log('  · Under ~2x the local baseline, option (b) in plan 27 works and the plan is done.')
console.log('  · Around 5x, it is usable for small tickets and painful for large ones.')
console.log('  · Past ~10x, or if worktree add fails outright, the SSH runner is the only')
console.log('    honest answer and plan 27 has to be built properly.\n')
