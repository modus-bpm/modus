import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimObject } from '@modus-bpm/core'
import type { ServerDesign } from './client'
import { fakeStream, json } from './fakes'
import { createWorkStore } from './work'

const design = {
  apps: [{ id: 'app_invoice', name: 'Invoices', workflows: [], objectTypes: [], lists: [] }],
  users: [
    { id: 'u_ann', name: 'Ann', title: '', color: '', speed: 1, available: true },
    { id: 'u_bob', name: 'Bob', title: '', color: '', speed: 1, available: true },
  ],
  groups: [],
  services: [],
  templates: [],
} as unknown as ServerDesign

const item = (id: string, extra: Partial<SimObject> = {}) => ({ id, number: id.toUpperCase(), status: 'active', tokens: [], history: [], data: {}, ...extra }) as unknown as SimObject

/** A fake Modus server holding each person's Workspace; the test changes it and pushes stream events. */
function fakeServer() {
  const calls: Array<{ method: string; path: string; user: string | null; body?: unknown }> = []
  const streams: Array<ReturnType<typeof fakeStream>> = []
  const s = {
    calls,
    streams,
    clock: 100,
    /** What is in each person's Workspace. */
    mine: { u_ann: [item('o1'), item('o2')], u_bob: [item('o9')] } as Record<string, SimObject[]>,
    /** Items anyone may read (found by search, kept when pinned). */
    readable: [item('o50'), item('o51')],
    loads: { u_ann: { open: 2, working: false } },
    older: 0,
    /** Status to answer a path with instead, by prefix. */
    failing: new Map<string, number>(),
    /** What a command answers. */
    answer: { status: 200, body: { ok: true, value: true } as unknown },
    onCommand: undefined as ((path: string, user: string) => void) | undefined,
    hold: undefined as ((path: string) => Promise<void> | undefined) | undefined,
    paths: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)).map((c) => c.path),
    stream: () => streams[streams.length - 1]!,
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      const user = new Headers(init?.headers).get('x-user-id')
      const method = init?.method ?? 'GET'
      calls.push({ method, path, user, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      await s.hold?.(path)
      for (const [prefix, status] of s.failing) if (path.startsWith(prefix)) return json({ ok: false, error: `failing ${status}` }, status)
      const url = new URL(path, 'http://x')
      const here = s.mine[user ?? ''] ?? []
      if (path === '/api/design') return json(design)
      if (url.pathname.endsWith('/stream')) {
        streams.push(fakeStream())
        return s.stream().response()
      }
      if (method === 'POST' && url.pathname.endsWith('/workspace/ask')) return json({ kind: 'results', text: 'Found one.', hits: [{ obj: s.readable[1], score: 1, title: '', where: '', matches: [] }], suggestions: [] })
      if (method === 'POST') {
        s.onCommand?.(url.pathname, user ?? '')
        return json(s.answer.body, s.answer.status)
      }
      if (url.pathname.endsWith('/workspace')) return json({ clock: s.clock, items: here, olderRequests: s.older, loads: s.loads })
      if (url.pathname.endsWith('/workspace/items')) {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
        const pin = new Set((url.searchParams.get('pin') ?? '').split(',').filter(Boolean))
        const found = (id: string) => here.find((o) => o.id === id) ?? (pin.has(id) ? s.readable.find((o) => o.id === id) : undefined)
        const all = [...new Set([...ids, ...pin])]
        return json({ clock: s.clock, items: all.map(found).filter(Boolean), gone: all.filter((id) => !found(id)), loads: s.loads })
      }
      if (url.pathname.endsWith('/workspace/search')) return json({ query: { terms: [], phrases: [], excluded: [], filters: [] }, total: 1, facets: {}, hits: [{ obj: s.readable[0], score: 1, title: '', where: '', matches: [] }] })
      return json({ ok: false, error: 'not found' }, 404)
    }),
  }
  return s
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const ids = (store: ReturnType<typeof createWorkStore>) => Object.keys(store.getState().sim?.objects ?? {})

