import { describe, expect, it, vi } from 'vitest'
import { versionUsage } from '@modus-bpm/core'
import { seedDesign } from '@modus-bpm/core/model/seed'
import type { Design } from '@modus-bpm/core/model/types'
import { createDesignStore } from './design'
import { json } from './fakes'

const edit = (d: Design, change: (x: Design) => void): Design => {
  const next = structuredClone(d)
  change(next)
  return next
}
const label = (d: Design) => d.apps[0]!.workflows[0]!.nodes[1]!.data.label

/** A fake Modus server holding one design with a revision. Avery is its administrator, Noah a designer, Maya a clerk. */
function fakeServer() {
  const calls: Array<{ method: string; path: string; user: string | null; body?: { revision?: number; design?: Design } & Record<string, unknown> }> = []
  const s = {
    calls,
    design: seedDesign(),
    revision: 1,
    /** Run just before a save is taken, e.g. to save something else first. */
    beforeSave: undefined as (() => void) | undefined,
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      const user = new Headers(init?.headers).get('x-user-id')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, user, body })
      const may = (role: string) => !!s.design.users.find((u) => u.id === user)?.roles?.includes(role as never)
      if (path === '/api/design' && method === 'GET') return json({ ...s.design, revision: s.revision })
      if (path === '/api/design' && method === 'PUT') {
        const hook = s.beforeSave
        s.beforeSave = undefined
        hook?.()
        if (!may('admin') && !may('designer')) return json({ ok: false, error: 'Only a designer or an administrator can change the design.' }, 403)
        if (body.revision !== s.revision) return json({ ok: false, error: 'Someone else changed the design since you loaded it.', revision: s.revision }, 409)
        s.design = body.design
        s.revision++
        return json({ ok: true, value: { ...s.design, revision: s.revision } })
      }
      if (path.endsWith('/publish')) {
        if (body.revision !== s.revision) return json({ ok: false, error: 'conflict', revision: s.revision }, 409)
        s.revision++
        return json({ ok: true, value: { revision: s.revision, version: 2, ...(body.who === 'all' ? { migration: { moved: 3, skipped: [] } } : {}) } })
      }
      if (path.endsWith('/items')) return json({ clock: 50, items: [{ id: 'o1', number: 'INV-1', status: 'active', workflowId: 'w_invoice', versions: { w_invoice: 1 }, tokens: [{ id: 'o1~1', nodeId: 'n_clerk', workflowId: 'w_invoice', calls: [], forks: [] }], history: [], data: {} }] })
      if (path.endsWith('/migrate')) return may('admin') ? json({ ok: true, value: { moved: 1, skipped: [] } }) : json({ ok: false, error: 'Only an administrator can move items between versions.' }, 403)
      if (path.endsWith('/forecast')) return json({ ok: true, value: { hours: body.hours, version: 2, baseline: {}, scenario: {} } })
      return json({ ok: false, error: 'not found' }, 404)
    }),
  }
  return s
}

const setup = async (actor?: string) => {
  const server = fakeServer()
  const store = createDesignStore({ fetch: server.fetch, storage: null })
  const design = await store.getState().load(actor)
  return { server, store, design: design! }
}

