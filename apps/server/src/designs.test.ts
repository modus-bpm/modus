import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { type Design, type Migration, missingSteps, type PublishPreview, publishedVersion, type SimObject, versionUsage, workspaceState } from '@modus-bpm/core'
import { memoryStorage } from './adapters/memory'
import { buildServer } from './http'
import { Runtime } from './runtime'

// Designing on a server: saving the design, publishing a workflow's draft, moving items between
// versions and trying a draft first. Noah is a designer, Avery an administrator, Maya a clerk.

let rt: Runtime
let api: FastifyInstance

beforeEach(async () => {
  process.env.NODE_ENV = 'test'
  rt = await Runtime.create({ storage: memoryStorage() })
  api = buildServer(rt)
})

afterEach(async () => {
  await api.close()
  await rt.stop()
})

const as = (user: string) => ({ 'x-user-id': user })
const APP = '/api/apps/app_invoice'
const WF = `${APP}/workflows/w_invoice`

type Served = Design & { revision: number }
const design = async (user = 'u_noah') => (await api.inject({ method: 'GET', url: '/api/design', headers: as(user) })).json() as Served
const save = (user: string, revision: number, d: unknown) => api.inject({ method: 'PUT', url: '/api/design', headers: as(user), payload: { revision, design: d } })
const post = (url: string, user: string, payload: object = {}) => api.inject({ method: 'POST', url, headers: as(user), payload })
const invoiceWf = (d: Design) => d.apps.find((a) => a.id === 'app_invoice')!.workflows.find((w) => w.id === 'w_invoice')!
const stored = () => invoiceWf(rt.design)

/** The design with w_invoice's map changed. */
function edit(d: Served, change: (wf: ReturnType<typeof invoiceWf>) => void): Served {
  const next = structuredClone(d)
  change(invoiceWf(next))
  return next
}
const rename = (d: Served, label: string) => edit(d, (wf) => void (wf.nodes.find((n) => n.id === 'n_clerk')!.data.label = label))

/** Save a renamed clerk step as the draft; answers the design as saved. */
async function saveDraft(label = 'Clerk check') {
  const d = await design()
  const res = await save('u_noah', d.revision, rename(d, label))
  expect(res.statusCode).toBe(200)
  return res.json().value as Served
}

