import { describe, expect, it } from 'vitest'
import { advance, burst, type Ctx, newSim } from '../engine/engine'
import { appFromTemplate, seedDesign } from './seed'
import { seedTemplates, TEMPLATE_CATEGORIES } from './seed-templates'
import type { App, Group, Template, User } from './types'

// The starter library: fifty templates a visitor can recognise, each one a workflow that
// is whole (nothing unreachable, every outcome has a path) and that runs to an end.

const templates = seedTemplates()

describe('the starter library', () => {
  it('has fifty templates, named once each, in the gallery’s departments', () => {
    expect(templates).toHaveLength(50)
    expect(new Set(templates.map((t) => t.id)).size).toBe(50)
    expect(new Set(templates.map((t) => t.name)).size).toBe(50)
    const counts = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c, templates.filter((t) => t.category === c).length]))
    expect(counts).toEqual({
      'Finance and AP': 9,
      'Purchasing and contracts': 5,
      'People and HR': 7,
      'IT and security': 7,
      'Facilities, fleet and safety': 7,
      'Government and public safety': 9,
      'Customers and operations': 6,
    })
    for (const t of templates) expect(t.builtIn).toBe(true)
  })

  it('names the work, not the pattern, and says what happens in a sentence or two', () => {
    for (const t of templates) {
      expect(t.name, t.id).not.toMatch(/parallel|two-level|multi|workflow|template|routing/i)
      expect(t.name.split(' ').length, t.name).toBeLessThanOrEqual(5)
      expect(t.description.length, t.name).toBeGreaterThan(60)
      expect(t.description, t.name).not.toMatch(/compliant|seamless|streamline/i)
      expect(t.fields.length, t.name).toBeGreaterThanOrEqual(2)
    }
  })

  for (const t of templates) {
    it(`“${t.name}” is whole`, () => {
      expect(problems(t)).toEqual([])
    })
  }

  for (const t of templates) {
    it(`“${t.name}” runs to an end`, () => {
      const { ctx, workflowId } = stamped(t)
      const sim = newSim(ctx.app.id, 7)
      sim.arrivals = false
      expect(burst(sim, ctx, workflowId, 12)).toBe(12)
      // Long enough for a 30-day wait, a rework loop and the slowest step.
      for (let day = 0; day < 150; day++) advance(sim, ctx, 24 * 60)
      const items = Object.values(sim.objects)
      const stuck = items.flatMap((o) => o.tokens.filter((k) => k.state === 'stuck').map((k) => `${o.number}: ${k.stuckReason}`))
      expect(stuck).toEqual([])
      expect(items.filter((o) => o.status === 'active').map((o) => o.number)).toEqual([])
    })
  }
})

