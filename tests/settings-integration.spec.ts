import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('WorkBuddy Host settings integration', () => {
  it('exposes the provider directory entry, the settings section, and the local model catalog', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)

    // Pin the product-config cache to a fixture. The real one lives under
    // ~/.workbuddy/cache and is refreshed by the desktop app, so reading it
    // here would make this test depend on the host machine's state. The
    // fixture exercises every catalog shape the merged adapter handles:
    // old-form reasoning (auto), a declared effort set with canDisableThinking
    // (deepseek-v4-pro-ioa), billing credits + promo badge (glm-5.2-ioa), and
    // a plain text-only row (glm-5.1).
    const configPath = join(root, 'acc-product-config-v3.json')
    await writeFile(configPath, JSON.stringify({
      models: [
        { id: 'auto', name: 'Auto', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsReasoning: true, reasoning: { effort: 'high' }, supportsImages: true },
        {
          id: 'deepseek-v4-pro-ioa',
          name: 'DeepSeek V4 Pro',
          maxInputTokens: 1_000_000,
          maxOutputTokens: 64_000,
          supportsReasoning: true,
          reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high'], canDisableThinking: true },
        },
        {
          id: 'm-five-tier',
          name: 'Five Tier',
          maxInputTokens: 200_000,
          maxOutputTokens: 32_000,
          supportsReasoning: true,
          reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], canDisableThinking: false },
        },
        {
          id: 'glm-5.2-ioa',
          name: 'GLM-5.2',
          maxInputTokens: 1_000_000,
          maxOutputTokens: 48_000,
          supportsImages: true,
          credits: 'x0.79 credits',
          tags: ['craft', 'badge:夜间折扣:#1E90FF'],
        },
        // Text-only: the flag is absent upstream, which resolves to text-only.
        { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200_000, maxOutputTokens: 48_000 },
      ],
      agents: [{ name: 'cli', description: 'cli agent', models: ['auto', 'deepseek-v4-pro-ioa', 'm-five-tier', 'glm-5.2-ioa', 'glm-5.1'] }],
    }), 'utf8')
    vi.stubEnv('ACC_PRODUCT_CONFIG_PATH', configPath)

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-oo')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy-oo',
      displayName: 'WorkBuddy',
      settingsNs: WorkBuddy.WORKBUDDY_SETTINGS_NS,
      settingsPath: [],
      declared: false,
    })

    // The section is what the Models settings page joins on to render a card.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    // The catalog refresh is fire-and-forget after registration: the local
    // cache tier needs no credential, so waiting for a fixture-only id proves
    // the cache tier served the catalog (not the static fallback list).
    const models = await vi.waitFor(async () => {
      const list = await ctx.llm.listModels('workbuddy-oo')
      expect(list.map(model => model.id)).toContain('glm-5.2-ioa')
      return list
    })
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro-ioa')

    // The profile handed to `dsh-llm-pi-ai` must carry `modelErrors`.
    //
    // 0.1.5+ reads `profile.modelErrors.get(model)` inside `modelOf()` on every
    // resolution; without the map it throws `Cannot read properties of
    // undefined (reading 'get')`, which `buildModelCatalog` contains per
    // provider — so the picker shows "WorkBuddy 加载失败：…" and offers none of
    // the models, while this very test keeps passing. It keeps passing because
    // the devDependency here is still `0.1.2-alpha.5`, whose `modelOf()` never
    // reads the field: the requirement lives only in the library the Host
    // actually loads. A structural assertion is therefore the only thing in
    // this repo that can catch a regression.
    const registered = (ctx.llm as unknown as {
      adapters: Map<string, { adapter: { config: { profiles: () => ReadonlyMap<string, { modelErrors?: unknown }> } } }>
    }).adapters.get('workbuddy-oo')
    expect(registered).toBeDefined()
    const profile = registered!.adapter.config.profiles().get('workbuddy-oo')
    expect(profile?.modelErrors).toBeInstanceOf(Map)
    expect((profile!.modelErrors as Map<string, string>).size).toBe(0)

    // The billing rate rides the display name (and the advisory description)
    // so both the /model popup and the composer seat show it; the id and the
    // request path are untouched by this display-only decoration. The raw
    // upstream string "x0.79 credits" is normalized to the bare multiplier.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('glm-5.2-ioa')?.name).toBe('GLM-5.2 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    // The rate lives on the name only: the /model popup renders name AND
    // description, so a description copy would display it twice there.
    // description instead carries the declared promo badges, when present.
    expect(byId.get('glm-5.2-ioa')?.description).toBe('夜间折扣')
    expect(byId.get('glm-5.1')?.description).toBeUndefined()

    // Thinking controls: a declared `supportedEfforts` set offers exactly the
    // declared values — nothing else. `off` is not auto-added for
    // `canDisableThinking` models: pi-ai sends `thinkingLevelMap.off` as the
    // literal `reasoning_effort` on every request that names no level, and the
    // upstream rejects any value outside the model's declared set (HTTP 400
    // code 11150), so an undeclared `off` breaks the default request.
    const proResolved = await ctx.llm.resolveModelInfo('workbuddy-oo', 'deepseek-v4-pro-ioa')
    expect(proResolved.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low'])
    // Old-form rows (`{effort, summary}`, no declared set) keep this fork's
    // calibrated single-tier policy: exactly the default effort is offered.
    // (Upstream v0.2.6 exposes no control at all for these rows — a
    // deliberate divergence recorded in AGENTS.md.)
    const autoResolved = await ctx.llm.resolveModelInfo('workbuddy-oo', 'auto')
    expect(autoResolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['high'])
    // A row with no reasoning metadata exposes no thinking control.
    const plainResolved = await ctx.llm.resolveModelInfo('workbuddy-oo', 'glm-5.1')
    expect(plainResolved.reasoning).toBeUndefined()

    // The opening effort is the second-highest declared tier (or the only tier
    // when one is declared). DSH materializes `defaultEffort` into requests
    // that name no level, so "nothing chosen" always sends a declared value
    // instead of relying on the provider's own unlisted default.
    const fiveTier = await ctx.llm.resolveModelInfo('workbuddy-oo', 'm-five-tier')
    expect(fiveTier.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(fiveTier.reasoning?.defaultEffort).toBe('xhigh')
    // Two declared tiers: the second-highest is the lower one.
    expect(proResolved.reasoning?.defaultEffort).toBe('low')
    // A lone tier is its own default.
    expect(autoResolved.reasoning?.defaultEffort).toBe('high')

    // Image modalities follow the per-model catalog flag (fixture list here):
    // image-capable entries expose `image`, glm-5.1 stays text-only.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('glm-5.1')).toEqual(['text'])

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
  })
})