/** A small invoice, matched, waiting with an AP clerk. */
async function invoice(invno: string, price = 100) {
  const created = await post(`${APP}/items`, 'u_maya', { workflowId: 'w_invoice', data: { f_invno: invno, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Desks', c_qty: 1, c_price: price }], f_dept: 'l_org_0', f_cc: 'l_org_1' } })
  expect(created.statusCode).toBe(201)
  const polled = (await api.inject({ method: 'POST', url: '/api/jobs/poll', payload: { serviceId: 'svc_erp', workerId: 't', max: 10 } })).json() as { jobs: Array<{ id: string }> }
  for (const j of polled.jobs) await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(j.id)}/complete`, payload: { outputs: { matched: true } } })
  return rt.state('app_invoice').objects[created.json().value.id as string]!
}

describe('the design, as people get it', () => {
  it('comes with its revision, and with drafts only for designers and administrators', async () => {
    expect((await design()).revision).toBe(1)
    const saved = await saveDraft()
    expect(saved.revision).toBe(2)
    const label = (d: Design) => invoiceWf(d).nodes.find((n) => n.id === 'n_clerk')!.data.label
    expect(label(await design('u_noah'))).toBe('Clerk check')
    expect(label(await design('u_avery'))).toBe('Clerk check')
    // A clerk and an auditor get the workflow as it runs.
    expect(label(await design('u_maya'))).toBe('AP clerk review')
    expect(label(await design('u_mei'))).toBe('AP clerk review')
    expect((await design('u_maya')).revision).toBe(2)
    expect((await api.inject({ method: 'GET', url: '/api/design' })).statusCode).toBe(401)
  })
})

describe('saving the design', () => {
  it('takes a workflow’s map as its draft: saved, shared, and running nothing', async () => {
    const before = await invoice('D-1')
    const saved = await saveDraft()
    // The first write gave every workflow its version 1, made from what it ran.
    expect(publishedVersion(stored())).toBe(1)
    expect(stored().versions).toHaveLength(1)
    expect(stored().versions![0]!.snapshot.nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('AP clerk review')
    expect(stored().nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('Clerk check')
    expect(invoiceWf(saved).nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('Clerk check')
    // Work goes on under version 1: the clerk's work item still reads as published.
    const after = await invoice('D-2')
    const basket = (await api.inject({ method: 'GET', url: `${APP}/my/basket`, headers: as(after.tokens[0]!.userId!) })).json() as Array<{ number: string; step: { label: string } }>
    expect(basket.find((b) => b.number === after.number)!.step.label).toBe('AP clerk review')
    expect(rt.state('app_invoice').objects[before.id]!.tokens[0]!.nodeId).toBe('n_clerk')
  })

  it('needs a designer or an administrator, and a document it can store', async () => {
    const d = await design()
    expect((await save('u_maya', d.revision, d)).statusCode).toBe(403)
    expect((await save('u_mei', d.revision, d)).statusCode).toBe(403)
    expect((await api.inject({ method: 'PUT', url: '/api/design', payload: { revision: 1, design: d } })).statusCode).toBe(401)
    expect((await save('u_noah', d.revision, { apps: 'none' })).statusCode).toBe(400)
    const twice = structuredClone(d)
    twice.users.push({ ...twice.users[0]! })
    const dup = await save('u_noah', d.revision, twice)
    expect(dup.statusCode).toBe(400)
    expect(dup.json().error).toMatch(/Two people share the id/)
    const loose = edit(d, (wf) => void (wf.edges[0]!.target = 'n_nowhere'))
    expect((await save('u_noah', d.revision, loose)).json().error).toMatch(/joins a step that isn’t on its map/)
    const typeless = edit(d, (wf) => void (wf.objectTypeId = 't_nope'))
    expect((await save('u_noah', d.revision, typeless)).statusCode).toBe(400)
    expect(rt.designRevision).toBe(1)
    expect((await save('u_avery', d.revision, d)).statusCode).toBe(200)
  })

  it('refuses a save made from an older revision, says which is stored, and changes nothing', async () => {
    const mine = await design()
    await saveDraft('Theirs')
    const late = await save('u_noah', mine.revision, rename(mine, 'Mine'))
    expect(late.statusCode).toBe(409)
    expect(late.json()).toMatchObject({ ok: false, revision: 2 })
    expect(stored().nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('Theirs')
    // Loaded again and saved from there, it goes in.
    const now = await design()
    expect((await save('u_noah', now.revision, rename(now, 'Mine'))).json().value.revision).toBe(3)
  })

  it('keeps versions and connection details the server’s, whatever the document says', async () => {
    const d = await saveDraft()
    const forged = edit(d, (wf) => {
      wf.versions = [{ version: 9, publishedAt: 0, snapshot: { nodes: [], edges: [] } }]
      wf.published = 9
    })
    forged.services[0] = { ...forged.services[0]!, name: 'ERP, renamed', endpoint: 'https://evil.example', secretRef: 'stolen' } as never
    expect((await save('u_noah', d.revision, forged)).statusCode).toBe(200)
    expect(stored().versions!.map((v) => v.version)).toEqual([1])
    expect(publishedVersion(stored())).toBe(1)
    const sample = (await Runtime.create({ storage: memoryStorage() })).design.services[0]!
    expect(rt.design.services[0]).toMatchObject({ name: 'ERP, renamed', endpoint: sample.endpoint, secretRef: sample.secretRef })
    // And they still never go out.
    expect(JSON.stringify(await design())).not.toContain(sample.endpoint)
  })

  it('takes the rest of the design at once: a new person, group, list entry and workflow', async () => {
    const d = await design()
    const next = structuredClone(d)
    next.users.push({ id: 'u_new', name: 'Nia New', title: 'AP Clerk', color: '#333', speed: 1, available: true })
    next.groups.find((g) => g.id === 'g_clerks')!.memberIds.push('u_new')
    const app = next.apps.find((a) => a.id === 'app_invoice')!
    app.workflows.push({ ...structuredClone(invoiceWf(next)), id: 'w_copy', name: 'Invoice Approval (copy)', versions: [{ version: 7, publishedAt: 0, snapshot: { nodes: [], edges: [] } }], published: 7 })
    const res = await save('u_noah', d.revision, next)
    expect(res.statusCode).toBe(200)
    expect(rt.design.users.some((u) => u.id === 'u_new')).toBe(true)
    // A new workflow starts at version 1 from its map, whatever history the document carried.
    const copy = rt.design.apps[0]!.workflows.find((w) => w.id === 'w_copy')!
    expect(copy.versions!.map((v) => v.version)).toEqual([1])
    expect(copy.versions![0]!.snapshot.nodes.length).toBe(copy.nodes.length)
    // Live at once: the new clerk can create an invoice.
    const made = await post(`${APP}/items`, 'u_new', { workflowId: 'w_copy', data: { f_invno: 'NEW-1' } })
    expect(made.statusCode).toBe(201)
  })

  it('refuses a save that would strand work or lock people out', async () => {
    const held = await invoice('S-1')
    const holder = held.tokens[0]!.userId!
    const d = await design('u_avery')
    const refused = async (change: (x: Served) => void, pattern: RegExp, status = 409, user = 'u_avery') => {
      const next = structuredClone(d)
      change(next)
      const res = await save(user, d.revision, next)
      expect(res.json().error).toMatch(pattern)
      expect(res.statusCode).toBe(status)
    }
    await refused((x) => void (x.apps = x.apps.filter((a) => a.id !== 'app_invoice')), /Invoice Processing has items/)
    await refused((x) => void (x.apps[0]!.workflows = x.apps[0]!.workflows.filter((w) => w.id !== 'w_invoice')), /has items, so it can’t be removed/)
    await refused((x) => {
      const a = x.apps[0]!
      const gone = invoiceWf(x).objectTypeId
      a.objectTypes = a.objectTypes.filter((t) => t.id !== gone)
      a.workflows = a.workflows.filter((w) => w.objectTypeId !== gone)
    }, /can’t be removed/)
    await refused((x) => void (x.users = x.users.filter((u) => u.id !== holder)), /holds work/)
    await refused((x) => void (invoiceWf(x).kind = 'subflow'), /can’t change its kind or object type/)
    await refused((x) => void (x.users = x.users.map((u) => ({ ...u, roles: u.roles?.filter((r) => r !== 'admin') }))), /at least one administrator/)
    // Roles are an administrator's to give and take.
    await refused((x) => void (x.users.find((u) => u.id === 'u_noah')!.roles = ['designer', 'admin']), /Only an administrator can change people’s roles/, 403, 'u_noah')
    await refused((x) => void (x.users = x.users.filter((u) => u.id !== 'u_mei')), /Only an administrator can remove someone who has a role/, 403, 'u_noah')
    expect(rt.designRevision).toBe(1)

    // What strands nothing goes in: an application with no items, a person holding nothing, a role from an administrator.
    const next = structuredClone(d)
    next.apps = next.apps.filter((a) => a.id !== 'app_fleet')
    next.users.find((u) => u.id === 'u_noah')!.roles = ['designer', 'auditor']
    expect((await save('u_avery', d.revision, next)).statusCode).toBe(200)
    expect(rt.design.apps.some((a) => a.id === 'app_fleet')).toBe(false)
    expect((await api.inject({ method: 'GET', url: '/api/apps/app_fleet/overview' })).statusCode).toBe(404)
  })
})

describe('publishing a draft', () => {
  it('for new items: they start on the new version, and items in flight finish on theirs', async () => {
    const old = await invoice('P-1')
    const saved = await saveDraft('Clerk check')
    const res = await post(`${WF}/publish`, 'u_noah', { revision: saved.revision, note: 'Renamed the clerk step', who: 'new' })
    expect(res.json()).toEqual({ ok: true, value: { revision: saved.revision + 1, version: 2 } })
    expect(stored().versions!.at(-1)).toMatchObject({ version: 2, note: 'Renamed the clerk step', publishedBy: 'Noah Fitzgerald' })
    expect(publishedVersion(stored())).toBe(2)
    const now = rt.state('app_invoice').objects[old.id]!
    expect(now.versions).toEqual({ w_invoice: 1 })
    const fresh = await invoice('P-2')
    expect(fresh.versions).toEqual({ w_invoice: 2 })
    const step = async (o: SimObject) => ((await api.inject({ method: 'GET', url: `${APP}/my/basket`, headers: as(o.tokens[0]!.userId!) })).json() as Array<{ number: string; step: { label: string } }>).find((b) => b.number === o.number)!.step.label
    expect(await step(fresh)).toBe('Clerk check')
    expect(await step(now)).toBe('AP clerk review')
    // Everyone gets the published map now.
    expect(invoiceWf(await design('u_maya')).nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('Clerk check')
  })

  it('needs changes to publish, the current revision, and the right person', async () => {
    const d = await design()
    const same = await post(`${WF}/publish`, 'u_noah', { revision: d.revision })
    expect(same.statusCode).toBe(409)
    expect(same.json().error).toMatch(/matches version/)
    const saved = await saveDraft()
    expect((await post(`${WF}/publish`, 'u_maya', { revision: saved.revision })).statusCode).toBe(403)
    expect((await post(`${WF}/publish`, 'u_noah', { revision: saved.revision - 1 })).json()).toMatchObject({ ok: false, revision: saved.revision })
    // Moving items in flight is an administrator's lever.
    const all = await post(`${WF}/publish`, 'u_noah', { revision: saved.revision, who: 'all' })
    expect(all.statusCode).toBe(403)
    expect(all.json().error).toMatch(/Only an administrator can move items in flight/)
    expect((await post(`${APP}/workflows/w_nope/publish`, 'u_noah', { revision: saved.revision })).statusCode).toBe(404)
    expect((await api.inject({ method: 'POST', url: `${WF}/publish`, payload: { revision: saved.revision } })).statusCode).toBe(401)
    expect(publishedVersion(stored())).toBe(1)
  })

  it('for items in flight too: they move, and work at a removed step goes where the step map says', async () => {
    const a = await invoice('M-1')
    const b = await invoice('M-2')
    // The draft replaces the clerk step with a new one.
    const d = await design('u_avery')
    const draft = edit(d, (wf) => {
      const clerk = wf.nodes.find((n) => n.id === 'n_clerk')!
      wf.nodes.push({ ...structuredClone(clerk), id: 'n_clerk2', data: { ...structuredClone(clerk.data), label: 'Clerk review, new' } } as typeof clerk)
      wf.nodes = wf.nodes.filter((n) => n.id !== 'n_clerk')
      for (const e of wf.edges) {
        if (e.source === 'n_clerk') e.source = 'n_clerk2'
        if (e.target === 'n_clerk') e.target = 'n_clerk2'
      }
    })
    const saved = (await save('u_avery', d.revision, draft)).json().value as Served

    // What the Studio's panels count, from the items in flight alone: the same as over the whole state.
    const got = (await api.inject({ method: 'GET', url: `${WF}/items`, headers: as('u_noah') })).json() as { clock: number; items: SimObject[] }
    const slice = workspaceState('app_invoice', got.clock, got.items)
    const ctx = rt.ctx('app_invoice')
    expect(versionUsage(slice, ctx, 'w_invoice')).toEqual(versionUsage(rt.state('app_invoice'), ctx, 'w_invoice'))
    const missing = missingSteps(slice, ctx, 'w_invoice', invoiceWf(rt.design).nodes)
    expect(missing).toMatchObject([{ nodeId: 'n_clerk', label: 'AP clerk review', count: 2 }])
    expect(JSON.stringify(got)).not.toContain('M-1')
    expect((await api.inject({ method: 'GET', url: `${WF}/items`, headers: as('u_maya') })).statusCode).toBe(403)
    expect((await api.inject({ method: 'GET', url: `${WF}/items`, headers: as('u_mei') })).statusCode).toBe(200)

    // Without a place for that work, the items stay on their version and the answer says why.
    const res = await post(`${WF}/publish`, 'u_avery', { revision: saved.revision, who: 'all' })
    const first = res.json().value as { version: number; revision: number; migration: Migration }
    expect(first.version).toBe(2)
    expect(first.migration.moved).toBe(0)
    expect(first.migration.skipped.map((s) => s.number).sort()).toEqual([a.number, b.number].sort())
    expect(first.migration.skipped[0]!.reason).toMatch(/isn’t in version 2; choose a step for it/)

    // Moved afterwards, one at a time or all, with the step map. Only an administrator.
    const body = { toVersion: 2, stepMap: { n_clerk: 'n_clerk2' } }
    expect((await post(`${WF}/migrate`, 'u_noah', body)).statusCode).toBe(403)
    const one = (await post(`${WF}/migrate`, 'u_avery', { ...body, objectIds: [a.id] })).json() as { value: Migration }
    expect(one.value).toEqual({ moved: 1, skipped: [] })
    const rest = (await post(`${WF}/migrate`, 'u_avery', body)).json() as { value: Migration }
    expect(rest.value).toEqual({ moved: 1, skipped: [] })
    for (const o of [a, b]) {
      const now = rt.state('app_invoice').objects[o.id]!
      expect(now.versions).toEqual({ w_invoice: 2 })
      expect(now.tokens.map((t) => t.nodeId)).toEqual(['n_clerk2'])
      expect(now.history.some((h) => /Moved to version 2 by Avery/.test(h.text))).toBe(true)
    }
    expect((await post(`${WF}/migrate`, 'u_avery', { toVersion: 9 })).statusCode).toBe(409)
  })

  it('moves the items in flight at publish when nothing they are at was removed', async () => {
    const a = await invoice('A-1')
    const saved = await saveDraft('Clerk check')
    const res = await post(`${WF}/publish`, 'u_avery', { revision: saved.revision, who: 'all' })
    expect(res.json().value).toMatchObject({ version: 2, migration: { moved: 1, skipped: [] } })
    expect(rt.state('app_invoice').objects[a.id]!.versions).toEqual({ w_invoice: 2 })
  })

  it('restores an older version as the draft by saving its map, and publishes it as the next version', async () => {
    const saved = await saveDraft('Clerk check')
    const second = (await post(`${WF}/publish`, 'u_noah', { revision: saved.revision })).json().value as { revision: number }
    // Restore version 1: its snapshot becomes the map, saved as the draft.
    const d = await design()
    const v1 = invoiceWf(d).versions!.find((v) => v.version === 1)!
    const restored = edit(d, (wf) => Object.assign(wf, structuredClone(v1.snapshot)))
    const res = await save('u_noah', second.revision, restored)
    expect(res.statusCode).toBe(200)
    expect(stored().nodes.find((n) => n.id === 'n_clerk')!.data.label).toBe('AP clerk review')
    expect(publishedVersion(stored())).toBe(2)
    const third = await post(`${WF}/publish`, 'u_noah', { revision: res.json().value.revision, note: 'Back to how it was' })
    expect(third.json().value.version).toBe(3)
    expect((await invoice('R-1')).versions).toEqual({ w_invoice: 3 })
  })
})

describe('trying a draft first', () => {
  it('runs a copy of the live state forward with and without the draft, and writes nothing', async () => {
    await invoice('F-1')
    const saved = await saveDraft('Clerk check')
    const before = JSON.stringify(rt.state('app_invoice'))
    const res = await post(`${WF}/forecast`, 'u_noah', { who: 'all', hours: 4 })
    expect(res.statusCode).toBe(200)
    const preview = res.json().value as PublishPreview
    expect(preview).toMatchObject({ hours: 4, version: 2, migration: { moved: 1, skipped: [] } })
    // Simulated people and arrivals moved work on both sides.
    expect(preview.baseline.completed).toBeGreaterThan(0)
    expect(preview.scenario.completed).toBeGreaterThan(0)
    expect(JSON.stringify(rt.state('app_invoice'))).toBe(before)
    expect(rt.designRevision).toBe(saved.revision)
    expect((await post(`${WF}/forecast`, 'u_maya', {})).statusCode).toBe(403)
    expect((await post(`${WF}/forecast`, 'u_noah', { hours: 500 })).statusCode).toBe(400)
    expect((await post(`${APP}/workflows/w_nope/forecast`, 'u_noah', {})).statusCode).toBe(404)
  })
})

describe('the stream', () => {
  it('tells open pages when the design changes', async () => {
    await api.listen({ port: 0, host: '127.0.0.1' })
    const { port } = api.server.address() as { port: number }
    const abort = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}${APP}/stream`, { headers: as('u_maya'), signal: abort.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    const until = async (what: string) => {
      while (!text.includes(what)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`the stream ended before “${what}”`)
        text += value
      }
    }
    await until(': connected')
    await saveDraft()
    await until('event: design\ndata: {"revision":2}')
    abort.abort()
  })
})
