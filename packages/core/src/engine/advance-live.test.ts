import { describe, expect, it } from 'vitest'
import { appFromTemplate, seedDesign } from '../model/seed'
import { seedTemplates } from '../model/seed-templates'
import type { App, Distribution, Group, ServiceDef, User, WfEdge, WfNode, Workflow } from '../model/types'
import { advance, advanceEveryMinute, burst, completeJob, createObject, type Ctx, pollJobs } from './engine'
import { workRelease } from './ops'
import { copyState, newSim, type SimState } from './state'

// A live clock doesn't look at every item every minute: once a minute has changed nothing, it
// only touches items whose own time has come. That shortcut must change nothing about what
// happens. Here every starter template is run both ways, from the same state over the same gap,
// and the two states must be the same down to the last field.

const DAY = 24 * 60
const users: User[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, title: 'Staff', color: '#000', speed: 1, available: true }))
const groups: Group[] = [{ id: 'g_team', name: 'Team', memberIds: users.map((u) => u.id), supervisorId: 'p0' }]
const services = seedDesign().services

/** An application from a template, with work spread through it by a short simulated run. */
function inFlight(name: string, seed: number, simulatedMinutes: number): { live: Ctx; sim: SimState } {
  const t = seedTemplates().find((x) => x.name === name)!
  const app = appFromTemplate(t, { groups, users })
  let people = 0
  for (const n of app.workflows[0]!.nodes) {
    if (n.type === 'user') {
      n.data.groupId = 'g_team'
      // Some steps escalate, so escalations come due during the gap too; every other one hands
      // the work back to the team's supervisor, to be given out again.
      n.data.escalateAfterHours ??= 30
      n.data.escalation ??= { raisePriority: true, toDistributors: people++ % 2 === 1 }
    }
    if (n.type === 'auto') n.data.fallbackGroupId = 'g_team'
  }
  const ctx: Ctx = { app, users, groups, services }
  const sim = newSim(app.id, seed)
  sim.arrivals = false
  burst(sim, ctx, app.workflows[0]!.id, 14)
  advance(sim, ctx, simulatedMinutes)
  return { live: { ...ctx, live: true }, sim }
}

const same = (a: SimState, b: SimState) => expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)))

