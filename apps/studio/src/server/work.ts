// The live Workspace's source: one person's share of a Modus server's state, kept fresh from its
// event stream, and their actions sent to its API. A vanilla zustand store (no React) so tests drive
// it directly; the Workspace wraps it with `useWork`.
//
// The server sends the items in the person's Workspace as they may see them (core's workspaceSlice).
// They are held here as an engine state, so the pages run the same read models over it that they run
// over the simulation. Nothing is ever changed here: every action is a request, and what it did
// comes back from the server.

import { createStore } from 'zustand/vanilla'
import { type AssistantReply, type Id, type Result, type SearchResult, type SimObject, type SimState, workspaceState } from '@modus-bpm/core'
import {
  ApiError,
  askWorkspace,
  command,
  getDesign,
  getWorkspace,
  getWorkspaceItems,
  openStream,
  searchWorkspace,
  type ApiOptions,
  type ChangeEvent,
  type CommandRequest,
  type Fetch,
  type Loads,
  type SearchSort,
  type ServerDesign,
} from './client'
import { designStore } from './design'
import type { LiveStatus, Visibility } from './live'

export interface WorkState {
  appId?: Id
  /** Who the Workspace is working as (`x-user-id`) until OIDC. */
  userId?: Id
  design?: ServerDesign
  /** The person's items as an engine state. Replaced, never changed, whenever anything in it moves. */
  sim?: SimState
  loads: Loads
  /** Finished requests of theirs the server left out. */
  olderRequests: number
  /** Goes up each time `sim` is replaced. */
  version: number
  /** Date.now() of the last change that touched the person's items. */
  lastChange?: number
  status: LiveStatus
  error?: string

  /** Load the server's design for this application. Nothing else is read until someone is followed. */
  open: (appId: Id) => Promise<void>
  /** Load this person's Workspace and keep it current from the stream. */
  follow: (userId: Id) => Promise<void>
  close: () => void
  /** Keep these items of the Workspace after they leave it, for as long as the person may read them. */
  hold: (ids: Id[]) => void
  /** Send one action; the Workspace is reloaded before this resolves, so what it did is already showing. */
  run: <T>(req: CommandRequest) => Promise<Result<T>>
  /** Search everything the person may read on the server. The hits' items are kept so they can be opened. */
  search: (query: string, opts: { sort?: SearchSort; limit: number }) => Promise<SearchResult>
  ask: (question: string) => Promise<AssistantReply>
}

export interface WorkDeps {
  fetch?: Fetch
  /** At most one refetch per this long, however many events arrive. */
  throttleMs?: number
  /** Before trying again when the design or the Workspace couldn't be loaded. */
  retryMs?: number
  /** More changed items than this in one refetch: reload everything instead. */
  maxIds?: number
  /** Items opened from searches that are kept (the oldest are dropped past this). */
  maxPinned?: number
  visibility?: Visibility
  silentMs?: number
  /** The server said its design is at this revision now. */
  onDesign?: (revision: number) => void
}

function documentVisibility(): Visibility {
  if (typeof document === 'undefined') return { hidden: () => false, subscribe: () => {} }
  return { hidden: () => document.hidden, subscribe: (cb) => document.addEventListener('visibilitychange', cb) }
}

/** The application's clock moves between changes too; nothing is redrawn for less than this many minutes of it. */
const CLOCK_STEP = 0.5

