import { describe, expect, it } from 'vitest'
import { seedDesign } from '../model/seed'
import { advance, buildIndex, type Ctx, newSim, type SimState } from './engine'
import { createAccess, createRefusals, setExpedite, workClaim, workStart } from './ops'
import { canReadItem, hiddenFieldsOf } from './search'
import { basketOf, distributionFor, queuesFor, requestsBy, supervisionFor } from './view'
import { inWorkspace, workspaceColleagues, workspaceItem, workspaceItems, workspaceSlice, workspaceState } from './workspace'

const design = seedDesign()

function ctxOf(appIndex: number): Ctx {
  return { app: design.apps[appIndex]!, users: design.users, groups: design.groups, services: design.services }
}

/** A busy state: a working day of simulated arrivals and people. */
function busy(ctx: Ctx, seed = 7): SimState {
  const sim = newSim(ctx.app.id, seed)
  advance(sim, ctx, 8 * 60)
  return sim
}

/** What the Workspace shows a person, reduced to ids so two states compare. */
function shown(sim: SimState, ctx: Ctx, userId: string) {
  const s = supervisionFor(sim, ctx, userId)
  return {
    basket: basketOf(sim, ctx, userId).map((i) => i.token.id),
    queues: queuesFor(sim, ctx, userId).map((q) => [q.nodeId, q.items.map((i) => i.token.id)]),
    distribution: distributionFor(sim, ctx, userId).map((d) => [d.nodeId, d.waiting.map((i) => i.token.id), d.assigned.map((i) => i.token.id)]),
    requests: requestsBy(sim, ctx, userId).map((r) => [r.obj.id, r.where, r.overdue]),
    supervision: [s.processes, s.steps.map((st) => [st.nodeId, st.items.map((i) => [i.token.id, i.due, i.overdue]), st.escalated.map((i) => i.token.id)])],
  }
}