describe('the live Workspace store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = async (deps: Parameters<typeof createWorkStore>[0] = {}) => {
    const server = fakeServer()
    const store = createWorkStore({ fetch: server.fetch, ...deps })
    await store.getState().open('app_invoice')
    return { server, store }
  }
  const following = async (deps: Parameters<typeof createWorkStore>[0] = {}) => {
    const s = await setup(deps)
    await s.store.getState().follow('u_ann')
    await flush()
    return s
  }

  it('loads the design first, and nothing of anyone’s work until a person is followed', async () => {
    const { server, store } = await setup()
    expect(store.getState()).toMatchObject({ appId: 'app_invoice', design, status: 'connecting', sim: undefined })
    expect(server.calls.map((c) => c.path)).toEqual(['/api/design'])
  })

  it('follows a person: their items as an engine state, then the stream, all as them', async () => {
    const { server, store } = await following()
    const s = store.getState()
    expect(s.status).toBe('live')
    expect(s.userId).toBe('u_ann')
    expect(s.sim).toMatchObject({ appId: 'app_invoice', clock: 100, activeIds: ['o1', 'o2'], arrivals: false })
    expect(ids(store)).toEqual(['o1', 'o2'])
    expect(s.loads).toEqual(server.loads)
    expect(server.paths('/api/apps/app_invoice/stream')).toHaveLength(1)
    expect(server.calls.filter((c) => c.path.startsWith('/api/apps')).every((c) => c.user === 'u_ann')).toBe(true)
  })

  it('does nothing for an application the server doesn’t run', async () => {
    const server = fakeServer()
    const store = createWorkStore({ fetch: server.fetch })
    await store.getState().open('app_local_only')
    expect(store.getState().status).toBe('idle')
    await store.getState().follow('u_ann')
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.calls.map((c) => c.path)).toEqual(['/api/design'])
    expect(store.getState().sim).toBeUndefined()
  })

  it('refetches only the items the stream names, drops those that left, and keeps the rest untouched', async () => {
    const { server, store } = await following({ throttleMs: 1000 })
    const before = store.getState().sim!
    const o1 = before.objects.o1
    server.mine.u_ann = [item('o2', { priority: 'urgent' } as Partial<SimObject>), item('o3')]
    server.clock = 104
    server.stream().change({ clock: 104, items: ['o1', 'o2', 'o3', 'o77'], counts: {}, active: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.paths('/api/apps/app_invoice/workspace/items')).toEqual(['/api/apps/app_invoice/workspace/items?ids=o1%2Co2%2Co3%2Co77'])
    expect(server.paths('/api/apps/app_invoice/workspace').filter((p) => p.endsWith('/workspace'))).toHaveLength(1)
    const now = store.getState().sim!
    expect(ids(store)).toEqual(['o2', 'o3'])
    expect(now.objects.o2!.priority).toBe('urgent')
    expect(now.clock).toBe(104)
    expect(store.getState().lastChange).toBeTypeOf('number')
    // A state already handed out is never changed under its readers.
    expect(now).not.toBe(before)
    expect(Object.keys(before.objects)).toEqual(['o1', 'o2'])
    expect(before.objects.o1).toBe(o1)
  })

  it('coalesces a burst of events into one refetch per throttle', async () => {
    const { server, store } = await following({ throttleMs: 1000 })
    for (let i = 0; i < 20; i++) server.stream().change({ clock: 101, items: [`o${i}`], counts: {}, active: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.paths('/api/apps/app_invoice/workspace/items')).toHaveLength(1)
    server.stream().change({ clock: 102, items: ['o1'], counts: {}, active: 1 })
    await vi.advanceTimersByTimeAsync(400)
    expect(server.paths('/api/apps/app_invoice/workspace/items')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(server.paths('/api/apps/app_invoice/workspace/items')).toHaveLength(2)
    expect(store.getState().status).toBe('live')
  })

  it('reloads everything when the stream says too much changed, or more items changed than one request names', async () => {
    const { server } = await following({ throttleMs: 0, maxIds: 3 })
    const full = () => server.calls.filter((c) => c.path === '/api/apps/app_invoice/workspace').length
    expect(full()).toBe(1)
    server.stream().change({ clock: 101, items: null, counts: {}, active: 1 })
    await flush()
    await flush()
    expect(full()).toBe(2)
    server.stream().change({ clock: 102, items: ['a', 'b', 'c', 'd'], counts: {}, active: 1 })
    await flush()
    await flush()
    expect(full()).toBe(3)
    expect(server.paths('/api/apps/app_invoice/workspace/items')).toEqual([])
  })

  it('moves the clock on quiet ticks without asking the server anything, a step at a time', async () => {
    const { server, store } = await following({ throttleMs: 0 })
    const asked = server.calls.length
    const v = store.getState().version
    server.stream().change({ clock: 100.2, items: [], counts: {}, active: 2 })
    await flush()
    expect(store.getState().sim!.clock).toBe(100)
    expect(store.getState().version).toBe(v)
    server.stream().change({ clock: 100.7, items: [], counts: {}, active: 2 })
    await flush()
    expect(store.getState().sim!.clock).toBe(100.7)
    expect(store.getState().version).toBe(v + 1)
    expect(server.calls.length).toBe(asked)
  })

  it('sends an action as the person and shows what it did before answering', async () => {
    const { server, store } = await following()
    server.onCommand = () => {
      server.mine.u_ann = [item('o2')]
    }
    const r = await store.getState().run({ path: '/work/o1~1/release', body: { outcomeId: 'ok' } })
    expect(r).toEqual({ ok: true, value: true })
    const sent = server.calls.find((c) => c.method === 'POST')!
    expect(sent).toMatchObject({ path: '/api/apps/app_invoice/work/o1~1/release', user: 'u_ann', body: { outcomeId: 'ok' } })
    // Already showing, with no timer run.
    expect(ids(store)).toEqual(['o2'])
  })

  it('hands back a refusal as the engine’s answer, and throws only when the server can’t be asked', async () => {
    const { server, store } = await following()
    server.answer = { status: 409, body: { ok: false, error: 'Someone else took it.' } }
    expect(await store.getState().run({ path: '/work/o1~1/claim' })).toEqual({ ok: false, error: 'Someone else took it.' })
    server.answer = { status: 403, body: { ok: false, error: 'You can’t create items in that workflow.' } }
    expect(await store.getState().run({ path: '/items' })).toEqual({ ok: false, error: 'You can’t create items in that workflow.' })
    server.answer = { status: 201, body: { ok: true, value: { id: 'o3', number: 'INV-3' } } }
    expect(await store.getState().run({ path: '/items' })).toEqual({ ok: true, value: { id: 'o3', number: 'INV-3' } })
    server.answer = { status: 503, body: { ok: false, error: 'Storage is unavailable' } }
    await expect(store.getState().run({ path: '/work/o1~1/claim' })).rejects.toThrow('Storage is unavailable')
  })

  it('answers that the work hasn’t loaded rather than acting before it has', async () => {
    const { server, store } = await setup()
    expect(await store.getState().run({ path: '/my/next' })).toMatchObject({ ok: false })
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('keeps the items a search found so they can be opened, across reloads, until they can’t be read', async () => {
    const { server, store } = await following({ throttleMs: 0 })
    const r = await store.getState().search('acme', { sort: 'newest', limit: 20 })
    expect(r.total).toBe(1)
    expect(server.paths('/api/apps/app_invoice/workspace/search')).toEqual(['/api/apps/app_invoice/workspace/search?q=acme&limit=20&sort=newest'])
    expect(ids(store)).toEqual(['o1', 'o2', 'o50'])
    // The same search again redraws nothing.
    const v = store.getState().version
    await store.getState().search('acme', { limit: 20 })
    expect(store.getState().version).toBe(v)

    // Ask Modus keeps what it found too.
    expect((await store.getState().ask('what is late?')).text).toBe('Found one.')
    expect(ids(store)).toEqual(['o1', 'o2', 'o50', 'o51'])

    // A full reload asks for them again by name.
    server.stream().change({ clock: 101, items: null, counts: {}, active: 1 })
    await flush()
    await flush()
    expect(server.paths('/api/apps/app_invoice/workspace/items').at(-1)).toBe('/api/apps/app_invoice/workspace/items?pin=o50%2Co51')
    expect(ids(store)).toEqual(['o1', 'o2', 'o50', 'o51'])

    // No longer readable: gone on the next change that names it.
    server.readable = [server.readable[1]!]
    server.stream().change({ clock: 102, items: ['o50'], counts: {}, active: 1 })
    await flush()
    await flush()
    expect(ids(store)).toEqual(['o1', 'o2', 'o51'])
  })

  it('holds an item across the action that takes it out of the Workspace', async () => {
    const { server, store } = await following()
    server.readable.push(item('o1', { status: 'completed' } as Partial<SimObject>))
    server.onCommand = () => {
      server.mine.u_ann = [item('o2')]
    }
    store.getState().hold(['o1', 'o_unknown'])
    await store.getState().run({ path: '/work/o1~1/release', body: { outcomeId: 'ok' } })
    expect(ids(store)).toEqual(['o2', 'o1'])
    expect(store.getState().sim!.objects.o1!.status).toBe('completed')
    expect(store.getState().sim!.activeIds).toEqual(['o2'])
  })

  it('forgets the oldest held items past the limit', async () => {
    const { server, store } = await following({ maxPinned: 1, throttleMs: 0 })
    await store.getState().search('a', { limit: 5 })
    await store.getState().ask('b')
    await flush()
    await flush()
    expect(ids(store)).toEqual(['o1', 'o2', 'o51'])
    expect(server.paths('/api/apps/app_invoice/workspace/items').at(-1)).toContain('ids=o50')
  })

  it('switching person starts over as them', async () => {
    const { server, store } = await following()
    const first = server.stream()
    await store.getState().follow('u_bob')
    await flush()
    expect(first.cancelled()).toBe(true)
    expect(store.getState().userId).toBe('u_bob')
    expect(ids(store)).toEqual(['o9'])
    expect(server.calls.at(-1)).toMatchObject({ path: '/api/apps/app_invoice/stream', user: 'u_bob' })
  })

  it('fetches nothing while the tab is hidden, and everything once when it is shown again', async () => {
    let hidden = false
    let shown = () => {}
    const { server } = await following({ throttleMs: 0, visibility: { hidden: () => hidden, subscribe: (cb) => (shown = cb) } })
    const asked = server.calls.length
    hidden = true
    server.stream().change({ clock: 101, items: ['o1'], counts: {}, active: 1 })
    server.stream().change({ clock: 102, items: ['o2'], counts: {}, active: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.calls.length).toBe(asked)
    hidden = false
    shown()
    await flush()
    await flush()
    expect(server.calls.slice(asked).map((c) => c.path)).toEqual(['/api/apps/app_invoice/workspace'])
  })

  it('says reconnecting when a refetch fails, tries again, and is live once one works', async () => {
    const { server, store } = await following({ throttleMs: 0, retryMs: 3000 })
    server.failing.set('/api/apps/app_invoice/workspace', 500)
    server.stream().change({ clock: 101, items: ['o1'], counts: {}, active: 1 })
    await flush()
    await flush()
    expect(store.getState().status).toBe('reconnecting')
    expect(ids(store)).toEqual(['o1', 'o2'])
    server.failing.clear()
    server.mine.u_ann = [item('o2')]
    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(store.getState()).toMatchObject({ status: 'live', error: undefined })
    expect(ids(store)).toEqual(['o2'])
  })

  it('stops with an explanation when the server doesn’t accept the person', async () => {
    const server = fakeServer()
    const store = createWorkStore({ fetch: server.fetch })
    await store.getState().open('app_invoice')
    server.failing.set('/api/apps/app_invoice/workspace', 401)
    await store.getState().follow('u_ann')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toMatch(/didn’t accept you/)
    expect(server.paths('/api/apps/app_invoice/workspace')).toHaveLength(1)
  })

  it('retries the design until the server answers', async () => {
    const server = fakeServer()
    server.failing.set('/api/design', 503)
    const store = createWorkStore({ fetch: server.fetch, retryMs: 3000 })
    await store.getState().open('app_invoice')
    expect(store.getState().status).toBe('reconnecting')
    server.failing.clear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getState().design).toEqual(design)
    expect(store.getState().status).toBe('connecting')
  })

  it('close stops the stream and forgets the work', async () => {
    const { server, store } = await following()
    store.getState().close()
    expect(server.stream().cancelled()).toBe(true)
    expect(store.getState()).toMatchObject({ status: 'idle', sim: undefined, appId: undefined })
    const asked = server.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.calls.length).toBe(asked)
  })
})
