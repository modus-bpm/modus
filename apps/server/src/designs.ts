// Saving the design from a Studio. A save sends the whole document; this decides what of it is
// taken. A workflow's map is its draft and runs nothing until published, so it is taken as sent.
// Everything else (object types, lists, people, groups, services, new applications and workflows)
// is live the moment it is stored, so a save that would strand work or lock people out is refused.
// Versions, and which one is published, are the server's: a save never changes them.

import { z } from 'zod'
import { activeObjects, type Design, ensureVersions, type Id, runsIn, type ServiceDef, type SimState, type Workflow } from '@modus-bpm/core'

/** A save the server won't take: 400 for a broken document, 403 for something the caller may not do, 409 for one that would strand work. */
export class DesignRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message)
  }
}

// ---------- The document's shape ----------
// Loose on purpose: the model's types are the Studio's to get right, and unknown keys pass through
// so a newer Studio's fields aren't dropped. What the engine indexes by (ids, the graph) is checked.

const id = z.string().min(1).max(200)
const node = z.looseObject({ id, type: z.enum(['start', 'user', 'auto', 'decision', 'split', 'join', 'subflow', 'wait', 'end']), position: z.object({ x: z.number(), y: z.number() }), data: z.looseObject({ label: z.string().max(500) }) })
const edge = z.looseObject({ id, source: id, target: id, data: z.looseObject({}).default({}) })
const workflow = z.looseObject({ id, name: z.string().max(500), kind: z.enum(['process', 'subflow']).optional(), objectTypeId: id, nodes: z.array(node).max(2000), edges: z.array(edge).max(5000), arrivalsPerHour: z.number().min(0) })
const objectType = z.looseObject({ id, name: z.string().max(500), fields: z.array(z.looseObject({ id, label: z.string().max(500), type: z.string().max(50) })).max(1000), permissions: z.record(z.string(), z.looseObject({})) })
const app = z.looseObject({ id, name: z.string().max(500), lists: z.array(z.looseObject({ id })).max(2000), objectTypes: z.array(objectType).max(500), workflows: z.array(workflow).max(500) })
const user = z.looseObject({ id, name: z.string().max(500), roles: z.array(z.enum(['admin', 'designer', 'auditor'])).optional(), speed: z.number().positive(), available: z.boolean() })
const group = z.looseObject({ id, name: z.string().max(500), memberIds: z.array(id) })
const service = z.looseObject({ id, name: z.string().max(500), operations: z.array(z.looseObject({ id })).default([]) })
const document = z.object({ apps: z.array(app).max(200), users: z.array(user).max(20_000), groups: z.array(group).max(5000), services: z.array(service).max(1000), templates: z.array(z.looseObject({ id })).max(1000) })

const repeated = (ids: string[]) => ids.find((x, i) => ids.indexOf(x) !== i)

/** The document as a design, or DesignRefused(400) saying what is wrong with it. */
export function parseDesign(raw: unknown): Design {
  const parsed = document.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new DesignRefused(400, `That isn’t a design the server can store: ${first ? `${first.path.join('.') || 'the document'}: ${first.message}` : 'it has the wrong shape'}.`)
  }
  const d = parsed.data as unknown as Design
  const twice = (what: string, ids: string[]) => {
    const dup = repeated(ids)
    if (dup) throw new DesignRefused(400, `Two ${what} share the id “${dup}”.`)
  }
  twice('applications', d.apps.map((a) => a.id))
  twice('people', d.users.map((u) => u.id))
  twice('groups', d.groups.map((g) => g.id))
  twice('services', d.services.map((s) => s.id))
  for (const a of d.apps) {
    twice(`workflows of ${a.name}`, a.workflows.map((w) => w.id))
    twice(`object types of ${a.name}`, a.objectTypes.map((t) => t.id))
    twice(`lists of ${a.name}`, a.lists.map((l) => l.id))
    for (const t of a.objectTypes) twice(`fields of ${t.name}`, t.fields.map((f) => f.id))
    for (const w of a.workflows) {
      if (!a.objectTypes.some((t) => t.id === w.objectTypeId)) throw new DesignRefused(400, `${w.name} is for an object type that ${a.name} doesn’t have.`)
      twice(`steps of ${w.name}`, w.nodes.map((n) => n.id))
      twice(`paths of ${w.name}`, w.edges.map((e) => e.id))
      const steps = new Set(w.nodes.map((n) => n.id))
      const loose = w.edges.find((e) => !steps.has(e.source) || !steps.has(e.target))
      if (loose) throw new DesignRefused(400, `A path in ${w.name} joins a step that isn’t on its map.`)
    }
  }
  return d
}

// ---------- What the running work depends on ----------

/** What the items of every application hold on to in the design. */
export interface DesignUse {
  /** Applications that have any item. */
  apps: Set<Id>
  /** Object types items have, as `appId/typeId`. */
  types: Set<string>
  /** Workflows items were created in or are running now, as `appId/workflowId`. */
  workflows: Set<string>
  /** People who hold work now. */
  holders: Set<Id>
}