describe('a person’s slice of the state', () => {
  it('shows every person the same Workspace as the whole state does', () => {
    for (let a = 0; a < design.apps.length; a++) {
      const ctx = ctxOf(a)
      const sim = busy(ctx)
      expect(Object.keys(sim.objects).length).toBeGreaterThan(20)
      for (const u of design.users) {
        const slice = workspaceSlice(sim, ctx, u.id, { finishedLimit: 100_000 })
        const mine = workspaceState(ctx.app.id, slice.clock, slice.items)
        expect(shown(mine, ctx, u.id), `${ctx.app.name} as ${u.name}`).toEqual(shown(sim, ctx, u.id))
      }
    }
  })

  it('is smaller than the state for people who are not administrators', () => {
    const ctx = ctxOf(0)
    const sim = busy(ctx)
    const all = Object.keys(sim.objects).length
    const clerk = design.users.find((u) => !u.roles?.length && basketOf(sim, ctx, u.id).length)!
    expect(workspaceSlice(sim, ctx, clerk.id).items.length).toBeLessThan(all)
  })

  it('never carries a field the person may not see, or the history of an item they may not read', () => {
    let hiddenSomewhere = 0
    for (let a = 0; a < design.apps.length; a++) {
      const ctx = ctxOf(a)
      const sim = busy(ctx)
      for (const u of design.users) {
        for (const item of workspaceSlice(sim, ctx, u.id).items) {
          const full = sim.objects[item.id]!
          const holds = full.tokens.some((t) => t.userId === u.id)
          if (!holds) {
            const hidden = hiddenFieldsOf(ctx, full, u.id)
            hiddenSomewhere += hidden.size
            for (const f of hidden) expect(item.data, `${item.number} as ${u.name}`).not.toHaveProperty(f)
          }
          // The stored item is never touched.
          expect(item).not.toBe(full)
        }
      }
    }
    expect(hiddenSomewhere).toBeGreaterThan(0)
  })

  it('gives someone who meets an item only in a worklist its title and nothing else', () => {
    // Nobody may read invoices by their type; people still see what waits in the queues they fetch from.
    const base = ctxOf(0)
    const app = structuredClone(base.app)
    for (const t of app.objectTypes) for (const p of Object.values(t.permissions)) p.read = false
    const ctx: Ctx = { ...base, app, manualUserIds: design.users.map((u) => u.id) }
    const sim = busy(ctx)
    let titleOnly = 0
    for (const u of design.users) {
      for (const q of queuesFor(sim, ctx, u.id)) {
        for (const i of q.items) {
          if (canReadItem(ctx, i.obj, u.id)) continue
          titleOnly++
          const item = workspaceItem(sim, ctx, i.obj, u.id)
          const type = app.objectTypes.find((t) => t.id === item.typeId)!
          expect(Object.keys(item.data).filter((k) => k !== type.titleFieldId)).toEqual([])
          expect(item.history).toEqual([])
          expect(i.obj.history.length).toBeGreaterThan(0)
          // A row's worth and no more: nothing of the stored item rides along.
          expect(Object.keys(item).sort()).toEqual(['completedAt', 'createdAt', 'createdBy', 'data', 'dueBy', 'history', 'id', 'number', 'passed', 'priority', 'status', 'tokenSeq', 'tokens', 'typeId', 'versions', 'workflowId'])
          for (const t of item.tokens) expect(t).not.toHaveProperty('waitReason')
        }
      }
    }
    expect(titleOnly).toBeGreaterThan(0)
  })

  it('keeps only the newest finished requests, and says how many it left out', () => {
    const ctx = ctxOf(0)
    const sim = busy(ctx, 11)
    advance(sim, ctx, 3 * 24 * 60)
    const requester = design.users
      .map((u) => ({ u, done: Object.values(sim.objects).filter((o) => o.createdBy === u.id && o.status !== 'active') }))
      .sort((x, y) => y.done.length - x.done.length)[0]!
    expect(requester.done.length).toBeGreaterThan(3)
    const slice = workspaceSlice(sim, ctx, requester.u.id, { finishedLimit: 3 })
    const finished = slice.items.filter((o) => o.status !== 'active')
    expect(finished).toHaveLength(3)
    expect(slice.olderRequests).toBe(requester.done.length - 3)
    const newest = [...requester.done].sort((x, y) => (y.completedAt ?? 0) - (x.completedAt ?? 0)).slice(0, 3)
    expect(new Set(finished.map((o) => o.id))).toEqual(new Set(newest.map((o) => o.id)))
  })

  it('follows changes item by item: what left the Workspace is gone, what was opened from a search stays while readable', () => {
    // Everyone is a real person here, so queues fill up rather than being worked by the simulation.
    const ctx: Ctx = { ...ctxOf(0), manualUserIds: design.users.map((u) => u.id) }
    const sim = busy(ctx)
    const idx = buildIndex(ctx)
    // Someone with a queue to fetch from, and an item waiting in it.
    const pick = design.users.flatMap((u) => queuesFor(sim, ctx, u.id).flatMap((q) => q.items.map((i) => ({ u, i }))))[0]!
    const { u, i } = pick
    expect(workspaceItems(sim, ctx, u.id, [i.obj.id]).items.map((o) => o.id)).toEqual([i.obj.id])

    // A colleague in the same queue takes it: it has left the first person's Workspace.
    const other = design.groups.find((g) => g.memberIds.includes(u.id) && g.id === i.step.groupId)!.memberIds.find((id) => id !== u.id)!
    expect(workClaim(sim, ctx, i.token.id, other).ok).toBe(true)
    expect(workStart(sim, ctx, i.token.id, other).ok).toBe(true)
    const obj = sim.objects[i.obj.id]!
    if (!inWorkspace(idx, obj, u.id)) {
      expect(workspaceItems(sim, ctx, u.id, [obj.id])).toEqual({ items: [], gone: [obj.id] })
      // Opened from a search, it stays for as long as they may read it.
      const pinned = workspaceItems(sim, ctx, u.id, [], [obj.id])
      expect(pinned.items.map((o) => o.id)).toEqual(canReadItem(ctx, obj, u.id) ? [obj.id] : [])
    }
    // The colleague who holds it sees it as their work shows it.
    expect(workspaceItem(sim, ctx, obj, other).history.length).toBeGreaterThan(0)
    expect(workspaceItems(sim, ctx, u.id, ['no_such_item'])).toEqual({ items: [], gone: ['no_such_item'] })
  })

  it('keeps an expedited row in its place without saying who asked or why', () => {
    const base = ctxOf(0)
    const app = structuredClone(base.app)
    for (const t of app.objectTypes) for (const p of Object.values(t.permissions)) p.read = false
    const ctx: Ctx = { ...base, app, manualUserIds: design.users.map((u) => u.id) }
    const sim = busy(ctx)
    const { u, i } = design.users.flatMap((u) => queuesFor(sim, ctx, u.id).flatMap((q) => q.items.filter((i) => !canReadItem(ctx, i.obj, u.id)).map((i) => ({ u, i }))))[0]!
    const admin = design.users.find((x) => x.roles?.includes('admin'))!
    expect(setExpedite(sim, ctx, i.obj.id, admin.id, true, 'The CFO asked for this one').ok).toBe(true)
    const item = workspaceItem(sim, ctx, sim.objects[i.obj.id]!, u.id)
    expect(item.expedite).toEqual({ by: '', at: sim.clock })
    expect(JSON.stringify(item)).not.toContain('CFO')
    // Unknown keys in the stored data never go out, to a reader either.
    sim.objects[i.obj.id]!.data.not_a_field = 'left behind'
    expect(workspaceItem(sim, ctx, sim.objects[i.obj.id]!, admin.id).data).not.toHaveProperty('not_a_field')
    expect(workspaceItem(sim, ctx, sim.objects[i.obj.id]!, admin.id).expedite?.reason).toBe('The CFO asked for this one')
  })

  it('shows workloads of teammates and of the groups a person hands out to or supervises, and everyone’s to administrators', () => {
    const ctx = ctxOf(0)
    const everyone = design.users.map((u) => u.id)
    expect([...workspaceColleagues(ctx, 'u_avery')].sort()).toEqual([...everyone].sort())
    // A clerk: the AP Clerks, and nobody from the other teams.
    const maya = workspaceColleagues(ctx, 'u_maya')
    expect(maya.has('u_maya') && maya.has('u_jordan')).toBe(true)
    expect(maya.has('u_marcus') || maya.has('u_carmen') || maya.has('u_victor')).toBe(false)
    // Carla supervises the clerks and hands approvals out to the budget approvers.
    const carla = workspaceColleagues(ctx, 'u_carla')
    expect(carla.has('u_jordan') && carla.has('u_marcus')).toBe(true)
    expect(carla.has('u_carmen')).toBe(false)
    // Someone the design doesn't know sees no one else's.
    expect([...workspaceColleagues(ctx, 'stranger')]).toEqual(['stranger'])
  })

  it('the create form offers a person only the fields the engine would let them set', () => {
    const ctx = ctxOf(0)
    const type = ctx.app.objectTypes[0]!
    const everything = Object.fromEntries(type.fields.map((f) => [f.id, 'x']))
    for (const u of ['u_maya', 'u_rosa', 'u_avery']) {
      const access = createAccess(ctx, 'w_invoice', u)
      const refused = new Set(createRefusals(ctx, 'w_invoice', u, everything).map((r) => r.field.id))
      for (const f of type.fields) if (!f.total) expect(access[f.id] !== 'edit', `${f.label} for ${u}`).toBe(refused.has(f.id))
    }
    // A clerk may not enter bank details; AP Exceptions may.
    expect(createAccess(ctx, 'w_invoice', 'u_maya').f_bank).not.toBe('edit')
    expect(createAccess(ctx, 'w_invoice', 'u_rosa').f_bank).toBe('edit')
    expect(createAccess(ctx, 'w_nope', 'u_maya')).toEqual({})
  })
})
