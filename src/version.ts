/**
 * Package version and build identity reported by status and doctor output.
 *
 * Both are injected at build time by tsdown's `define` (see tsdown.config.ts).
 * The version comes from package.json so a release bumps one place; the build
 * id is a hash of `src/`, so it changes exactly when the code does. The
 * `typeof === 'string'` guards keep the bundle harmless if a build forgets to
 * define them (each falls back to a clearly-dev marker).
 *
 * The build id exists because the version alone cannot answer "which build is
 * installed": the profile pins this package as a local directory, whose
 * dependency entry carries no integrity hash, so two different builds both
 * report version `0.4.2`. `doctor` prints the CLI's own build and, from the
 * heartbeat, the running host's — which is how you tell whether the host is
 * already running what you just built.
 */
declare const __DSH_WORKBUDDY_VERSION__: string
declare const __DSH_WORKBUDDY_BUILD__: string

export const WORKBUDDY_CONNECT_VERSION: string =
  typeof __DSH_WORKBUDDY_VERSION__ === 'string' ? __DSH_WORKBUDDY_VERSION__ : '0.0.0-dev'

/** Identity of the sources this bundle was built from (see the module header). */
export const WORKBUDDY_CONNECT_BUILD: string =
  typeof __DSH_WORKBUDDY_BUILD__ === 'string' ? __DSH_WORKBUDDY_BUILD__ : 'unknown'
