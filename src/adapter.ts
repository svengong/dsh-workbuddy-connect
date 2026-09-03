/**
 * The `workbuddy` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
 * extension points the way `dsh-codex-connect` assembles its Codex route.
 *
 * @module dsh-workbuddy-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyShim } from './shim.ts'
import { normalizeCredits } from './upstream.ts'

/** Provider route this bundle owns. */
export const WORKBUDDY_PROVIDER = 'workbuddy-oo'

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2. They bound requests to models whose catalog
 * entry declares `supportsImages`; text-only models never receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The workbuddy route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
 * separator would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * Append the billing rate to one model's display name.
 *
 * The rate rides the *name* alone because the DSH model surfaces disagree
 * about which field they render: the composer's model seat (`ModelSelect`)
 * renders `model.name` only and never reads `description`, while the `/model`
 * popup renders BOTH — a rate in `description` would show it twice there, so
 * `description` stays untouched.
 *
 * This is display-only and cannot affect routing: the wire request is built
 * from `model.id` (pi-ai's completions API sets `model: model.id`), the
 * selection a picker submits is `{provider, model: id, reasoningEffort}`, and
 * `dsh-llm` validates `name` as a non-empty string without comparing its
 * contents. Nothing in the host resolves a model *by* name.
 */

/**
 * The declared promo badges (`限时免费`, `夜间折扣`) as a display string for the
 * `/model` popup's description slot, which the name does not cover. The
 * labels are the upstream's own spellings and the host seam has no locale
 * service, so non-Chinese UIs see them verbatim — accepted until the picker
 * grows a localized badge slot.
 */
function promoDescription(info: WorkBuddyModelInfo): string | undefined {
  const badges = info.billing?.badges
  return badges === undefined || badges.length === 0 ? undefined : badges.join(' · ')
}
function withRate(name: string, info: WorkBuddyModelInfo): string {
  const rate = normalizeCredits(info.billing?.credits)
  return rate === undefined ? name : `${name}${RATE_SEPARATOR}${rate}`
}

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 内置档位映射：后端 reasoning 元数据未下发 supportedEfforts 的模型，用这份
 * 表补齐（与 WorkBuddy 桌面端内置目录一致，如 deepseek 的 high + max）。
 * 现在后端已对这些模型下发 supportedEfforts，此表转入休眠——仅当后端
 * 回退到不下发档位时才生效，保留作为降级安全网。
 */
const BUILTIN_THINKING_LEVEL_MAP: Record<string, Record<string, string | null>> = {
  'deepseek-v4-flash': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max', max: null },
  'deepseek-v4-pro': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max', max: null },
  'deepseek-v4-flash-ioa': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max', max: null },
  'deepseek-v4-pro-ioa': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max', max: null },
}

/**
 * Resolve one model's reasoning capability into the `reasoning` flag and
 * pi-ai's `thinkingLevelMap` (every level pinned to its wire spelling or
 * `null` for unsupported), mirroring `dsh-llm-pi-ai`'s own
 * `resolveModelReasoning`.
 *
 * 档位优先级（本 fork 的校准结果，与上游 v0.2.6 的 declared-set-only 策略
 * 的差异是有意的）：
 *   1. 后端下发 supportedEfforts（多档）——恰好提供声明的档位；`off` 仅在
 *      canDisableThinking === true 时提供（undeclared 值有 400 风险，
 *      workbuddy2api 同样按声明集门控）
 *   2. 内置档位映射（后端未下发档位时的 deepseek 安全网）
 *   3. 固定 effort 单档（老式 `{effort, summary}` 行，如 auto / glm-5.2 /
 *      kimi 系列）——DSH 校验要求 efforts 非空，无法表达「零档位」，故用
 *      单档表达：只保留默认 effort 一档，其余 null
 *
 * 后端 supports=true 但三者皆无的模型（如 glm-5.0 / glm-4.7 / glm-4.6）在
 * 桌面端前端不显示推理档位，这里同样置为不支持推理。
 */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string): Model<Api> {
  const reasoningCfg = info.reasoning
  const builtin = BUILTIN_THINKING_LEVEL_MAP[info.id]
  const supportsReasoning = reasoningCfg?.supports === true
    && (reasoningCfg.supportedEfforts !== undefined
      || reasoningCfg.defaultEffort !== undefined
      || builtin !== undefined)
  let thinkingLevelMap: Record<string, string | null> | undefined
  const explicit = reasoningCfg?.supportedEfforts
  const fixedEffort = reasoningCfg?.defaultEffort

  if (explicit !== undefined && explicit.length > 0) {
    // 恰好提供声明的档位；`off` 独立于 effort 词表，由 canDisableThinking 决定。
    thinkingLevelMap = {}
    for (const level of THINKING_LEVELS) {
      thinkingLevelMap[level] = (explicit as readonly string[]).includes(level) ? level : null
    }
    if (reasoningCfg?.canDisableThinking === true) thinkingLevelMap.off = 'off'
  } else if (builtin !== undefined) {
    thinkingLevelMap = { ...builtin }
  } else if (fixedEffort !== undefined) {
    thinkingLevelMap = {}
    for (const level of THINKING_LEVELS) {
      thinkingLevelMap[level] = level === fixedEffort ? level : null
    }
  }
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: WORKBUDDY_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: supportsReasoning,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap: thinkingLevelMap as ThinkingLevelMap },
    compat: { supportsReasoningEffort: true },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, store, catalog, resolveAttachments } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl))
  }

  const base = createProvider({
    id: WORKBUDDY_PROVIDER,
    name: 'WorkBuddy',
    auth: {
      apiKey: {
        name: 'WorkBuddy OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: WORKBUDDY_PROVIDER,
    displayName: 'WorkBuddy',
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDY_PROVIDER, profile]])

  const adapter = new WorkBuddyPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDY_PROVIDER, profile]])
    },
  }
}

/**
 * The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
 * from the pi-ai descriptors, which carry no billing fact, so the rate is
 * layered on here by looking the model up in the live catalog. Both overrides
 * delegate to `super` and then rewrite only the display fields, so streaming,
 * capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
 * implements them.
 *
 * A model missing from the catalog (an id the shim would serve but the last
 * upstream refresh did not list) falls through with its name untouched rather
 * than being dropped: catalog membership is advisory, and the seam tolerates
 * serving an unlisted id.
 */
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: WorkBuddyCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): WorkBuddyModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      const promo = promoDescription(info)
      return { ...model, name: withRate(model.name, info), ...promo === undefined ? {} : { description: promo } }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    const promo = promoDescription(info)
    return { ...resolved, name: withRate(resolved.name, info), ...promo === undefined ? {} : { description: promo } }
  }
}
