// What a person can do in the Workspace, as data: one list of actions with two ways to carry them
// out. Over the simulation each runs the engine operation in this browser; over a Modus server each
// is the request for the route that runs the same operation there.

import {
  canCreate,
  createObject,
  createRefusals,
  type Ctx,
  type Result,
  setExpedite,
  type SimState,
  superviseAssign,
  superviseRedistribute,
  superviseRelease,
  superviseRetry,
  superviseReturn,
  superviseSetPriority,
  workClaim,
  workDelegate,
  workDistribute,
  workDistributeEvenly,
  workNext,
  workRelease,
  workReturn,
  workSave,
  workSetPriority,
  workStart,
} from '@modus-bpm/core'
import type { Id, Priority } from '@modus-bpm/core/model/types'
import type { CommandRequest } from '../../server/client'

export type WorkCommand =
  | { do: 'create'; workflowId: Id; data: Record<string, unknown> }
  /** Take the most urgent item from any of your queues. */
  | { do: 'next' }
  | { do: 'claim' | 'start'; tokenId: Id }
  | { do: 'save'; tokenId: Id; patch: Record<string, unknown> }
  | { do: 'release'; tokenId: Id; outcomeId: Id; comment: string; patch: Record<string, unknown> }
  | { do: 'return'; tokenId: Id; comment: string }
  | { do: 'delegate'; tokenId: Id; to: Id; comment: string }
  | { do: 'distribute'; tokenId: Id; to: Id }
  | { do: 'distributeEvenly'; stepId: Id }
  | { do: 'priority'; itemId: Id; priority: Priority }
  | { do: 'expedite'; itemId: Id; on: boolean; reason?: string }
  | { do: 'superviseAssign'; tokenId: Id; to: Id }
  | { do: 'superviseReturn' | 'superviseRetry'; tokenId: Id }
  | { do: 'superviseRelease'; tokenId: Id; outcomeId: Id; comment: string }
  | { do: 'superviseRedistribute'; stepId: Id }
  | { do: 'supervisePriority'; itemId: Id; priority: Priority }

/** The item a create made. */
export interface Created {
  id: Id
  number: string
}

/** What each action answers with when it works. */
export type CommandValue<C extends WorkCommand> = C extends { do: 'create' } ? Created : C extends { do: 'next' } ? Id : C extends { do: 'distributeEvenly' | 'superviseRedistribute' } ? number : true

/** Carry an action out on a simulation, as `me`. */
export function runInSim(sim: SimState, ctx: Ctx, me: Id, c: WorkCommand): Result<unknown> {
  switch (c.do) {
    case 'create': {
      // The same checks, in the same words, as the server makes before it creates one.
      if (!canCreate(ctx, c.workflowId, me)) return { ok: false, error: 'You can’t create items in that workflow.' }
      const refused = createRefusals(ctx, c.workflowId, me, c.data)
      if (refused.length) return { ok: false, error: `You can’t set ${refused.map((r) => r.field.label).join(', ')} (${refused[0]!.reason}).` }
      const obj = createObject(sim, ctx, c.workflowId, c.data, me)
      return obj ? { ok: true, value: { id: obj.id, number: obj.number } satisfies Created } : { ok: false, error: 'It couldn’t be created. Check the workflow.' }
    }
    case 'next':
      return workNext(sim, ctx, me)
    case 'claim':
      return workClaim(sim, ctx, c.tokenId, me)
    case 'start':
      return workStart(sim, ctx, c.tokenId, me)
    case 'save':
      return workSave(sim, ctx, c.tokenId, me, c.patch)
    case 'release':
      return workRelease(sim, ctx, c.tokenId, me, c.outcomeId, c.comment, c.patch)
    case 'return':
      return workReturn(sim, ctx, c.tokenId, me, c.comment)
    case 'delegate':
      return workDelegate(sim, ctx, c.tokenId, me, c.to, c.comment)
    case 'distribute':
      return workDistribute(sim, ctx, c.tokenId, me, c.to)
    case 'distributeEvenly':
      return workDistributeEvenly(sim, ctx, c.stepId, me)
    case 'priority':
      return workSetPriority(sim, ctx, c.itemId, me, c.priority)
    case 'expedite':
      return setExpedite(sim, ctx, c.itemId, me, c.on, c.reason ?? '')
    case 'superviseAssign':
      return superviseAssign(sim, ctx, c.tokenId, c.to, me)
    case 'superviseReturn':
      return superviseReturn(sim, ctx, c.tokenId, me)
    case 'superviseRetry':
      return superviseRetry(sim, ctx, c.tokenId, me)
    case 'superviseRelease':
      return superviseRelease(sim, ctx, c.tokenId, c.outcomeId, c.comment, me)
    case 'superviseRedistribute':
      return superviseRedistribute(sim, ctx, c.stepId, me)
    case 'supervisePriority':
      return superviseSetPriority(sim, ctx, c.itemId, c.priority, me)
  }
}

const seg = encodeURIComponent

/** The same action as a request to a Modus server (the path is under the application). Who acts is the caller. */
export function toRequest(c: WorkCommand): CommandRequest {
  switch (c.do) {
    case 'create':
      return { path: '/items', body: { workflowId: c.workflowId, data: c.data } }
    case 'next':
      return { path: '/my/next' }
    case 'claim':
    case 'start':
      return { path: `/work/${seg(c.tokenId)}/${c.do}` }
    case 'save':
      return { path: `/work/${seg(c.tokenId)}/save`, body: { patch: c.patch } }
    case 'release':
      return { path: `/work/${seg(c.tokenId)}/release`, body: { outcomeId: c.outcomeId, comment: c.comment, patch: c.patch } }
    case 'return':
      return { path: `/work/${seg(c.tokenId)}/return`, body: { comment: c.comment } }
    case 'delegate':
      return { path: `/work/${seg(c.tokenId)}/delegate`, body: { to: c.to, comment: c.comment } }
    case 'distribute':
      return { path: `/work/${seg(c.tokenId)}/distribute`, body: { to: c.to } }
    case 'distributeEvenly':
      return { path: `/my/distribution/${seg(c.stepId)}/evenly` }
    case 'priority':
      return { path: `/items/${seg(c.itemId)}/priority`, body: { priority: c.priority } }
    case 'expedite':
      return { path: `/items/${seg(c.itemId)}/expedite`, body: { on: c.on, reason: c.reason ?? '' } }
    case 'superviseAssign':
      return { path: `/supervise/${seg(c.tokenId)}/assign`, body: { to: c.to } }
    case 'superviseReturn':
      return { path: `/supervise/${seg(c.tokenId)}/return` }
    case 'superviseRetry':
      return { path: `/supervise/${seg(c.tokenId)}/retry` }
    case 'superviseRelease':
      return { path: `/supervise/${seg(c.tokenId)}/release`, body: { outcomeId: c.outcomeId, comment: c.comment } }
    case 'superviseRedistribute':
      return { path: `/supervise/steps/${seg(c.stepId)}/redistribute` }
    case 'supervisePriority':
      return { path: `/supervise/items/${seg(c.itemId)}/priority`, body: { priority: c.priority } }
  }
}
