/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers the `workbuddy` provider; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 * @module dsh-workbuddy-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyRefreshRoute, registerWorkBuddyStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  inspectWorkBuddyAuthDocument,
  isEncryptedFieldWrapper,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WORKBUDDY_CREDENTIAL_UNREADABLE_CODE,
  WORKBUDDY_ENCRYPTED_AT_REST_REASON,
  WorkBuddyCredentialStore,
  WorkBuddyCredentialUnreadableError,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyAuthTokenShape,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  createAtRestUnlocker,
  defaultAppBinaryCandidates,
  deriveKeyId,
  deriveProtectorKey,
  envelopeAad,
  isSealedField,
  openSealedFields,
  resetProtectorKeyCache,
  resolveProtectorKey,
  WORKBUDDY_APP_BINARY_ENV,
  WorkBuddyAtRestError,
  type WorkBuddyAuthUnlocker,
  type WorkBuddySealedField,
} from './at-rest.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy-connect-oo'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace reserved for the configuration card.
 *
 * A bare string since `dsh-settings` 0.1.2-alpha.5 dropped the
 * `settingsNamespace()` brand factory; the namespace stays a nominal
 * `SettingsNamespace` at the type level so provider/directory joins and the
 * settings descriptors keep comparing by identity.
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy-oo' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
})

/**
 * Start the loopback endpoint, register the `workbuddy` provider, and load
 * the model catalog from the desktop app's local product-config cache before
 * registration. A cache miss leaves the catalog empty (no network or static
 * fallback), so the picker never shows a stale model list.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
    logger: ctx.logger,
  })
  const catalog = new WorkBuddyCatalog()
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })

  /**
   * The live adapter registration, kept so a manual refresh can announce the
   * routes again. `AdapterRegistrationHandle.replace()` is the LLM registry's
   * own `llm/adapters-updated` publication point, and that event is what makes
   * the browser's per-Host-generation model catalog re-read itself — the
   * alternative would be a page reload or a DSH restart.
   */
  let adapterHandle: AdapterRegistrationHandle | undefined

  /**
   * Read the desktop app's product-config cache again and publish the result.
   *
   * The catalog is swapped only after a successful read, so a failed refresh
   * leaves the previously served list intact instead of emptying the picker.
   * `replace()` then re-announces the same adapter instance (its `listModels`
   * reads the catalog live), which is enough for every open client to re-read.
   * @returns how many models the picker now serves.
   */
  async function refreshCatalog(): Promise<number> {
    const models = await client.fetchModels()
    catalog.set([...models])
    const handle = adapterHandle
    if (handle === undefined) {
      throw new Error('the WorkBuddy provider is not registered yet; the loopback endpoint is still starting')
    }
    handle.replace([WORKBUDDY_PROVIDER])
    return models.length
  }

  // Same-origin routes backing the browser surfaces; the webServer service is
  // optional (a headless profile serves no browser).
  ctx.inject(['webServer'], (webCtx) => {
    registerWorkBuddyStatusRoute(webCtx, { store, client, models: () => catalog.current() })
    registerWorkBuddyRefreshRoute(webCtx, { refresh: refreshCatalog })
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file path live across edits.
  let current = () => config
  // Resolved through a runtime inject rather than the declared `inject` list:
  // `dsh-settings` 0.1.2-alpha.5 replaced the free `installSettingsSection`
  // helper with the `settings` service's `installSection` method, and the
  // service is optional. A profile that never provides it (a headless one)
  // simply keeps the entry-config fallback instead of blocking plugin load.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        const next = current().authFile
        store.setDesktopPath(next)
      },
    })
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(async () => {
      if (stopped) return

      // The model catalog is sourced from a single tier — the WorkBuddy
      // desktop app's local product-config cache — so the provider's list
      // cannot drift from the app's own picker. A cache miss keeps the catalog
      // empty (no network or static fallback); the provider still registers,
      // it just offers no models until the app refreshes the cache.
      try {
        const models = await client.fetchModels()
        if (!stopped) catalog.set([...models])
      } catch (error: unknown) {
        ctx.logger.error(
          'dsh-workbuddy-connect: model catalog unavailable (local product-config cache read failed); serving no models',
          error,
        )
      }
      if (stopped) return

      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const workbuddy = createWorkBuddyAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })

        let releaseAdapter: AdapterRegistrationHandle | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], workbuddy.adapter)
          adapterHandle = releaseAdapter
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_PROVIDER,
            displayName: 'WorkBuddy',
            settingsNs: WORKBUDDY_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed, and leave the
            // refresh route reporting "not registered" rather than calling into
            // a released handle.
            adapterHandle = undefined
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            adapterHandle = undefined
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          adapterHandle = undefined
          releaseAdapter?.()
          releaseDirectory?.()
        }

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy-connect: provider registration failed', error)
        return
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddy-connect: loopback endpoint failed to start; provider not registered', error)
    })
}
