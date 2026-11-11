// The Studio's client for a Modus server: detection, the Monitor's read endpoints, the Workspace's
// reads and commands, and the live stream.
// Browser-only APIs (fetch, ReadableStream, TextDecoder): the same file runs in Vitest on Node.
// Who the Studio acts as goes in the `x-user-id` header; a server that signs people in (oidc) goes by
// its session cookie and ignores it. The browser sends the cookie by itself.

import type { AssistantReply, Design, ExplorerRow, FeedEntry, Id, Migration, PublishPreview, Result, SearchResult, ServiceDef, SimObject, SimState, SimView, WorkingOn } from '@modus-bpm/core'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ApiOptions {
  user: Id
  fetch?: Fetch
  signal?: AbortSignal
}

/**
 * The design as the server sends it: services without their connection details, and the revision it
 * is at. Designers and administrators get each workflow's draft; everyone else gets it as published.
 */
export type ServerDesign = Omit<Design, 'services'> & { services: Array<Pick<ServiceDef, 'id' | 'name' | 'kind' | 'description' | 'concurrency' | 'status' | 'operations'>>; revision?: number }

export interface MonitorSnapshot {
  clock: number
  view: SimView
  expeditedByStep: Record<Id, number>
  working: Record<Id, WorkingOn>
}

export type SeriesPoint = SimState['series'][number]

export type ItemStatus = 'all' | 'active' | 'completed' | 'rejected'

export interface ItemFilters {
  status: ItemStatus
  type?: Id
  step?: Id
  assignee?: Id
  q: string
}

export interface ItemsPage {
  items: ExplorerRow[]
  total: number
  /** Present when there are more rows after these. */
  next?: string
}

