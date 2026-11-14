// The runtime: the same engine the studio simulates with, run live. Every command
// runs in one storage transaction: under the application's row lock it catches the
// clock up, runs on a copy of the state, and commits the items that changed and
// the rest of the state, with the audit entries, projections and outbox messages
// the command produced. Other servers' commits arrive the same way: only the
// items they changed, applied to the cached state. The cached state is
// replaced only after a commit, so a failed command or commit leaves it as it was.
// Commands run one at a time per application within a process (a queue per
// application) and under the row lock across processes. Replicas hear each
// other's commits through the storage's change notices, and one replica per
// application, the holder of its clock lock, moves the clock.
//
// The design is storage's too. The sample is written only when storage has none (first
// start); after that the stored design is the only source. Designers change it through
// `changeDesign`, each write making the next revision; other servers hear the revision and
// reload, and a command whose server holds an older design reloads it before it runs.

import { randomUUID } from 'node:crypto'
import { advance, buildIndex, changedItems, changesBetween, copyState, type Ctx, type Design, ensureVersions, type Id, newSim, projectItem, type ProjectedItem, type SimState, withChanges } from '@modus-bpm/core'
import { seedDesign } from '@modus-bpm/core/model/seed'
import { type ChangeNotice, type Deliveries, type Files, type Storage, StorageBusy } from './ports'

export interface RuntimeOptions {
  storage: Storage
  /** Simulated minutes per real minute. 1 = real time; demos may run faster. */
  timeScale?: number
  /** How often the clock moves (timers, escalations, retries). */
  tickMs?: number
  /** Write the sample design when storage has none (first start). Off: start with an empty design. */
  seedIfEmpty?: boolean
  /**
   * Background work that failed: a clock tick or reloading another server's change (both retried), or a
   * subscriber that threw on a change (not retried; the change stands).
   */
  onError?: (err: unknown, during: 'tick' | 'listen' | 'subscriber') => void
}

export interface Change {
  appId: Id
  clock: number
  /** Items touched by this change. */
  itemIds: Id[]
}

export class NotFound extends Error {}

/** A design write made against a revision that is no longer the stored one. */
export class DesignConflict extends Error {
  constructor(readonly revision: number) {
    super('Someone else changed the design since you loaded it.')
  }
}

const emptyDesign = (): Design => ({ apps: [], users: [], groups: [], services: [], templates: [] })

/** Storage can't take writes right now (the HTTP layer answers 503). */
export class StorageUnavailable extends Error {}

/** An application's state as of a committed version. Never mutated: commands run on a copy. */
interface Cached {
  version: number
  sim: SimState
  /** Wall time (epoch ms) `sim.clock` corresponds to. Absent: never ticked. */
  tickedAt?: number
}

/** Items that differ between two committed states (both left unchanged). */
const moved = (before: SimState, after: SimState) => changesBetween(before, after).itemIds

/** A tick that logged nothing and comes this soon after the last stored clock time is rolled back. */
const IDLE_TICK_MS = 30_000

export class Runtime {
  design!: Design
  /** The stored design's revision as this server holds it (0: nothing stored). */
  designRevision = 0
  private readonly cache = new Map<Id, Cached>()
  private readonly queues = new Map<Id, Promise<unknown>>()
  private readonly listeners = new Set<(c: Change) => void>()
  private readonly designListeners = new Set<(revision: number) => void>()
  /** Design writes and reloads on this server, one at a time. */
  private designQueue: Promise<unknown> = Promise.resolve()
  /** Who holds this runtime's clock locks (the memory adapter tells runtimes on one store apart by it). */
  private readonly owner = randomUUID()
  private timer?: ReturnType<typeof setInterval>
  private ticking?: Promise<void>
  private unlisten?: () => Promise<void>
  private stopping = false

