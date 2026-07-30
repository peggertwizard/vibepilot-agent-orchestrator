import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cut a release.
 *
 * Everything here exists because doing it by hand went wrong in a specific way the first time,
 * and each of those ways is silent — the build succeeds, the release appears on GitHub, and the
 * installed app simply never finds it.
 *
 *   1. electron-builder creates GitHub releases as **drafts**. A draft is invisible to an
 *      anonymous fetch, which is exactly what the updater performs, so a drafted release means
 *      no user ever sees the update. It must be flipped live.
 *   2. It runs its publisher once per target, and those two runs can race into **two releases
 *      on the same tag** — one complete, one holding a stray asset. The wrong one being newer
 *      is enough to break the manifest.
 *   3. `latest.yml` is the only file that actually matters. If it does not answer over plain
 *      HTTP to someone with no credentials, nothing else in the release is worth anything.
 *
 * So this builds, publishes, undrafts, removes duplicates, and then verifies the manifest the
 * same way the shipped app will. Run with: npm run release
 */

const REPO = 'peggertwizard/vibepilot-agent-orchestrator'

/** Run and capture. */
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts }).trim()

/** Run and stream. Returns nothing — with inherited stdio there is no output to capture. */
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...opts,
  })

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`

console.log(`release: ${tag}`)

// The token gh already holds. Nothing is stored in the repo and nothing is ever put in the app.
const token = sh('gh', ['auth', 'token'])

console.log('release: building and uploading…')
/*
 * `shell: true` because on Windows `npx` is a .cmd shim, and execFileSync cannot spawn one
 * directly — it fails with ENOENT on a command that plainly exists. No user input reaches this
 * line; the arguments are literals.
 */
/*
 * electron-builder's own entry point, run with this node.
 *
 * Not `npx` (a .cmd shim, which spawnSync cannot exec — ENOENT), and not the .bin shim either
 * (also a .cmd — EINVAL). Both would need `shell: true`, which Node warns about because an
 * argument array under a shell is concatenated without escaping. Calling the JavaScript
 * directly sidesteps the shims and needs no shell at all.
 */
run(process.execPath, ['node_modules/electron-builder/cli.js', '--win', '--publish', 'always'], {
  env: { ...process.env, GH_TOKEN: token },
})

const releases = JSON.parse(sh('gh', ['api', `repos/${REPO}/releases`]))
const mine = releases.filter((r) => r.tag_name === tag)

if (mine.length === 0) {
  console.error(`release: nothing was published for ${tag}`)
  process.exit(1)
}

/*
 * Where the race left two, the real one is the release carrying the most assets — a complete
 * publish is the installer, its blockmap and `latest.yml`. Anything else on the same tag is
 * debris and would only confuse the next release.
 */
const [keep, ...duplicates] = mine.sort((a, b) => b.assets.length - a.assets.length)

for (const dup of duplicates) {
  console.log(`release: removing duplicate release ${dup.id} (${dup.assets.length} assets)`)
  sh('gh', ['api', '-X', 'DELETE', `repos/${REPO}/releases/${dup.id}`])
}

if (keep.draft) {
  console.log('release: publishing (was a draft, which the updater cannot see)')
  sh('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false', '--title', `vibePilot ${version}`])
}

// The real test: fetch the manifest with no credentials, exactly as the installed app does.
const manifest = sh('curl', [
  '-sL',
  `https://github.com/${REPO}/releases/latest/download/latest.yml`,
])

if (!manifest.includes(`version: ${version}`)) {
  console.error(`release: latest.yml does not serve ${version}. What it returned:\n${manifest}`)
  process.exit(1)
}

console.log(`release: ${tag} is live and updatable — installed copies will find it within 6 hours`)
