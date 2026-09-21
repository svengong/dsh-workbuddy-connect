/**
 * Reinstall this repo into a DSH profile after a local change.
 *
 * Why this exists: the profile depends on this package as a local directory
 * (`file:/…/dsh-workbuddy-connect`), and pnpm records that dependency in its
 * lockfile as `resolution: {directory: …, type: directory}` — with no
 * integrity hash. Nothing about the source directory is tracked, so every
 * "refresh" command pnpm offers is a no-op against it:
 *
 *   pnpm add file:…        → "Already up to date", copy not rewritten
 *   pnpm add --force …     → same
 *   pnpm update <name>     → same
 *   pnpm install --force   → same
 *
 * The node_modules entry is a plain copy (files with link count 1), so the only
 * reliable refresh is to drop the dependency and resolve it again. This script
 * does that, restores the `dsh.profile.bundles` order that remove/add shuffles,
 * and verifies the installed copy byte-for-byte.
 *
 * Usage (from the package root):
 *
 *   node scripts/reinstall-local.mjs            # profile "web"
 *   node scripts/reinstall-local.mjs desktop    # another profile
 *
 * After it succeeds, which reload you need depends on what changed, so the
 * script reports that too:
 *   - only lib/client.js → refresh the page (DSH re-serves the bundle)
 *   - anything else      → reload the plugin or restart DSH
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in `<root>/scripts`). */
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The package this script installs, read from the repo itself. */
const { name: PACKAGE, version: VERSION } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

/** DSH home; the profiles live under it. */
const DSH_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/** Profile to reinstall into: argv[2], else `web`. */
const PROFILE = process.argv[2] ?? 'web'

/**
 * The `dsh` binary to drive the profile with.
 *
 * NOT the one on PATH by default: this machine's PATH carries a global
 * `dsh@0.1.1-rc.2`, while the active runtime is `~/.dsh/runtime/current`
 * (0.1.6-alpha.2 here). Driving the profile with the wrong CLI is how you get a
 * manifest written by an older schema, so the runtime's own binary wins.
 * Override with `DSH_BIN=/path/to/dsh` when the layout differs.
 */
const DSH_BIN = process.env['DSH_BIN']
  ?? (existsSync(join(DSH_HOME, 'runtime', 'current', 'node_modules', '.bin', 'dsh'))
    ? join(DSH_HOME, 'runtime', 'current', 'node_modules', '.bin', 'dsh')
    : 'dsh')

const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
const INSTALLED_DIR = join(PROFILE_DIR, 'node_modules', PACKAGE)

/** Print a step heading. */
function step(message) {
  process.stdout.write(`\n▶ ${message}\n`)
}

/** Run a command with inherited stdio; throws on a non-zero exit. */
function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: REPO, ...options })
}

/** Read the profile manifest. */
function readManifest() {
  return JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8'))
}

/** Current `dsh.profile.bundles` order, or `undefined` for profiles without it. */
function bundleOrder() {
  return readManifest().dsh?.profile?.bundles
}

/**
 * Hash every file under one directory, keyed by its path relative to it.
 * Used to compare the repo's build output with the installed copy.
 * @returns a map of relative path to content hash.
 */