  private constructor(private readonly opts: Required<Omit<RuntimeOptions, 'storage'>> & { storage: Storage }) {}

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const rt = new Runtime({ timeScale: 1, tickMs: 1000, seedIfEmpty: true, onError: (err, during) => console.error(`Runtime ${during} failed:`, err), ...options })
    const { storage } = rt.opts
    const stored = await storage.designs.current()
    if (stored) {
      rt.design = stored.design
      rt.designRevision = stored.revision
    } else if (rt.opts.seedIfEmpty) {
      // First start: the sample becomes the stored design. Another server starting at the same moment may
      // have written it first; either way what storage holds is what runs.
      await storage.designs.replace(seedDesign(), 0)
      const now = (await storage.designs.current())!
      rt.design = now.design
      rt.designRevision = now.revision
    } else {
      rt.design = emptyDesign()
    }
    // Listen before loading, so a commit another server makes meanwhile isn't missed.
    rt.unlisten = await storage.listen(
      (n) => void rt.heard(n),
      () => void rt.reloadAll(),
      (revision) => void rt.heardDesign(revision),
    )
    try {
      for (const app of rt.design.apps) {
        // In the application's queue, so a reload heard meanwhile runs before or after, not during.
        await rt.serial(app.id, async () => {
          const s = await storage.state.load(app.id)
          if (!s) return
          rt.adopt(app.id, { version: s.version, sim: s.state, tickedAt: s.tickedAt })
          // Projections arrived after this state was first written: fill them in once.
          if (Object.keys(s.state.objects).length && !(await storage.projections.any(app.id))) await rt.backfill(app.id)
        })
      }
    } catch (err) {
      await rt.stop().catch(() => undefined)
      throw err
    }
    return rt
  }

  /** Start the clock. */
  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      // A slow tick (a busy database) isn't overlapped by the next one.
      if (!this.ticking) this.ticking = this.tick().finally(() => (this.ticking = undefined))
    }, this.opts.tickMs)
  }

  /** Loaded and not shutting down: the readiness probe. */
  get ready(): boolean {
    return !this.stopping
  }

  /** Readiness of the storage behind the runtime: its name, and the error when it cannot be reached. */
  async checkStorage(): Promise<{ storage: string; error?: string }> {
    const { storage } = this.opts
    try {
      await storage.ping?.()
    } catch (err) {
      return { storage: storage.name, error: err instanceof Error ? err.message : String(err) }
    }
    // Without change notices this replica's cache goes stale; another may serve instead.
    if (storage.listening && !storage.listening()) return { storage: storage.name, error: 'Storage is reachable but this server is not receiving other servers’ changes.' }
    return { storage: storage.name }
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    // A reload heard meanwhile can queue more work: wait until every queue is quiet.
    for (;;) {
      const tail = [...this.queues.values()]
      await Promise.all(tail)
      if ([...this.queues.values()].every((q, i) => q === tail[i])) break
    }
    await this.designQueue
    await this.unlisten?.()
    this.unlisten = undefined
    await this.opts.storage.releaseClocks(this.owner)
  }

  /** The engine context for an application, in live mode. */
  ctx(appId: Id): Ctx {
    const app = this.design.apps.find((a) => a.id === appId)
    if (!app) throw new NotFound(`No application “${appId}”`)
    return { app, users: this.design.users, groups: this.design.groups, services: this.design.services, live: true }
  }

  /** Where uploaded files are kept. */
  get files(): Files {
    return this.opts.storage.files
  }

  /** The outbox's deliveries, for the administrators' routes (the sender works on the storage directly). */
  get deliveries(): Deliveries {
    return this.opts.storage.deliveries
  }

  /** The cached state (don't change it: commands run on a copy). An application never written starts empty. */
  state(appId: Id): SimState {
    return this.cached(appId).sim
  }

  /** Application minutes per real minute. */
  get timeScale(): number {
    return this.opts.timeScale
  }

  /**
   * The application's clock as of now: the cached clock plus the wall time since it was stored. The
   * cached clock lags on a quiet application (idle ticks aren't committed); this doesn't.
   */
  clockNow(appId: Id): number {
    const c = this.cached(appId)
    if (c.tickedAt === undefined) return c.sim.clock
    return c.sim.clock + (Math.max(0, Date.now() - c.tickedAt) / 60_000) * this.opts.timeScale
  }

  /** Run a command against one application's live state, in one storage transaction. */
  run<T>(appId: Id, fn: (sim: SimState, ctx: Ctx) => T): Promise<T> {
    return this.command(appId, fn)
  }

  /**
   * Read the last committed state without changing anything. Not queued behind commands: it sees every
   * command that finished before it, a caller's own awaited ones included, and none still running.
   */
  async read<T>(appId: Id, fn: (sim: SimState, ctx: Ctx) => T): Promise<T> {
    return fn(this.state(appId), this.ctx(appId))
  }

  /** Move the clock of every application this runtime is the ticker for. One failing doesn't stop the rest. */
  async tick(): Promise<void> {
    for (const app of this.design.apps) {
      if (this.stopping) return
      try {
        if (await this.opts.storage.tryClock(app.id, this.owner)) await this.command(app.id, () => undefined, true)
      } catch (err) {
        this.opts.onError(err, 'tick')
      }
    }
  }

  subscribe(listener: (c: Change) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Hear the revision each time this server's design changes (its own writes and other servers'). */
  subscribeDesign(listener: (revision: number) => void): () => void {
    this.designListeners.add(listener)
    return () => this.designListeners.delete(listener)
  }

  /**
   * Change the design: `change` gets the stored design (every workflow versioned, so a draft never runs)
   * and returns the next one. With `known`, only if that is still the stored revision; otherwise
   * DesignConflict, and nothing changes. `change` may throw to refuse: nothing is written.
   * Returns the new revision.
   */
  changeDesign(known: number | undefined, change: (design: Design) => Design): Promise<number> {
    const run = this.designQueue.then(async () => {
      const { storage } = this.opts
      for (;;) {
        const stored = await storage.designs.current()
        const revision = stored?.revision ?? 0
        if (known !== undefined && known !== revision) throw new DesignConflict(revision)
        // A workflow with no versions runs its draft. Give each its version 1 (what it runs now) first.
        const next = change(ensureVersions(stored?.design ?? emptyDesign(), this.clockOfDesign()))
        const written = await storage.designs.replace(next, revision)
        if (written === undefined) {
          // Another server wrote between the read and the write.
          if (known !== undefined) throw new DesignConflict(await storage.designs.revision())
          continue
        }
        this.adoptDesign(next, written)
        return written
      }
    })
    this.designQueue = run.catch(() => undefined)
    return run
  }

  /** A publish time for a workflow's first version when it has no application clock to take it from. */
  private clockOfDesign(): number {
    return Math.max(0, ...[...this.cache.values()].map((c) => c.sim.clock))
  }

  /** Take a newer design; listeners hear its revision. */
  private adoptDesign(design: Design, revision: number): boolean {
    if (revision <= this.designRevision) return false
    this.design = design
    this.designRevision = revision
    // An application the design no longer has keeps its stored state; this server just stops holding it.
    for (const appId of this.cache.keys()) if (!design.apps.some((a) => a.id === appId)) this.cache.delete(appId)
    for (const l of this.designListeners) {
      try {
        l(revision)
      } catch (err) {
        this.opts.onError(err, 'subscriber')
      }
    }
    return true
  }

  /** Load the stored design when it is newer than this server's. Never throws when `quiet`. */
  private reloadDesign(quiet = true): Promise<void> {
    const run = this.designQueue.then(async () => {
      const stored = await this.opts.storage.designs.current()
      if (stored) this.adoptDesign(stored.design, stored.revision)
    })
    this.designQueue = run.catch(() => undefined)
    return quiet ? run.catch((err) => this.opts.onError(err, 'listen')) : run
  }

  /** Another server (or this one) wrote the design. */
  private heardDesign(revision: number): Promise<void> {
    if (this.stopping || revision <= this.designRevision) return Promise.resolve()
    return this.reloadDesign()
  }

  private cached(appId: Id): Cached {
    this.ctx(appId)
    let c = this.cache.get(appId)
    if (!c) {
      const sim = newSim(appId, Date.now() & 0x7fffffff)
      sim.arrivals = false
      this.cache.set(appId, (c = { version: 0, sim }))
    }
    return c
  }

  /** One at a time per application, in order; a failure doesn't hold up what comes next. */
  private serial<T>(appId: Id, fn: () => T | Promise<T>): Promise<T> {
    const next = (this.queues.get(appId) ?? Promise.resolve()).then(fn)
    this.queues.set(
      appId,
      next.catch(() => undefined),
    )
    return next
  }

  /** Adopt a committed state unless the cache already holds that version or a later one. */
  private adopt(appId: Id, c: Cached): boolean {
    if (c.version <= (this.cache.get(appId)?.version ?? 0)) return false
    this.cache.set(appId, c)
    return true
  }

  private command<T>(appId: Id, fn: (sim: SimState, ctx: Ctx) => T, tick = false): Promise<T> {
    return this.serial(appId, async () => {
      let ctx = this.ctx(appId)
      const cached = this.cached(appId)
      // A throw from our side of the transaction (the command, or projecting its result), as opposed to storage's.
      let failed: { err: unknown } | undefined
      // Another server's newer state, handed over under the lock: worth keeping whatever happens next.
      let fresh: Cached | undefined
      let sim!: SimState
      let tickedAt: number | undefined
      let itemIds: Id[] = []
      let r: { value: T; version: number; committed: boolean }
      try {
        r = await this.opts.storage.transact(appId, cached.version, async (stored) => {
          try {
            // Another server changed the design and we haven't heard yet: its items may run a version we lack.
            if ((stored.designRevision ?? 0) > this.designRevision) {
              await this.reloadDesign(false)
              ctx = this.ctx(appId)
            }
            // Another server committed since our version: what it changed, applied to the cached state.
            if (stored.changes) fresh = { version: stored.version, sim: withChanges(cached.sim, stored.changes), tickedAt: stored.tickedAt }
            const before = fresh?.sim ?? cached.sim
            sim = copyState(before)
            // Taken under the lock: waiting for it doesn't count as clock time already spent.
            const now = Date.now()
            // Catch the clock up from when it was last moved, by whichever server. A state from before
            // clock times were kept isn't moved; this commit starts keeping one.
            const last = stored.tickedAt
            if (last !== undefined && now > last) advance(sim, ctx, ((now - last) / 60_000) * this.opts.timeScale)
            const value = fn(sim, ctx)
            const c = changesBetween(before, sim)
            itemIds = c.itemIds
            if (tick && !c.itemIds.length && last !== undefined && now - last < IDLE_TICK_MS) return { value }
            // Every item that changed is written (its state and its rows), not only those whose rows moved.
            const idx = buildIndex(ctx)
            const items = changedItems(before, sim)
              .map((id) => projectItem(sim, ctx, id, idx))
              .filter((p): p is ProjectedItem => !!p)
            // Never write a clock time earlier than the stored one (another server's clock may run ahead).
            tickedAt = Math.max(now, last ?? now)
            return { value, write: { state: sim, entries: c.entries, items, outbox: c.outbox, tickedAt } }
          } catch (err) {
            failed = { err }
            throw err
          }
        })
      } catch (err) {
        // The command failed, but another server's change it was handed is real: keep and show it.
        if (fresh && this.adopt(appId, fresh)) this.emit({ appId, clock: fresh.sim.clock, itemIds: moved(cached.sim, fresh.sim) })
        if (failed) throw failed.err
        if (err instanceof StorageBusy) throw new StorageUnavailable(err.message, { cause: err })
        throw new StorageUnavailable('Storage is unavailable, so the change wasn’t made. Try again shortly.', { cause: err })
      }
      // Items another server moved since our cached version, which this runtime hasn't told anyone about.
      const theirs = fresh ? moved(cached.sim, fresh.sim) : []
      if (r.committed) {
        this.adopt(appId, { version: r.version, sim, tickedAt })
        this.emit({ appId, clock: sim.clock, itemIds: [...new Set([...theirs, ...itemIds])].sort() })
      } else if (fresh && this.adopt(appId, fresh)) {
        // A rolled-back idle tick still brought another server's change: show it.
        this.emit({ appId, clock: fresh.sim.clock, itemIds: theirs })
      }
      return r.value
    })
  }

  /** Another server (or this one) committed: reload unless the cache has that version already. */
  private async heard(n: ChangeNotice): Promise<void> {
    if (this.stopping) return
    // An application we don't know: the design that added it may not have reached us yet.
    if (!this.design.apps.some((a) => a.id === n.appId)) await this.reloadDesign()
    if (this.stopping || !this.design.apps.some((a) => a.id === n.appId)) return
    // Cheap check first: this process's own commits arrive here too.
    if (n.version <= (this.cache.get(n.appId)?.version ?? 0)) return
    return this.reload(n.appId, n)
  }

  /** The connection to storage came back: anything may have been missed. */
  private async reloadAll(): Promise<void> {
    if (this.stopping) return
    await this.reloadDesign()
    await Promise.all(this.design.apps.map((a) => this.reload(a.id)))
  }

  /** Load the stored state when it is newer than the cache, and tell listeners. Never throws. */
  private reload(appId: Id, n?: ChangeNotice): Promise<void> {
    return this.serial(appId, async () => {
      const was = this.cached(appId)
      // Checked again in turn: a commit queued ahead (this runtime's own, say) may have brought the cache there.
      if (n && n.version <= was.version) return
      // Only what changed since the cached version: the rest of the state and the items written since.
      const s = await this.opts.storage.state.since(appId, was.version)
      if (!s?.changes) return
      const sim = withChanges(was.sim, s.changes)
      if (!this.adopt(appId, { version: s.version, sim, tickedAt: s.tickedAt })) return
      // The notice's items cover the state only when it is the one commit between the cache and storage.
      const one = n?.itemIds && s.version === n.version && was.version === n.version - 1
      this.emit({ appId, clock: sim.clock, itemIds: one ? n.itemIds! : moved(was.sim, sim) })
    }).catch((err) => this.opts.onError(err, 'listen'))
  }

  /** Project every item of a state stored before projections existed. */
  private async backfill(appId: Id) {
    const ctx = this.ctx(appId)
    const cached = this.cached(appId)
    let sim = cached.sim
    let tickedAt: number | undefined
    const r = await this.opts.storage.transact(appId, cached.version, (stored) => {
      sim = stored.changes ? withChanges(cached.sim, stored.changes) : cached.sim
      tickedAt = stored.tickedAt ?? Date.now()
      const idx = buildIndex(ctx)
      const items = Object.keys(sim.objects)
        .map((id) => projectItem(sim, ctx, id, idx))
        .filter((p): p is ProjectedItem => !!p)
      return { value: undefined, write: { state: sim, entries: [], items, outbox: [], tickedAt: tickedAt! } }
    })
    this.adopt(appId, { version: r.version, sim, tickedAt })
  }

  private emit(change: Change) {
    for (const l of this.listeners) {
      // The change is committed: a failing listener is its own problem, not the command's.
      try {
        l(change)
      } catch (err) {
        this.opts.onError(err, 'subscriber')
      }
    }
  }
}
