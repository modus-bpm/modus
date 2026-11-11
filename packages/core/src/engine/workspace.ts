// One person's share of an application's state: what their Workspace shows, as they may see it.
// A server sends this instead of the whole state, and the Workspace runs the usual read models
// (basketOf, queuesFor, distributionFor, requestsBy, supervisionFor) over it. Fields the person may
// not see, and the history lines that would show them, never leave the server.

import type { Id } from '../model/types'
import { buildIndex, type Ctx, distributorsOf, type Index, indexFor, newSim, type SimObject, type SimState, stepOf, supervisesStep, workStepOf } from './engine'
import { accessFor } from './ops'
import { canReadItem, hiddenFieldsOf, visibleHistory } from './search'

/**
 * Does this item belong in the person's Workspace? Theirs if they created it; otherwise while it
 * is active and has work in their basket, in a queue they fetch from, at a step they hand work out
 * for, or at a people step they supervise. A little wider than the read models, never narrower.
 */
export function inWorkspace(idx: Index, obj: SimObject, userId: Id): boolean {
  if (obj.createdBy === userId) return true
  if (obj.status !== 'active') return false
  const own = indexFor(idx, obj)
  return obj.tokens.some((t) => {
    if (t.userId === userId) return true
    if (stepOf(own, t.nodeId)?.node.type === 'user' && supervisesStep(own, t.nodeId, userId)) return true
    const ws = workStepOf(own, t)
    if (!ws) return false
    if (t.state === 'unassigned' && ws.distribution === 'queue' && !!idx.group.get(ws.groupId ?? '')?.memberIds.includes(userId)) return true
    return ws.distribution === 'manager' && distributorsOf(own, ws).includes(userId)
  })
}

/** Fields hidden from the person on this item: at the work they hold when they hold some, otherwise as a reader. */
function hiddenFrom(sim: SimState, ctx: Ctx, obj: SimObject, userId: Id): Set<Id> {
  const asReader = hiddenFieldsOf(ctx, obj, userId)
  let atWork: Set<Id> | undefined
  for (const t of obj.tokens) {
    if (t.userId !== userId) continue
    const verdicts = accessFor(sim, ctx, t.id, userId)
    if (!verdicts) continue
    const here = new Set(Object.entries(verdicts).filter(([, v]) => v.access === 'hidden').map(([id]) => id))
    // Holding two branches: a field one of their forms shows is theirs to see.
    atWork = atWork ? new Set([...atWork].filter((id) => here.has(id))) : here
  }
  return atWork ? new Set([...atWork, ...[...asReader].filter((id) => atWork!.has(id))]) : asReader
}

/**
 * An item as this person may see it: hidden fields left out and history lines that show them
 * redacted. Someone who meets it only in a worklist (a queue they fetch from, a step they hand out
 * or supervise) and may not read it otherwise gets its title alone, and no history.
 */
export function workspaceItem(sim: SimState, ctx: Ctx, obj: SimObject, userId: Id): SimObject {
  const hidden = hiddenFrom(sim, ctx, obj, userId)
  const titleOnly = !obj.tokens.some((t) => t.userId === userId) && !canReadItem(ctx, obj, userId)
  const type = ctx.app.objectTypes.find((t) => t.id === obj.typeId)
  const titleField = type && (type.fields.find((f) => f.id === type.titleFieldId) ?? type.fields.find((f) => f.summary))
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj.data)) {
    if (hidden.has(k)) continue
    if (titleOnly && k !== titleField?.id) continue
    data[k] = v
  }
  return { ...obj, data, history: titleOnly ? [] : visibleHistory(ctx, obj, userId, hidden) }
}

export interface WorkspaceSlice {
  clock: number
  items: SimObject[]
  /** Finished requests of theirs left out (only the newest `finishedLimit` are sent). */
  olderRequests: number
}

/**
 * Everything in the person's Workspace: the active items (see `inWorkspace`) and the requests
 * they made that have finished, newest first up to `finishedLimit`.
 */
export function workspaceSlice(sim: SimState, ctx: Ctx, userId: Id, opts: { finishedLimit?: number } = {}): WorkspaceSlice {
  const idx = buildIndex(ctx)
  const limit = opts.finishedLimit ?? 200
  const chosen = new Set<Id>()
  for (const id of sim.activeIds) {
    const obj = sim.objects[id]
    if (obj && inWorkspace(idx, obj, userId)) chosen.add(id)
  }
  const all = Object.values(sim.objects)
  const finished = all.filter((o) => o.status !== 'active' && o.createdBy === userId).sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  for (const obj of finished.slice(0, limit)) chosen.add(obj.id)
  // In the state's own order, so lists that sort items come out the same as they do over the whole state.
  const items = all.filter((o) => chosen.has(o.id)).map((o) => workspaceItem(sim, ctx, o, userId))
  return { clock: sim.clock, items, olderRequests: Math.max(0, finished.length - limit) }
}

/**
 * The given items as the person may see them now, for keeping a slice current. `ids` are items that
 * changed: those no longer in their Workspace come back in `gone`. `pinned` are items they opened
 * from a search: kept for as long as they may read them.
 */
export function workspaceItems(sim: SimState, ctx: Ctx, userId: Id, ids: readonly Id[], pinned: readonly Id[] = []): { items: SimObject[]; gone: Id[] } {
  const idx = buildIndex(ctx)
  const items: SimObject[] = []
  const gone: Id[] = []
  const pin = new Set(pinned)
  for (const id of new Set([...ids, ...pinned])) {
    const obj = sim.objects[id]
    if (obj && (inWorkspace(idx, obj, userId) || (pin.has(id) && canReadItem(ctx, obj, userId)))) items.push(workspaceItem(sim, ctx, obj, userId))
    else gone.push(id)
  }
  return { items, gone }
}

/**
 * A state holding just these items, for the read models to run over. `activeIds` lists the active
 * ones in the order given; everything else is as in a new state.
 */
export function workspaceState(appId: Id, clock: number, items: readonly SimObject[]): SimState {
  const sim = newSim(appId)
  sim.arrivals = false
  sim.clock = clock
  for (const o of items) {
    sim.objects[o.id] = o
    if (o.status === 'active') sim.activeIds.push(o.id)
  }
  return sim
}