export function createWorkStore(deps: WorkDeps = {}) {
  const f = deps.fetch ?? ((input, init) => fetch(input, init))
  const throttleMs = deps.throttleMs ?? 1000
  const retryMs = deps.retryMs ?? 3000
  const maxIds = deps.maxIds ?? 300
  const maxPinned = deps.maxPinned ?? 200
  const visibility = deps.visibility ?? documentVisibility()

  // A new open or follow bumps `gen`, so late answers to an old one are dropped.
  let gen = 0
  let closeStream: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFetch = 0
  let inFlight: Promise<void> | undefined
  let streamLive = false
  /** Loaded once: only then do stream events lead to refetches. */
  let ready = false
  /** A load failed or the stream dropped: the next refetch reloads everything. */
  let stale = false
  let pendingFull = false
  const pendingIds = new Set<Id>()
  /** The person's items in the server's order. */
  let items = new Map<Id, SimObject>()
  /** Items kept because they were found by a search, oldest first. */
  const pinned = new Set<Id>()
  let clock = 0

  const store = createStore<WorkState>()((set, get) => {
    const opts = (): ApiOptions => ({ user: get().userId!, fetch: f })
    const current = (g: number) => g === gen

    const stop = () => {
      gen++
      closeStream?.()
      closeStream = undefined
      clearTimeout(timer)
      timer = undefined
      inFlight = undefined
      streamLive = ready = stale = pendingFull = false
      pendingIds.clear()
    }

    const publish = (extra: Partial<WorkState> = {}) => {
      const { appId } = get()
      if (!appId) return
      set((s) => ({ sim: workspaceState(appId, clock, [...items.values()]), version: s.version + 1, ...extra }))
    }

    const fail = (g: number, e: unknown) => {
      if (!current(g)) return
      if (e instanceof ApiError && e.status === 401) {
        stop()
        set({ status: 'error', error: 'The server didn’t accept you as a signed-in user.' })
        return
      }
      if (e instanceof ApiError && e.status === 404) {
        stop()
        set({ status: 'error', error: 'The server no longer runs this application.' })
        return
      }
      stale = true
      set({ status: 'reconnecting', error: e instanceof Error ? e.message : String(e) })
    }

    /** Everything again: the person's Workspace, and the searched-for items still held. */
    const loadAll = async (g: number) => {
      const { appId } = get()
      const keep = [...pinned]
      const [all, extra] = await Promise.all([getWorkspace(appId!, opts()), keep.length ? getWorkspaceItems(appId!, [], keep, opts()) : undefined])
      if (!current(g)) return
      const next = new Map<Id, SimObject>()
      for (const o of all.items) next.set(o.id, o)
      for (const o of extra?.items ?? []) if (!next.has(o.id)) next.set(o.id, o)
      for (const id of extra?.gone ?? []) pinned.delete(id)
      items = next
      clock = Math.max(all.clock, extra?.clock ?? 0)
      publish({ loads: all.loads, olderRequests: all.olderRequests, error: undefined, ...(get().status === 'reconnecting' && streamLive ? { status: 'live' as const } : {}) })
    }

    /** Only the items that changed. */
    const loadChanged = async (g: number, ids: Id[]) => {
      const { appId } = get()
      const r = await getWorkspaceItems(appId!, ids, ids.filter((id) => pinned.has(id)), opts())
      if (!current(g)) return
      // A copy, so a state already handed out never changes under its readers.
      const next = new Map(items)
      let touched = false
      for (const o of r.items) {
        next.set(o.id, o)
        touched = true
      }
      for (const id of r.gone) {
        pinned.delete(id)
        touched = next.delete(id) || touched
      }
      items = next
      clock = Math.max(clock, r.clock)
      publish({ loads: r.loads, error: undefined, ...(touched ? { lastChange: Date.now() } : {}), ...(get().status === 'reconnecting' && streamLive ? { status: 'live' as const } : {}) })
    }

    /** One refetch of whatever is waiting. Failures are reported and tried again. */
    const refetch = (g: number): Promise<void> => {
      const full = pendingFull || stale || pendingIds.size > maxIds
      const ids = full ? [] : [...pendingIds]
      pendingFull = stale = false
      pendingIds.clear()
      lastFetch = Date.now()
      const run = (full ? loadAll(g) : ids.length ? loadChanged(g, ids) : Promise.resolve())
        .catch((e) => {
          fail(g, e)
          if (!current(g)) return
          // Whatever this one was fetching is still owed.
          pendingFull = true
          if (!timer) timer = setTimeout(flush, retryMs)
        })
        .finally(() => {
          if (inFlight === run) inFlight = undefined
          if (current(g) && (pendingFull || pendingIds.size) && !timer) schedule()
        })
      inFlight = run
      return run
    }

    const flush = () => {
      timer = undefined
      const g = gen
      if (!ready || !(pendingFull || stale || pendingIds.size)) return
      // Hidden: nothing is fetched until the tab is shown again, then everything once.
      if (visibility.hidden()) return void (pendingFull = true)
      if (inFlight) return void inFlight.finally(() => current(g) && schedule())
      void refetch(g)
    }

    /** At most one refetch per `throttleMs`: a burst of events coalesces into the next one. */
    const schedule = () => {
      if (!ready) return
      if (visibility.hidden()) return void (pendingFull = true)
      if (timer || inFlight) return
      timer = setTimeout(flush, Math.max(0, lastFetch + throttleMs - Date.now()))
    }

    const onChange = (e: ChangeEvent) => {
      if (e.items === null) pendingFull = true
      else for (const id of e.items) pendingIds.add(id)
      // Something moved: the refetch brings the clock with it.
      if (pendingFull || pendingIds.size) return schedule()
      // Only the clock: due dates and ages follow it, a redraw at a time.
      if (e.clock - clock < CLOCK_STEP) return
      clock = e.clock
      publish()
    }

    const followStream = (g: number, appId: Id) => {
      closeStream = openStream(
        appId,
        (e) => current(g) && onChange(e),
        (state) => {
          if (!current(g)) return
          streamLive = state === 'live'
          if (state === 'reconnecting') {
            stale = true
            set({ status: 'reconnecting' })
            return
          }
          set({ status: 'live', error: undefined })
          if (stale) {
            pendingFull = true
            schedule()
          }
        },
        {
          user: opts().user,
          fetch: f,
          silentMs: deps.silentMs,
          // Published or saved meanwhile: the pages draw the design as it is now.
          onDesign: (revision) => {
            if (!current(g)) return
            deps.onDesign?.(revision)
            getDesign({ user: opts().user, fetch: f }).then(
              (design) => current(g) && set({ design }),
              () => undefined,
            )
          },
          onDenied: () => current(g) && fail(g, new ApiError(401, 'denied')),
          onNotFound: () => current(g) && fail(g, new ApiError(404, 'gone')),
        },
      )
    }

    // Back in view: one full reload, whatever was missed while hidden.
    visibility.subscribe(() => {
      if (visibility.hidden() || !ready) return
      pendingFull = true
      schedule()
    })

    const pin = (objs: SimObject[]) => {
      if (!objs.length || !get().sim) return
      const next = new Map(items)
      let added = false
      for (const o of objs) {
        const have = next.get(o.id)
        // Already in the Workspace: it is kept current there without being held for the search.
        if (have && !pinned.has(o.id)) continue
        // Found again: it becomes the newest of the held ones.
        pinned.delete(o.id)
        pinned.add(o.id)
        // The same as the copy held: nothing to redraw (a search refreshes with every change).
        if (have && JSON.stringify(have) === JSON.stringify(o)) continue
        next.set(o.id, o)
        added = true
      }
      added = trim(next) || added
      if (!added) return
      items = next
      publish()
    }

    /** Past the limit the oldest held items go; the server says which of them are in the Workspace anyway. */
    const trim = (from: Map<Id, SimObject>) => {
      let dropped = false
      for (const id of pinned) {
        if (pinned.size <= maxPinned) break
        pinned.delete(id)
        dropped = from.delete(id) || dropped
        pendingIds.add(id)
      }
      if (dropped) schedule()
      return dropped
    }

    return {
      loads: {},
      olderRequests: 0,
      version: 0,
      status: 'idle',

      open: async (appId) => {
        stop()
        const g = gen
        items = new Map()
        pinned.clear()
        clock = 0
        set({ appId, userId: undefined, design: undefined, sim: undefined, loads: {}, olderRequests: 0, lastChange: undefined, status: 'connecting', error: undefined })
        try {
          // Anyone named may read the design; who to work as is chosen from it.
          const design = await getDesign({ user: 'studio', fetch: f })
          if (!current(g)) return
          set({ design, status: design.apps.some((a) => a.id === appId) ? 'connecting' : 'idle' })
        } catch (e) {
          if (!current(g)) return
          set({ status: 'reconnecting', error: e instanceof Error ? e.message : String(e) })
          timer = setTimeout(() => current(g) && void get().open(appId), retryMs)
        }
      },

      follow: async (userId) => {
        const { appId, design } = get()
        if (!appId || !design?.apps.some((a) => a.id === appId)) return
        stop()
        const g = gen
        items = new Map()
        pinned.clear()
        clock = 0
        set({ userId, sim: undefined, loads: {}, olderRequests: 0, lastChange: undefined, status: 'connecting', error: undefined })
        try {
          lastFetch = Date.now()
          await loadAll(g)
        } catch (e) {
          fail(g, e)
          if (!current(g)) return
          // Nothing to show yet: try the whole thing again shortly.
          timer = setTimeout(() => current(g) && void get().follow(userId), retryMs)
          return
        }
        if (!current(g)) return
        ready = true
        followStream(g, appId)
      },

      close: () => {
        stop()
        items = new Map()
        pinned.clear()
        set({ appId: undefined, userId: undefined, sim: undefined, loads: {}, olderRequests: 0, status: 'idle', error: undefined })
      },

      hold: (ids) => {
        for (const id of ids) {
          if (!items.has(id)) continue
          pinned.delete(id)
          pinned.add(id)
        }
        const next = new Map(items)
        if (!trim(next)) return
        items = next
        publish()
      },

      run: async <T>(req: CommandRequest) => {
        const g = gen
        const { appId } = get()
        if (!appId || !ready) return { ok: false as const, error: 'The server’s work hasn’t loaded yet. Try again in a moment.' }
        const r = await command<T>(appId, req, opts())
        if (!current(g)) return r
        // What it did, before the caller goes on: it may open the item it just took.
        pendingFull = true
        clearTimeout(timer)
        timer = undefined
        if (inFlight) await inFlight
        if (current(g) && pendingFull) await refetch(g)
        if (current(g)) set({ lastChange: Date.now() })
        return r
      },

      search: async (query, o) => {
        const { appId } = get()
        const r = await searchWorkspace(appId!, query, o, opts())
        pin(r.hits.map((h) => h.obj))
        return r
      },

      ask: async (question) => {
        const { appId } = get()
        const r = await askWorkspace(appId!, question, opts())
        pin((r.hits ?? []).map((h) => h.obj))
        return r
      },
    }
  })
  return store
}

/** The Studio's one live Workspace. */
export const workStore = createWorkStore({ onDesign: (revision) => designStore.getState().heard(revision) })