/** Everything that would make a template arrive broken. */
function problems(t: Template): string[] {
  const out: string[] = []
  const ids = new Set(t.nodes.map((n) => n.id))
  const fields = new Map(t.fields.map((f) => [f.id, f]))
  if (ids.size !== t.nodes.length) out.push('two steps share an id')
  if (new Set(t.fields.map((f) => f.id)).size !== t.fields.length) out.push('two fields share an id')
  const starts = t.nodes.filter((n) => n.type === 'start')
  if (starts.length !== 1) out.push(`${starts.length} start steps`)
  if (!t.nodes.some((n) => n.type === 'end')) out.push('no end step')
  for (const e of t.edges) if (!ids.has(e.source) || !ids.has(e.target)) out.push(`path ${e.id} leads nowhere`)

  const reach = new Set<string>()
  const queue = starts.map((s) => s.id)
  while (queue.length) {
    const id = queue.shift()!
    if (reach.has(id)) continue
    reach.add(id)
    for (const e of t.edges) if (e.source === id) queue.push(e.target)
  }
  const field = (id: string | undefined, where: string, type?: string) => {
    if (!id) return
    const f = fields.get(id)
    if (!f) out.push(`${where} uses a field the template does not carry (${id})`)
    else if (type && f.type !== type) out.push(`${where} needs a ${type} field, and ${f.label} is ${f.type}`)
  }

  for (const n of t.nodes) {
    const label = n.data.label
    const outs = t.edges.filter((e) => e.source === n.id)
    const ins = t.edges.filter((e) => e.target === n.id)
    if (!reach.has(n.id)) out.push(`“${label}” cannot be reached`)
    if (n.type !== 'end' && outs.length === 0) out.push(`“${label}” has no path out`)
    if (n.type !== 'start' && ins.length === 0) out.push(`“${label}” has no path in`)
    if (n.type === 'user') {
      const d = n.data
      if (d.distribution === 'direct') out.push(`“${label}” names a person, which no other organization has`)
      if (d.distribution === 'field') field(d.assigneeFieldId, `“${label}”`, 'user')
      for (const id of Object.keys(d.fieldAccess)) field(id, `“${label}”`)
      for (const o of d.outcomes) {
        for (const a of o.actions) if (a.kind === 'setField') field(a.fieldId, `“${label}”`)
        if (outs.length > 1 && !outs.some((e) => e.data.outcomeId === o.id)) out.push(`outcome “${o.label}” of “${label}” has no path`)
      }
      for (const e of outs) if (outs.length > 1 && !d.outcomes.some((o) => o.id === e.data.outcomeId)) out.push(`a path out of “${label}” follows no outcome`)
      for (const id of d.separateFrom ?? []) if (!t.nodes.some((x) => x.id === id && x.type === 'user')) out.push(`“${label}” is kept apart from a step that is not there`)
      if (d.groupId || d.userId) out.push(`“${label}” carries someone else’s group or person`)
    }
    if (n.type === 'auto') {
      for (const o of n.data.outputs ?? []) field(o.fieldId, `“${label}”`)
      if (outs.filter((e) => !e.data.outcomeId).length > 1) out.push(`“${label}” has more than one plain path`)
    }
    if (n.type === 'decision') {
      if (!outs.some((e) => e.data.isDefault)) out.push(`“${label}” has no Otherwise path`)
      for (const e of outs) {
        if (!e.data.isDefault && !e.data.condition?.rules.length) out.push(`a path out of “${label}” has no rule`)
        for (const r of e.data.condition?.rules ?? []) field(r.fieldId, `“${label}”`)
      }
    }
    if (n.type === 'split' && outs.length < 2) out.push(`“${label}” splits into one path`)
    if (n.type === 'join') {
      if (ins.length < 2) out.push(`“${label}” joins fewer than two paths`)
      if (n.data.mode === 'count' && !(n.data.count && n.data.count >= 1 && n.data.count < ins.length)) out.push(`“${label}” waits for a number of paths that makes no sense`)
    }
    if ((n.type === 'start' || n.type === 'wait' || n.type === 'join') && outs.length > 1) out.push(`“${label}” has more than one path out`)
  }
  return out
}

/** An application started from the template, in a small organization: one team, a supervisor, the sample services. */
function stamped(t: Template): { ctx: Ctx; workflowId: string } {
  const design = seedDesign()
  const users: User[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, title: 'Staff', color: '#000', speed: 1, available: true }))
  const groups: Group[] = [{ id: 'g_team', name: 'Team', memberIds: users.map((u) => u.id), supervisorId: 'p0' }]
  const app: App = appFromTemplate(t, { groups, users })
  const wf = app.workflows[0]!
  const type = app.objectTypes[0]!
  // Its own object type, named for the work, with a title people will recognise.
  expect(type.name).toBe(t.item!.one)
  expect(type.fields.some((f) => f.id === type.titleFieldId)).toBe(true)
  expect(wf.kind).toBe('process')
  for (const n of wf.nodes) {
    if (n.type === 'user') n.data.groupId = 'g_team'
    if (n.type === 'auto') n.data.fallbackGroupId = 'g_team'
  }
  // Four-eyes rules survive being stamped.
  const original = t.nodes.filter((n) => n.type === 'user' && n.data.separateFrom?.length).length
  const kept = wf.nodes.filter((n) => n.type === 'user' && n.data.separateFrom?.length && n.data.separateFrom.every((id) => wf.nodes.some((x) => x.id === id))).length
  expect(kept).toBe(original)
  return { ctx: { app, users, groups, services: design.services }, workflowId: wf.id }
}
