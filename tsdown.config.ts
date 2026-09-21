import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-workbuddy-connect-oo'

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

/**
 * Stable identity of the build inputs.
 *
 * Why a content hash and not a git revision: `lib/` is committed in this repo,
 * so a baked `HEAD` could only ever name the *parent* commit (a commit's hash
 * cannot contain itself) — off by one and therefore misleading. A hash over the
 * inputs changes exactly when the artifact does, is reproducible, and needs no
 * git at build time.
 *
 * `package.json` is part of it because its `version` is baked into the bundle:
 * hashing only `src/` would let a version bump produce a new artifact under the
 * old build id, which is precisely the ambiguity this id exists to remove.
 *
 * Byte-level comparison stays with `scripts/reinstall-local.mjs`; this id exists
 * so `doctor` can report which build the CLI and the *running* host each came
 * from (the host's id rides the heartbeat).
 * @param dir - absolute directory to hash, walked in sorted order.
 * @param extraFiles - additional files mixed in after the directory.
 * @returns the first 10 hex characters of the sha256 over paths and contents.
 */
function buildId(dir: string, extraFiles: readonly string[] = []): string {
  const hash = createHash('sha256')
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        hash.update(relative(dir, full))
        hash.update('\0')
        hash.update(readFileSync(full))
        hash.update('\0')
      }
    }
  }
  walk(dir)
  for (const file of extraFiles) {
    hash.update(basename(file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 10)
}

const BUILD_ID = buildId(
  fileURLToPath(new URL('./src', import.meta.url)),
  [fileURLToPath(new URL('./package.json', import.meta.url))],
)

/** Build-time define map; `src/version.ts` reads both symbols. */
const VERSION_DEFINE = {
  __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  __DSH_WORKBUDDY_BUILD__: JSON.stringify(BUILD_ID),
}

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
