#!/usr/bin/env node
/**
 * Fails the build if vibePilot ever takes a dependency on the Claude Agent SDK.
 *
 * Anthropic does not permit subscription OAuth tokens (Free/Pro/Max) to be used with the
 * Agent SDK or any third-party tool — that path requires API-key billing.
 * See https://code.claude.com/docs/en/legal-and-compliance
 *
 * vibePilot instead spawns the user's own `claude` binary, which authenticates itself.
 * We never read, store, forward or transmit a token.
 *
 * This is easy to violate by accident — someone reaches for the SDK's nicer type
 * definitions and the whole legal posture changes silently. Hence a hard gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const BANNED = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-code',
  '@anthropic-ai/sdk',
]

const problems = []

// 1. package.json
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (BANNED.includes(name)) problems.push(`package.json ${field} declares "${name}"`)
  }
}

// 2. imports anywhere in src/
const SRC = 'src'
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (EXT.has(extname(p))) {
      const text = readFileSync(p, 'utf8')
      for (const banned of BANNED) {
        // Only flag real module specifiers, so this file and docs can name the package.
        const re = new RegExp(`(from|require\\()\\s*['"\`]${banned.replace(/[/@-]/g, '\\$&')}`)
        if (re.test(text)) problems.push(`${p} imports "${banned}"`)
      }
    }
  }
}
try {
  walk(SRC)
} catch {
  /* src not present yet */
}

if (problems.length) {
  console.error('\n  COMPLIANCE CHECK FAILED\n')
  for (const p of problems) console.error('   ✗ ' + p)
  console.error(
    '\n  vibePilot must spawn the user\'s own `claude` binary, not embed the Agent SDK.\n' +
      '  Subscription OAuth tokens may not be used with the SDK.\n' +
      '  See docs/architecture/auth.md\n',
  )
  process.exit(1)
}

console.log('compliance: no Agent SDK dependency or import found')
