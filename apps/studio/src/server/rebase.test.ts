import { describe, expect, it } from 'vitest'
import { publishWorkflow } from '@modus-bpm/core'
import { seedDesign } from '@modus-bpm/core/model/seed'
import type { Design } from '@modus-bpm/core/model/types'
import { carryOver, changedParts, describeParts } from './rebase'

const base = seedDesign()
const edit = (d: Design, change: (x: Design) => void): Design => {
  const next = structuredClone(d)
  change(next)
  return next
}
const wf = (d: Design, id = 'w_invoice') => d.apps[0]!.workflows.find((w) => w.id === id)!
const keys = (d: Design, from = base) => changedParts(from, d).map((p) => p.key).sort()

describe('a design in parts', () => {
  it('counts what changed, added and removed, one part per thing a person would name', () => {
    expect(changedParts(base, base)).toEqual([])
    expect(changedParts(base, structuredClone(base))).toEqual([])
    const mine = edit(base, (d) => {
      wf(d).nodes[1]!.data.label = 'Capture'
      d.apps[0]!.objectTypes[0]!.fields[0]!.label = 'Invoice No.'
      d.apps[0]!.name = 'Invoices'
      d.users.push({ id: 'u_new', name: 'Nia', title: '', color: '', speed: 1, available: true })
      d.groups = d.groups.filter((g) => g.id !== 'g_records')
      d.users.reverse()
    })
    expect(keys(mine)).toEqual(['app:app_invoice', 'group:g_records', `type:app_invoice/${base.apps[0]!.objectTypes[0]!.id}`, 'user:u_new', 'wf:app_invoice/w_invoice'])
    expect(changedParts(base, mine).find((p) => p.key === 'group:g_records')).toMatchObject({ kind: 'group', name: 'Records' })
  })

  it('doesn’t count a workflow’s versions: those are the server’s', () => {
    const published = edit(base, (d) => void (d.apps[0]!.workflows = d.apps[0]!.workflows.map((w) => (w.id === 'w_invoice' ? publishWorkflow(w) : w))))
    expect(changedParts(base, published)).toEqual([])
  })

  it('says what changed in words', () => {
    expect(describeParts([{ key: 'a', kind: 'workflow', name: 'Invoice Approval' }])).toBe('the workflow “Invoice Approval”')
    const many = [1, 2, 3].map((i) => ({ key: `u${i}`, kind: 'person' as const, name: `P${i}` })).concat([{ key: 'w', kind: 'workflow' as never, name: 'W' }])
    expect(describeParts(many)).toBe('3 people and 1 workflow')
  })
})

describe('carrying changes over to a design someone else saved', () => {
  const mine = edit(base, (d) => {
    wf(d).nodes[1]!.data.label = 'Mine'
    d.users.push({ id: 'u_mine', name: 'Mine', title: '', color: '', speed: 1, available: true })
    d.groups = d.groups.filter((g) => g.id !== 'g_records')
  })

  it('keeps both sides when they changed different parts, with the server’s versions on my workflow', () => {
    const theirs = edit(base, (d) => {
      d.apps[0]!.workflows = d.apps[0]!.workflows.map((w) => (w.id === 'w_invoice' ? publishWorkflow(w, { note: 'theirs' }) : w))
      d.apps[1]!.name = 'Their fleet'
      d.users.find((u) => u.id === 'u_maya')!.title = 'Senior Clerk'
      d.users.push({ id: 'u_theirs', name: 'Theirs', title: '', color: '', speed: 1, available: true })
    })
    const r = carryOver(base, mine, theirs)
    expect(r.conflicts).toEqual([])
    expect(wf(r.design).nodes[1]!.data.label).toBe('Mine')
    expect(wf(r.design).versions?.at(-1)?.note).toBe('theirs')
    expect(r.design.apps[1]!.name).toBe('Their fleet')
    expect(r.design.users.find((u) => u.id === 'u_maya')!.title).toBe('Senior Clerk')
    expect(r.design.users.map((u) => u.id)).toEqual(expect.arrayContaining(['u_mine', 'u_theirs']))
    expect(r.design.groups.some((g) => g.id === 'g_records')).toBe(false)
    // Saved from there, only my parts differ from theirs.
    expect(keys(r.design, theirs)).toEqual(['group:g_records', 'user:u_mine', 'wf:app_invoice/w_invoice'])
  })

  it('names a part both changed, and lets the caller choose whose to keep', () => {
    const theirs = edit(base, (d) => {
      wf(d).nodes[1]!.data.label = 'Theirs'
      d.users.find((u) => u.id === 'u_maya')!.title = 'Senior Clerk'
    })
    const kept = carryOver(base, mine, theirs, 'mine')
    expect(kept.conflicts).toEqual([{ key: 'wf:app_invoice/w_invoice', kind: 'workflow', name: 'Invoice Approval' }])
    expect(wf(kept.design).nodes[1]!.data.label).toBe('Mine')
    const given = carryOver(base, mine, theirs, 'theirs')
    expect(given.conflicts).toHaveLength(1)
    expect(wf(given.design).nodes[1]!.data.label).toBe('Theirs')
    // My other changes go on either way.
    for (const r of [kept, given]) expect(r.design.users.some((u) => u.id === 'u_mine')).toBe(true)
  })

  it('is no conflict when both made the same change, and theirs alone when I changed nothing', () => {
    expect(carryOver(base, mine, structuredClone(mine)).conflicts).toEqual([])
    const theirs = edit(base, (d) => void (d.apps[0]!.name = 'Renamed'))
    expect(carryOver(base, base, theirs).design).toBe(theirs)
  })

  it('treats the organization’s look as one part: mine when I changed it, theirs otherwise', () => {
    const look = { primary: '#15803d', background: '#ffffff', surface: '#ffffff', text: '#000000', font: 'inter', radius: 'soft', density: 'comfortable', fields: 'outlined', labels: 'plain', header: 'light' } as const
    const themed = edit(base, (d) => void (d.theme = { ...look }))
    expect(changedParts(base, themed)).toEqual([{ key: 'look', kind: 'look', name: 'Workspace' }])
    const theirs = edit(base, (d) => void (d.apps[0]!.name = 'Invoices'))
    expect(carryOver(base, themed, theirs).design.theme).toEqual(look)
    expect(carryOver(base, theirs, themed).design.theme).toEqual(look)
    // Both changed it, differently: a conflict the caller decides.
    const other = edit(base, (d) => void (d.theme = { ...look, primary: '#b91c1c' }))
    const both = carryOver(base, themed, other)
    expect(both.conflicts.map((c) => c.key)).toEqual(['look'])
    expect(both.design.theme?.primary).toBe('#15803d')
    expect(carryOver(base, themed, other, 'theirs').design.theme?.primary).toBe('#b91c1c')
  })

  it('carries a new application and a removed one', () => {
    const added = edit(base, (d) => {
      d.apps.push({ ...structuredClone(d.apps[2]!), id: 'app_new', name: 'New' })
      d.apps = d.apps.filter((a) => a.id !== 'app_fleet')
    })
    const theirs = edit(base, (d) => void (d.users[0]!.title = 'x'))
    const r = carryOver(base, added, theirs)
    expect(r.conflicts).toEqual([])
    expect(r.design.apps.map((a) => a.id)).toEqual(['app_invoice', base.apps[2]!.id, 'app_new'])
  })
})