export function designUse(states: Array<{ appId: Id; sim: SimState }>): DesignUse {
  const use: DesignUse = { apps: new Set(), types: new Set(), workflows: new Set(), holders: new Set() }
  for (const { appId, sim } of states) {
    for (const obj of Object.values(sim.objects)) {
      use.apps.add(appId)
      use.types.add(`${appId}/${obj.typeId}`)
      use.workflows.add(`${appId}/${obj.workflowId}`)
    }
    for (const obj of activeObjects(sim)) {
      for (const t of obj.tokens) {
        if (t.userId) use.holders.add(t.userId)
        use.workflows.add(`${appId}/${t.workflowId}`)
        for (const c of t.calls) use.workflows.add(`${appId}/${c.workflowId}`)
      }
    }
  }
  return use
}

/** Does any item in flight run this workflow? */
export const inFlight = (sim: SimState, workflowId: Id) => activeObjects(sim).some((o) => runsIn(o, workflowId))

// ---------- Taking a save ----------

const SERVICE_SHOWN = ['name', 'kind', 'description', 'concurrency', 'status'] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** A service as saved: what the Studio shows comes from the save, its connection details stay the server's. */
function mergeService(have: ServiceDef | undefined, sent: ServiceDef): ServiceDef {
  if (!have) return { ...sent, endpoint: '', auth: undefined, secretRef: undefined }
  // Operations and their results likewise: what was never sent out (anything the allowlist in dto.ts leaves behind) is kept.
  const operations = sent.operations.map((op) => {
    const was = have.operations.find((x) => x.id === op.id)
    return was ? { ...was, ...op, outputs: op.outputs.map((o) => ({ ...was.outputs.find((x) => x.key === o.key), ...o })) } : op
  })
  const out: ServiceDef = { ...have, operations }
  for (const k of SERVICE_SHOWN) (out as unknown as Record<string, unknown>)[k] = sent[k]
  return out
}

/** A workflow as saved: its map and settings from the save (the draft), its versions from the server. */
function mergeWorkflow(have: Workflow | undefined, sent: Workflow, appName: string): Workflow {
  // New here: it starts at version 1 from its map (ensureVersions, below), whatever history the file carried.
  if (!have) return { ...sent, versions: undefined, published: undefined }
  if ((have.kind ?? 'process') !== (sent.kind ?? 'process') || have.objectTypeId !== sent.objectTypeId)
    throw new DesignRefused(409, `${have.name} in ${appName} can’t change its kind or object type: items already run it. Make a new workflow instead.`)
  return { ...sent, versions: have.versions, published: have.published }
}

/**
 * The design after a save: `sent` applied to `have` (the stored design, every workflow versioned).
 * Throws DesignRefused when the save would strand work, lock everyone out, or change what the
 * caller may not. `at` is the clock a new workflow's version 1 is published at.
 */
export function takeDesign(have: Design, sent: Design, by: { admin: boolean }, use: DesignUse, at: number): Design {
  for (const a of have.apps) {
    const next = sent.apps.find((x) => x.id === a.id)
    if (!next) {
      if (use.apps.has(a.id)) throw new DesignRefused(409, `${a.name} has items, so it can’t be removed.`)
      continue
    }
    for (const w of a.workflows) if (!next.workflows.some((x) => x.id === w.id) && use.workflows.has(`${a.id}/${w.id}`)) throw new DesignRefused(409, `${w.name} in ${a.name} has items, so it can’t be removed.`)
    for (const t of a.objectTypes) if (!next.objectTypes.some((x) => x.id === t.id) && use.types.has(`${a.id}/${t.id}`)) throw new DesignRefused(409, `${a.name} has ${t.pluralName ?? t.name} items, so that object type can’t be removed.`)
  }
  for (const u of have.users) if (!sent.users.some((x) => x.id === u.id) && use.holders.has(u.id)) throw new DesignRefused(409, `${u.name} holds work. Reassign it before removing them.`)

  if (!by.admin) {
    const roles = (d: Design) => new Map(d.users.map((u) => [u.id, [...(u.roles ?? [])].sort()]))
    const before = roles(have)
    for (const [userId, now] of roles(sent)) if (!same(before.get(userId) ?? [], now)) throw new DesignRefused(403, 'Only an administrator can change people’s roles.')
    for (const [userId, was] of before) if (was.length && !sent.users.some((u) => u.id === userId)) throw new DesignRefused(403, 'Only an administrator can remove someone who has a role.')
  }
  if (!sent.users.some((u) => u.roles?.includes('admin'))) throw new DesignRefused(409, 'A design needs at least one administrator.')

  const next: Design = {
    ...sent,
    apps: sent.apps.map((a) => {
      const was = have.apps.find((x) => x.id === a.id)
      return { ...a, workflows: a.workflows.map((w) => mergeWorkflow(was?.workflows.find((x) => x.id === w.id), w, a.name)) }
    }),
    services: sent.services.map((s) =>
      mergeService(
        have.services.find((x) => x.id === s.id),
        s,
      ),
    ),
  }
  return ensureVersions(next, at)
}