function hashTree(dir) {
  const out = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.set(relative(dir, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** Compare two hash maps and return the differing paths. */
function diffTrees(left, right) {
  const paths = new Set([...left.keys(), ...right.keys()])
  return [...paths].filter(path => left.get(path) !== right.get(path)).sort()
}

// --- preconditions ---------------------------------------------------------

if (!existsSync(PROFILE_MANIFEST)) {
  process.stderr.write(`✖ no profile manifest at ${PROFILE_MANIFEST}\n`)
  process.exit(1)
}

const bundlesBefore = bundleOrder()
if (bundlesBefore !== undefined && !bundlesBefore.includes(PACKAGE)) {
  process.stderr.write(`✖ "${PACKAGE}" is not in dsh.profile.bundles for profile "${PROFILE}"\n`)
  process.stderr.write('  reinstall would remove it from the composed tree; refusing.\n')
  process.exit(1)
}

// Capture what is installed right now, so the reload hint can say what changed.
const installedHost = existsSync(join(INSTALLED_DIR, 'lib/index.js'))
  ? createHash('sha256').update(readFileSync(join(INSTALLED_DIR, 'lib/index.js'))).digest('hex')
  : undefined
const installedClient = existsSync(join(INSTALLED_DIR, 'lib/client.js'))
  ? createHash('sha256').update(readFileSync(join(INSTALLED_DIR, 'lib/client.js'))).digest('hex')
  : undefined

// --- build -----------------------------------------------------------------

step(`building ${PACKAGE}@${VERSION}`)
run(join(REPO, 'node_modules', '.bin', 'tsdown'))

// --- reinstall -------------------------------------------------------------

// The remove/add pair is the whole point: see the module docstring.
step(`reinstalling into profile "${PROFILE}" (${PROFILE_DIR})`)
try {
  run(DSH_BIN, ['plugin', '--profile', PROFILE, 'remove', PACKAGE])
} catch {
  // Either it was not installed yet, or the remove itself failed. `add` below is
  // what actually installs, so continue either way.
  process.stdout.write('  (remove did not apply; continuing)\n')
}
try {
  run(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', `file:${REPO}`])
} catch (error) {
  // The dangerous window: the dependency entry is gone and the add did not land,
  // so the plugin is NOT installed right now. Say that loudly with the exact
  // command that fixes it, instead of exiting on a bare stack trace.
  process.stderr.write('\n✖ the add step failed, so the plugin is currently NOT installed in this profile.\n')
  process.stderr.write(`  Restore it with:\n    ${DSH_BIN} plugin --profile ${PROFILE} add file:${REPO}\n`)
  process.stderr.write(`  cause: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

// --- restore the bundle order ---------------------------------------------

const bundlesAfter = bundleOrder()
if (bundlesBefore !== undefined && bundlesAfter !== undefined && bundlesBefore.join() !== bundlesAfter.join()) {
  step('restoring dsh.profile.bundles order (remove/add appends to the end)')
  const manifest = readManifest()
  const next = [...bundlesBefore, ...bundlesAfter.filter(name => !bundlesBefore.includes(name))]
  manifest.dsh.profile.bundles = next
  writeFileSync(PROFILE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`  ${bundlesAfter.join(' → ')}\n  ${next.join(' → ')}\n`)
}

// --- verify ----------------------------------------------------------------

step('verifying the installed copy')
const problems = []
if (!existsSync(INSTALLED_DIR)) {
  problems.push('the installed copy does not exist')
} else {
  const missing = diffTrees(hashTree(join(REPO, 'lib')), hashTree(join(INSTALLED_DIR, 'lib')))
  if (missing.length > 0) problems.push(`lib/ differs in ${missing.length} file(s): ${missing.slice(0, 5).join(', ')}`)
  for (const file of ['package.json', 'cordis.patch.yml']) {
    if (existsSync(join(REPO, file)) && readFileSync(join(REPO, file), 'utf8') !== readFileSync(join(INSTALLED_DIR, file), 'utf8')) {
      problems.push(`${file} differs`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('\n✖ reinstall did not take effect:\n')
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.exit(1)
}

const installedVersion = JSON.parse(readFileSync(join(INSTALLED_DIR, 'package.json'), 'utf8')).version
process.stdout.write(`  ok: ${PACKAGE}@${installedVersion} matches the repo\n`)

// --- what to reload --------------------------------------------------------

const hostChanged = installedHost !== createHash('sha256').update(readFileSync(join(INSTALLED_DIR, 'lib/index.js'))).digest('hex')
const clientChanged = installedClient !== createHash('sha256').update(readFileSync(join(INSTALLED_DIR, 'lib/client.js'))).digest('hex')

step('next step to make it live')
if (hostChanged) {
  process.stdout.write('  Host-side code changed → reload the plugin (Plugins panel toggle) or restart DSH.\n')
} else if (clientChanged) {
  process.stdout.write('  Only the client bundle changed → refresh the page (DSH re-serves it).\n')
} else {
  process.stdout.write('  Build output is byte-identical to what was installed — nothing to reload.\n')
}
