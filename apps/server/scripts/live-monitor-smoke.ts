// End-to-end smoke check for the live Monitor and Workspace: a real server, serving the built Studio,
// answers the Monitor endpoints, streams a change when an invoice is created through the API, and takes
// that invoice through a clerk's Workspace (their share of the state, start, release, search). Last it
// saves a workflow's draft, publishes it, and checks a new invoice runs the new version.
//
//   pnpm --filter @modus-bpm/studio build
//   pnpm --filter @modus-bpm/server smoke:live
//
// It builds nothing itself. The server runs as a child process on a free port, or on SMOKE_PORT if set,
// and is always stopped. It runs in memory (nothing written), or on PostgreSQL when SMOKE_DATABASE_URL
// names a throwaway database. Exits non-zero with the failed check on any problem.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..')
const studioDist = resolve(serverDir, '../studio/dist')
const ADMIN = 'u_avery'
const APP = 'app_invoice'

class SmokeError extends Error {}
const check = (ok: unknown, what: string): void => {
  if (!ok) throw new SmokeError(what)
}
const step = (msg: string) => console.log(`ok  ${msg}`)

/** True if something already accepts connections there (binding alone can't tell: macOS lets 127.0.0.1 share a port with a wildcard listener such as Docker's). */
function inUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => (sock.destroy(), done(true)))
    sock.once('error', () => done(false))
  })
}

/** SMOKE_PORT if set and free, else any free port. A taken port fails: whatever holds it would answer the checks. */
async function freePort(): Promise<number> {
  if (process.env.SMOKE_PORT) {
    const want = Number(process.env.SMOKE_PORT)
    if (await inUse(want)) throw new SmokeError(`port ${want} is already in use; pick another SMOKE_PORT or leave it unset`)
    return want
  }
  return new Promise((done, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })
}

if (!existsSync(join(studioDist, 'index.html'))) {
  console.error(`No built Studio at ${studioDist}. Run: pnpm --filter @modus-bpm/studio build`)
  process.exit(1)
}

let port: number
try {
  port = await freePort()
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
const as = (user: string) => ({ 'x-user-id': user })

// In memory unless SMOKE_DATABASE_URL names a PostgreSQL database to run on (a throwaway one: the check creates work in it).
const storage = process.env.SMOKE_DATABASE_URL ? { DB_DIALECT: 'postgres', DATABASE_URL: process.env.SMOKE_DATABASE_URL } : { DB_DIALECT: 'memory' }

const child = spawn(join(serverDir, 'node_modules/.bin/tsx'), ['src/main.ts'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: studioDist, LOG_LEVEL: 'warn', DATA_DIR: '', TIME_SCALE: '1', ...storage },
  stdio: ['ignore', 'inherit', 'inherit'],
})
let exited = false
child.on('exit', () => (exited = true))

