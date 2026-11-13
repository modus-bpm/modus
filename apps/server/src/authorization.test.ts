import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { memoryStorage } from './adapters/memory'
import { buildServer } from './http'
import { Runtime } from './runtime'

// Who may take the whole event log out, and who may take and finish a service's jobs.
// Both were open to anyone who could reach the API.

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
const SECRET = 'ACCT-SECRET-7714'
const ADMIN = 'u_avery'
const AUDITOR = 'u_mei'
const CLERK = 'u_maya'

/** An invoice carrying bank details, which only AP Exceptions and Finance Leadership may see. Left waiting on the ERP match. */
async function invoiceWithBankDetails(invno: string): Promise<string> {
  const created = await api.inject({
    method: 'POST',
    url: '/api/apps/app_invoice/items',
    headers: as('u_rosa'),
    payload: {
      workflowId: 'w_invoice',
      data: { f_invno: invno, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Toner cartridge', c_qty: 2, c_price: 50 }], f_dept: 'l_org_0', f_cc: 'l_org_1', f_bank: SECRET },
    },
  })
  expect(created.statusCode).toBe(201)
  return created.json().value.id as string
}

const poll = (headers: Record<string, string> | undefined, serviceId = 'svc_erp') =>
  api.inject({ method: 'POST', url: '/api/jobs/poll', headers, payload: { serviceId, workerId: 'test-worker', max: 10 } })

describe('the event log export', () => {
  const url = '/api/apps/app_invoice/export/ocel'

  it('asks who is calling', async () => {
    expect((await api.inject({ method: 'GET', url })).statusCode).toBe(401)
  })

  it('is refused to people who are neither administrators nor auditors', async () => {
    await invoiceWithBankDetails('INV-AUTHZ-1')
    for (const user of [CLERK, 'u_rosa', 'u_victor']) {
      const res = await api.inject({ method: 'GET', url, headers: as(user) })
      expect(res.statusCode, user).toBe(403)
      expect(res.body).not.toContain(SECRET)
    }
  })

  it('gives an administrator everything', async () => {
    const res = await api.inject({ method: 'GET', url, headers: as(ADMIN) })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('INV-AUTHZ-1')
    expect(res.body).toContain(SECRET)
  })

  it('gives an auditor every item, without the fields hidden from them', async () => {
    const res = await api.inject({ method: 'GET', url, headers: as(AUDITOR) })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('INV-AUTHZ-1')
    expect(res.body).not.toContain(SECRET)
    expect((res.json() as { events: unknown[] }).events.length).toBeGreaterThan(0)
  })
})

describe('a service’s jobs', () => {
  it('asks who is calling', async () => {
    expect((await poll(undefined)).statusCode).toBe(401)
    expect((await api.inject({ method: 'POST', url: '/api/jobs/app_invoice%3Ao1~1/complete', payload: { outputs: {} } })).statusCode).toBe(401)
    expect((await api.inject({ method: 'POST', url: '/api/jobs/app_invoice%3Ao1~1/fail', payload: {} })).statusCode).toBe(401)
  })

  it('cannot be taken by someone who merely has an account', async () => {
    await invoiceWithBankDetails('INV-AUTHZ-2')
    const res = await poll(as(CLERK))
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('INV-')
  })

  it('cannot be finished or failed by someone who merely has an account', async () => {
    const jobs = ((await poll(as(ADMIN))).json() as { jobs: Array<{ id: string; itemId: string }> }).jobs
    expect(jobs.length).toBeGreaterThan(0)
    const job = jobs[0]!
    const done = await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(job.id)}/complete`, headers: as(CLERK), payload: { outputs: { matched: true } } })
    expect(done.statusCode).toBe(403)
    const failed = await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(job.id)}/fail`, headers: as(CLERK), payload: { error: 'nope' } })
    expect(failed.statusCode).toBe(403)
    // The item has not moved: it is still at the automated step.
    const item = (await api.inject({ method: 'GET', url: `/api/apps/app_invoice/items/${job.itemId}`, headers: as(ADMIN) })).json() as { branches: Array<{ stepId: string }> }
    expect(item.branches.map((b) => b.stepId)).toEqual(['n_capture'])
    // An administrator may finish it.
    expect((await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(job.id)}/complete`, headers: as(ADMIN), payload: { outputs: { matched: true } } })).statusCode).toBe(200)
  })

  it('has its workers named by an administrator, not by a designer', async () => {
    const { revision, ...design } = (await api.inject({ method: 'GET', url: '/api/design', headers: as('u_noah') })).json() as { revision: number; services: Array<{ id: string; workers?: string[] }> }
    design.services.find((s) => s.id === 'svc_erp')!.workers = ['u_noah']
    const saved = await api.inject({ method: 'PUT', url: '/api/design', headers: as('u_noah'), payload: { revision, design } })
    expect(saved.statusCode).toBe(403)
    expect((await poll(as('u_noah'))).statusCode).toBe(403)
  })

  it('can be worked by a person the service lists, and only that service’s', async () => {
    const { revision, ...design } = (await api.inject({ method: 'GET', url: '/api/design', headers: as(ADMIN) })).json() as { revision: number; services: Array<{ id: string; workers?: string[] }> }
    design.services.find((s) => s.id === 'svc_erp')!.workers = ['u_noah']
    const saved = await api.inject({ method: 'PUT', url: '/api/design', headers: as(ADMIN), payload: { revision, design } })
    expect(saved.statusCode).toBe(200)

    await invoiceWithBankDetails('INV-AUTHZ-3')
    const mine = await poll(as('u_noah'), 'svc_erp')
    expect(mine.statusCode).toBe(200)
    const jobs = (mine.json() as { jobs: Array<{ id: string }> }).jobs
    expect(jobs.length).toBeGreaterThan(0)
    expect((await poll(as('u_noah'), 'svc_ocr')).statusCode).toBe(403)
    expect((await api.inject({ method: 'POST', url: `/api/jobs/${encodeURIComponent(jobs[0]!.id)}/complete`, headers: as('u_noah'), payload: { outputs: { matched: true } } })).statusCode).toBe(200)
  })
})