describe('the live clock', () => {
  for (const t of seedTemplates()) {
    it(`leaves “${t.name}” as stepping every minute would, over 45 days`, () => {
      // Caught at three moments: just started, part way, and mostly waiting on timers.
      for (const [seed, ran] of [
        [3, 20],
        [5, 9 * 60],
        [9, 4 * DAY],
      ] as const) {
        const { live, sim } = inFlight(t.name, seed, ran)
        const fast = copyState(sim)
        const slow = copyState(sim)
        advance(fast, live, 45 * DAY)
        advanceEveryMinute(slow, live, 45 * DAY)
        same(fast, slow)
      }
    })
  }

  it('is the same in pieces as in one go, whatever the pieces', () => {
    const { live, sim } = inFlight('Code enforcement complaint', 21, 3 * DAY)
    const whole = copyState(sim)
    const pieces = copyState(sim)
    const reference = copyState(sim)
    const steps = [0.4, 1, 1 / 60, 37.5, 600, 0.25, 3 * DAY + 0.7, 29 * DAY, 11, 5 * DAY]
    advance(whole, live, steps.reduce((a, b) => a + b, 0))
    for (const m of steps) {
      advance(pieces, live, m)
      advanceEveryMinute(reference, live, m)
    }
    // In pieces, each piece is a clock tick of its own, as the reference's are.
    same(pieces, reference)
    expect(whole.activeIds.length).toBe(pieces.activeIds.length)
  })

  it('still does the work a command left for the next minute', () => {
    // People release work and a worker finishes jobs between clock moves: what that leaves
    // (a queued call with a free slot, a built-in step) is done on the minutes that follow.
    const { live, sim } = inFlight('Three-way match', 13, 30)
    const fast = copyState(sim)
    const slow = copyState(sim)
    for (const s of [fast, slow]) {
      const jobs = pollJobs(s, live, 'svc_erp', 'w', 50, 5)
      for (const j of jobs) completeJob(s, live, j.id, { found: true })
    }
    for (let round = 0; round < 6; round++) {
      for (const [s, move] of [
        [fast, advance],
        [slow, advanceEveryMinute],
      ] as const) {
        move(s, live, 90)
        for (const j of pollJobs(s, live, 'svc_erp', 'w', 50, 5)) completeJob(s, live, j.id, { found: round % 2 === 0 })
        const held = Object.values(s.objects)
          .flatMap((o) => o.tokens)
          .find((k) => k.userId && (k.state === 'assigned' || k.state === 'working'))
        if (held) {
          const node = live.app.workflows[0]!.nodes.find((n) => n.id === held.nodeId)
          if (node?.type === 'user') workRelease(s, live, held.id, held.userId!, node.data.outcomes[0]!.id, 'ok', {})
        }
      }
      same(fast, slow)
    }
  })

  /** `count` more items waiting at the timer, coming due one after another, `every` minutes apart. */
  function crowd(sim: SimState, count: number, every: number) {
    const waiter = Object.values(sim.objects).find((o) => o.status === 'active' && o.tokens.length === 1 && o.tokens[0]!.state === 'waiting')
    expect(waiter).toBeDefined()
    for (let i = 0; i < count; i++) {
      const copy = structuredClone(waiter!)
      copy.id = `o_c${i}`
      copy.tokens[0]!.id = `t_c${i}`
      copy.tokens[0]!.objectId = copy.id
      copy.tokens[0]!.dueAt = sim.clock + 0.3 + i * every
      sim.objects[copy.id] = copy
      sim.activeIds.push(copy.id)
    }
  }

  it('is the same when something comes due every minute, and when it stops part way', () => {
    const { live, sim } = inFlight('Code enforcement complaint', 7, 4 * DAY)
    crowd(sim, 400, 0.7)
    const fast = copyState(sim)
    const slow = copyState(sim)
    // Asked to stop after every hour, it does, on a whole minute; going on from there changes nothing.
    let moved = 0
    let calls = 0
    while (moved < 2 * DAY - 1e-9) {
      const step = advance(fast, live, 2 * DAY - moved, () => true)
      expect(step === 60 || moved + step >= 2 * DAY - 1e-9).toBe(true)
      moved += step
      calls++
    }
    expect(calls).toBe(48)
    advanceEveryMinute(slow, live, 2 * DAY)
    same(fast, slow)
  })

  it('stays quick with a timer coming due every minute for a week', () => {
    const { live, sim } = inFlight('Code enforcement complaint', 7, 4 * DAY)
    crowd(sim, 8000, 1.2)
    const started = Date.now()
    advance(sim, live, 7 * DAY)
    expect(Object.values(sim.objects).filter((o) => o.id.startsWith('o_c') && o.tokens.some((k) => k.state === 'waiting')).length).toBeLessThan(10)
    // Looking at every item every minute, this was minutes of work.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('costs next to nothing for a week in which little is due', () => {
    const { live, sim } = inFlight('Code enforcement complaint', 7, 4 * DAY)
    // Many items, all waiting on a timer three weeks off.
    const waiter = Object.values(sim.objects).find((o) => o.status === 'active' && o.tokens.length === 1 && o.tokens[0]!.state === 'waiting')
    expect(waiter).toBeDefined()
    for (let i = 0; i < 5000; i++) {
      const copy = structuredClone(waiter!)
      copy.id = `o_w${i}`
      copy.tokens[0]!.id = `t_w${i}`
      copy.tokens[0]!.objectId = copy.id
      copy.tokens[0]!.dueAt = sim.clock + 21 * DAY + i
      sim.objects[copy.id] = copy
      sim.activeIds.push(copy.id)
    }
    const started = Date.now()
    advance(sim, live, 7 * DAY)
    // Stepping every minute over 5,000 items took tens of seconds; this is a few ticks' work.
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

// The due items' minute can free or hand on work that belongs to other items: a service slot
// another item is queued for, work handed back to be given out again. The shortcut has to do
// that work the same minute the reference does.
describe('the live clock, when an item that comes due frees or hands on work', () => {
  const at = { x: 0, y: 0 }
  const start: WfNode = { id: 's', type: 'start', position: at, data: { label: 'Start' } }
  const split: WfNode = { id: 'p', type: 'split', position: at, data: { label: 'Split', mode: 'all' } }
  const end = (id: string, result: 'completed' | 'cancelled' = 'completed'): WfNode => ({ id, type: 'end', position: at, data: { label: id, result } })
  const wait = (id: string, minutes: number): WfNode => ({ id, type: 'wait', position: at, data: { label: id, minutes } })
  const call = (id: string, serviceId: string): WfNode => ({ id, type: 'auto', position: at, data: { label: id, avgMinutes: 5, actions: [], serviceId, operationId: `${serviceId}_op` } })
  const person = (id: string, distribution: Distribution, extra: Partial<Extract<WfNode, { type: 'user' }>['data']> = {}): WfNode => ({
    id,
    type: 'user',
    position: at,
    data: { label: id, distribution, groupId: 'g', autoDistribute: false, distributeEveryMinutes: 30, avgMinutes: 60, outcomes: [{ id: 'ok', label: 'Done', weight: 1, actions: [] }], fieldAccess: {}, ...extra },
  })
  const edge = (source: string, target: string, outcomeId?: string): WfEdge => ({ id: `${source}-${target}`, source, target, data: outcomeId ? { outcomeId } : {} })
  /** A workflow; its node ids get the workflow's id in front (`hold.cx`), as they must be unique in an application. */
  const flow = (id: string, nodes: WfNode[], edges: WfEdge[]): Workflow => ({
    id,
    name: id,
    kind: 'process',
    objectTypeId: 't',
    arrivalsPerHour: 0,
    nodes: nodes.map((n) => ({ ...n, id: `${id}.${n.id}` })),
    edges: edges.map((e) => ({ ...e, id: `${id}.${e.id}`, source: `${id}.${e.source}`, target: `${id}.${e.target}` })),
  })
  const service = (id: string, concurrency: number): ServiceDef => ({
    id,
    name: id,
    kind: 'worker',
    endpoint: `topic: ${id}`,
    status: 'online',
    concurrency,
    operations: [{ id: `${id}_op`, name: 'run', avgMinutes: 5, successRate: 1, outputs: [] }],
  })

  /** A live application with one type (an Owner field), a team of three with a supervisor, and these workflows. */
  function liveApp(workflows: Workflow[], opts: { services?: ServiceDef[]; available?: boolean } = {}): Ctx {
    const team: User[] = ['u0', 'u1', 'u2'].map((id, i) => ({ id, name: `Person ${i}`, title: 'Clerk', color: '#000', speed: 1, available: opts.available ?? true }))
    team.push({ id: 'boss', name: 'Boss', title: 'Supervisor', color: '#000', speed: 1, available: true })
    const app: App = {
      id: 'a',
      name: 'Test',
      description: '',
      color: '#000',
      lists: [],
      objectTypes: [
        {
          id: 't',
          name: 'Thing',
          pluralName: 'Things',
          icon: 'file',
          color: '#000',
          numberPrefix: 'T-',
          permissions: { g: { create: true, read: true, update: true, delete: false } },
          fields: [{ id: 'who', label: 'Owner', type: 'user', width: 'half' }],
        },
      ],
      workflows,
    }
    return { app, users: team, groups: [{ id: 'g', name: 'Team', memberIds: ['u0', 'u1', 'u2'], supervisorId: 'boss' }], services: opts.services ?? [], live: true }
  }

  function quietSim(seed: number) {
    const sim = newSim('a', seed)
    sim.arrivals = false
    return sim
  }

  /** Both clocks from the same state over the same gap must agree; returns the shortcut's state. */
  function bothWays(ctx: Ctx, sim: SimState, minutes: number): SimState {
    const fast = copyState(sim)
    const slow = copyState(sim)
    advance(fast, ctx, minutes)
    advanceEveryMinute(slow, ctx, minutes)
    same(fast, slow)
    return fast
  }

  // Holds a slot on x until its timer ends the whole item and withdraws the call.
  const hold = flow('hold', [start, split, call('cx', 'x'), wait('w', 60), end('stop', 'cancelled')], [edge('s', 'p'), edge('p', 'cx'), edge('p', 'w'), edge('w', 'stop')])

  it('hands escalated work back out the minute it escalates', () => {
    const escalates = person('u', 'load-balance', { escalateAfterHours: 1, escalation: { raisePriority: false, toDistributors: true } })
    const ctx = liveApp([flow('w', [start, escalates, end('e')], [edge('s', 'u'), edge('u', 'e', 'ok')])])
    const sim = quietSim(1)
    for (let i = 0; i < 3; i++) createObject(sim, ctx, 'w', {}, 'boss')
    const fast = bothWays(ctx, sim, 3 * 60)
    for (const o of Object.values(fast.objects)) {
      expect(o.tokens[0]!.escalated).toBe(true)
      expect(o.tokens[0]!.state).toBe('assigned')
    }
  })

  it('starts a call queued for one service when another service takes a slot the same minute', () => {
    const ctx = liveApp(
      [
        hold,
        flow('queue', [start, call('cx', 'x'), end('e')], [edge('s', 'cx'), edge('cx', 'e')]),
        // Takes a slot on y when its timer ends, the same minute the holder lets go of x.
        flow('later', [start, wait('w', 60), call('cy', 'y'), end('e')], [edge('s', 'w'), edge('w', 'cy'), edge('cy', 'e')]),
      ],
      { services: [service('x', 1), service('y', 5)] },
    )
    const sim = quietSim(2)
    const holder = createObject(sim, ctx, 'hold', {}, 'boss')!
    const queued = createObject(sim, ctx, 'queue', {}, 'boss')!
    createObject(sim, ctx, 'later', {}, 'boss')
    expect(queued.tokens[0]!.state).toBe('queued')
    const fast = bothWays(ctx, sim, 2 * 60)
    expect(fast.objects[holder.id]!.status).not.toBe('active')
    expect(fast.objects[queued.id]!.tokens[0]!.state).toBe('auto')
  })

  it('starts a call queued behind one that took the slot before it came free, the same minute', () => {
    // x has room for two. The holder has one; at minute 60 one waiter takes the other, the
    // second waiter queues, and then the holder lets go: x is as busy as it began, with a call waiting.
    const ctx = liveApp([hold, flow('later', [start, wait('w', 60), call('cx', 'x'), end('e')], [edge('s', 'w'), edge('w', 'cx'), edge('cx', 'e')])], { services: [service('x', 2)] })
    const sim = quietSim(3)
    createObject(sim, ctx, 'later', {}, 'boss')
    const second = createObject(sim, ctx, 'later', {}, 'boss')!
    createObject(sim, ctx, 'hold', {}, 'boss')
    const fast = bothWays(ctx, sim, 2 * 60)
    expect(fast.objects[second.id]!.tokens[0]!.state).toBe('auto')
  })

  it('hands out work by a field filled in the same minute', () => {
    // Nobody in the team is available, so the work waits until the item names its owner.
    const ctx = liveApp(
      [
        flow(
          'w',
          [
            start,
            split,
            person('f', 'field', { assigneeFieldId: 'who' }),
            wait('w', 60),
            { id: 'set', type: 'auto', position: at, data: { label: 'Name the owner', avgMinutes: 0, actions: [{ id: 'a1', kind: 'setField', fieldId: 'who', value: 'u1' }] } },
            end('e'),
          ],
          [edge('s', 'p'), edge('p', 'f'), edge('p', 'w'), edge('w', 'set'), edge('set', 'e'), edge('f', 'e', 'ok')],
        ),
      ],
      { available: false },
    )
    const sim = quietSim(4)
    const o = createObject(sim, ctx, 'w', {}, 'boss')!
    expect(o.tokens.find((t) => t.nodeId === 'w.f')!.state).toBe('unassigned')
    const fast = bothWays(ctx, sim, 2 * 60)
    expect(fast.objects[o.id]!.tokens.find((t) => t.nodeId === 'w.f')!.userId).toBe('u1')
  })
})
