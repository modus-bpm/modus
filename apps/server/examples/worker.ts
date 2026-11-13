// An example registered worker: the "device" pattern. It polls the server for
// jobs of one service, does the work, and completes (or fails) each job. Any
// language can do this; it is three HTTP calls.
//
//   pnpm --filter @modus-bpm/server dev                      # in one terminal
//   SERVICE=svc_vision pnpm --filter @modus-bpm/server worker # in another
//
// The server asks who is calling: only an administrator, or an account the service lists
// under "May run its jobs", can take its jobs. Give the worker a machine token for such an
// account (MODUS_TOKEN, matching the server's MODUS_API_TOKENS). On a server with sign-in off
// (MODUS_AUTH=none) it names itself instead (MODUS_USER, the sample administrator by default).
//
// Then create a camera event (see apps/server/README.md) and watch it move.

const base = process.env.MODUS_URL ?? 'http://127.0.0.1:8787'
const serviceId = process.env.SERVICE ?? 'svc_vision'
const workerId = `${serviceId}-${process.pid}`
const identity: Record<string, string> = process.env.MODUS_TOKEN ? { authorization: `Bearer ${process.env.MODUS_TOKEN}` } : { 'x-user-id': process.env.MODUS_USER ?? 'u_avery' }

interface Job {
  id: string
  itemNumber: string
  operation: string
  attempt: number
  inputs: Record<string, unknown>
}

/** The actual work. Replace with a call to your model, robot, legacy system… */
async function handle(job: Job): Promise<Record<string, unknown>> {
  // job.inputs holds the step's request parameters, e.g. { po: 'PO-9' } for the ERP match.
  await new Promise((r) => setTimeout(r, 300 + 100 * Object.keys(job.inputs).length))
  if (serviceId === 'svc_vision') return { confidence: Math.round(40 + Math.random() * 59), label: Math.random() < 0.7 ? 'Person' : 'Vehicle' }
  if (serviceId === 'svc_erp') return { matched: Math.random() < 0.85 }
  return {}
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...identity }, body: JSON.stringify(body) })
  if (r.status === 401 || r.status === 403) throw new Error(`${r.status}: ${((await r.json()) as { error?: string }).error ?? 'refused'}`)
  return (await r.json()) as T
}

console.log(`${workerId} polling ${base} for ${serviceId} jobs`)
for (;;) {
  try {
    const { jobs } = await post<{ jobs: Job[] }>('/api/jobs/poll', { serviceId, workerId, max: 5, leaseSeconds: 60 })
    if (!jobs.length) {
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    for (const job of jobs) {
      try {
        const outputs = await handle(job)
        await post(`/api/jobs/${encodeURIComponent(job.id)}/complete`, { outputs })
        console.log(`done ${job.itemNumber} ${job.operation}`, outputs)
      } catch (err) {
        await post(`/api/jobs/${encodeURIComponent(job.id)}/fail`, { error: String(err) })
        console.log(`failed ${job.itemNumber}: ${String(err)}`)
      }
    }
  } catch {
    // Server not up yet, or restarting.
    await new Promise((r) => setTimeout(r, 2000))
  }
}
