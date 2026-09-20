import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { WORKBUDDY_REFRESH_PATH } from '../src/status-paths.ts'

/**
 * The manual model refresh end to end on the Host: a real cordis tree with the
 * real LLM registry, the plugin's real route, and a rewritten cache file.
 *
 * This is the test that proves the mechanism the button depends on — that
 * swapping the catalog and calling `AdapterRegistrationHandle.replace()`
 * actually republishes the routes (DSH's `llm/adapters-updated`) and that the
 * registry then answers with the NEW list. The browser half only has to POST,
 * because the client's model catalog re-reads itself on that event.
 */

interface CapturedRoute {
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** Minimal webserver stand-in: record routes, dispose by deletion. */
function fakeWebServer(routes: Map<string, CapturedRoute['handler']>) {
  return {
    register(options: { kind: string; path: string; handler: CapturedRoute['handler'] }) {
      routes.set(options.path, options.handler)
      return () => routes.delete(options.path)
    },
  }
}

/** Response stand-in recording status and JSON body. */
function fakeResponse(): { res: never; status: () => number; body: () => unknown } {
  let status = 0
  let payload = ''
  const res = {
    setHeader() {},
    writeHead(next: number) { status = next },
    end(body?: string) { payload = body ?? '' },
  }
  return {
    res: res as never,
    status: () => status,
    body: () => (payload === '' ? undefined : JSON.parse(payload)),
  }
}

/** One product-config document exposing the named models to the `cli` agent. */
function productConfig(ids: readonly string[]): string {
  return JSON.stringify({
    models: ids.map(id => ({
      id,
      name: id.toUpperCase(),
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
    })),
    agents: [{ name: 'cli', description: 'cli agent', models: [...ids] }],
  })
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

describe('WorkBuddy manual model refresh (Host)', () => {
  it('re-reads the cache, republishes the routes, and serves the new list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-refresh-'))
    vi.stubEnv('DSH_HOME', root)
    const configPath = join(root, 'acc-product-config-v3.json')
    await writeFile(configPath, productConfig(['alpha', 'beta']), 'utf8')
    vi.stubEnv('ACC_PRODUCT_CONFIG_PATH', configPath)

    const routes = new Map<string, CapturedRoute['handler']>()
    const ctx = new Context()
    context = ctx
    // The route is mounted through `ctx.inject(['webServer'], …)`, so the
    // service must exist before the plugin applies.
    ctx.provide('webServer', fakeWebServer(routes) as never)
    await ctx.plugin(LlmRuntime)

    // Every adapter (re)publication the registry announces, counted so a
    // `replace()` that silently did nothing cannot pass this test.
    const announcements: string[] = []
    ctx.on('llm/adapters-updated', () => { announcements.push('announced') })

    await ctx.plugin(WorkBuddy, {})
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-oo')
    })
    // The route is mounted by the same apply, independently of registration.
    expect(routes.has(WORKBUDDY_REFRESH_PATH)).toBe(true)

    // The opening catalog comes from the cache tier (no credential involved).
    await vi.waitFor(async () => {
      const list = await ctx.llm.listModels('workbuddy-oo')
      expect(list.map(model => model.id)).toEqual(['alpha', 'beta'])
    })

    // The desktop app rewrites its cache out from under the running Host.
    await writeFile(configPath, productConfig(['alpha', 'gamma', 'delta']), 'utf8')
    const before = announcements.length

    const res = fakeResponse()
    await routes.get(WORKBUDDY_REFRESH_PATH)!(
      { method: 'POST', headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } } as never,
      res.res,
    )

    expect(res.status()).toBe(200)
    expect(res.body()).toMatchObject({ status: 'ok', models: 3 })

    // The republish is what makes every open client re-read the catalog.
    expect(announcements.length).toBeGreaterThan(before)

    // …and the registry now answers with the NEW list.
    const after = await ctx.llm.listModels('workbuddy-oo')
    expect(after.map(model => model.id)).toEqual(['alpha', 'gamma', 'delta'])
  })

  it('keeps serving the previous list when the cache read fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-refresh-fail-'))
    vi.stubEnv('DSH_HOME', root)
    const configPath = join(root, 'acc-product-config-v3.json')
    await writeFile(configPath, productConfig(['alpha', 'beta']), 'utf8')
    vi.stubEnv('ACC_PRODUCT_CONFIG_PATH', configPath)

    const routes = new Map<string, CapturedRoute['handler']>()
    const ctx = new Context()
    context = ctx
    ctx.provide('webServer', fakeWebServer(routes) as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WorkBuddy, {})
    await vi.waitFor(async () => {
      const list = await ctx.llm.listModels('workbuddy-oo')
      expect(list.map(model => model.id)).toEqual(['alpha', 'beta'])
    })

    // The app's cache disappears (uninstalled, rotated, permissions).
    await rm(configPath, { force: true })

    const res = fakeResponse()
    await routes.get(WORKBUDDY_REFRESH_PATH)!(
      { method: 'POST', headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } } as never,
      res.res,
    )

    expect(res.status()).toBe(200)
    expect(res.body()).toMatchObject({ status: 'error' })
    // A failed read must not empty the picker: the old list stays served.
    const after = await ctx.llm.listModels('workbuddy-oo')
    expect(after.map(model => model.id)).toEqual(['alpha', 'beta'])
  })
})
