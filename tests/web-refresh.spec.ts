import { describe, expect, it, vi } from 'vitest'
import { registerWorkBuddyRefreshRoute } from '../src/web-status.ts'
import { WORKBUDDY_REFRESH_PATH } from '../src/status-paths.ts'

/**
 * The manual model-refresh route is the one plugin endpoint that mutates
 * registry state, so its gates and its two answer shapes are pinned here.
 *
 * The route is exercised through the same `ctx.effect` + `ctx.webServer.register`
 * seam the Host uses, with a fake server capturing the handler: this keeps the
 * test off the network and independent of the real webserver service.
 */

interface Captured {
  path?: string
  handler?: (req: unknown, res: unknown) => Promise<void>
}

/** Minimal Context stand-in: `effect` runs its callback and keeps the disposer. */
function fakeContext(captured: Captured): { ctx: never; dispose: () => void } {
  let disposer: (() => void) | undefined
  const ctx = {
    effect(callback: () => (() => void) | void) {
      const result = callback()
      if (typeof result === 'function') disposer = result
    },
    webServer: {
      register(options: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
        captured.path = options.path
        captured.handler = options.handler
        return () => {}
      },
    },
  }
  return { ctx: ctx as never, dispose: () => disposer?.() }
}

/** Response stand-in recording the status and the JSON body. */
function fakeResponse(): { res: never; status: () => number; body: () => unknown; allow: () => string | undefined } {
  let status = 0
  let payload = ''
  const headers = new Map<string, string>()
  const res = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value) },
    writeHead(next: number) { status = next },
    end(body?: string) { payload = body ?? '' },
  }
  return {
    res: res as never,
    status: () => status,
    body: () => (payload === '' ? undefined : JSON.parse(payload)),
    allow: () => headers.get('allow'),
  }
}

function request(method: string, origin?: string, host?: string): never {
  const headers: Record<string, string> = {}
  if (origin !== undefined) headers.origin = origin
  if (host !== undefined) headers.host = host
  return { method, headers } as never
}

describe('WorkBuddy model-refresh route', () => {
  it('mounts on the plugin-owned refresh path', () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    registerWorkBuddyRefreshRoute(ctx, { refresh: async () => 1 })
    expect(captured.path).toBe(WORKBUDDY_REFRESH_PATH)
    expect(captured.handler).toBeTypeOf('function')
  })

  it('refuses a non-POST with 405 and an Allow header', async () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    const refresh = vi.fn(async () => 3)
    registerWorkBuddyRefreshRoute(ctx, { refresh })

    const res = fakeResponse()
    await captured.handler!(request('GET', 'http://127.0.0.1:1', '127.0.0.1:1'), res.res)

    expect(res.status()).toBe(405)
    expect(res.allow()).toBe('POST')
    // A GET must not be able to drive a refresh (it would be reachable from an
    // <img> tag on any page).
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refuses a non-loopback Host even when the Origin looks local', async () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    const refresh = vi.fn(async () => 3)
    registerWorkBuddyRefreshRoute(ctx, { refresh })

    const res = fakeResponse()
    await captured.handler!(request('POST', 'http://127.0.0.1:1', 'evil.example.com'), res.res)

    expect(res.status()).toBe(403)
    expect(res.body()).toEqual({ error: 'origin-not-trusted' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refuses a cross-site Origin', async () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    registerWorkBuddyRefreshRoute(ctx, { refresh: async () => 3 })

    const res = fakeResponse()
    await captured.handler!(request('POST', 'https://evil.example.com', '127.0.0.1:53815'), res.res)

    expect(res.status()).toBe(403)
  })

  it('reports the model count on a successful loopback refresh', async () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    registerWorkBuddyRefreshRoute(ctx, { refresh: async () => 33 })

    const res = fakeResponse()
    await captured.handler!(request('POST', 'http://127.0.0.1:53815', '127.0.0.1:53815'), res.res)

    expect(res.status()).toBe(200)
    expect(res.body()).toMatchObject({ status: 'ok', models: 33 })
    expect((res.body() as { readAt: number }).readAt).toBeTypeOf('number')
  })

  it('answers a failed read with the reason instead of an HTTP error', async () => {
    const captured: Captured = {}
    const { ctx } = fakeContext(captured)
    registerWorkBuddyRefreshRoute(ctx, {
      refresh: async () => { throw new Error('cache unreadable at /tmp/x; open the WorkBuddy desktop app once') },
    })

    const res = fakeResponse()
    await captured.handler!(request('POST', 'http://127.0.0.1:53815', '127.0.0.1:53815'), res.res)

    // 200 with a status field: the browser half renders the reason, and the
    // previous list stays served (the catalog is only swapped after a good read).
    expect(res.status()).toBe(200)
    expect(res.body()).toMatchObject({ status: 'error' })
    expect(String((res.body() as { message: string }).message)).toContain('cache unreadable')
  })
})
