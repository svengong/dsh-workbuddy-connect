/**
 * WorkBuddy model catalog. The runtime catalog starts empty and is populated
 * by the caller from the desktop app's local product-config cache; a static
 * list is kept only for diagnostics and as a public export.
 *
 * @module dsh-workbuddy-connect/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * A static CLI-model list captured from the CN endpoint (re-verified against
 * the live catalog 2026-09-01). It is kept for diagnostics and as a public
 * export only: the runtime catalog no longer initializes from it. The model
 * directory now comes exclusively from the desktop app's local product-config
 * cache, so an unreadable cache yields an empty catalog — never this stale
 * list.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  // Old-form reasoning rows (`{effort, summary}`, no `supportedEfforts`): the
  // upstream does not restrict their effort ladder, and most reject `off`, so
  // they carry a default effort, `canDisableThinking: false`, and no explicit
  // effort set (the adapter offers exactly the default effort as a single tier).
  { id: 'auto', name: 'Auto', contextWindow: 168_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', badges: ['限时免费'], free: true } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79 credits', badges: ['夜间折扣'], free: false } },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79 credits', free: false } },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.71 credits', free: false } },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62 credits', free: false } },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.57 credits', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52 credits', free: false } },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.25 credits', free: false } },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.17 credits', free: false } },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.51 credits', free: false } },
  // New-form reasoning rows (explicit `supportedEfforts` and `canDisableThinking`).
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', badges: ['限时免费'], free: true } },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.05', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.06', free: false } },
]

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = []

  /**
   * Current entries. The catalog starts empty and is populated once the local
   * product-config cache loads; a cache miss keeps it empty rather than
   * serving the static fallback list, so the picker never shows stale models.
   */
  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    this.models = [...models]
  }
}
