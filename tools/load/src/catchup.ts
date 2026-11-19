// The clock catch-up test. A server that was off for a while catches its clock up when the first
// command comes in. A gap of an hour or less is moved inside that command's transaction; a longer
// one in pieces of about two seconds' work, each committed on its own, and the command runs in the
// transaction that reaches now. This measures what that costs on an application with a long
// history, and whether each of those transactions finishes well before PostgreSQL gives up on it
// (15 s idle in transaction).
//
//   tools/load/node_modules/.bin/tsx tools/load/src/catchup.ts                 # the engine alone
//   DATABASE_URL=postgres://… tools/load/node_modules/.bin/tsx tools/load/src/catchup.ts   # and through a server
//
// FINISHED and WAITING set how many items (100000 and 20000), DAYS how long the server was off (7).

import { performance } from 'node:perf_hooks'
import { advance, buildIndex, burst, changedItems, changesBetween, copyState, createObject, type Ctx, ensureVersions, newSim, projectItem, type ProjectedItem, type SimObject, type SimState } from '@modus-bpm/core'
import { appFromTemplate, seedDesign } from '@modus-bpm/core/model/seed'
import { seedTemplates } from '@modus-bpm/core/model/seed-templates'
import type { Design } from '@modus-bpm/core/model/types'
import { postgresStorage } from '@modus-bpm/server/src/adapters/postgres'
import { Runtime } from '@modus-bpm/server/src/runtime'

const FINISHED = Number(process.env.FINISHED ?? 100_000)
const WAITING = Number(process.env.WAITING ?? 20_000)
const DAYS = Number(process.env.DAYS ?? 7)
const DAY = 24 * 60

