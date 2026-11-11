import { useMemo } from 'react'
import {
  basketOf,
  type Ctx,
  distributionFor,
  type DistributionSummary,
  type QueueSummary,
  queuesFor,
  type RequestSummary,
  requestsBy,
  type Result,
  type SimState,
  type Supervision,
  supervisionFor,
  type WorkItem,
} from '@modus-bpm/core'
import type { App, Group, Id, User } from '@modus-bpm/core/model/types'
import { ApiError, type Loads, type ServerDesign } from '../../server/client'
import { liveStore, type LiveStatus } from '../../server/live'
import { useLive } from '../../server/useLive'
import { useWork } from '../../server/useWork'
import { workStore } from '../../server/work'
import { useDesign } from '../../store/design'
import { ctxFor, useSim } from '../../store/sim'
import { useUi } from '../../store/ui'
import { isLive } from '../monitor/source'
import { type CommandValue, runInSim, toRequest, type WorkCommand } from './commands'
import { useWorkspace } from './store'

// Where the Workspace's work comes from: the in-browser simulation, or (served by a Modus server,
// with Live chosen) the server. Either way the pages get an application, an engine state to run the
// read models over and one way to act; only this file knows which is behind them.

/** The Workspace is showing a server's work, not the simulation. */
export function workspaceIsLive(): boolean {
  return isLive(liveStore.getState())
}

export interface WorkSource {
  live: boolean
  /** The application as that source runs it; undefined when it doesn't (a server without this app). */
  app: App | undefined
  users: User[]
  groups: Group[]
  ctx: Ctx | undefined
  /** The work to show: the simulation, or the person's share of the server's state. */
  sim: SimState | undefined
  /** Changes whenever the data may have changed: use it as a memo dependency. */
  tick: string
  /** Live only: how the connection is. */
  status?: LiveStatus
  error?: string
}

/** The server's design as an engine context. Services come without their connection details. */
function liveCtx(design: ServerDesign | undefined, appId: Id): Ctx | undefined {
  const app = design?.apps.find((a) => a.id === appId)
  if (!design || !app) return undefined
  return { app, users: design.users, groups: design.groups, services: design.services.map((s) => ({ endpoint: '', ...s })), live: true }
}

/**
 * The open app's work for the Workspace. Over the simulation, components using this re-render
 * about twice a second while it runs instead of every tick, so typing stays smooth; when paused,
 * and right after your own actions, they refresh at once. Over a server they refresh when the
 * server says something of yours changed.
 */
export function useWorkSource(): WorkSource {
  const appId = useUi((s) => s.appId)
  const actingAs = useUi((s) => s.actingAs)
  const mode = useUi((s) => s.mode)
  const live = useLive(isLive)
  const nonce = useWorkspace((s) => s.nonce)

  // The simulation.
  const design = useDesign((s) => s.design)
  const running = useSim((s) => s.running)
  const step = useSim((s) => (running ? Math.floor(s.version / 5) : s.version))
  const simState = useSim((s) => s.sims[appId])
  const simCtx = useMemo(() => ctxFor(appId), [design, appId, actingAs, mode])

  // The server.
  const served = useWork((s) => (s.appId === appId ? s.design : undefined))
  const slice = useWork((s) => (s.appId === appId && s.userId === actingAs ? s.sim : undefined))
  const version = useWork((s) => s.version)
  const status = useWork((s) => s.status)
  const error = useWork((s) => s.error)
  const servedCtx = useMemo(() => liveCtx(served, appId), [served, appId])

  if (live) return { live, app: servedCtx?.app, users: served?.users ?? [], groups: served?.groups ?? [], ctx: servedCtx, sim: slice, tick: `l${version}.${nonce}`, status, error }
  return { live, app: simCtx?.app, users: design.users, groups: design.groups, ctx: simCtx, sim: simState, tick: `${running ? 'r' : 'p'}${step}.${nonce}` }
}

/** How much work each person has open, for the pickers: from the server in Live, else from the simulation. */
export function currentLoads(): Loads {
  if (workspaceIsLive()) return workStore.getState().loads
  return useSim.getState().views[useUi.getState().appId]?.users ?? {}
}

/** The state the Workspace is showing right now (for code outside a component). */
export function currentWork(): { sim: SimState | undefined; ctx: Ctx | undefined } {
  const appId = useUi.getState().appId
  if (workspaceIsLive()) return { sim: workStore.getState().sim, ctx: liveCtx(workStore.getState().design, appId) }
  return { sim: useSim.getState().sims[appId], ctx: ctxFor(appId) }
}

const UNREACHABLE = 'The server couldn’t be reached, so nothing was changed. Try again.'

/**
 * Do something as the person you are working as: on the simulation, or through the server's API.
 * Resolves once the result is showing. Refusals become a warning toast.
 */
export async function perform<C extends WorkCommand>(cmd: C): Promise<Result<CommandValue<C>>> {
  const me = useUi.getState().actingAs
  let r: Result<CommandValue<C>>
  if (workspaceIsLive()) {
    try {
      // Released or handed on, an item leaves your Workspace; held, it stays to say where it went.
      const itemId = 'tokenId' in cmd ? cmd.tokenId.slice(0, cmd.tokenId.lastIndexOf('~')) : 'itemId' in cmd ? cmd.itemId : undefined
      if (itemId) workStore.getState().hold([itemId])
      r = await workStore.getState().run<CommandValue<C>>(toRequest(cmd))
    } catch (e) {
      r = { ok: false, error: e instanceof ApiError && e.status < 500 ? e.message : UNREACHABLE }
    }
  } else {
    r = useSim.getState().act((sim, ctx) => runInSim(sim, ctx, me, cmd)) as Result<CommandValue<C>>
  }
  useWorkspace.getState().bump()
  if (!r.ok) useUi.getState().toast(r.error, 'warn')
  return r
}

export interface WorkData {
  clock: number
  basket: WorkItem[]
  queues: QueueSummary[]
  distribution: DistributionSummary[]
  requests: RequestSummary[]
  /** Steps and processes the person oversees (everything, for administrators). */
  supervision: Supervision
}

const EMPTY: WorkData = { clock: 0, basket: [], queues: [], distribution: [], requests: [], supervision: { processes: [], steps: [] } }

/** Everything the Workspace shows for one person, recomputed when `tick` says the data may have changed. */
export function useWorkData(sim: SimState | undefined, ctx: Ctx | undefined, me: Id, tick: string): WorkData {
  return useMemo(() => {
    if (!sim || !ctx) return EMPTY
    return {
      clock: sim.clock,
      basket: basketOf(sim, ctx, me),
      queues: queuesFor(sim, ctx, me),
      distribution: distributionFor(sim, ctx, me),
      requests: requestsBy(sim, ctx, me),
      supervision: supervisionFor(sim, ctx, me),
    }
  }, [sim, ctx, me, tick])
}
