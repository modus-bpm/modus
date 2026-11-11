import { describe, expect, it } from 'vitest'
import { advance, basketOf, type Ctx, newSim, queuesFor } from '@modus-bpm/core'
import { seedDesign } from '@modus-bpm/core/model/seed'
import { type Created, runInSim, toRequest, type WorkCommand } from './commands'

// Every action the Workspace offers, once: the request it becomes for a server. The server's own
// tests (apps/server/src/workspace.test.ts) check that each of these routes exists.
const REQUESTS: Array<[WorkCommand, string, unknown?]> = [
  [{ do: 'create', workflowId: 'w_invoice', data: { f_invno: 'A-1' } }, '/items', { workflowId: 'w_invoice', data: { f_invno: 'A-1' } }],
  [{ do: 'next' }, '/my/next'],
  [{ do: 'claim', tokenId: 'o1~1' }, '/work/o1~1/claim'],
  [{ do: 'start', tokenId: 'o1~1' }, '/work/o1~1/start'],
  [{ do: 'save', tokenId: 'o1~1', patch: { f_gl: '6100' } }, '/work/o1~1/save', { patch: { f_gl: '6100' } }],
  [{ do: 'release', tokenId: 'o1~1', outcomeId: 'o_k_ok', comment: 'ok', patch: {} }, '/work/o1~1/release', { outcomeId: 'o_k_ok', comment: 'ok', patch: {} }],
  [{ do: 'return', tokenId: 'o1~1', comment: 'not mine' }, '/work/o1~1/return', { comment: 'not mine' }],
  [{ do: 'delegate', tokenId: 'o1~1', to: 'u_tom', comment: '' }, '/work/o1~1/delegate', { to: 'u_tom', comment: '' }],
  [{ do: 'distribute', tokenId: 'o1~1', to: 'u_tom' }, '/work/o1~1/distribute', { to: 'u_tom' }],
  [{ do: 'distributeEvenly', stepId: 'n_manager' }, '/my/distribution/n_manager/evenly'],
  [{ do: 'priority', itemId: 'o1', priority: 'high' }, '/items/o1/priority', { priority: 'high' }],
  [{ do: 'expedite', itemId: 'o1', on: true, reason: 'audit' }, '/items/o1/expedite', { on: true, reason: 'audit' }],
  [{ do: 'expedite', itemId: 'o1', on: false }, '/items/o1/expedite', { on: false, reason: '' }],
  [{ do: 'superviseAssign', tokenId: 'o1~1', to: 'u_tom' }, '/supervise/o1~1/assign', { to: 'u_tom' }],
  [{ do: 'superviseReturn', tokenId: 'o1~1' }, '/supervise/o1~1/return'],
  [{ do: 'superviseRetry', tokenId: 'o1~1' }, '/supervise/o1~1/retry'],
  [{ do: 'superviseRelease', tokenId: 'o1~1', outcomeId: 'o_k_ok', comment: 'on leave' }, '/supervise/o1~1/release', { outcomeId: 'o_k_ok', comment: 'on leave' }],
  [{ do: 'superviseRedistribute', stepId: 'n_clerk' }, '/supervise/steps/n_clerk/redistribute'],
  [{ do: 'supervisePriority', itemId: 'o1', priority: 'urgent' }, '/supervise/items/o1/priority', { priority: 'urgent' }],
]

describe('Workspace actions', () => {
  it('each become one request to the server', () => {
    for (const [cmd, path, body] of REQUESTS) expect(toRequest(cmd), cmd.do).toEqual({ path, ...(body === undefined ? {} : { body }) })
  })

  it('escape ids in the path', () => {
    expect(toRequest({ do: 'claim', tokenId: 'o 1/2~3' }).path).toBe('/work/o%201%2F2~3/claim')
  })

  it('run the engine’s operations on a simulation, as the person', () => {
    const d = seedDesign()
    const all = d.users.map((u) => u.id)
    // Everyone is a real person, so work waits for them instead of being done by the simulation.
    const ctx: Ctx = { app: d.apps[0]!, users: d.users, groups: d.groups, services: d.services, manualUserIds: all }
    const sim = newSim(ctx.app.id, 5)
    advance(sim, ctx, 6 * 60)

    // Create as someone who may: the item exists and is theirs.
    const made = runInSim(sim, ctx, 'u_maya', { do: 'create', workflowId: 'w_invoice', data: { f_invno: 'CMD-1' } })
    expect(made.ok).toBe(true)
    const created = (made as { value: Created }).value
    expect(sim.objects[created.id]).toMatchObject({ number: created.number, createdBy: 'u_maya' })

    // The same refusals as the server's: no permission, or a field the person may not set.
    expect(runInSim(sim, ctx, 'u_carmen', { do: 'create', workflowId: 'w_invoice', data: {} })).toEqual({ ok: false, error: 'You can’t create items in that workflow.' })
    const bank = runInSim(sim, ctx, 'u_maya', { do: 'create', workflowId: 'w_invoice', data: { f_invno: 'CMD-2', f_bank: 'ACCT-1' } })
    expect(bank).toMatchObject({ ok: false })
    expect((bank as { error: string }).error).toMatch(/^You can’t set Vendor Bank Account \(/)
    expect(runInSim(sim, ctx, 'u_rosa', { do: 'create', workflowId: 'w_invoice', data: { f_invno: 'CMD-3', f_bank: 'ACCT-1' } }).ok).toBe(true)

    // Start and release something from a basket.
    const holder = d.users.find((u) => basketOf(sim, ctx, u.id).length)!
    const work = basketOf(sim, ctx, holder.id)[0]!
    expect(runInSim(sim, ctx, holder.id, { do: 'start', tokenId: work.token.id })).toEqual({ ok: true, value: true })
    expect(work.token.state).toBe('working')
    // Someone else can't act on it: the engine's refusal comes back as it is.
    const other = d.users.find((u) => u.id !== holder.id && !u.roles?.length)!
    expect(runInSim(sim, ctx, other.id, { do: 'save', tokenId: work.token.id, patch: {} }).ok).toBe(false)
    expect(runInSim(sim, ctx, holder.id, { do: 'priority', itemId: work.obj.id, priority: work.obj.priority === 'urgent' ? 'high' : 'urgent' })).toEqual({ ok: true, value: true })

    // Get next takes the most urgent item from the person's queues and answers with it.
    const fetcher = d.users.find((u) => queuesFor(sim, ctx, u.id).some((q) => q.items.length))
    if (fetcher) {
      const before = basketOf(sim, ctx, fetcher.id).length
      const next = runInSim(sim, ctx, fetcher.id, { do: 'next' })
      expect(next.ok).toBe(true)
      expect(basketOf(sim, ctx, fetcher.id).map((i) => i.token.id)).toContain((next as { value: string }).value)
      expect(basketOf(sim, ctx, fetcher.id).length).toBe(before + 1)
    }
  })
})