describe('the server’s design, for the designer pages', () => {
  it('loads as an administrator of the design, asking again as them for the drafts', async () => {
    const { server, store, design } = await setup()
    expect(store.getState()).toMatchObject({ status: 'ready', actor: 'u_avery', admin: true, revision: 1 })
    expect(design.apps.map((a) => a.id)).toEqual(seedDesign().apps.map((a) => a.id))
    expect(server.calls.map((c) => [c.path, c.user])).toEqual([
      ['/api/design', 'studio'],
      ['/api/design', 'u_avery'],
    ])
    // A designer who isn't an administrator may design, and not move items in flight.
    expect((await setup('u_noah')).store.getState()).toMatchObject({ actor: 'u_noah', admin: false })
    // Someone who is neither: the design's administrator acts instead.
    expect((await setup('u_maya')).store.getState().actor).toBe('u_avery')
  })

  it('stops with an explanation when the design has nobody who may change it', async () => {
    const server = fakeServer()
    server.design = edit(server.design, (d) => void (d.users = d.users.map((u) => ({ ...u, roles: undefined }))))
    const store = createDesignStore({ fetch: server.fetch, storage: null })
    expect(await store.getState().load()).toBeUndefined()
    expect(store.getState()).toMatchObject({ status: 'error' })
    expect(store.getState().error).toMatch(/no administrator or designer/)
  })

  it('saves the working copy from the revision it was loaded at', async () => {
    const { server, store, design } = await setup()
    const work = edit(design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Mine'))
    const r = await store.getState().save(work)
    expect(r).toMatchObject({ ok: true, revision: 2 })
    expect(label(server.design)).toBe('Mine')
    expect(store.getState()).toMatchObject({ revision: 2, saving: false })
    expect(label(store.getState().base!)).toBe('Mine')
    expect(server.calls.at(-1)).toMatchObject({ method: 'PUT', user: 'u_avery', body: { revision: 1 } })
  })

  it('carries the changes over when someone else saved a different part meanwhile, and saves again', async () => {
    const { server, store, design } = await setup()
    server.beforeSave = () => {
      server.design = edit(server.design, (d) => void (d.users.find((u) => u.id === 'u_maya')!.title = 'Senior Clerk'))
      server.revision++
    }
    const r = await store.getState().save(edit(design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Mine')))
    expect(r).toMatchObject({ ok: true, revision: 3 })
    // Both are in what the server holds, and in what comes back.
    expect(label(server.design)).toBe('Mine')
    expect(server.design.users.find((u) => u.id === 'u_maya')!.title).toBe('Senior Clerk')
    expect(r.ok && r.design.users.find((u) => u.id === 'u_maya')!.title).toBe('Senior Clerk')
    expect(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body!.revision)).toEqual([1, 2])
  })

  it('stores nothing when someone else changed the same part, until told whose to keep', async () => {
    const { server, store, design } = await setup()
    const theirs = () => {
      server.design = edit(server.design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Theirs'))
      server.revision++
    }
    const work = edit(design, (d) => {
      d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Mine'
      d.users.find((u) => u.id === 'u_tom')!.title = 'Mine too'
    })
    server.beforeSave = theirs
    const first = await store.getState().save(work)
    expect(first).toMatchObject({ ok: false, conflicts: [{ kind: 'workflow', name: 'Invoice Approval' }] })
    expect(label(server.design)).toBe('Theirs')
    expect(store.getState().saving).toBe(false)

    // Theirs: their map stays, my other change still goes in.
    const given = await store.getState().save(work, 'theirs')
    expect(given.ok).toBe(true)
    expect(label(server.design)).toBe('Theirs')
    expect(server.design.users.find((u) => u.id === 'u_tom')!.title).toBe('Mine too')

    // Mine: said up front, it replaces theirs.
    const again = await setup()
    again.server.beforeSave = () => {
      again.server.design = edit(again.server.design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Theirs'))
      again.server.revision++
    }
    expect((await again.store.getState().save(work, 'mine')).ok).toBe(true)
    expect(label(again.server.design)).toBe('Mine')
  })

  it('reports a refusal in the server’s words, and an unreachable server plainly', async () => {
    const { server, store, design } = await setup()
    server.design = edit(server.design, (d) => void (d.users.find((u) => u.id === 'u_avery')!.roles = ['auditor']))
    expect(await store.getState().save(edit(design, (d) => void (d.apps[0]!.name = 'x')))).toEqual({ ok: false, error: 'Only a designer or an administrator can change the design.' })
    server.fetch.mockRejectedValueOnce(new TypeError('network'))
    const down = await store.getState().save(edit(design, (d) => void (d.apps[0]!.name = 'y')))
    expect(down).toMatchObject({ ok: false })
    expect(!down.ok && 'error' in down && down.error).toMatch(/couldn’t be reached/)
    expect(store.getState().saving).toBe(false)
  })

  it('takes in a design someone else saved, keeping what is unsaved here', async () => {
    const { server, store, design } = await setup()
    const work = edit(design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Mine'))
    server.design = edit(server.design, (d) => void (d.apps[1]!.name = 'Their fleet'))
    server.revision = 5
    store.getState().heard(5)
    expect(store.getState().behind).toBe(5)
    const caught = await store.getState().catchUp(work)
    expect(caught?.conflicts).toEqual([])
    expect(label(caught!.design)).toBe('Mine')
    expect(caught!.design.apps[1]!.name).toBe('Their fleet')
    expect(store.getState()).toMatchObject({ revision: 5, behind: undefined })
    // Nothing newer: nothing to do.
    expect(await store.getState().catchUp(work)).toBeUndefined()
    // Changed on both sides: left for the save to ask about.
    server.design = edit(server.design, (d) => void (d.apps[0]!.workflows[0]!.nodes[1]!.data.label = 'Theirs'))
    server.revision = 6
    const clash = await store.getState().catchUp(work)
    expect(clash?.conflicts).toHaveLength(1)
    expect(store.getState().revision).toBe(5)
  })

  it('publishes from the current revision and loads the design as published', async () => {
    const { server, store } = await setup()
    const r = await store.getState().publish('app_invoice', 'w_invoice', { who: 'all', note: 'n', stepMap: { a: 'b' } })
    expect(r).toMatchObject({ ok: true, published: { version: 2, migration: { moved: 3 } } })
    expect(server.calls.find((c) => c.path.endsWith('/publish'))).toMatchObject({ path: '/api/apps/app_invoice/workflows/w_invoice/publish', user: 'u_avery', body: { revision: 1, who: 'all', note: 'n', stepMap: { a: 'b' } } })
    expect(store.getState().revision).toBe(2)
    // From a stale revision: told to save again.
    server.revision = 9
    const late = await store.getState().publish('app_invoice', 'w_invoice', { who: 'new' })
    expect(late).toMatchObject({ ok: false })
    expect(!late.ok && late.error).toMatch(/Save again, then publish/)
  })

  it('gives the version panels the items in flight as a state they can count over', async () => {
    const { store, design } = await setup()
    const sim = await store.getState().items('app_invoice', 'w_invoice')
    expect(sim).toMatchObject({ appId: 'app_invoice', clock: 50, activeIds: ['o1'] })
    const ctx = { app: design.apps[0]!, users: design.users, groups: design.groups, services: design.services }
    expect(versionUsage(sim, ctx, 'w_invoice').total).toBe(1)
  })

  it('moves items and asks for a forecast as the acting person', async () => {
    const { server, store } = await setup()
    expect(await store.getState().migrate('app_invoice', 'w_invoice', { toVersion: 2, objectIds: ['o1'] })).toEqual({ ok: true, value: { moved: 1, skipped: [] } })
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/apps/app_invoice/workflows/w_invoice/migrate', body: { toVersion: 2, objectIds: ['o1'] } })
    expect((await store.getState().forecast('app_invoice', 'w_invoice', { who: 'new', hours: 4 })).hours).toBe(4)
    const noah = await setup('u_noah')
    expect(await noah.store.getState().migrate('app_invoice', 'w_invoice', { toVersion: 2 })).toEqual({ ok: false, error: 'Only an administrator can move items between versions.' })
  })
})
