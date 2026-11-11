import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { type AssistantReply, basketOf, type Ctx, distributionFor, queuesFor, requestsBy, type SearchResult, type SimObject, supervisionFor, workspaceState } from '@modus-bpm/core'
import { memoryStorage } from './adapters/memory'
import { buildServer } from './http'
import { Runtime } from './runtime'

// What the Studio's Workspace needs from a server: each person's share of the state as they may see
// it, kept current item by item, and the actions the pages offer that had no route before.

let rt: Runtime
let api: FastifyInstance

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  rt = await Runtime.create({ storage: memoryStorage() })
  api = buildServer(rt)
})

afterAll(async () => {
  await api.close()
  await rt.stop()
})

const as = (user: string) => ({ 'x-user-id': user })
const APP = '/api/apps/app_invoice'
const SECRET = 'ACCT-SECRET-4410'

interface Slice {
  clock: number
  items: SimObject[]
  olderRequests: number
  loads: Record<string, { open: number; working: boolean }>
}

const get = async <T>(url: string, user: string) => (await api.inject({ method: 'GET', url, headers: as(user) })).json() as T
const post = (url: string, user: string, payload?: unknown) => api.inject({ method: 'POST', url, headers: as(user), payload: payload as object })
const slice = (user: string) => get<Slice>(`${APP}/workspace`, user)
const ctx = (): Ctx => rt.ctx('app_invoice')

/** The read models the Workspace pages use, over a person's slice. */
async function workspaceOf(user: string) {
  const s = await slice(user)
  const sim = workspaceState('app_invoice', s.clock, s.items)
  return { s, sim, basket: basketOf(sim, ctx(), user), queues: queuesFor(sim, ctx(), user), distribution: distributionFor(sim, ctx(), user), requests: requestsBy(sim, ctx(), user), supervision: supervisionFor(sim, ctx(), user) }
}

