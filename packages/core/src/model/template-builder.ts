// A small builder for the starter templates: steps placed on a grid (column, row), paths named
// by the outcome they follow, and ids made from the template's key. It keeps fifty templates
// readable; what it returns is an ordinary Template.

import { outcome } from './seed-helpers'
import type { Distribution, FieldAccess, FieldDef, Id, Operator, Outcome, StartData, Template, UserStepData, WfEdge, WfNode } from './types'

type At = [col: number, row: number]

/** [key, label, share of simulated people who choose it, extras]. The outcome's id is `<step>_<key>`. */
export type OutcomeSpec = [key: string, label: string, weight: number, extra?: { comment?: boolean; set?: [fieldId: Id, value: string] }]

interface PersonOpts {
  how?: Distribution
  /** `field` distribution: the person field that names who gets the work. */
  by?: Id
  minutes?: number
  sla?: number
  outcomes?: OutcomeSpec[]
  fields?: Record<Id, FieldAccess>
  note?: string
  /** Escalate (raise priority, tell the supervisors) after this many hours. */
  escalateAfter?: number
  /** Four eyes: nobody who released these steps (by their short id) may work this one. */
  separateFrom?: string[]
  delegate?: boolean
}

interface AutoOpts {
  minutes?: number
  /** A sample service and operation. Left out, the step is a placeholder for the organization's own system. */
  service?: [serviceId: Id, operationId: Id]
  outputs?: Array<[key: string, fieldId: Id]>
  note?: string
  /** `route` (follow a Failed path) is only for steps that have one; the default hands failures to a person. */
  failed?: 'manual' | 'route' | 'stuck'
}

export type Step =
  | { kind: 'start'; id: string; label: string; at: At; data?: Partial<StartData> }
  | { kind: 'user'; id: string; label: string; at: At; opts: PersonOpts }
  | { kind: 'auto'; id: string; label: string; at: At; opts: AutoOpts }
  | { kind: 'decision'; id: string; label: string; at: At }
  | { kind: 'split'; id: string; label: string; at: At; mode: 'all' | 'inclusive' }
  | { kind: 'join'; id: string; label: string; at: At; mode: 'all' | 'any' | 'count'; count?: number; cancelRemaining?: boolean }
  | { kind: 'wait'; id: string; label: string; at: At; minutes: number }
  | { kind: 'end'; id: string; label: string; at: At; result: 'completed' | 'rejected' | 'cancelled'; outcome?: string; terminate?: boolean }

export const start = (id: string, label: string, at: At, data?: Partial<StartData>): Step => ({ kind: 'start', id, label, at, data })
export const person = (id: string, label: string, at: At, opts: PersonOpts = {}): Step => ({ kind: 'user', id, label, at, opts })
export const auto = (id: string, label: string, at: At, opts: AutoOpts = {}): Step => ({ kind: 'auto', id, label, at, opts })
export const decide = (id: string, label: string, at: At): Step => ({ kind: 'decision', id, label, at })
export const split = (id: string, label: string, at: At, mode: 'all' | 'inclusive' = 'all'): Step => ({ kind: 'split', id, label, at, mode })
export const join = (id: string, label: string, at: At, mode: 'all' | 'any' | 'count' = 'all', count?: number): Step => ({
  kind: 'join',
  id,
  label,
  at,
  mode,
  count,
  cancelRemaining: mode === 'all' ? undefined : true,
})
export const wait = (id: string, label: string, at: At, minutes: number): Step => ({ kind: 'wait', id, label, at, minutes })
export const end = (id: string, label: string, at: At, result: 'completed' | 'rejected' | 'cancelled' = 'completed', extra: { outcome?: string; terminate?: boolean } = {}): Step => ({
  kind: 'end',
  id,
  label,
  at,
  result,
  ...extra,
})

/** One rule of a decision path: [field, operator, value]. */
export type When = [fieldId: Id, op: Operator, value?: string | number]

/**
 * A path: [from, to] and, where the source needs one, what selects it: an outcome key
 * (people steps), `{ when }` or `{ otherwise }` (decisions), `'failed'` (automated steps).
 */
export type Flow = [from: string, to: string, pick?: string | { when: When[]; any?: boolean } | { otherwise: true }, via?: [source: string, target: string]]

export interface TemplateSpec {
  name: string
  description: string
  category: string
  tags: string[]
  fields: FieldDef[]
  steps: Step[]
  flows: Flow[]
}

const CREATED = '2026-11-13T12:00:00.000Z'
const COL = 310
const ROW = 170
/** Drawn sizes, so steps of different kinds line up on their centres. */
const SIZE: Record<Step['kind'], { w: number; h: number }> = {
  start: { w: 184, h: 52 },
  end: { w: 156, h: 52 },
  decision: { w: 120, h: 120 },
  split: { w: 84, h: 84 },
  join: { w: 84, h: 84 },
  user: { w: 258, h: 112 },
  auto: { w: 228, h: 92 },
  wait: { w: 150, h: 52 },
}

const DAY = 24 * 60
export const days = (n: number) => n * DAY
export const hours = (n: number) => n * 60

