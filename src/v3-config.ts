/**
 * Local product-config cache reader.
 *
 * The WorkBuddy desktop app and CLI pull their runtime configuration from
 * `https://copilot.tencent.com/v3/config` and mirror the answer to disk at
 * `~/.workbuddy/cache/acc-product-config-v3.json`. That mirrored document is
 * the authoritative product catalog: it is the same source the app renders its
 * own model picker from, and it is the only source that carries the models the
 * `cli` agent exposes (`hy4-preview-ioa`, `echo`, …). The
 * `/console/enterprises/{id}/models` endpoint returns a narrower catalog that
 * omits them.
 *
 * Reading the on-disk mirror keeps catalog discovery entirely local — no
 * network round trip and no credential — and keeps this plugin's catalog from
 * drifting away from the one the desktop app shows.
 *
 * @module dsh-workbuddy-connect/v3-config
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Circular with upstream.ts by design: upstream owns the catalog-row parsing
// helpers (reasoning / billing), v3-config owns the local cache reader, and
// both only call into each other at runtime — never at module-eval time — so
// the ESM live bindings resolve fine in the bundler and in vitest.
import { resolveUpstreamBilling, resolveUpstreamReasoning } from './upstream.ts'
import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** Basename of the cached `/v3/config` product document. */
export const PRODUCT_CONFIG_CACHE_FILENAME = 'acc-product-config-v3.json'

/**
 * Env override for the cached product document's location. The desktop app
 * publishes the same name in the document's `productConfigPathEnv` field, so
 * pointing it at a fixture pins the catalog for tests and for support runs.
 */
export const PRODUCT_CONFIG_PATH_ENV = 'ACC_PRODUCT_CONFIG_PATH'

/** Name of the agent whose model list the CLI — and this plugin — exposes. */
const CLI_AGENT_NAME = 'cli'

/** Cached product document location for the current platform. */
export function defaultProductConfigPath(): string {
  return join(homedir(), '.workbuddy', 'cache', PRODUCT_CONFIG_CACHE_FILENAME)
}

/** Cached product document location: env override first, then the default. */
export function resolveProductConfigPath(): string {
  const fromEnv = process.env[PRODUCT_CONFIG_PATH_ENV]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : defaultProductConfigPath()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** A field that is a finite number greater than zero. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * The context ceiling, preferring the per-variant input limit.
 *
 * `maxInputTokens` is per-variant and authoritative. `contextWindow` is only
 * the vendor family's default and over-reports for constrained variants —
 * `claude-opus-4.8` carries `contextWindow.defaultLength: 1000000` while its
 * real input limit is 200000 — so it is the last resort, never the first.
 */
function contextLength(record: Record<string, unknown>): number | undefined {
  const input = positiveNumber(record['maxInputTokens'])
  if (input !== undefined) return input
  const allowed = positiveNumber(record['maxAllowedSize'])
  if (allowed !== undefined) return allowed
  const window = record['contextWindow']
  if (typeof window === 'number') return positiveNumber(window)
  const wrapped = asRecord(window)
  return wrapped === undefined ? undefined : positiveNumber(wrapped['defaultLength'])
}

/** One `models[]` entry as an upstream model, or undefined when unusable. */
function toModel(raw: unknown): WorkBuddyUpstreamModel | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '' || record['disabled'] === true) return undefined
  const contextWindow = contextLength(record)
  const maxTokens = positiveNumber(record['maxOutputTokens'])
  if (contextWindow === undefined || maxTokens === undefined) return undefined
  const name = typeof record['name'] === 'string' && record['name'] !== '' ? record['name'] : id
  return {
    id,
    name,
    contextWindow,
    maxTokens,
    // The cache rows carry the same `supportsReasoning` / `reasoning` /
    // `credits` / `tags` fields the network catalog serves, so the reasoning
    // and billing metadata is parsed through the very helpers the network
    // path uses — one shape, two sources.
    ...resolveUpstreamReasoning(record),
    ...resolveUpstreamBilling(record),
    // The cache is the desktop app's own mirror of `/v3/config` and carries
    // both fields, so image support is read exactly as the upstream network
    // catalog would declare it. `disabledMultimodal` is a master switch that
    // overrides the per-model flag; a missing `supportsImages` means unknown
    // capability, and over-claiming admits an image the provider then rejects
    // after the message is already durable — so it resolves to text-only.
    supportsImages: record['supportsImages'] === true && record['disabledMultimodal'] !== true,
  }
}

/**
 * The `cli` agent's model ids from an `agents[]` array. The document names the
 * CLI agent both as `name: "cli"` and `description: "cli agent"`, so `name`
 * wins when present and the description is the fallback.
 */
function cliAgentModelIds(agents: unknown): readonly string[] | undefined {
  if (!Array.isArray(agents)) return undefined
  let fallback: readonly string[] | undefined
  for (const raw of agents) {
    const agent = asRecord(raw)
    if (agent === undefined || !Array.isArray(agent['models'])) continue
    const ids = agent['models'].filter((id): id is string => typeof id === 'string')
    if (ids.length === 0) continue
    if (agent['name'] === CLI_AGENT_NAME) return ids
    const description = typeof agent['description'] === 'string' ? agent['description'].trim().toLowerCase() : ''
    if (fallback === undefined && (description === 'cli agent' || description.startsWith('cli agent'))) {
      fallback = ids
    }
  }
  return fallback
}

/**
 * Parse a cached product document into the `cli` agent's model list, keeping
 * the agent's order. Throws a descriptive error when the document is absent,
 * malformed, or lists no cli models, so the caller can fall back to the static
 * catalog with a useful log line.
 */
export function parseProductConfig(text: string): readonly WorkBuddyUpstreamModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error(`workbuddy product config is not valid JSON: ${String(error)}`)
  }
  const document = asRecord(parsed)
  if (document === undefined) throw new Error('workbuddy product config is not a JSON object')

  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const raw of Array.isArray(document['models']) ? document['models'] : []) {
    const model = toModel(raw)
    if (model !== undefined) byId.set(model.id, model)
  }

  const cliIds = cliAgentModelIds(document['agents'])
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('workbuddy product config lists no cli agent models')
  }
  const models: WorkBuddyUpstreamModel[] = []
  for (const id of cliIds) {
    const model = byId.get(id)
    if (model !== undefined) models.push(model)
  }
  if (models.length === 0) {
    throw new Error('workbuddy product config resolved to an empty cli model list')
  }
  return models
}

/**
 * Read the `cli` agent's model list from the cached product document. The
 * document is refreshed by the WorkBuddy desktop app, so a stale or missing
 * file means the app has not run recently; the error says so.
 */
export async function readProductConfigModels(
  path: string = resolveProductConfigPath(),
): Promise<readonly WorkBuddyUpstreamModel[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(
      `workbuddy product config cache unreadable at ${path} (${String(error)});`
      + ' open the WorkBuddy desktop app once so it refreshes',
    )
  }
  return parseProductConfig(text)
}