/** An invoice created by `creator`, matched by the ERP worker; `price` decides where it goes next. */
async function invoice(invno: string, creator: string, price: number, extra: Record<string, unknown> = {}) {
  const created = await post(`${APP}/items`, creator, {
    workflowId: 'w_invoice',
    data: { f_invno: invno, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Desks', c_qty: 1, c_price: price }], f_dept: 'l_org_0', f_cc: 'l_org_1', ...extra },
  })
  expect(created.statusCode).toBe(201)
  const polled = (await api.inject({ method: 'POST', url: '/api/jobs/poll', payload: { serviceId: 'svc_erp', workerId: 'erp-test', max: 10 } })).json() as { jobs: Array<{ id: string }> }
  for (const j of polled.jobs) await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(j.id)}/complete`, payload: { outputs: { matched: true } } })
  const id = created.json().value.id as string
  return rt.state('app_invoice').objects[id]!
}

describe('a person’s Workspace', () => {
  it('holds their basket, their requests and what they supervise, and nothing else', async () => {
    // Rosa (AP Exceptions) may enter bank details; the clerk who gets the invoice may not see them.
    const obj = await invoice('WS-1', 'u_rosa', 100, { f_bank: SECRET })
    const clerk = obj.tokens.find((t) => t.nodeId === 'n_clerk')!.userId!

    const theirs = await workspaceOf(clerk)
    expect(theirs.basket.map((i) => i.obj.number)).toContain(obj.number)
    expect(theirs.s.loads[clerk]!.open).toBeGreaterThan(0)
    const seen = theirs.s.items.find((o) => o.id === obj.id)!
    expect(seen.data).not.toHaveProperty('f_bank')
    expect(JSON.stringify(theirs.s)).not.toContain(SECRET)
    expect(seen.data.f_invno).toBe('WS-1')

    const rosa = await workspaceOf('u_rosa')
    expect(rosa.requests.map((r) => r.obj.number)).toContain(obj.number)
    expect(rosa.s.items.find((o) => o.id === obj.id)!.data.f_bank).toBe(SECRET)

    // Carla supervises the clerks: it is on her Supervise page, and not in her basket.
    const carla = await workspaceOf('u_carla')
    expect(carla.supervision.steps.find((s) => s.nodeId === 'n_clerk')!.items.map((i) => i.obj.number)).toContain(obj.number)
    expect(carla.basket.map((i) => i.obj.id)).not.toContain(obj.id)

    // Workloads: a clerk sees the clerks', Carla also the approvers' she hands out to, a stranger no one's.
    expect(Object.keys(theirs.s.loads)).not.toContain('u_marcus')
    expect(Object.keys(theirs.s.loads)).not.toContain('u_carmen')
    expect(Object.keys(carla.s.loads)).toEqual(expect.arrayContaining([clerk, 'u_marcus']))
    expect((await slice('nobody-we-know')).loads).toEqual({})

    // A patrol officer has nothing to do with invoices.
    expect((await slice('u_carmen')).items).toEqual([])
    expect((await slice('nobody-we-know')).items).toEqual([])
  })

  it('needs a named caller and a known application', async () => {
    expect((await api.inject({ method: 'GET', url: `${APP}/workspace` })).statusCode).toBe(401)
    expect((await api.inject({ method: 'GET', url: `${APP}/workspace/items?ids=x` })).statusCode).toBe(401)
    expect((await api.inject({ method: 'GET', url: '/api/apps/app_nope/workspace', headers: as('u_maya') })).statusCode).toBe(404)
  })

  it('follows changes item by item, and keeps an item opened from a search while it may be read', async () => {
    const obj = await invoice('WS-2', 'u_rosa', 100)
    const clerk = obj.tokens.find((t) => t.nodeId === 'n_clerk')!.userId!
    const items = (user: string, q: string) => get<{ items: SimObject[]; gone: string[]; clock: number; loads: object }>(`${APP}/workspace/items?${q}`, user)

    const mine = await items(clerk, `ids=${obj.id},o_nope`)
    expect(mine.items.map((o) => o.id)).toEqual([obj.id])
    expect(mine.gone).toEqual(['o_nope'])
    expect(typeof mine.clock).toBe('number')
    expect(mine.loads).toHaveProperty(clerk)

    // Mei (an auditor) may read everything, and nothing reaches her Workspace by itself.
    expect(await items('u_mei', `ids=${obj.id}`)).toMatchObject({ items: [], gone: [obj.id] })
    const pinned = await items('u_mei', `pin=${obj.id}`)
    expect(pinned.items.map((o) => o.id)).toEqual([obj.id])
    // A patrol officer may not read it, opened from a search or not.
    expect(await items('u_carmen', `ids=${obj.id}&pin=${obj.id}`)).toMatchObject({ items: [], gone: [obj.id] })

    // Released by the clerk, it has left their Workspace (it stays in Rosa's: she asked for it).
    const tok = obj.tokens.find((t) => t.nodeId === 'n_clerk')!
    expect((await post(`${APP}/work/${encodeURIComponent(tok.id)}/release`, clerk, { outcomeId: 'o_k_ok' })).statusCode).toBe(200)
    expect(await items(clerk, `ids=${obj.id}`)).toMatchObject({ items: [], gone: [obj.id] })
    expect((await items('u_rosa', `ids=${obj.id}`)).items.map((o) => o.id)).toEqual([obj.id])

    expect((await api.inject({ method: 'GET', url: `${APP}/workspace/items?ids=${'x,'.repeat(501)}`, headers: as(clerk) })).statusCode).toBe(400)
  })

  it('searches every item the caller may read, with each hit as they may see it', async () => {
    const obj = await invoice('WS-FIND-3', 'u_rosa', 100, { f_bank: SECRET })
    const clerk = obj.tokens.find((t) => t.nodeId === 'n_clerk')!.userId!
    const found = await get<SearchResult>(`${APP}/workspace/search?q=WS-FIND-3`, clerk)
    expect(found.total).toBe(1)
    expect(found.hits[0]!.obj.id).toBe(obj.id)
    expect(found.hits[0]!.where).toMatch(/AP clerk|basket|approval/i)
    expect(found.query.terms).toEqual(['ws-find-3'])
    expect(found.facets.status.active).toBe(1)
    expect(JSON.stringify(found)).not.toContain(SECRET)
    // The same answer as the plain search route, which carries no items.
    expect((await get<{ total: number }>(`${APP}/search?q=WS-FIND-3`, clerk)).total).toBe(1)
    expect((await get<SearchResult>(`${APP}/workspace/search?q=WS-FIND-3`, 'u_carmen')).total).toBe(0)
    expect((await get<SearchResult>(`${APP}/workspace/search?q=${encodeURIComponent(SECRET)}`, clerk)).total).toBe(0)
  })

  it('answers Ask Modus over the server’s work, with the items found', async () => {
    const obj = await invoice('WS-ASK-4', 'u_rosa', 100)
    const reply = (await post(`${APP}/workspace/ask`, 'u_rosa', { question: 'find WS-ASK-4' })).json() as AssistantReply
    expect(reply.text.length).toBeGreaterThan(0)
    expect(reply.suggestions.length).toBeGreaterThan(0)
    expect(reply.hits?.map((h) => h.obj.id)).toContain(obj.id)
    // An empty question lists what to ask.
    expect(((await post(`${APP}/workspace/ask`, 'u_rosa', { question: '' })).json() as AssistantReply).suggestions.length).toBeGreaterThan(0)
    expect((await post(`${APP}/workspace/ask`, 'u_rosa', {})).statusCode).toBe(400)
  })
})

describe('actions the Workspace offers', () => {
  it('lets the requester or the person working an item change its priority', async () => {
    const obj = await invoice('WS-PRI-5', 'u_rosa', 100)
    const clerk = obj.tokens.find((t) => t.nodeId === 'n_clerk')!.userId!
    const url = `${APP}/items/${obj.id}/priority`
    expect((await post(url, 'u_rosa', { priority: 'high' })).json()).toEqual({ ok: true, value: true })
    expect(rt.state('app_invoice').objects[obj.id]!.priority).toBe('high')
    expect((await post(url, clerk, { priority: 'urgent' })).statusCode).toBe(200)
    // By its number too.
    expect((await post(`${APP}/items/${obj.number}/priority`, clerk, { priority: 'normal' })).statusCode).toBe(200)
    // Already there, or someone who can read it but neither asked for it nor works it: the engine refuses.
    expect((await post(url, clerk, { priority: 'normal' })).statusCode).toBe(409)
    const auditor = await post(url, 'u_mei', { priority: 'low' })
    expect(auditor.statusCode).toBe(409)
    expect(auditor.json().error).toMatch(/requester or the person working it/)
    // Someone who can't see it at all, a bad priority, nobody.
    expect((await post(url, 'u_carmen', { priority: 'low' })).statusCode).toBe(404)
    expect((await post(url, 'u_rosa', { priority: 'whenever' })).statusCode).toBe(400)
    expect((await api.inject({ method: 'POST', url, payload: { priority: 'low' } })).statusCode).toBe(401)
    expect(rt.state('app_invoice').objects[obj.id]!.priority).toBe('normal')
  })

  it('lets supervisors change the priority of work they supervise', async () => {
    const obj = await invoice('WS-PRI-6', 'u_rosa', 100)
    const clerk = obj.tokens.find((t) => t.nodeId === 'n_clerk')!.userId!
    const url = `${APP}/supervise/items/${obj.id}/priority`
    const peer = ['u_maya', 'u_jordan', 'u_aisha'].find((u) => u !== clerk)!
    expect((await post(url, peer, { priority: 'urgent' })).statusCode).toBe(403)
    expect((await post(url, 'u_carla', { priority: 'urgent' })).json()).toEqual({ ok: true, value: true })
    expect(rt.state('app_invoice').objects[obj.id]!.priority).toBe('urgent')
    expect(rt.state('app_invoice').objects[obj.id]!.history.at(-1)!.text).toMatch(/Priority changed from normal to urgent by Carla/)
    expect((await post(url, 'u_carla', { priority: 'urgent' })).statusCode).toBe(409)
    expect((await post(`${APP}/supervise/items/o_nope/priority`, 'u_carla', { priority: 'low' })).statusCode).toBe(404)
    expect((await post(url, 'u_carla', {})).statusCode).toBe(400)
    // The routes beside it still answer: a work item called "items" is not one.
    expect((await post(`${APP}/supervise/steps/n_clerk/redistribute`, 'u_carla')).statusCode).toBe(200)
  })

  it('lets a dispatcher hand out everything waiting at a step evenly', async () => {
    // Between 1,000 and 10,000: Manager approval, handed out by AP Dispatch (Carla, Victor).
    const a = await invoice('WS-EVEN-7', 'u_rosa', 2500)
    const b = await invoice('WS-EVEN-8', 'u_rosa', 3500)
    for (const o of [a, b]) expect(o.tokens.map((t) => [t.nodeId, t.state])).toEqual([['n_manager', 'unassigned']])
    const before = await workspaceOf('u_carla')
    const board = before.distribution.find((d) => d.nodeId === 'n_manager')!
    expect(board.waiting.map((i) => i.obj.number)).toEqual(expect.arrayContaining([a.number, b.number]))
    const waiting = board.waiting.length

    const url = `${APP}/my/distribution/n_manager/evenly`
    // A budget approver receives work there; they don't hand it out.
    const refused = await post(url, 'u_marcus')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/don’t distribute work/)
    expect((await post(`${APP}/my/distribution/n_nope/evenly`, 'u_carla')).statusCode).toBe(404)
    expect((await api.inject({ method: 'POST', url })).statusCode).toBe(401)

    expect((await post(url, 'u_carla')).json()).toEqual({ ok: true, value: waiting })
    const after = await workspaceOf('u_carla')
    const now = after.distribution.find((d) => d.nodeId === 'n_manager')!
    expect(now.waiting).toEqual([])
    expect(now.assigned.map((i) => i.obj.number)).toEqual(expect.arrayContaining([a.number, b.number]))
    // Shared out, not piled on one person.
    const holders = new Set(now.assigned.map((i) => i.token.userId))
    expect(holders.size).toBe(Math.min(waiting, 4))
    // Nothing left to hand out.
    expect((await post(url, 'u_carla')).statusCode).toBe(409)
    // Each approver finds theirs in their own Workspace.
    const approver = now.assigned[0]!.token.userId!
    expect((await workspaceOf(approver)).basket.map((i) => i.token.id)).toContain(now.assigned[0]!.token.id)
  })
})