function personData(key: string, s: Extract<Step, { kind: 'user' }>, nid: (id: string) => Id): UserStepData {
  const o = s.opts
  const outcomes: Outcome[] = (
    o.outcomes ?? [
      ['ok', 'Approve', 85],
      ['no', 'Reject', 15, { comment: true }],
    ]
  ).map(([k, label, weight, extra]) =>
    outcome(`${nid(s.id)}_${k}`, label, weight, {
      requireComment: extra?.comment || undefined,
      actions: extra?.set ? [{ id: `${nid(s.id)}_${k}_set`, kind: 'setField' as const, fieldId: extra.set[0], value: extra.set[1] }] : [],
    }),
  )
  void key
  return {
    label: s.label,
    description: o.note,
    distribution: o.by ? 'field' : (o.how ?? 'queue'),
    assigneeFieldId: o.by,
    autoDistribute: true,
    distributeEveryMinutes: 30,
    avgMinutes: o.minutes ?? 20,
    slaHours: o.sla ?? 24,
    escalateAfterHours: o.escalateAfter,
    escalation: o.escalateAfter ? { raisePriority: true, toDistributors: false, notifySupervisors: true } : undefined,
    allowDelegate: o.delegate || undefined,
    separateFrom: o.separateFrom?.map(nid),
    outcomes,
    fieldAccess: o.fields ?? {},
  }
}

/** Which sides a path leaves and enters by, from where the two steps sit. */
function handles(a: Step, b: Step): [string, string] {
  const dc = b.at[0] - a.at[0]
  const dr = b.at[1] - a.at[1]
  if (dc <= 0 && dr === 0) return ['b', 'b'] // back along the row: under the steps between
  if (dc <= 0) return [dr < 0 ? 't' : 'b', dr < 0 ? 'b' : 't']
  if (dr === 0) return ['r', 'l']
  if (b.kind === 'join') return ['r', dr > 0 ? 't' : 'b']
  return [dr < 0 ? 't' : 'b', 'l']
}

/** Build a built-in template. `key` prefixes every step id and makes the template's id (`tpl_<key>`). */
export function template(key: string, spec: TemplateSpec): Template {
  const nid = (id: string) => `${key}_${id}`
  const byId = new Map(spec.steps.map((s) => [s.id, s]))
  const minC = Math.min(...spec.steps.map((s) => s.at[0]))
  const minR = Math.min(...spec.steps.map((s) => s.at[1]))
  const pos = (s: Step) => ({ x: Math.round((s.at[0] - minC) * COL + (258 - SIZE[s.kind].w) / 2), y: Math.round((s.at[1] - minR) * ROW + (120 - SIZE[s.kind].h) / 2) })

  const nodes: WfNode[] = spec.steps.map((s): WfNode => {
    const id = nid(s.id)
    const position = pos(s)
    switch (s.kind) {
      case 'start':
        return { id, type: 'start', position, data: { label: s.label, ...s.data } }
      case 'user':
        return { id, type: 'user', position, data: personData(key, s, nid) }
      case 'auto':
        return {
          id,
          type: 'auto',
          position,
          data: {
            label: s.label,
            description: s.opts.note ?? (s.opts.service ? undefined : 'A placeholder: point it at your own system, or leave it and the step simply takes this long.'),
            avgMinutes: s.opts.minutes ?? 1,
            actions: [],
            serviceId: s.opts.service?.[0],
            operationId: s.opts.service?.[1],
            outputs: s.opts.outputs?.map(([k, fieldId]) => ({ key: k, fieldId })),
            retries: s.opts.service ? 1 : undefined,
            onFailure: s.opts.service ? (s.opts.failed ?? 'manual') : undefined,
          },
        }
      case 'decision':
        return { id, type: 'decision', position, data: { label: s.label } }
      case 'split':
        return { id, type: 'split', position, data: { label: s.label, mode: s.mode } }
      case 'join':
        return { id, type: 'join', position, data: { label: s.label, mode: s.mode, count: s.count, cancelRemaining: s.cancelRemaining } }
      case 'wait':
        return { id, type: 'wait', position, data: { label: s.label, minutes: s.minutes } }
      case 'end':
        return { id, type: 'end', position, data: { label: s.label, result: s.result, outcome: s.outcome ?? s.label, terminate: s.terminate } }
    }
  })

  const order = new Map<string, number>()
  const edges: WfEdge[] = spec.flows.map(([from, to, pick, via], i): WfEdge => {
    const a = byId.get(from)
    const b = byId.get(to)
    if (!a || !b) throw new Error(`Template ${key}: path ${from} → ${to} names a step that isn't there.`)
    const [sh, th] = via ?? handles(a, b)
    const data: WfEdge['data'] = {}
    if (typeof pick === 'string') {
      data.outcomeId = a.kind === 'auto' ? (pick === 'failed' ? 'failure' : 'success') : `${nid(from)}_${pick}`
      if (a.kind === 'user' && !(a.opts.outcomes ?? [['ok'], ['no']]).some(([k]) => k === pick)) throw new Error(`Template ${key}: “${a.label}” has no outcome “${pick}”.`)
    } else if (pick) {
      const n = order.get(from) ?? 0
      order.set(from, n + 1)
      data.order = n
      if ('otherwise' in pick) data.isDefault = true
      else data.condition = { match: pick.any ? 'any' : 'all', rules: pick.when.map(([fieldId, op, value], r) => ({ id: `${key}_r${i}_${r}`, fieldId, op, value })) }
    }
    return { id: `${key}_e${i + 1}`, source: nid(from), target: nid(to), sourceHandle: sh, targetHandle: th, data }
  })

  return { id: `tpl_${key}`, name: spec.name, description: spec.description, category: spec.category, tags: spec.tags, builtIn: true, createdAt: CREATED, fields: spec.fields, nodes, edges }
}

// ---------- Field shorthands ----------

type FieldExtra = Partial<Omit<FieldDef, 'id' | 'label' | 'type'>>
const field =
  (type: FieldDef['type'], width: FieldDef['width'] = 'half') =>
  (id: Id, label: string, extra: FieldExtra = {}): FieldDef => ({ id, label, type, width, ...extra })

export const text = field('text')
export const long = field('textarea', 'full')
export const money = field('currency')
export const num = field('number')
export const date = field('date')
export const yesNo = field('boolean')
export const who = field('user')
export const mail = field('email')
export const file = field('attachment')
