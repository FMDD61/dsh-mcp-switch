#!/usr/bin/env node
/**
 * Recompute the dsh plugin compatibility gate for this package — under BOTH matchers.
 *
 * The host skips a whole bundle when any peer named `@deepseek-ai/dsh` or prefixed
 * `@deepseek-ai/dsh-` falls outside its range, evaluated with
 * `semver.satisfies(host, range, { includePrerelease: true })` (see `evaluatePluginCompatibility` in
 * `@deepseek-ai/dsh-app-boot`). npm and pnpm, by contrast, validate peer ranges with a **plain**
 * `semver.satisfies` — no flag. The two disagree on prereleases, and every dsh release so far is a
 * prerelease, so a range can look correct to the host and read as "compatible with nothing" to npm.
 *
 * That disagreement is exactly why the peer ranges here carry a second clause
 * (`|| >=0.2.1-0 <0.3.0-0`): a plain matcher only admits a prerelease version when some comparator
 * shares its `major.minor.patch` tuple, and `>=0.2.1-0` supplies that tuple for the 0.2.1 line.
 *
 * This script asserts both views, in both directions, so neither can regress unnoticed:
 *   - supported hosts pass BOTH matchers;
 *   - the hosts below the supported line, and the whole 0.3.0 prerelease line, fail BOTH.
 *
 * Usage:
 *   node scripts/verify-peer-gate.mjs            # the known host lines
 *   node scripts/verify-peer-gate.mjs 0.2.1-rc.2 # explicit extra hosts (gate view only)
 *
 * Exits 1 when any assertion fails.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** semver comes from the checkout, or from the installed dsh host. */
function loadSemver() {
  const candidates = ['semver', '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/semver']
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // try the next source
    }
  }
  throw new Error('semver not found: install it (npm i -D semver) or run where dsh is installed')
}

const semver = loadSemver()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The gate's own name filter. */
function isGated(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => isGated(name))

/** Peers of one host version that fail the given matcher. */
function blocked(host, includePrerelease) {
  return peers.filter(([, range]) => !semver.satisfies(host, range, { includePrerelease })).length
}

/** Host lines this plugin claims to support. */
const SUPPORTED = ['0.2.0-rc.2', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1']

/** Host lines this plugin must refuse: below the supported floor, and the whole 0.3.0 prerelease line. */
const REFUSED = ['0.1.7-rc.2', '0.3.0-0', '0.3.0-rc.1', '0.3.0']

console.log(manifest.name + '@' + manifest.version + ' — ' + peers.length + ' gated peers')
for (const [name, range] of peers) console.log('    ' + name + '  ' + range)
console.log('')

let failures = 0

console.log('supported hosts — must pass BOTH matchers')
for (const host of SUPPORTED) {
  const g = blocked(host, true)
  const p = blocked(host, false)
  const ok = g === 0 && p === 0
  if (!ok) failures += 1
  console.log(
    '  dsh ' + host.padEnd(14) + (ok ? 'PASS   ' : 'FAIL   ') +
    'gate=' + (g === 0 ? 'pass' : g + ' blocked') + '  plain=' + (p === 0 ? 'pass' : p + ' blocked'),
  )
}

console.log('')
console.log('refused hosts — every peer must be out of range under BOTH matchers')
for (const host of REFUSED) {
  const g = blocked(host, true)
  const p = blocked(host, false)
  const ok = g === peers.length && p === peers.length
  if (!ok) failures += 1
  console.log(
    '  dsh ' + host.padEnd(14) + (ok ? 'REFUSED' : 'ACCEPTED <-- must be refused') +
    '  gate=' + g + '/' + peers.length + '  plain=' + p + '/' + peers.length,
  )
}

for (const host of process.argv.slice(2)) {
  if (semver.valid(host) === null) {
    console.log('  dsh ' + host.padEnd(14) + 'SKIP   (not a semantic version)')
    continue
  }
  const g = blocked(host, true)
  console.log('  dsh ' + host.padEnd(14) + (g === 0 ? 'PASS   ' : 'BLOCKED') + '  (gate view, ad hoc)')
}

console.log('')
process.exit(failures === 0 ? 0 : 1)
