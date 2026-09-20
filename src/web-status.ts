/**
 * Same-origin status route for the WorkBuddy plugin card: sign-in state,
 * token expiry, and remaining credit, fetched by the browser half. The route
 * answers loopback browser requests only and never carries token material.
 *
 * @module dsh-workbuddy-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { WORKBUDDY_REFRESH_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebRefreshResult, WorkBuddyWebStatus } from './status-paths.ts'

export { WORKBUDDY_REFRESH_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyWebRefreshResult, WorkBuddyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
  /** Resolve the current model catalog for free/badge display. */
  models: () => readonly WorkBuddyModelInfo[]
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Loopback Host required, and a missing Host counts as untrusted.
 *
 * The status route tolerates an absent Origin because it only reads. The
 * refresh route mutates registry state, so it adopts the stricter gate: a
 * request that reached this server under a non-loopback name (a tunnel, a
 * LAN address, a rebound DNS entry) must not be able to re-drive the model
 * catalog even though the connection itself is local.
 */
function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return false
  try {
    const { hostname } = new URL(`http://${host}`)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
): Promise<WorkBuddyWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') {
    // A diagnosable reason (e.g. the desktop app sealed the credential at
    // rest) rides the document so the card explains the state instead of
    // insisting the user is simply signed out.
    return authStatus.reason === undefined
      ? { status: 'signed-out' }
      : { status: 'signed-out', reason: authStatus.reason }
  }
  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
  }
  // Model billing facts ride the signed-in document so the card can show which
  // models are free or on a promo, without touching the Models picker. The
  // rate is normalized here (not in the card) so both halves agree on one
  // display form; the card additionally localizes it.
  const models = deps.models()
  const modelsField: readonly WorkBuddyWebModelBadge[] = models
    .filter(model => model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0)
    .map(model => {
      const rate = normalizeCredits(model.billing?.credits)
      return {
        id: model.id,
        name: model.name,
        ...model.billing?.free === true ? { free: true as const } : {},
        ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
        ...rate === undefined ? {} : { credits: rate },
      }
    })
  const statusWithModels: WorkBuddyWebStatus = modelsField.length > 0
    ? { ...status, models: modelsField }
    : status
  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      return { ...statusWithModels, credits }
    }
  } catch (error: unknown) {
    return { ...statusWithModels, creditsError: safeMessage(error) }
  }
  return statusWithModels
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!loopbackOrigin(req)) {
          json(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          json(res, 200, await workBuddyWebStatus(deps))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web status route')
}

/** Constructor dependencies of the manual model-refresh route. */
export interface WorkBuddyRefreshRouteOptions {
  /**
   * Re-read the local product-config cache, swap the served catalog, and
   * republish the provider's routes so DSH re-reads its model catalog.
   * @returns how many models the picker now serves.
   */
  refresh: () => Promise<number>
}

/**
 * Mount the POST model-refresh route on an optional webServer context.
 *
 * The catalog the picker renders is cached per Host generation by the client
 * (`ui-model-selection`), and the Host half answers `session.modelCatalog()`
 * from the live LLM registry. So refreshing takes two steps that this route
 * performs together on the Host: re-read the cache into the plugin's catalog,
 * then announce the provider's routes again (`AdapterRegistrationHandle.replace`
 * is the registry's own `llm/adapters-updated` publication point). The client
 * hears that event and re-reads the catalog — no page reload, no DSH restart.
 */
export function registerWorkBuddyRefreshRoute(ctx: Context, deps: WorkBuddyRefreshRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          // 405 with an Allow header: this route exists only to be POSTed to,
          // and a GET that quietly refreshed would be reachable from an <img>.
          res.setHeader('Allow', 'POST')
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!loopbackOrigin(req) || !loopbackHost(req)) {
          json(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          const models = await deps.refresh()
          const result: WorkBuddyWebRefreshResult = { status: 'ok', models, readAt: Date.now() }
          json(res, 200, result)
        } catch (error: unknown) {
          // A failed read keeps the previously served list (the catalog is only
          // swapped after a successful read), so the answer reports the reason
          // without pretending the picker is now empty.
          const result: WorkBuddyWebRefreshResult = { status: 'error', message: safeMessage(error) }
          json(res, 200, result)
        }
      },
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-connect: Web model-refresh route')
}