/** One `change` event of the stream. `items: null` means "too much changed: refetch everything". */
export interface ChangeEvent {
  clock: number
  items: Id[] | null
  counts: Record<Id, number>
  active: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Is the Studio served by a Modus server? One GET /api/health: a static host (Pages, `vite dev`) answers
 * with HTML or 404, and an unreachable one times out. Never throws.
 */
export async function detectServer(f: Fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await f('/api/health', { signal: ctl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return false
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** How the server signs people in, and whether this browser is signed in (GET /api/session). */
export interface ServerSession {
  auth: 'none' | 'password' | 'oidc'
  signedIn: boolean
  /** The Studio says who it acts as (`x-user-id`); false when the server knows (oidc). */
  choose: boolean
  user?: { id: Id; name: string }
  /** Where to send the browser to sign in (oidc). */
  signIn?: string
}

/** The server's session. A server from before sign-in existed has no such route: that reads as `none`. */
export async function getSession(f: Fetch = fetch): Promise<ServerSession> {
  const res = await f('/api/session', { headers: { accept: 'application/json' } })
  const body: unknown = res.ok ? await res.json() : undefined
  const s = body as Partial<ServerSession> | undefined
  if (!s || (s.auth !== 'password' && s.auth !== 'oidc')) return { auth: 'none', signedIn: true, choose: true }
  return { auth: s.auth, signedIn: s.signedIn === true, choose: s.choose !== false, user: s.user, signIn: s.signIn }
}

/** Sign in with the server's shared password. Returns what went wrong, or nothing when in. */
export async function passwordSignIn(password: string, f: Fetch = fetch): Promise<string | undefined> {
  try {
    const res = await f('/api/session', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    if (res.ok) return undefined
    const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined
    return typeof body?.error === 'string' ? body.error : 'The server didn’t accept that.'
  } catch {
    return 'The server couldn’t be reached. Try again.'
  }
}

export async function signOut(f: Fetch = fetch): Promise<void> {
  await f('/api/session', { method: 'DELETE', headers: { accept: 'application/json' } }).catch(() => {})
}

let unauthorized: (() => void) | undefined
/** Hear when the server answers 401 (the sign-in may have run out). One listener: the session store. */
export const onUnauthorized = (cb: () => void) => void (unauthorized = cb)

/** A GET as `o.user`; an error answer throws an ApiError with the server's message. */
async function request(path: string, o: ApiOptions): Promise<Response> {
  const res = await (o.fetch ?? fetch)(path, { signal: o.signal, headers: { accept: 'application/json', 'x-user-id': o.user } })
  if (res.status === 401) unauthorized?.()
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim()
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown }
      if (typeof body.error === 'string') message = body.error
      else if (typeof body.message === 'string') message = body.message
    } catch {}
    throw new ApiError(res.status, message)
  }
  return res
}

export async function api<T>(path: string, o: ApiOptions): Promise<T> {
  return (await (await request(path, o)).json()) as T
}

const appPath = (appId: Id) => `/api/apps/${encodeURIComponent(appId)}`

export const getDesign = (o: ApiOptions) => api<ServerDesign>('/api/design', o)

export const getMonitor = (appId: Id, o: ApiOptions) => api<MonitorSnapshot>(`${appPath(appId)}/monitor`, o)

/** Points after `since` only, when given. */
export const getSeries = (appId: Id, since: number | undefined, o: ApiOptions) =>
  api<{ points: SeriesPoint[] }>(`${appPath(appId)}/monitor/series${since === undefined ? '' : `?since=${since}`}`, o)

/** Newest first. */
export const getFeed = (appId: Id, limit: number, o: ApiOptions) => api<{ entries: FeedEntry[] }>(`${appPath(appId)}/monitor/feed?limit=${limit}`, o)

/** The event log as OCEL 2.0 JSON, as a file to save (a plain link can't send `x-user-id`). */
export const getOcel = async (appId: Id, o: ApiOptions) => (await request(`${appPath(appId)}/export/ocel`, o)).blob()

export function getItems(appId: Id, f: ItemFilters, page: { limit: number; cursor?: string }, o: ApiOptions) {
  const q = new URLSearchParams({ status: f.status, limit: String(page.limit) })
  if (f.type) q.set('type', f.type)
  if (f.step) q.set('step', f.step)
  if (f.assignee) q.set('assignee', f.assignee)
  if (f.q) q.set('q', f.q)
  if (page.cursor) q.set('cursor', page.cursor)
  return api<ItemsPage>(`${appPath(appId)}/monitor/items?${q}`, o)
}

// ---------- The Workspace ----------

/** How much work each person has open, and whether they are working now. */
export type Loads = Record<Id, { open: number; working: boolean }>

/** One person's share of an application's state, as they may see it (core's `workspaceSlice`). */
export interface WorkspacePayload {
  clock: number
  items: SimObject[]
  /** Finished requests of theirs the server left out (it sends the newest). */
  olderRequests: number
  loads: Loads
}

/** Items that changed, as the person may see them now; `gone` have left their Workspace. */
export interface WorkspaceChanges {
  clock: number
  items: SimObject[]
  gone: Id[]
  loads: Loads
}

export const getWorkspace = (appId: Id, o: ApiOptions) => api<WorkspacePayload>(`${appPath(appId)}/workspace`, o)

/** `ids` changed (from the stream); `pin` are items opened from a search, kept while they may be read. */
export function getWorkspaceItems(appId: Id, ids: Id[], pin: Id[], o: ApiOptions) {
  const q = new URLSearchParams()
  if (ids.length) q.set('ids', ids.join(','))
  if (pin.length) q.set('pin', pin.join(','))
  return api<WorkspaceChanges>(`${appPath(appId)}/workspace/items?${q}`, o)
}

export type SearchSort = 'relevance' | 'newest' | 'due' | 'priority'

/** The engine's search over everything the person may read on the server, each hit with its item. */
export function searchWorkspace(appId: Id, query: string, opts: { sort?: SearchSort; limit: number }, o: ApiOptions) {
  const q = new URLSearchParams({ q: query, limit: String(opts.limit) })
  if (opts.sort) q.set('sort', opts.sort)
  return api<SearchResult>(`${appPath(appId)}/workspace/search?${q}`, o)
}

/** A POST with a JSON body, as `o.user`. */
function post(path: string, body: unknown, o: ApiOptions): Promise<Response> {
  return (o.fetch ?? fetch)(path, {
    method: 'POST',
    signal: o.signal,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-user-id': o.user },
    body: JSON.stringify(body ?? {}),
  })
}

/** Ask Modus on the server: the built-in assistant's reply over everything the person may read. */
export async function askWorkspace(appId: Id, question: string, o: ApiOptions): Promise<AssistantReply> {
  const res = await post(`${appPath(appId)}/workspace/ask`, { question }, o)
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`.trim())
  return (await res.json()) as AssistantReply
}

/** One action of the Workspace as a request: a path under the application and its body. */
export interface CommandRequest {
  path: string
  body?: unknown
}

/**
 * Run a command. The engine's answer comes back as it is, a refusal included (the server answers those
 * 403, 404 or 409 with `{ ok: false, error }`): only a caller the server doesn't know, a bad request or
 * a failing server throws.
 */
export async function command<T>(appId: Id, req: CommandRequest, o: ApiOptions): Promise<Result<T>> {
  const res = await post(`${appPath(appId)}${req.path}`, req.body, o)
  let body: { ok?: unknown; value?: unknown; error?: unknown } | undefined
  try {
    body = (await res.json()) as typeof body
  } catch {}
  if (res.ok && body?.ok === true) return { ok: true, value: body.value as T }
  if ([403, 404, 409].includes(res.status) && typeof body?.error === 'string') return { ok: false, error: body.error }
  throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `${res.status} ${res.statusText}`.trim())
}

// ---------- Designing on the server ----------

/** A save or publish made from a revision that is no longer the stored one. */
export class DesignConflictError extends ApiError {
  constructor(
    message: string,
    /** The revision the server holds now. */
    readonly revision: number,
  ) {
    super(409, message)
  }
}

/** A request with a JSON body that answers `{ ok, value }`; anything else throws with the server's words. */
async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown, o: ApiOptions): Promise<T> {
  const res = await (o.fetch ?? fetch)(path, {
    method,
    signal: o.signal,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-user-id': o.user },
    body: JSON.stringify(body ?? {}),
  })
  let answer: { ok?: unknown; value?: unknown; error?: unknown; revision?: unknown } | undefined
  try {
    answer = (await res.json()) as typeof answer
  } catch {}
  if (res.ok && answer?.ok === true) return answer.value as T
  const message = typeof answer?.error === 'string' ? answer.error : `${res.status} ${res.statusText}`.trim()
  if (res.status === 409 && typeof answer?.revision === 'number') throw new DesignConflictError(message, answer.revision)
  throw new ApiError(res.status, message)
}

/** Save the design: workflows' maps as drafts, the rest at once. Answers the design as stored. */
export const saveDesign = (revision: number, design: Design | ServerDesign, o: ApiOptions) => send<ServerDesign & { revision: number }>('PUT', '/api/design', { revision, design }, o)

const wfPath = (appId: Id, workflowId: Id) => `${appPath(appId)}/workflows/${encodeURIComponent(workflowId)}`

export interface Published {
  revision: number
  version: number
  /** With `who: 'all'`: what moved, and what stayed and why. */
  migration?: Migration
  migrationError?: string
}

/** Publish a workflow's saved draft as its next version. */
export const publishWorkflowDraft = (appId: Id, workflowId: Id, body: { revision: number; note?: string; who: 'new' | 'all'; stepMap?: Record<Id, Id> }, o: ApiOptions) =>
  send<Published>('POST', `${wfPath(appId, workflowId)}/publish`, body, o)

/** The items in flight that run a workflow, reduced to their versions and steps. */
export const getVersionItems = (appId: Id, workflowId: Id, o: ApiOptions) => api<{ clock: number; items: SimObject[] }>(`${wfPath(appId, workflowId)}/items`, o)

export const migrateWorkflowItems = (appId: Id, workflowId: Id, body: { toVersion: number; objectIds?: Id[]; stepMap?: Record<Id, Id> }, o: ApiOptions) =>
  send<Migration>('POST', `${wfPath(appId, workflowId)}/migrate`, body, o)

/** The server's forecast: its live state run forward with and without the draft published. */
export const forecastWorkflow = (appId: Id, workflowId: Id, body: { who: 'new' | 'all'; stepMap?: Record<Id, Id>; hours: number }, o: ApiOptions) =>
  send<PublishPreview>('POST', `${wfPath(appId, workflowId)}/forecast`, body, o)

// ---------- The live stream ----------

export interface SseEvent {
  event: string
  data: string
}

/**
 * A Server-Sent Events parser: feed it decoded text in any chunks. Comment lines (`:`) are skipped,
 * an event ends at a blank line, `data` lines join with newlines, and CRLF, LF or CR all end a line.
 */
export function sseParser(onEvent: (e: SseEvent) => void): (chunk: string) => void {
  let buffer = ''
  let event = ''
  let data: string[] = []
  const line = (l: string) => {
    if (l === '') {
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n') })
      event = ''
      data = []
      return
    }
    if (l.startsWith(':')) return
    const colon = l.indexOf(':')
    const field = colon < 0 ? l : l.slice(0, colon)
    let value = colon < 0 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return (chunk) => {
    buffer += chunk
    // A CR at the very end may be the first half of a CRLF: wait for the next chunk to tell.
    const end = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length
    const re = /\r\n|\r|\n/g
    let start = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(buffer)) && m.index < end) {
      line(buffer.slice(start, m.index))
      start = m.index + m[0].length
    }
    buffer = buffer.slice(start)
  }
}

export type StreamState = 'live' | 'reconnecting'

/**
 * The server pings a quiet stream every 25 s; hearing nothing for 60 s means the connection is gone even if
 * the socket says otherwise (a proxy or a sleeping laptop can leave one half-open), so "Live" means heard from recently.
 */
export const SILENT_AFTER_MS = 60_000

export interface StreamOptions extends Omit<ApiOptions, 'signal'> {
  /** First retry delay; doubles per failed attempt up to `maxBackoffMs`. */
  backoffMs?: number
  maxBackoffMs?: number
  /** The server refused who we are (401/403): retrying won't help, so the stream stops for good. */
  onDenied?: (status: number) => void
  /** The server doesn't run this app (404): the stream stops for good too. */
  onNotFound?: () => void
  /** Any bytes arrived, keep-alive comments included: the connection is alive even when nothing changes. */
  onActivity?: () => void
  /** The server's design changed (saved, published): `revision` is the one it holds now. */
  onDesign?: (revision: number) => void
  /** An attempt silent this long (no headers yet, or no bytes since the last) is dropped and retried. Default SILENT_AFTER_MS. */
  silentMs?: number
}

/**
 * Follows `/api/apps/:app/stream` and reconnects with backoff when it drops. Uses fetch and a reader rather
 * than EventSource, which can't send the `x-user-id` header. `onState` reports 'live' on each (re)connect
 * and 'reconnecting' once per outage; a 401 or 403 ends it through `onDenied`, a 404 through `onNotFound`.
 * `onActivity` hears every chunk. An attempt that hears nothing for `silentMs` (a hung request, or a stream
 * that stopped even pinging) is aborted and retried like any drop, keeping the current backoff.
 * Returns a function that closes the stream for good.
 */
export function openStream(appId: Id, onEvent: (e: ChangeEvent) => void, onState: (s: StreamState) => void, o: StreamOptions): () => void {
  const f = o.fetch ?? fetch
  const first = o.backoffMs ?? 1000
  const max = o.maxBackoffMs ?? 15_000
  const silentMs = o.silentMs ?? SILENT_AFTER_MS
  let closed = false
  let delay = first
  let state: StreamState | undefined
  let ctl: AbortController | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined

  /** (Re)start the silence watch for this attempt: when it fires, drop the attempt so the catch below retries. */
  const watch = (attempt: AbortController) => {
    clearTimeout(silence)
    silence = setTimeout(() => {
      attempt.abort()
      reader?.cancel().catch(() => {})
    }, silentMs)
  }

  const report = (s: StreamState) => {
    if (closed || s === state) return
    state = s
    onState(s)
  }

  const run = async () => {
    const attempt = (ctl = new AbortController())
    watch(attempt)
    try {
      const res = await f(`${appPath(appId)}/stream`, { signal: ctl.signal, headers: { accept: 'text/event-stream', 'x-user-id': o.user } })
      if (!res.ok || !res.body) {
        res.body?.cancel().catch(() => {})
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          clearTimeout(silence)
          if (!closed) {
            closed = true
            if (res.status === 404) o.onNotFound?.()
            else o.onDenied?.(res.status)
          }
          return
        }
        throw new ApiError(res.status, `stream: ${res.status}`)
      }
      if (closed) return void res.body.cancel().catch(() => {})
      reader = res.body.getReader()
      delay = first
      report('live')
      const decoder = new TextDecoder()
      const push = sseParser((e) => {
        if (e.event === 'design') {
          try {
            o.onDesign?.((JSON.parse(e.data) as { revision: number }).revision)
          } catch (err) {
            console.error(err)
          }
          return
        }
        if (e.event !== 'change') return
        let parsed: ChangeEvent
        try {
          parsed = JSON.parse(e.data) as ChangeEvent
        } catch {
          return // a malformed event: the next one or the throttled refetch catches up
        }
        try {
          onEvent(parsed)
        } catch (err) {
          // The consumer's bug, not the stream's: keep reading.
          console.error(err)
        }
      })
      for (;;) {
        const { done, value } = await reader.read()
        if (done || closed || attempt.signal.aborted) break
        watch(attempt)
        o.onActivity?.()
        push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // dropped, refused or unreachable: retry below
    }
    clearTimeout(silence)
    reader = undefined
    if (closed) return
    report('reconnecting')
    timer = setTimeout(run, delay)
    delay = Math.min(delay * 2, max)
  }

  void run()
  return () => {
    closed = true
    clearTimeout(timer)
    clearTimeout(silence)
    ctl?.abort()
    reader?.cancel().catch(() => {})
  }
}