const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`
const timed = <T>(fn: () => T): [T, number] => {
  const t = performance.now()
  const v = fn()
  return [v, performance.now() - t]
}

// ---------- An application with a timer in it ----------
// Code enforcement complaint: inspect, send a notice, wait 30 days, re-inspect. Its people steps
// get a group so the simulation can work them.

function design(): { design: Design; appId: string; workflowId: string } {
  const d = seedDesign()
  const template = seedTemplates().find((t) => t.name === 'Code enforcement complaint')
  if (!template) throw new Error('The Code enforcement complaint template is gone.')
  const app = appFromTemplate(template, { groups: d.groups, users: d.users })
  const group = d.groups.find((g) => g.memberIds.length >= 3) ?? d.groups[0]!
  for (const wf of app.workflows) for (const n of wf.nodes) if (n.type === 'user') n.data.groupId = group.id
  for (const t of app.objectTypes) for (const g of d.groups) t.permissions[g.id] = { create: true, read: true, update: true, delete: false }
  d.apps.push(app)
  return { design: ensureVersions(d, 0), appId: app.id, workflowId: app.workflows[0]!.id }
}

/** A state with `finished` finished items and `waiting` items sitting at the 30-day timer, made by copying real ones. */
function history(ctx: Ctx, workflowId: string, finished: number, waiting: number): SimState {
  const sim = newSim(ctx.app.id, 7)
  sim.arrivals = false
  burst(sim, ctx, workflowId, 300)
  // Run until a good number wait at the timer; keep copies of those as they are then.
  let atTimer: SimObject[] = []
  for (let day = 0; day < 20 && atTimer.length < 40; day++) {
    advance(sim, ctx, DAY)
    atTimer = Object.values(sim.objects).filter((o) => o.status === 'active' && o.tokens.length === 1 && o.tokens[0]!.state === 'waiting' && o.tokens[0]!.dueAt !== undefined)
  }
  if (atTimer.length < 10) throw new Error(`Only ${atTimer.length} items reached the timer.`)
  const waiters = structuredClone(atTimer)
  // Then run them all to an end; those are the finished ones to copy.
  for (let day = 0; day < 120 && sim.activeIds.length; day++) advance(sim, ctx, DAY)
  const done = Object.values(sim.objects).filter((o) => o.status !== 'active')
  if (sim.activeIds.length || done.length < 50) throw new Error(`The sample run did not finish: ${sim.activeIds.length} still active.`)

  for (let i = 0; i < finished; i++) {
    const copy = structuredClone(done[i % done.length]!)
    copy.id = `o_done_${i}`
    copy.number = `CE-D${i}`
    sim.objects[copy.id] = copy
  }
  for (let i = 0; i < waiting; i++) {
    const copy = structuredClone(waiters[i % waiters.length]!)
    copy.id = `o_wait_${i}`
    copy.number = `CE-W${i}`
    const tok = copy.tokens[0]!
    tok.id = `t_wait_${i}`
    tok.objectId = copy.id
    tok.enteredAt = sim.clock
    // Due over the next two weeks, evenly: half of them come due during a week off.
    tok.dueAt = sim.clock + ((i + 1) / waiting) * 14 * DAY
    sim.objects[copy.id] = copy
    sim.activeIds.push(copy.id)
  }
  return sim
}

const { design: d, appId, workflowId } = design()
const app = d.apps.find((a) => a.id === appId)!
const simCtx: Ctx = { app, users: d.users, groups: d.groups, services: d.services }
const liveCtx: Ctx = { ...simCtx, live: true }

console.log(`Building ${FINISHED.toLocaleString('en-US')} finished items and ${WAITING.toLocaleString('en-US')} waiting on a timer…`)
let t = performance.now()
const base = history(simCtx, workflowId, FINISHED, WAITING)
console.log(`  built in ${ms(t)}: ${Object.keys(base.objects).length.toLocaleString('en-US')} items, ${base.activeIds.length.toLocaleString('en-US')} active\n`)

/** How many items sit at a timer. */
const atTimer = (sim: SimState) => sim.activeIds.filter((id) => sim.objects[id]?.tokens.some((k) => k.state === 'waiting' && k.dueAt !== undefined)).length

// ---------- 1. The engine alone ----------
console.log('1. The engine alone (no storage)')
const [copy, copyMs] = timed(() => copyState(base))
console.log(`  copy the state, as every command does:        ${copyMs.toFixed(0)} ms`)
for (const [label, minutes] of [
  ['one minute', 1],
  ['one hour', 60],
  ['one day', DAY],
  [`${DAYS} days`, DAYS * DAY],
] as const) {
  const sim = copyState(base)
  const before = atTimer(sim)
  const [, took] = timed(() => advance(sim, liveCtx, minutes))
  console.log(`  catch the clock up ${label.padEnd(11)} ${String(took.toFixed(0)).padStart(8)} ms   (${(before - atTimer(sim)).toLocaleString('en-US')} timers came due, ${(took / minutes).toFixed(2)} ms a minute)`)
  if (minutes === DAYS * DAY) {
    const [, diffMs] = timed(() => {
      changesBetween(base, sim)
      return changedItems(base, sim)
    })
    console.log(`  find what the command changed:                ${diffMs.toFixed(0)} ms`)
  }
}
void copy

// ---------- 2. Through a server on PostgreSQL ----------
const url = process.env.DATABASE_URL
if (!url) {
  console.log('\n2. Skipped: set DATABASE_URL to run the first command after the gap through a real server.')
  process.exit(0)
}
console.log('\n2. Through a server on PostgreSQL')
const storage = postgresStorage(url, { max: 4 })
await storage.migrate()
await storage.designs.save(d)
// The state as a server left it, with its clock last moved DAYS ago.
const idx = buildIndex(liveCtx)
t = performance.now()
const items = Object.keys(base.objects)
  .map((id) => projectItem(base, liveCtx, id, idx))
  .filter((p): p is ProjectedItem => !!p)
const leftAt = Date.now() - DAYS * DAY * 60_000
await storage.transact(appId, 0, () => ({ value: undefined, write: { state: base, entries: [], items, outbox: [], tickedAt: leftAt } }))
console.log(`  stored ${items.length.toLocaleString('en-US')} items in ${ms(t)}; the clock was last moved ${DAYS} days ago`)

t = performance.now()
const rt = await Runtime.create({ storage, seedIfEmpty: false, onError: (err, during) => console.log(`  (runtime ${during}: ${err instanceof Error ? err.message : String(err)})`) })
console.log(`  server start (loads the state):               ${ms(t)}`)

const creator = d.users.find((u) => u.roles?.includes('admin')) ?? d.users[0]!
for (let attempt = 1; attempt <= 3; attempt++) {
  t = performance.now()
  try {
    const made = await rt.run(appId, (sim, ctx) => createObject(sim, ctx, workflowId, {}, creator.id)?.number)
    console.log(`  command ${attempt} (create an item): done in ${ms(t)} → ${made}; active now ${rt.state(appId).activeIds.length.toLocaleString('en-US')}`)
  } catch (err) {
    console.log(`  command ${attempt} (create an item): FAILED after ${ms(t)} → ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
}
await rt.stop()
await storage.close?.()
