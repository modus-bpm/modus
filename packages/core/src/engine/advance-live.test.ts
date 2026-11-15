import { describe, expect, it } from 'vitest'
import { appFromTemplate, seedDesign } from '../model/seed'
import { seedTemplates } from '../model/seed-templates'
import type { Group, User } from '../model/types'
import { advance, advanceEveryMinute, burst, completeJob, type Ctx, pollJobs } from './engine'
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
  for (const n of app.workflows[0]!.nodes) {
    if (n.type === 'user') {
      n.data.groupId = 'g_team'
      // Some steps escalate, so escalations come due during the gap too.
      n.data.escalateAfterHours ??= 30
      n.data.escalation ??= { raisePriority: true, toDistributors: false }
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
