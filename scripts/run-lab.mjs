#!/usr/bin/env node
/**
 * Run the lab smoke suites.
 *
 *   node scripts/run-lab.mjs          # hermetic suites only (no network)
 *   node scripts/run-lab.mjs --live   # also run the suites that spawn a real MCP server
 *
 * The hermetic suites each drive the in-repo fake MCP server (lab/fake-mcp-server.mjs) or pure
 * units, so they run anywhere. The two networked suites reach a real server through `npx` and are
 * therefore opt-in: they are slow, and they fail for reasons that have nothing to do with this
 * plugin (a cold npx cache, a registry outage).
 *
 * Exit code is 0 only when every selected suite reported ALL PASS and exited 0.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Hermetic suites: fake MCP server or pure units, no network. */
const OFFLINE = [
  'call-smoke',
  'catalog-smoke',
  'channel-smoke',
  'client-static-smoke',
  'default-smoke',
  'defaults-config-smoke',
  'inherit-smoke',
  'invariant-smoke',
  'lock-smoke',
  'preset-scope-smoke',
  'readiness-wait-smoke',
  'retry-smoke',
  'review-fixes-smoke',
  'store-smoke',
]

/** Suites that spawn a real MCP server through npx. Opt in with --live. */
const NETWORKED = ['connection-smoke', 'state-smoke']

const live = process.argv.includes('--live')
const suites = live ? [...OFFLINE, ...NETWORKED] : [...OFFLINE]

console.log('dsh-mcp-switch — ' + suites.length + ' lab suite(s)' + (live ? ' (--live)' : ''))

const failed = []
for (const name of suites) {
  const file = join(root, 'lab', name + '.mjs')
  const run = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  const passed = run.status === 0 && out.includes('ALL PASS')
  if (!passed) failed.push(name)
  console.log('  ' + (passed ? 'ok   ' : 'FAIL ') + name)
  if (!passed) {
    const tail = out.trim().split('\n').slice(-6).join('\n    ')
    console.log('    ' + tail)
  }
}

console.log('')
if (failed.length > 0) {
  console.log(failed.length + ' suite(s) failed: ' + failed.join(', '))
  process.exit(1)
}
console.log('all ' + suites.length + ' suite(s) passed')