async function stopServer() {
  if (exited) return
  child.kill('SIGTERM')
  // main.ts closes cleanly on SIGTERM; don't wait forever if it doesn't.
  const gone = new Promise<void>((done) => child.once('exit', () => done()))
  const timeout = new Promise<void>((done) => setTimeout(done, 5000).unref())
  await Promise.race([gone, timeout])
  if (!exited) child.kill('SIGKILL')
}
// Anything that escapes the checks below still stops the server.
for (const event of ['unhandledRejection', 'uncaughtException'] as const)
  process.on(event, (e) => {
    console.error(`\nFAIL  ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    void stopServer().then(() => process.exit(1))
  })
// Ctrl-C on the smoke check still stops the server.
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    void stopServer().then(() => process.exit(130))
  })

async function waitForServer() {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    check(!exited, 'the server exited during startup (see its output above)')
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new SmokeError('the server did not answer /api/health within 30 s')
}

async function getJson<T>(path: string, user?: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: user ? as(user) : {} })
  check(res.ok, `GET ${path} answered ${res.status}: ${await res.clone().text()}`)
  return (await res.json()) as T
}

/** Set when the stream fails or ends on its own; every wait checks it, so it fails the run instead of escaping. */
let streamError: Error | undefined

/** Reads the event stream in the background, keeping each `change` event's item ids. */
function openStream(abort: AbortController) {
  const changes: Array<{ items: string[] | null; active: number }> = []
  let connected = false
  void (async () => {
    const res = await fetch(`${base}/api/apps/${APP}/stream`, { headers: as(ADMIN), signal: abort.signal })
    check(res.ok && res.body, `GET /api/apps/${APP}/stream answered ${res.status}`)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new SmokeError('the server closed the stream')
      buf += value
      let at: number
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at)
        buf = buf.slice(at + 2)
        if (block.startsWith(': connected')) connected = true
        const event = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (event === 'change' && data) changes.push(JSON.parse(data))
      }
    }
  })().catch((e) => {
    if (!abort.signal.aborted) streamError = e instanceof Error ? e : new Error(String(e))
  })
  return { changes, isConnected: () => connected }
}

async function waitFor(what: string, ok: () => boolean, ms = 5000) {
  const until = Date.now() + ms
  while (!ok()) {
    if (streamError) throw streamError instanceof SmokeError ? streamError : new SmokeError(`the stream failed: ${streamError.message}`)
    check(Date.now() < until, `${what} within ${ms / 1000} s`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const abort = new AbortController()
let failed = false
try {
  await waitForServer()
  step(`server up on ${base}`)

  const home = await fetch(`${base}/`)
  const html = await home.text()
  check(home.ok && (home.headers.get('content-type') ?? '').includes('text/html') && /<div id="root">/.test(html), `GET / should return the Studio's HTML (got ${home.status}, ${home.headers.get('content-type')})`)
  step('GET / returns the Studio')

  const health = await getJson<{ ok?: boolean }>('/api/health')
  check(health, 'GET /api/health returned nothing')
  step('GET /api/health')

  const design = await getJson<{ apps: Array<{ id: string }> }>('/api/design', ADMIN)
  check(design.apps.some((a) => a.id === APP), `the published design has no ${APP}`)
  step(`GET /api/design lists ${APP}`)

  const before = await getJson<{ view: { active: number } }>(`/api/apps/${APP}/monitor`, ADMIN)
  step(`GET /api/apps/${APP}/monitor: ${before.view.active} active`)

  const stream = openStream(abort)
  await waitFor('the stream should send ": connected"', stream.isConnected)
  step('stream connected')

  const created = await fetch(`${base}/api/apps/${APP}/items`, {
    method: 'POST',
    headers: { ...as('u_maya'), 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'w_invoice', data: { f_invno: `SMOKE-${Date.now()}`, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Toner', c_qty: 2, c_price: 50 }], f_dept: 'l_org_0', f_cc: 'l_org_1' } }),
  })
  check(created.status === 201, `creating an invoice answered ${created.status}: ${await created.clone().text()}`)
  const id = ((await created.json()) as { value: { id: string } }).value.id
  step(`created invoice ${id}`)

  const after = await getJson<{ view: { active: number } }>(`/api/apps/${APP}/monitor`, ADMIN)
  check(after.view.active === before.view.active + 1, `/monitor should show one more active item (was ${before.view.active}, now ${after.view.active})`)
  step(`/monitor shows ${after.view.active} active (up by one)`)

  await waitFor(`the stream should deliver a change naming ${id}`, () => stream.changes.some((c) => c.items?.includes(id)))
  step(`stream delivered a change for ${id}`)

  // The Workspace: the requester finds it in theirs, a worker matches it, and the clerk it reaches works it through the API.
  interface Slice {
    items: Array<{ id: string; tokens: Array<{ id: string; nodeId: string; state: string; userId?: string }> }>
  }
  const post = async (path: string, user: string | undefined, body: unknown = {}) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...(user ? as(user) : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    check(res.ok, `POST ${path} answered ${res.status}: ${await res.clone().text()}`)
    return res.json()
  }
  const requester = await getJson<Slice>(`/api/apps/${APP}/workspace`, 'u_maya')
  check(requester.items.some((o) => o.id === id), `the requester's Workspace should hold ${id}`)
  step(`GET /api/apps/${APP}/workspace holds ${id} for its requester`)

  const { jobs } = (await post('/api/jobs/poll', undefined, { serviceId: 'svc_erp', workerId: 'smoke', max: 10 })) as { jobs: Array<{ id: string }> }
  for (const j of jobs) await post(`/api/jobs/${encodeURIComponent(j.id)}/complete`, undefined, { outputs: { matched: true } })
  const matched = await getJson<Slice & { gone: string[] }>(`/api/apps/${APP}/workspace/items?ids=${id}`, 'u_maya')
  const work = matched.items.find((o) => o.id === id)?.tokens.find((t) => t.nodeId === 'n_clerk')
  check(work?.userId, `${id} should be with an AP clerk once its PO is matched`)
  const clerk = work!.userId!
  const theirs = await getJson<Slice>(`/api/apps/${APP}/workspace`, clerk)
  check(theirs.items.some((o) => o.tokens.some((t) => t.id === work!.id && t.userId === clerk)), `the clerk's Workspace should hold the work on ${id}`)
  step(`the work on ${id} is in ${clerk}'s Workspace`)

  await post(`/api/apps/${APP}/work/${encodeURIComponent(work!.id)}/start`, clerk)
  await post(`/api/apps/${APP}/work/${encodeURIComponent(work!.id)}/release`, clerk, { outcomeId: 'o_k_ok' })
  const left = await getJson<Slice & { gone: string[] }>(`/api/apps/${APP}/workspace/items?ids=${id}`, clerk)
  // Released, it leaves the clerk's Workspace, unless the clerk is also the one who asked for it.
  check(clerk === 'u_maya' ? left.items.some((o) => o.id === id) : left.gone.includes(id), `${id} should have left ${clerk}'s Workspace once released`)
  const found = await getJson<{ total: number; hits: Array<{ obj: { id: string } }> }>(`/api/apps/${APP}/workspace/search?q=${encodeURIComponent('is:open')}&limit=200`, 'u_maya')
  check(found.hits.some((h) => h.obj.id === id), `the requester's search should find ${id}`)
  step(`${clerk} started and released it; it left their Workspace and the requester still finds it`)

  // Designing: save a workflow's draft, publish it, and a new invoice runs the new version while the old one keeps its own.
  interface Served {
    revision: number
    apps: Array<{ id: string; workflows: Array<{ id: string; published?: number; nodes: Array<{ id: string; data: { label: string } }> }> }>
  }
  const invoiceWf = (d: Served) => d.apps.find((a) => a.id === APP)!.workflows.find((w) => w.id === 'w_invoice')!
  const loaded = await getJson<Served>('/api/design', ADMIN)
  invoiceWf(loaded).nodes.find((n) => n.id === 'n_clerk')!.data.label = 'Clerk check (smoke)'
  const { revision: from, ...draft } = loaded
  const put = await fetch(`${base}/api/design`, { method: 'PUT', headers: { ...as(ADMIN), 'content-type': 'application/json' }, body: JSON.stringify({ revision: from, design: draft }) })
  check(put.ok, `PUT /api/design answered ${put.status}: ${await put.clone().text()}`)
  const saved = ((await put.json()) as { value: Served }).value
  check(saved.revision === from + 1, `saving the design should make revision ${from + 1} (got ${saved.revision})`)
  const was = invoiceWf(saved).published
  step(`saved a draft of w_invoice as revision ${saved.revision}; version ${was} still runs`)

  const published = (await post(`/api/apps/${APP}/workflows/w_invoice/publish`, ADMIN, { revision: saved.revision, note: 'smoke', who: 'new' })) as { value: { version: number; revision: number } }
  check(published.value.version === (was ?? 0) + 1, `publishing should make version ${(was ?? 0) + 1} (got ${published.value.version})`)
  const next = (await post(`/api/apps/${APP}/items`, 'u_maya', { workflowId: 'w_invoice', data: { f_invno: `SMOKE-V-${Date.now()}`, f_vendor: 'l_vendors_0', f_lines: [{ id: 'row_1', c_desc: 'Toner', c_qty: 1, c_price: 50 }], f_dept: 'l_org_0', f_cc: 'l_org_1' } })) as { value: { id: string } }
  const running = await getJson<{ items: Array<{ id: string; versions?: Record<string, number> }> }>(`/api/apps/${APP}/workflows/w_invoice/items`, ADMIN)
  const fresh = running.items.find((o) => o.id === next.value.id)
  check(fresh?.versions?.w_invoice === published.value.version, `a new invoice should run version ${published.value.version} (runs ${fresh?.versions?.w_invoice})`)
  const old = running.items.find((o) => o.id === id)
  check(old?.versions?.w_invoice === was, `the invoice in flight should stay on version ${was} (runs ${old?.versions?.w_invoice})`)
  step(`published version ${published.value.version}: a new invoice runs it, the one in flight stays on version ${was}`)

  console.log('\nLive smoke check passed: the Monitor, the Workspace and publishing a design.')
} catch (e) {
  failed = true
  console.error(`\nFAIL  ${e instanceof SmokeError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
} finally {
  abort.abort()
  await stopServer()
}
process.exit(failed ? 1 : 0)
