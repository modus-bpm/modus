// The HTTP edge: REST for people, supervisors and administrators, the job
// protocol for workers, search and the assistant, a live event stream, and
// (optionally) the built studio. Every request is validated with zod and turned
// into one engine operation inside Runtime.run, so the rules (field security,
// who may claim, supervise or expedite, comments required…) are the engine's,
// exactly as in the studio.
//
// Who is calling is auth.ts's to say (MODUS_AUTH: the `x-user-id` header, a shared
// password, or OIDC sign-in; machine tokens in every mode).

import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import { z } from 'zod'
import { type AuthSettings, openAuth, registerAuth, Unauthorized, who } from './auth'
import {
  activeTokens,
  adminAssign,
  adminMove,
  adminRetry,
  ask,
  basketOf,
  ensureVersions,
  hasDraftChanges,
  migrateItems,
  pinInFlight,
  previewPublish,
  publishedVersion,
  publishWorkflow,
  runnable,
  versionItems,
  buildIndex,
  canCreate,
  createRefusals,
  canExpedite,
  canSuperviseToken,
  completeJob,
  jobService,
  computeView,
  createObject,
  type Ctx,
  distributionFor,
  expeditedByStep,
  explorerCache,
  type ExplorerCache,
  exploreItems,
  type ExplorerKey,
  explorerRow,
  explorerSteps,
  canWorkService,
  exportOcel,
  failJob,
  fileRefs,
  findToken,
  hasRole,
  type Id,
  isAdmin,
  openJob,
  pollJobs,
  queuesFor,
  requestsBy,
  type Result,
  searchItems,
  type SearchHit,
  type SimState,
  type SimView,
  setExpedite,
  superviseAssign,
  superviseRedistribute,
  superviseRelease,
  superviseRetry,
  superviseReturn,
  superviseSetPriority,
  supervisesItem,
  supervisesStep,
  supervisionFor,
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
  workingNow,
  workspaceColleagues,
  workspaceItem,
  workspaceItems,
  workspaceSlice,
} from '@modus-bpm/core'
import { answer, type ModelAssistant } from './assistant'
import { DesignRefused, designUse, parseDesign, takeDesign } from './designs'
import { canRead, designDto, findItem, hitDto, itemDto, workItemDto } from './dto'
import { defaultFileSettings, type FileSettings, FilesRefused, heldNow, sendFile, storeUpload, takeFiles } from './files'
import { liveChanges } from './live'
import { DesignConflict, NotFound, type Runtime, StorageUnavailable } from './runtime'
import type { Sender } from './sender'

export interface ServerOptions {
  logger?: FastifyServerOptions['logger']
  /** A built studio to serve at `/` (SPA fallback); `/api/*` stays the API. */
  staticDir?: string
  /** The language model behind the assistant; without it the built-in assistant answers. */
  assistant?: ModelAssistant
  /** The outbox sender, woken when an administrator retries a message. */
  sender?: Pick<Sender, 'wake'>
  /** How often a quiet live stream gets a keep-alive comment (default 25 s, under common 60 s proxy idle timeouts). */
  streamPingMs?: number
  /** How callers are identified (MODUS_AUTH). Default: the `x-user-id` header. */
  auth?: AuthSettings
  /** Uploaded files: the size limit and how long one waits for an item (ATTACHMENT_*). */
  files?: FileSettings
  /** The item explorer's search text per application (given here so tests can watch it). */
  explorerCaches?: Map<Id, ExplorerCache>
}

// ---------- Request helpers ----------


/** A refusal decided at the edge, before the engine operation runs. */
interface Refusal {
  refused: 403 | 404
  error: string
}

const refuse = (refused: Refusal['refused'], error: string): Refusal => ({ refused, error })

function send<T>(reply: FastifyReply, r: Result<T> | Refusal) {
  if ('refused' in r) return reply.code(r.refused).send({ ok: false, error: r.error })
  return r.ok ? reply.send({ ok: true, value: r.value }) : reply.code(409).send({ ok: false, error: r.error })
}

const nameOf = (ctx: Ctx, userId: Id) => ctx.users.find((u) => u.id === userId)?.name ?? userId

/** Administrators and supervisors of the work may act on it; anyone else is refused. */
function supervisedBy(sim: Parameters<typeof findToken>[0], ctx: Ctx, workItemId: Id, userId: Id): Refusal | undefined {
  const found = findToken(sim, workItemId)
  if (!found || found.obj.status !== 'active') return refuse(404, 'No such active work item.')
  if (!canSuperviseToken(buildIndex(ctx), found.obj, found.tok, userId)) return refuse(403, 'Only an administrator or a supervisor of this work can do that.')
  return undefined
}

const appParams = z.object({ app: z.string() })
const workParams = z.object({ app: z.string(), workItemId: z.string() })
const itemParams = z.object({ app: z.string(), itemId: z.string() })

// ---------- Studio (static files with SPA fallback) ----------

/**
 * The Studio's pages load pictures and fonts only from the server itself or from the page (logos and
 * form pictures are kept in the design). So a style rule or a picture address that got past the
 * checks still has nowhere outside to send anything.
 */
const STUDIO_CSP = "img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'"

