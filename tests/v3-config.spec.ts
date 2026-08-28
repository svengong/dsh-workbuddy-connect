import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseProductConfig,
  PRODUCT_CONFIG_PATH_ENV,
  readProductConfigModels,
  resolveProductConfigPath,
} from '../src/v3-config.ts'

/**
 * Offline unit tests for the local `/v3/config` product-config cache reader.
 * The catalog is now resolved from disk instead of an upstream endpoint, so
 * the parsing rules that decide which models appear — cli agent selection,
 * the context-length precedence, and the unusable-entry filters — are covered
 * here without a network call or a WorkBuddy account.
 */

/** A minimal cached product document with the given models under `cli`. */
function document(options: {
  models?: unknown[]
  agents?: unknown[]
}): string {
  return JSON.stringify({
    models: options.models ?? [],
    agents: options.agents ?? [{ name: 'cli', description: 'cli agent', models: ['a'] }],
  })
}

/** One `models[]` entry; `overrides` replaces fields wholesale. */
function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, maxInputTokens: 200_000, maxOutputTokens: 32_000, ...overrides }
}

afterEach(() => {
  delete process.env[PRODUCT_CONFIG_PATH_ENV]
})

describe('parseProductConfig', () => {
  it('keeps only the cli agent models, in the agent order', () => {
    const text = document({
      models: [entry('a'), entry('b'), entry('missing-from-agent')],
      agents: [
        { name: 'compact', models: [] },
        { name: 'cli', models: ['b', 'a'] },
      ],
    })

    expect(parseProductConfig(text).map(model => model.id)).toEqual(['b', 'a'])
  })

  it('falls back to the "cli agent" description when no agent is named cli', () => {
    const text = document({
      models: [entry('a')],
      agents: [{ description: 'cli agent', models: ['a'] }],
    })

    expect(parseProductConfig(text).map(model => model.id)).toEqual(['a'])
  })

  it('prefers maxInputTokens over contextWindow.defaultLength', () => {
    // claude-opus-4.8 carries defaultLength 1M while its real input limit is
    // 200K; reporting the family default would over-state the window 5x.
    const text = document({
      models: [entry('a', {
        contextWindow: { defaultLength: 1_000_000, supportedLengths: [200_000, 1_000_000] },
        maxInputTokens: 200_000,
      })],
    })

    expect(parseProductConfig(text)[0]?.contextWindow).toBe(200_000)
  })

  it('falls back to maxAllowedSize and then contextWindow.defaultLength', () => {
    const viaAllowed = parseProductConfig(document({
      models: [entry('a', { maxInputTokens: undefined, maxAllowedSize: 512_000 })],
    }))
    const viaWindow = parseProductConfig(document({
      models: [entry('a', { maxInputTokens: undefined, contextWindow: { defaultLength: 256_000 } })],
    }))

    expect(viaAllowed[0]?.contextWindow).toBe(512_000)
    expect(viaWindow[0]?.contextWindow).toBe(256_000)
  })

  it('carries the reasoning block through untouched', () => {
    const reasoning = { defaultEffort: 'high', supportedEfforts: ['low', 'high'] }
    const text = document({ models: [entry('a', { reasoning, supportsReasoning: true })] })

    const model = parseProductConfig(text)[0]
    expect(model?.supportsReasoning).toBe(true)
    expect(model?.reasoning).toEqual(reasoning)
  })

  it('drops disabled models and models without a usable token budget', () => {
    const text = document({
      models: [
        entry('a'),
        entry('disabled', { disabled: true }),
        entry('no-output', { maxOutputTokens: undefined }),
        entry('no-id', { id: undefined }),
      ],
      agents: [{ name: 'cli', models: ['a', 'disabled', 'no-output', 'no-id'] }],
    })

    expect(parseProductConfig(text).map(model => model.id)).toEqual(['a'])
  })

  it('throws a descriptive error for malformed or cli-less documents', () => {
    expect(() => parseProductConfig('not json')).toThrow(/not valid JSON/)
    expect(() => parseProductConfig('[1,2]')).toThrow(/not a JSON object/)
    expect(() => parseProductConfig(document({ agents: [{ name: 'compact', models: [] }] })))
      .toThrow(/no cli agent models/)
    expect(() => parseProductConfig(document({ models: [], agents: [{ name: 'cli', models: ['a'] }] })))
      .toThrow(/empty cli model list/)
  })
})

describe('resolveProductConfigPath', () => {
  it('honours the env override and ignores a blank one', () => {
    const fallback = resolveProductConfigPath()
    process.env[PRODUCT_CONFIG_PATH_ENV] = '/tmp/fixture-v3.json'
    expect(resolveProductConfigPath()).toBe('/tmp/fixture-v3.json')
    process.env[PRODUCT_CONFIG_PATH_ENV] = '   '
    expect(resolveProductConfigPath()).toBe(fallback)
  })
})

describe('readProductConfigModels', () => {
  it('reads and parses the file at the given path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'v3-config-')), 'acc-product-config-v3.json')
    writeFileSync(path, document({ models: [entry('a')] }))

    await expect(readProductConfigModels(path)).resolves.toEqual([
      { id: 'a', name: 'a', contextWindow: 200_000, maxTokens: 32_000, supportsReasoning: false },
    ])
  })

  it('reports a missing cache with its location so the log names the app', async () => {
    await expect(readProductConfigModels('/nonexistent/acc-product-config-v3.json'))
      .rejects.toThrow(/unreadable at \/nonexistent\/acc-product-config-v3\.json/)
  })
})