function serveStudio(app: FastifyInstance, dir: string) {
  const root = resolve(dir)
  if (!existsSync(join(root, 'index.html'))) throw new Error(`STATIC_DIR=${dir} has no index.html. Build the studio (pnpm --filter @modus-bpm/studio build) or unset STATIC_DIR.`)
  void app.register(fastifyStatic, {
    root,
    prefix: '/',
    setHeaders(reply, path) {
      // Vite fingerprints everything under assets/; the HTML must always be revalidated.
      reply.header('cache-control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
      reply.header('x-content-type-options', 'nosniff')
      if (path.endsWith('.html')) reply.header('content-security-policy', STUDIO_CSP)
    },
  })
}

// ---------- Routes ----------

export function buildServer(rt: Runtime, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? (process.env.NODE_ENV !== 'test' ? { level: 'info' } : false) })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFound) return reply.code(404).send({ ok: false, error: err.message })
    if (err instanceof Unauthorized) return reply.code(401).send({ ok: false, error: err.message })
    if (err instanceof DesignRefused) return reply.code(err.status).send({ ok: false, error: err.message })
    if (err instanceof FilesRefused) return reply.code(400).send({ ok: false, error: err.message })
    if ((err as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ ok: false, error: `That is larger than the server takes (${fileSettings.maxMb} MB for a file).` })
    // The revision now stored, so the Studio can load it and carry its changes over.
    if (err instanceof DesignConflict) return reply.code(409).send({ ok: false, error: err.message, revision: err.revision })
    if (err instanceof StorageUnavailable) {
      reply.log.warn({ err }, err.message)
      return reply.code(503).header('retry-after', '5').send({ ok: false, error: err.message })
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ ok: false, error: 'Invalid request', issues: err.issues })
    reply.log.error(err)
    return reply.code(500).send({ ok: false, error: 'Unexpected error' })
  })

  const fileSettings = opts.files ?? defaultFileSettings
  const auth = opts.auth ?? openAuth()
  registerAuth(app, rt, auth)

  if (opts.staticDir) serveStudio(app, opts.staticDir)
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!
    const api = path === '/api' || path.startsWith('/api/')
    // Client-side routes get the studio; missing files (anything with an extension) and API paths get a 404.
    if (opts.staticDir && !api && (req.method === 'GET' || req.method === 'HEAD') && !/\.[a-z0-9]+$/i.test(path)) {
      return reply.header('cache-control', 'no-cache').header('content-security-policy', STUDIO_CSP).sendFile('index.html')
    }
    return reply.code(404).send({ ok: false, error: `No route ${req.method} ${path}` })
  })

  // One view per committed state, shared by every live stream, the overview and the Monitor. A committed
  // state never changes (commands run on a copy), so its view doesn't either; without this each open
  // stream computed its own after every change.
  // A view also depends on the design: one computed under an older design is computed again.
  const views = new WeakMap<SimState, { app: Ctx['app']; view: SimView }>()
  const viewOf = (sim: SimState, ctx: Ctx) => {
    let v = views.get(sim)
    if (!v || v.app !== ctx.app) views.set(sim, (v = { app: ctx.app, view: computeView(sim, ctx) }))
    return v.view
  }

  // Probes run every few seconds; log them only when something is wrong.
  const quiet = { logLevel: 'warn' as const }

  /** Liveness: the process is up and serving. */
  app.get('/api/health', quiet, async () => ({ ok: true, apps: rt.design.apps.length }))

  /** Readiness: the design and state are loaded, storage answers, and the server is not shutting down. */
  app.get('/api/ready', quiet, async (req, reply) => {
    if (!rt.ready) return reply.code(503).send({ ok: false, error: 'Shutting down' })
    const { storage, error } = await rt.checkStorage()
    if (error) {
      // The probe is unauthenticated: driver errors can name hosts, users and databases, so they stay in the log.
      req.log.warn({ storage, error }, 'Storage unreachable')
      return reply.code(503).send({ ok: false, storage, error: 'Storage unreachable' })
    }
    return { ok: true, apps: rt.design.apps.length, storage }
  })

  app.get('/api', async () => ({
    name: 'Modus API',
    identity: { none: 'x-user-id header', password: 'a shared password, then the x-user-id header', oidc: 'OIDC sign-in' }[auth.auth.mode] + '; Authorization: Bearer for machine tokens',
    routes: app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean),
  }))

  /** 401 without a named user, 403 unless they're an administrator. */
  const requireAdmin = (req: FastifyRequest, error: string): Refusal | undefined => (isAdmin(rt.design.users, who(req)) ? undefined : refuse(403, error))

  /**
   * The published design (applications, people, groups, services without their connection details).
   * The Studio's live Monitor draws it; the Workspace will too.
   * TODO: once OIDC lands, review who may read it and whether people's roles should go out to everyone.
   */
  app.get('/api/design', async (req) => {
    const user = who(req) // any named user; 401 otherwise
    return designFor(user)
  })

  // ----- Designing on the server: save the design, publish a workflow's draft, move items between versions -----
  // See docs/plans/2026-11-10-publish-to-server-design.md. A workflow's map is its draft and runs nothing until
  // published; the rest of the design is live once saved, so designs.ts refuses a save that would strand work.

  const roleOf = (user: Id) => rt.design.users.find((u) => u.id === user)?.roles ?? []
  const mayDesign = (user: Id) => roleOf(user).includes('admin') || roleOf(user).includes('designer')
  const designersOnly = 'Only a designer or an administrator can change the design.'

  /** The design as this person gets it, with its revision. Drafts are for designers: everyone else gets each workflow as published. */
  const designFor = (user: Id) => {
    const design = mayDesign(user) ? rt.design : { ...rt.design, apps: rt.design.apps.map((a) => ({ ...a, workflows: a.workflows.map((w) => runnable(w)) })) }
    return { ...designDto(design), revision: rt.designRevision }
  }

  /** The application's clock, or 0 for one this server doesn't hold yet. */
  const clockOf = (appId: Id) => {
    try {
      return rt.clockNow(appId)
    } catch {
      return 0
    }
  }

  const saveBody = z.object({ revision: z.number().int().min(0), design: z.unknown() })
  /** Save the design. A workflow's map is saved as its draft; everything else takes effect at once. */
  app.put('/api/design', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const user = who(req)
    if (!mayDesign(user)) return send(reply, refuse(403, designersOnly))
    const body = saveBody.parse(req.body)
    const sent = parseDesign(body.design)
    await rt.changeDesign(body.revision, (have) => {
      const states = have.apps.flatMap((a) => (rt.design.apps.some((x) => x.id === a.id) ? [{ appId: a.id, sim: rt.state(a.id) }] : []))
      return takeDesign(have, sent, { admin: roleOf(user).includes('admin') }, designUse(states), Math.max(0, ...have.apps.map((a) => clockOf(a.id))))
    })
    return { ok: true, value: designFor(user) }
  })

  const wfParams = z.object({ app: z.string(), wf: z.string() })
  const stepMap = z.record(z.string().max(200), z.string().max(200)).default({})
  const workflowOf = (appId: Id, wfId: Id) => rt.ctx(appId).app.workflows.find((w) => w.id === wfId)

  const publishBody = z.object({ revision: z.number().int().min(0), note: z.string().max(1000).default(''), who: z.enum(['new', 'all']).default('new'), stepMap })
  /**
   * Publish a workflow's saved draft as its next version. `new`: new items start on it and items in
   * flight finish where they are. `all` (administrators): the items in flight move onto it too; work
   * at a step the version removed goes where `stepMap` says, or the item stays and the answer says why.
   */
  app.post('/api/apps/:app/workflows/:wf/publish', async (req, reply) => {
    const { app: appId, wf: wfId } = wfParams.parse(req.params)
    const user = who(req)
    const b = publishBody.parse(req.body)
    if (!mayDesign(user)) return send(reply, refuse(403, 'Only a designer or an administrator can publish.'))
    if (b.who === 'all' && !roleOf(user).includes('admin')) return send(reply, refuse(403, 'Only an administrator can move items in flight onto a new version.'))
    if (!workflowOf(appId, wfId)) return send(reply, refuse(404, 'No such workflow.'))
    if (b.revision !== rt.designRevision) throw new DesignConflict(rt.designRevision)
    const name = nameOf(rt.ctx(appId), user)
    // In this order a server that stops partway leaves a state someone could have chosen: items pinned to the
    // versions they run, then the version published for new items, then the items in flight moved.
    await rt.run(appId, (sim, ctx) => pinInFlight(sim, ctx))
    let version = 0
    const revision = await rt.changeDesign(b.revision, (have) => {
      const a = have.apps.find((x) => x.id === appId)
      const wf = a?.workflows.find((w) => w.id === wfId)
      if (!a || !wf) throw new DesignRefused(409, 'That workflow no longer exists.')
      if (!hasDraftChanges(wf)) throw new DesignRefused(409, `The draft of ${wf.name} matches version ${publishedVersion(wf)}. Change the map and save it first.`)
      const next = publishWorkflow(wf, { at: clockOf(appId), note: b.note, by: name })
      version = next.published!
      return { ...have, apps: have.apps.map((x) => (x.id === appId ? { ...x, workflows: x.workflows.map((w) => (w.id === wfId ? next : w)) } : x)) }
    })
    if (b.who === 'new') return { ok: true, value: { revision, version } }
    const moved = await rt.run(appId, (sim, ctx) => migrateItems(sim, ctx, wfId, version, { stepMap: b.stepMap, actor: name }))
    // Published either way: a migration the engine refused is reported beside the version, not instead of it.
    return { ok: true, value: { revision, version, ...(moved.ok ? { migration: moved.value } : { migrationError: moved.error }) } }
  })

  /**
   * The items in flight that run a workflow, reduced to which version each runs and where its work is:
   * what the Studio's history, publish dialog and step mapping count. No item data.
   */
  app.get('/api/apps/:app/workflows/:wf/items', async (req, reply) => {
    const { app: appId, wf: wfId } = wfParams.parse(req.params)
    const user = who(req)
    if (!mayDesign(user) && !roleOf(user).includes('auditor')) return send(reply, refuse(403, 'Only a designer, an administrator or an auditor can see which versions items run.'))
    if (!workflowOf(appId, wfId)) return send(reply, refuse(404, 'No such workflow.'))
    return rt.read(appId, (sim) => ({ clock: rt.clockNow(appId), items: versionItems(sim, wfId) }))
  })

  const migrateBody = z.object({ toVersion: z.number().int().min(1), objectIds: z.array(z.string().max(200)).max(100_000).optional(), stepMap })
  /** Move items (all on other versions, or just `objectIds`) to a version of the workflow. */
  app.post('/api/apps/:app/workflows/:wf/migrate', async (req, reply) => {
    const { app: appId, wf: wfId } = wfParams.parse(req.params)
    const user = who(req)
    const b = migrateBody.parse(req.body)
    if (!roleOf(user).includes('admin')) return send(reply, refuse(403, 'Only an administrator can move items between versions.'))
    if (!workflowOf(appId, wfId)) return send(reply, refuse(404, 'No such workflow.'))
    return send(reply, await rt.run(appId, (sim, ctx) => migrateItems(sim, ctx, wfId, b.toVersion, { objectIds: b.objectIds, stepMap: b.stepMap, actor: nameOf(ctx, user) })))
  })

  const forecastBody = z.object({ who: z.enum(['new', 'all']).default('new'), stepMap, hours: z.number().min(1).max(48).default(8) })
  /**
   * Try the draft before publishing: a copy of the live state run forward twice with simulated people and
   * arrivals, as it is and with the draft published the way the dialog says. Nothing is written.
   */
  app.post('/api/apps/:app/workflows/:wf/forecast', async (req, reply) => {
    const { app: appId, wf: wfId } = wfParams.parse(req.params)
    const user = who(req)
    const b = forecastBody.parse(req.body ?? {})
    if (!mayDesign(user)) return send(reply, refuse(403, 'Only a designer or an administrator can try a draft.'))
    if (!workflowOf(appId, wfId)) return send(reply, refuse(404, 'No such workflow.'))
    const preview = await rt.read(appId, (sim, live) => {
      // As the Simulation would run it: the design's people and arrival rates, not the server's real ones.
      const design = ensureVersions(rt.design, sim.clock)
      const ctx: Ctx = { app: design.apps.find((a) => a.id === appId) ?? live.app, users: live.users, groups: live.groups, services: live.services }
      return previewPublish({ ...sim, arrivals: true }, ctx, wfId, { who: b.who, stepMap: b.stepMap, hours: b.hours })
    })
    return preview ? { ok: true, value: preview } : send(reply, refuse(404, 'That workflow has nothing published to compare with.'))
  })

  app.get('/api/apps', async () =>
    rt.design.apps.map((a) => ({ id: a.id, name: a.name, description: a.description, workflows: a.workflows.map((w) => ({ id: w.id, name: w.name, kind: w.kind ?? 'process' })) })),
  )

  /** Live counts per step: the same numbers the studio canvas shows. */
  app.get('/api/apps/:app/overview', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    return rt.read(appId, (sim, ctx) => {
      const v = viewOf(sim, ctx)
      return { clock: v.clock, active: v.active, completed: v.completed, rejected: v.rejected, stuck: v.stuck, overdue: v.overdue, bottleneckId: v.bottleneckId, steps: v.nodes, services: v.services }
    })
  })

  // ----- The Monitor: administrators only, read from memory -----

  const monitorOnly = 'Only an administrator can see the Monitor.'

  /** The Studio's Monitor view, ready made: its size grows with steps, people and services, not items. */
  app.get('/api/apps/:app/monitor', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const refused = requireAdmin(req, monitorOnly)
    if (refused) return send(reply, refused)
    return rt.read(appId, (sim, ctx) => ({ clock: sim.clock, view: viewOf(sim, ctx), expeditedByStep: expeditedByStep(sim), working: workingNow(sim) }))
  })

  /** Work in flight over time (a point every 15 sim minutes, the last 3000): only points after `since` when given. */
  const seriesQuery = z.object({ since: z.string().trim().min(1).pipe(z.coerce.number()).optional() })
  app.get('/api/apps/:app/monitor/series', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const refused = requireAdmin(req, monitorOnly)
    if (refused) return send(reply, refused)
    const { since } = seriesQuery.parse(req.query)
    return rt.read(appId, (sim) => ({ points: since === undefined ? sim.series.slice() : sim.series.filter((p) => p.t > since) }))
  })

  /** The activity feed, newest first (the engine keeps the last 300). */
  const feedQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).default(100) })
  app.get('/api/apps/:app/monitor/feed', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const refused = requireAdmin(req, monitorOnly)
    if (refused) return send(reply, refused)
    const { limit } = feedQuery.parse(req.query)
    return rt.read(appId, (sim) => ({ entries: sim.feed.slice(0, limit) }))
  })

  // The cursor is where the last row sorts. Sort keys never change, so later pages neither repeat
  // nor skip items that existed at the first; newer items sort before it and wait for a fresh read.
  const cursorKey = z.tuple([z.number(), z.string(), z.string()])
  const encodeCursor = (k: ExplorerKey) => Buffer.from(JSON.stringify([k.createdAt, k.number, k.id])).toString('base64url')
  const cursor = z
    .string()
    .max(1000)
    .transform((s, c): ExplorerKey => {
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(s, 'base64url').toString())
      } catch {}
      const key = cursorKey.safeParse(parsed)
      if (key.success) return { createdAt: key.data[0], number: key.data[1], id: key.data[2] }
      c.addIssue({ code: 'custom', message: 'Invalid cursor' })
      return z.NEVER
    })
  const itemsQuery = z.object({
    status: z.enum(['all', 'active', 'completed', 'rejected']).default('all'),
    type: z.string().max(200).optional(),
    step: z.string().max(200).optional(),
    assignee: z.string().max(200).optional(),
    q: z.string().max(500).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: cursor.optional(),
  })

  // Kept across requests (and commits): without it every search formats every item again.
  const explorerCaches = opts.explorerCaches ?? new Map<Id, ExplorerCache>()
  const explorerCacheFor = (appId: Id) => explorerCaches.get(appId) ?? explorerCaches.set(appId, explorerCache()).get(appId)!

  /** The item explorer over every item, newest first, with the Studio's filters and text search (core's explorer). */
  app.get('/api/apps/:app/monitor/items', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const refused = requireAdmin(req, monitorOnly)
    if (refused) return send(reply, refused)
    const f = itemsQuery.parse(req.query)
    return rt.read(appId, (sim, ctx) => {
      const r = exploreItems(sim, ctx, { status: f.status, typeId: f.type, stepId: f.step, assignee: f.assignee, q: f.q }, { limit: f.limit, after: f.cursor, cache: explorerCacheFor(appId) })
      const steps = explorerSteps(ctx.app)
      const last = r.items[r.items.length - 1]
      return { items: r.items.map((o) => explorerRow(o, ctx, sim.clock, steps)), total: r.total, ...(r.more && last ? { next: encodeCursor(last) } : {}) }
    })
  })

  /** The event log as OCEL 2.0 JSON, for process-mining tools. */
  app.get('/api/apps/:app/export/ocel', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    // The whole log is for the people who may read every item. It still leaves out the fields hidden from them.
    if (!roleOf(user).includes('admin') && !roleOf(user).includes('auditor')) return send(reply, refuse(403, 'Only an administrator or an auditor can export the event log.'))
    const log = await rt.read(appId, (sim, ctx) => exportOcel(sim, ctx, user))
    return reply.header('content-disposition', `attachment; filename="${appId}-ocel2.json"`).send(log)
  })

  // ----- Items -----

  // ----- Uploaded files -----

  const objectTypeOf = (appId: Id, typeId: Id | undefined) => rt.ctx(appId).app.objectTypes.find((t) => t.id === typeId)

  /** The files a save or release names, checked against the item the work belongs to. */
  async function workFiles(appId: Id, workItemId: Id, user: Id, patch: Record<string, unknown>) {
    const held = await rt.read(appId, (sim) => {
      const obj = findToken(sim, workItemId)?.obj
      return obj ? { itemId: obj.id, typeId: obj.typeId, data: obj.data } : undefined
    })
    const type = held && objectTypeOf(appId, held.typeId)
    if (!held || !type) return { data: patch, ids: [] as Id[], itemId: undefined }
    return { ...(await takeFiles(rt.files, fileSettings, appId, user, type, patch, held)), itemId: held.itemId }
  }

  /**
   * The files a job's outputs name. An output stored on a file field must name files its worker
   * uploaded (or ones already there); on any other field a value is never read as a file.
   */
  async function jobFiles(appId: Id, tokenId: Id, user: Id, outputs: Record<string, unknown>) {
    const held = await rt.read(appId, (sim, ctx) => {
      const found = findToken(sim, tokenId)
      // The step as drawn and as every published version has it: an output any of them stores on a file field is checked.
      const mapped = !found
        ? []
        : ctx.app.workflows
            .flatMap((w) => [...w.nodes, ...(w.versions ?? []).flatMap((v) => v.snapshot.nodes)])
            .flatMap((n) => (n.id === found.tok.nodeId && n.type === 'auto' ? (n.data.outputs ?? []) : []))
      return found ? { itemId: found.obj.id, typeId: found.obj.typeId, data: found.obj.data, mapped } : undefined
    })
    const type = held && objectTypeOf(appId, held.typeId)
    if (!held || !type) return { outputs, ids: [] as Id[], itemId: undefined }
    const fileFields = new Set(type.fields.filter((f) => f.type === 'attachment').map((f) => f.id))
    const toFiles = held.mapped.filter((m) => fileFields.has(m.fieldId) && m.key in outputs)
    if (!toFiles.length) return { outputs, ids: [] as Id[], itemId: held.itemId }
    const taken = await takeFiles(rt.files, fileSettings, appId, user, type, Object.fromEntries(toFiles.map((m) => [m.fieldId, outputs[m.key]])), held)
    return { outputs: { ...outputs, ...Object.fromEntries(toFiles.map((m) => [m.key, taken.data[m.fieldId]])) }, ids: taken.ids, itemId: held.itemId }
  }

  /** After a commit: the item now has those of the files its data holds (a locked field's files are not among them). */
  async function keepFiles(appId: Id, itemId: Id, ids: Id[]) {
    if (!ids.length) return
    const now = await rt.read(appId, (sim) => {
      const obj = sim.objects[itemId]
      const type = obj && objectTypeOf(appId, obj.typeId)
      return obj && type ? heldNow(type, obj.data, ids) : []
    })
    await rt.files.attach(appId, now, itemId)
  }

  // An upload is the file's bytes as the body (`application/octet-stream`), its name and kind in the query.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  const uploadQuery = z.object({ name: z.string().max(500).optional(), kind: z.string().max(200).optional() })
  app.post('/api/apps/:app/files', { bodyLimit: fileSettings.maxMb * 1024 * 1024 }, async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const ctx = rt.ctx(appId)
    if (!ctx.users.some((u) => u.id === user)) return send(reply, refuse(403, 'Only people in the design can upload files.'))
    const q = uploadQuery.parse(req.query)
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ ok: false, error: 'Send the file’s bytes as application/octet-stream, with its name and kind in the query.' })
    if (!req.body.byteLength) return reply.code(400).send({ ok: false, error: 'That file is empty.' })
    return reply.code(201).send({ ok: true, value: await storeUpload(rt.files, appId, user, { name: q.name, kind: q.kind, bytes: req.body }) })
  })

  const inlineQuery = z.object({ inline: z.string().optional() })
  const noFile = { ok: false, error: 'No such file.' }
  // A file on an item: for whoever may read the field it is in, as the item stands now.
  app.get('/api/apps/:app/items/:itemId/files/:fileId', async (req, reply) => {
    const { app: appId, itemId, fileId } = z.object({ app: z.string(), itemId: z.string(), fileId: z.string() }).parse(req.params)
    const user = who(req)
    const visible = await rt.read(appId, (sim, ctx) => {
      const obj = findItem(sim, itemId)
      if (!obj || !canRead(sim, ctx, obj, user)) return undefined
      const type = objectTypeOf(appId, obj.typeId)
      // The data as this person sees it: a hidden field's files are not in it.
      return type && fileRefs(type, itemDto(obj, ctx, user, sim).data).some((r) => r.file.id === fileId) ? obj.id : undefined
    })
    const found = visible ? await rt.files.read(appId, fileId) : undefined
    if (!found || found.file.itemId !== visible) return reply.code(404).send(noFile)
    return sendFile(reply, found.file, found.bytes, inlineQuery.parse(req.query).inline === '1')
  })
  // A file its uploader has not put on an item yet (the form is still open).
  app.get('/api/apps/:app/files/:fileId', async (req, reply) => {
    const { app: appId, fileId } = z.object({ app: z.string(), fileId: z.string() }).parse(req.params)
    const user = who(req)
    rt.ctx(appId)
    const found = await rt.files.read(appId, fileId)
    if (!found || found.file.itemId || found.file.uploadedBy !== user) return reply.code(404).send(noFile)
    return sendFile(reply, found.file, found.bytes, inlineQuery.parse(req.query).inline === '1')
  })

  const createBody = z.object({ workflowId: z.string(), data: z.record(z.string(), z.unknown()).default({}) })
  app.post('/api/apps/:app/items', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const body = createBody.parse(req.body)
    // Files the new item names: checked, and described from storage, before the command runs.
    const type = objectTypeOf(appId, rt.ctx(appId).app.workflows.find((w) => w.id === body.workflowId)?.objectTypeId)
    const taken = type ? await takeFiles(rt.files, fileSettings, appId, user, type, body.data) : { data: body.data, ids: [] }
    body.data = taken.data
    // Decided inside the command, answered only once it has committed: a failed commit must reach the error handler (503).
    const r = await rt.run(appId, (sim, ctx) => {
      if (!canCreate(ctx, body.workflowId, user)) return refuse(403, 'You can’t create items in that workflow.')
      const refused = createRefusals(ctx, body.workflowId, user, body.data)
      if (refused.length) return refuse(403, `You can’t set ${refused.map((r) => r.field.label).join(', ')} (${refused[0]!.reason}).`)
      const obj = createObject(sim, ctx, body.workflowId, body.data, user)
      if (!obj) return refuse(404, 'Unknown workflow.')
      return { created: itemDto(obj, ctx, user, sim) }
    })
    if ('refused' in r) return send(reply, r)
    await keepFiles(appId, r.created.id, taken.ids)
    return reply.code(201).send({ ok: true, value: r.created })
  })

  /** One item by id or number, as the caller may see it (404 when they can't see it at all). */
  app.get('/api/apps/:app/items/:itemId', async (req, reply) => {
    const { app: appId, itemId } = itemParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => {
      const obj = findItem(sim, itemId)
      return obj && canRead(sim, ctx, obj, user) ? itemDto(obj, ctx, user, sim) : reply.code(404).send({ ok: false, error: 'No such item.' })
    })
  })

  /** Expedite (or stop expediting) an item, under its workflow's policy. */
  const expediteBody = z.object({ on: z.boolean().default(true), reason: z.string().max(500).default('') })
  app.post('/api/apps/:app/items/:itemId/expedite', async (req, reply) => {
    const { app: appId, itemId } = itemParams.parse(req.params)
    const user = who(req)
    const b = expediteBody.parse(req.body ?? {})
    const r = await rt.run(appId, (sim, ctx): Result | Refusal => {
      const obj = findItem(sim, itemId)
      if (!obj || !canRead(sim, ctx, obj, user)) return refuse(404, 'No such item.')
      if (obj.status !== 'active') return { ok: false, error: `${obj.number} is already finished.` }
      const verdict = setExpedite(sim, ctx, obj.id, user, b.on, b.reason)
      // Refused by the policy (who may expedite) rather than by the state of the item.
      if (!verdict.ok && !canExpedite(sim, ctx, obj.id, user)) return refuse(403, verdict.error)
      return verdict
    })
    return send(reply, r)
  })

  /** Change an item's priority: its requester, or whoever is working it. */
  const priorityBody = z.object({ priority: z.enum(['low', 'normal', 'high', 'urgent']) })
  app.post('/api/apps/:app/items/:itemId/priority', async (req, reply) => {
    const { app: appId, itemId } = itemParams.parse(req.params)
    const user = who(req)
    const b = priorityBody.parse(req.body)
    const r = await rt.run(appId, (sim, ctx): Result | Refusal => {
      const obj = findItem(sim, itemId)
      if (!obj || !canRead(sim, ctx, obj, user)) return refuse(404, 'No such item.')
      return workSetPriority(sim, ctx, obj.id, user, b.priority)
    })
    return send(reply, r)
  })

  // ----- Search -----

  const searchQuery = z.object({
    q: z.string().max(500).default(''),
    sort: z.enum(['relevance', 'newest', 'due', 'priority']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })

  /** Free text plus filters (see core search.ts for the language), scoped to what the caller may see. */
  app.get('/api/apps/:app/search', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const q = searchQuery.parse(req.query)
    return rt.read(appId, (sim, ctx) => {
      const r = searchItems(sim, ctx, q.q, { userId: user, sort: q.sort, limit: q.limit })
      return { query: q.q, total: r.total, hits: r.hits.map((h) => hitDto(h, sim, ctx, user)), facets: r.facets }
    })
  })

  // ----- Assistant -----

  const askBody = z.object({
    question: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(8000) }))
      .max(40)
      .default([]),
  })

  /** Ask Modus: Claude with read-only tools when ANTHROPIC_API_KEY is set, else the built-in interpreter. */
  app.post('/api/apps/:app/assistant', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const b = askBody.parse(req.body)
    rt.ctx(appId) // an unknown application is a 404 before any model call
    return answer({ rt, model: opts.assistant, log: req.log }, appId, user, b.question, b.history)
  })

  // ----- The Workspace: one person's share of the state, as they may see it -----
  // The Studio's Workspace runs the engine's read models (basket, queues, dispatch board, requests,
  // supervision) over this, so the pages are the same ones the simulation uses. Fields a person may
  // not see are left out here, on the server (core's workspaceItem).

  /**
   * How much work the caller's colleagues have open and whether they are working now, for the pickers
   * (delegate, hand out, reassign). Only the people core's workspaceColleagues names: their teams, and
   * the groups whose work they hand out or supervise.
   */
  const loadsOf = (sim: SimState, ctx: Ctx, user: Id) => {
    const users = viewOf(sim, ctx).users
    const out: Record<Id, { open: number; working: boolean }> = {}
    for (const id of workspaceColleagues(ctx, user)) if (users[id]) out[id] = { open: users[id].open, working: users[id].working }
    return out
  }

  /** Everything in the caller's Workspace: active work that reaches them, and the requests they made. */
  app.get('/api/apps/:app/workspace', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => ({ ...workspaceSlice(sim, ctx, user), clock: rt.clockNow(appId), loads: loadsOf(sim, ctx, user) }))
  })

  const idList = (max: number) =>
    z
      .string()
      .max(40_000)
      .default('')
      .transform((s) => s.split(',').filter(Boolean))
      .pipe(z.array(z.string().max(200)).max(max))
  const workspaceItemsQuery = z.object({ ids: idList(500), pin: idList(100) })

  /**
   * Items that changed (`ids`, from the live stream), as the caller may see them now; those that left
   * their Workspace come back in `gone`. `pin` names items they opened from a search: kept while readable.
   */
  app.get('/api/apps/:app/workspace/items', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const q = workspaceItemsQuery.parse(req.query)
    return rt.read(appId, (sim, ctx) => ({ ...workspaceItems(sim, ctx, user, q.ids, q.pin), clock: rt.clockNow(appId), loads: loadsOf(sim, ctx, user) }))
  })

  /** A hit with its item as the caller may see it, so the Workspace can show and open it. */
  const workspaceHit = (h: SearchHit, sim: SimState, ctx: Ctx, user: Id) => ({ ...h, obj: workspaceItem(sim, ctx, h.obj, user) })

  /** The Workspace's search: core's result as it is, over every item the caller may read. */
  app.get('/api/apps/:app/workspace/search', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const q = searchQuery.parse(req.query)
    return rt.read(appId, (sim, ctx) => {
      const r = searchItems(sim, ctx, q.q, { userId: user, sort: q.sort, limit: q.limit })
      return { ...r, hits: r.hits.map((h) => workspaceHit(h, sim, ctx, user)) }
    })
  })

  /** Ask Modus as the Workspace shows it: the built-in assistant's reply, with the items it found. */
  app.post('/api/apps/:app/workspace/ask', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    const { question } = z.object({ question: z.string().trim().max(2000) }).parse(req.body)
    return rt.read(appId, (sim, ctx) => {
      const r = ask(sim, ctx, question, { userId: user })
      return { ...r, hits: r.hits?.map((h) => workspaceHit(h, sim, ctx, user)) }
    })
  })

  // ----- My work (the workbasket) -----

  app.get('/api/apps/:app/my/basket', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => basketOf(sim, ctx, user).map((i) => workItemDto(i, ctx, user)))
  })

  app.get('/api/apps/:app/my/queues', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => queuesFor(sim, ctx, user).map((q) => ({ stepId: q.nodeId, label: q.label, group: q.groupName, waiting: q.items.map((i) => workItemDto(i, ctx, user)) })))
  })

  app.get('/api/apps/:app/my/distribution', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) =>
      distributionFor(sim, ctx, user).map((d) => ({
        stepId: d.nodeId,
        label: d.label,
        group: d.groupName,
        waiting: d.waiting.map((i) => workItemDto(i, ctx, user)),
        assigned: d.assigned.map((i) => workItemDto(i, ctx, user)),
      })),
    )
  })

  app.get('/api/apps/:app/my/requests', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => requestsBy(sim, ctx, user).map((r) => ({ itemId: r.obj.id, number: r.obj.number, status: r.obj.status, where: r.where, due: r.due, overdue: r.overdue })))
  })

  /** What the caller supervises: their processes and every people step they oversee, with the work there now. */
  app.get('/api/apps/:app/my/supervision', async (req) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return rt.read(appId, (sim, ctx) => {
      const s = supervisionFor(sim, ctx, user)
      return {
        processes: s.processes,
        steps: s.steps.map((st) => ({
          stepId: st.nodeId,
          label: st.label,
          path: st.path,
          workflowId: st.workflowId,
          groupId: st.groupId,
          escalated: st.escalated.length,
          items: st.items.map((i) => workItemDto(i, ctx, user)),
        })),
      }
    })
  })

  app.post('/api/apps/:app/my/next', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    const user = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => workNext(sim, ctx, user)))
  })

  // ----- Acting on a work item -----

  app.post('/api/apps/:app/work/:workItemId/claim', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => workClaim(sim, ctx, workItemId, user)))
  })

  app.post('/api/apps/:app/work/:workItemId/start', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => workStart(sim, ctx, workItemId, user)))
  })

  const patchBody = z.object({ patch: z.record(z.string(), z.unknown()).default({}) })
  app.post('/api/apps/:app/work/:workItemId/save', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const { patch } = patchBody.parse(req.body ?? {})
    const taken = await workFiles(appId, workItemId, user, patch)
    const r = await rt.run(appId, (sim, ctx) => workSave(sim, ctx, workItemId, user, taken.data))
    if (r.ok && taken.itemId) await keepFiles(appId, taken.itemId, taken.ids)
    return send(reply, r)
  })

  const releaseBody = z.object({ outcomeId: z.string(), comment: z.string().default(''), patch: z.record(z.string(), z.unknown()).default({}) })
  app.post('/api/apps/:app/work/:workItemId/release', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const b = releaseBody.parse(req.body)
    const taken = await workFiles(appId, workItemId, user, b.patch)
    const r = await rt.run(appId, (sim, ctx) => workRelease(sim, ctx, workItemId, user, b.outcomeId, b.comment, taken.data))
    if (r.ok && taken.itemId) await keepFiles(appId, taken.itemId, taken.ids)
    return send(reply, r)
  })

  app.post('/api/apps/:app/work/:workItemId/return', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const { comment } = z.object({ comment: z.string().default('') }).parse(req.body ?? {})
    return send(reply, await rt.run(appId, (sim, ctx) => workReturn(sim, ctx, workItemId, user, comment)))
  })

  app.post('/api/apps/:app/work/:workItemId/delegate', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const b = z.object({ to: z.string(), comment: z.string().default('') }).parse(req.body)
    return send(reply, await rt.run(appId, (sim, ctx) => workDelegate(sim, ctx, workItemId, user, b.to, b.comment)))
  })

  app.post('/api/apps/:app/work/:workItemId/distribute', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const b = z.object({ to: z.string() }).parse(req.body)
    return send(reply, await rt.run(appId, (sim, ctx) => workDistribute(sim, ctx, workItemId, user, b.to)))
  })

  /** A dispatcher spreads everything waiting at a step evenly across its available members. */
  app.post('/api/apps/:app/my/distribution/:stepId/evenly', async (req, reply) => {
    const { app: appId, stepId } = z.object({ app: z.string(), stepId: z.string() }).parse(req.params)
    const user = who(req)
    const r = await rt.run(appId, (sim, ctx): Result<number> | Refusal => {
      if (buildIndex(ctx).node.get(stepId)?.node.type !== 'user') return refuse(404, 'No such people step.')
      return workDistributeEvenly(sim, ctx, stepId, user)
    })
    return send(reply, r)
  })

  // ----- Supervisors: the administrator's levers, scoped to the work they supervise -----
  // 404 for no such active work item, 403 when the caller doesn't supervise it,
  // 409 when the engine refuses (for example, reassigning outside the step's group).

  const toBody = z.object({ to: z.string() })
  app.post('/api/apps/:app/supervise/:workItemId/assign', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const b = toBody.parse(req.body)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, user) ?? superviseAssign(sim, ctx, workItemId, b.to, user)))
  })

  app.post('/api/apps/:app/supervise/:workItemId/return', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, user) ?? superviseReturn(sim, ctx, workItemId, user)))
  })

  const superviseReleaseBody = z.object({ outcomeId: z.string(), comment: z.string().default('') })
  app.post('/api/apps/:app/supervise/:workItemId/release', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    const b = superviseReleaseBody.parse(req.body)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, user) ?? superviseRelease(sim, ctx, workItemId, b.outcomeId, b.comment, user)))
  })

  app.post('/api/apps/:app/supervise/:workItemId/retry', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const user = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, user) ?? superviseRetry(sim, ctx, workItemId, user)))
  })

  /** Even out everything not yet being worked at a step across its available members. */
  app.post('/api/apps/:app/supervise/steps/:stepId/redistribute', async (req, reply) => {
    const { app: appId, stepId } = z.object({ app: z.string(), stepId: z.string() }).parse(req.params)
    const user = who(req)
    const r = await rt.run(appId, (sim, ctx): Result<number> | Refusal => {
      const idx = buildIndex(ctx)
      if (idx.node.get(stepId)?.node.type !== 'user') return refuse(404, 'No such people step.')
      if (!supervisesStep(idx, stepId, user)) return refuse(403, 'Only an administrator or a supervisor of this step can redistribute it.')
      return superviseRedistribute(sim, ctx, stepId, user)
    })
    return send(reply, r)
  })

  /** Change the priority of an active item the caller supervises. */
  app.post('/api/apps/:app/supervise/items/:itemId/priority', async (req, reply) => {
    const { app: appId, itemId } = itemParams.parse(req.params)
    const user = who(req)
    const b = priorityBody.parse(req.body)
    const r = await rt.run(appId, (sim, ctx): Result | Refusal => {
      const obj = findItem(sim, itemId)
      if (!obj || obj.status !== 'active') return refuse(404, 'No such active item.')
      if (!supervisesItem(buildIndex(ctx), obj, user)) return refuse(403, 'Only an administrator or a supervisor of this item can change its priority here.')
      return superviseSetPriority(sim, ctx, obj.id, b.priority, user)
    })
    return send(reply, r)
  })

  // ----- Administration: administrators, or supervisors of that work -----

  app.post('/api/apps/:app/admin/work/:workItemId/assign', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const actor = who(req)
    const b = z.object({ to: z.string(), sameGroupOnly: z.boolean().default(true) }).parse(req.body)
    return send(
      reply,
      await rt.run(appId, (sim, ctx) => {
        const no = supervisedBy(sim, ctx, workItemId, actor)
        if (no) return no
        // Only administrators may reassign outside the step's group.
        const sameGroupOnly = hasRole(buildIndex(ctx), actor, 'admin') ? b.sameGroupOnly : true
        return adminAssign(sim, ctx, workItemId, b.to, nameOf(ctx, actor), { sameGroupOnly })
      }),
    )
  })

  app.post('/api/apps/:app/admin/work/:workItemId/move', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const actor = who(req)
    const b = z.object({ stepId: z.string() }).parse(req.body)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, actor) ?? adminMove(sim, ctx, workItemId, b.stepId, nameOf(ctx, actor))))
  })

  app.post('/api/apps/:app/admin/work/:workItemId/retry', async (req, reply) => {
    const { app: appId, workItemId } = workParams.parse(req.params)
    const actor = who(req)
    return send(reply, await rt.run(appId, (sim, ctx) => supervisedBy(sim, ctx, workItemId, actor) ?? adminRetry(sim, ctx, workItemId, nameOf(ctx, actor))))
  })

  // ----- The outbox: administrators only -----
  // Deliveries carry the endpoint's name only, never its URL or secret.

  const outboxOnly = 'Only an administrator can see or retry outbox deliveries.'
  const outboxQuery = z.object({ status: z.enum(['pending', 'delivered', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
  app.get('/api/admin/outbox', async (req, reply) => {
    const refused = requireAdmin(req, outboxOnly)
    if (refused) return send(reply, refused)
    const filter = outboxQuery.parse(req.query)
    return { deliveries: await rt.deliveries.list(filter) }
  })

  app.post('/api/admin/outbox/:id/retry', async (req, reply) => {
    const refused = requireAdmin(req, outboxOnly)
    if (refused) return send(reply, refused)
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params)
    if (!(await rt.deliveries.retry(id, Date.now()))) return send(reply, refuse(404, 'That message has no failed deliveries.'))
    void opts.sender?.wake()
    return { ok: true }
  })

  // ----- Workers: the job protocol for registered services ("devices") -----
  // Job ids are "<appId>:<workItemId>" because services are shared by every application.

  const pollBody = z.object({ serviceId: z.string(), workerId: z.string(), max: z.number().int().min(1).max(100).default(1), leaseSeconds: z.number().int().min(5).max(3600).default(300) })
  // A job's outputs are written onto the item and can route it, so only the service's own workers
  // (the people it lists, machine accounts as a rule) and administrators may take or answer one.
  const workersOnly = 'Only an administrator, or a person the service lists as one of its workers, can take or finish its jobs.'
  const mayWork = (serviceId: Id, user: Id) => canWorkService(rt.design, serviceId, user)

  app.post('/api/jobs/poll', async (req, reply) => {
    const b = pollBody.parse(req.body)
    if (!mayWork(b.serviceId, who(req))) return send(reply, refuse(403, workersOnly))
    // Leases are on the application's clock; a worker means real seconds, whatever the time scale.
    const lease = (b.leaseSeconds / 60) * rt.timeScale
    const jobs = []
    for (const a of rt.design.apps) {
      if (jobs.length >= b.max) break
      // Checked on the cache first, so idle workers polling every second don't lock and write every application.
      // Leases are compared with the clock as of now (the cached one lags on a quiet application). A stale
      // cache can still lead to a commit that claims nothing (another replica took the job): harmless.
      if (!(await rt.read(a.id, (sim) => activeTokens(sim).some((t) => openJob(sim, t, b.serviceId, rt.clockNow(a.id)))))) continue
      const got = await rt.run(a.id, (sim, ctx) => pollJobs(sim, ctx, b.serviceId, b.workerId, b.max - jobs.length, lease))
      jobs.push(...got.map((j) => ({ ...j, id: `${a.id}:${j.id}`, appId: a.id })))
    }
    return { jobs }
  })

  function jobParams(req: FastifyRequest) {
    const { jobId } = z.object({ jobId: z.string() }).parse(req.params)
    const at = jobId.indexOf(':')
    if (at < 1) throw new NotFound('Unknown job.')
    return { appId: jobId.slice(0, at), tokenId: jobId.slice(at + 1) }
  }

  app.post('/api/jobs/:jobId/complete', async (req, reply) => {
    const { appId, tokenId } = jobParams(req)
    const { outputs } = z.object({ outputs: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {})
    const user = who(req)
    // A job's result may put files on the item (a generated letter): the same rules as a person's.
    const taken = await jobFiles(appId, tokenId, user, outputs)
    const done = await rt.run(appId, (sim, ctx) => {
      const serviceId = jobService(sim, tokenId)
      if (serviceId && !mayWork(serviceId, user)) return refuse(403, workersOnly)
      return completeJob(sim, ctx, tokenId, taken.outputs)
    })
    if (done === true && taken.itemId) await keepFiles(appId, taken.itemId, taken.ids)
    if (typeof done === 'object') return send(reply, done)
    return done ? reply.send({ ok: true }) : reply.code(410).send({ ok: false, error: 'That job is no longer open (finished, cancelled or taken over by a person).' })
  })

  app.post('/api/jobs/:jobId/fail', async (req, reply) => {
    const { appId, tokenId } = jobParams(req)
    const { error } = z.object({ error: z.string().default('failed') }).parse(req.body ?? {})
    const user = who(req)
    const done = await rt.run(appId, (sim, ctx) => {
      const serviceId = jobService(sim, tokenId)
      if (serviceId && !mayWork(serviceId, user)) return refuse(403, workersOnly)
      return failJob(sim, ctx, tokenId, error)
    })
    if (typeof done === 'object') return send(reply, done)
    return done ? reply.send({ ok: true }) : reply.code(410).send({ ok: false, error: 'That job is no longer open.' })
  })

  // ----- Live stream (Server-Sent Events): counts per step and which items changed -----

  const streams = new Map<FastifyReply, { ping: NodeJS.Timeout; unsubscribe: () => void }>()
  const pingMs = opts.streamPingMs ?? 25_000
  // Open streams would otherwise hold a graceful shutdown until the orchestrator kills the process.
  app.addHook('preClose', async () => {
    for (const [s, { ping, unsubscribe }] of streams) {
      clearInterval(ping)
      unsubscribe()
      s.raw.end()
    }
    streams.clear()
  })

  app.get('/api/apps/:app/stream', async (req, reply) => {
    const { app: appId } = appParams.parse(req.params)
    // Any named user, like the design: events carry ids and counts, never data the caller may not read.
    // Checked before the headers go out, so a stranger gets a 401 rather than an open stream.
    void who(req)
    rt.ctx(appId)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // writeHead only queues the headers; the first write sends them, so the client sees the stream open now.
    reply.raw.write(': connected\n\n')
    // Proxies cut idle connections (often after 60 s); a comment line keeps a quiet stream alive.
    // A slow client's buffer is already full: a ping adds nothing, so skip it rather than queue more.
    const ping = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed || reply.raw.writableNeedDrain) return
      reply.raw.write(': ping\n\n')
    }, pingMs)
    ping.unref()
    const live = liveChanges(reply.raw, () =>
      rt.read(appId, (sim, ctx) => {
        const v = viewOf(sim, ctx)
        return { clock: sim.clock, counts: Object.fromEntries(Object.entries(v.nodes).map(([id, m]) => [id, m.total])), active: v.active }
      }),
      { onError: (err) => reply.log.error({ err }, 'live stream: reading the view failed') },
    )
    let last = 0
    const unsubscribe = rt.subscribe((c) => {
      if (c.appId !== appId) return
      const now = Date.now()
      if (!c.itemIds.length && now - last < 1000) return
      last = now
      live.change(c.clock, c.itemIds)
    })
    // The design changed (saved, published, or reloaded from another server): the page reloads it.
    const unsubscribeDesign = rt.subscribeDesign((revision) => {
      if (reply.raw.writableEnded || reply.raw.destroyed || reply.raw.writableNeedDrain) return
      reply.raw.write(`event: design\ndata: ${JSON.stringify({ revision })}\n\n`)
    })
    streams.set(reply, { ping, unsubscribe: () => (unsubscribe(), unsubscribeDesign()) })
    req.raw.on('close', () => {
      unsubscribeDesign()
      unsubscribe()
      clearInterval(ping)
      streams.delete(reply)
    })
    return reply
  })

  return app
}
