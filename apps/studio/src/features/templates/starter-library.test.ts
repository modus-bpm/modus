import { describe, expect, it } from 'vitest'
import { seedDesign } from '@modus-bpm/core/model/seed'
import { addStarterTemplates, seedTemplates } from '@modus-bpm/core/model/seed-templates'
import { instantiateTemplate, suggestBinding } from '@modus-bpm/core/model/templates'
import { validate } from '../workflow/model'
import { stepsNeedingGroup } from './UseTemplateModal'

// What a person meets after "Use in this app": the designer's own check. A starter template
// may ask for groups (the organization's to choose) and nothing else.

describe('the starter library in the designer', () => {
  const design = seedDesign()
  const app = design.apps[0]!
  const type = app.objectTypes[0]!

  for (const t of seedTemplates()) {
    it(`“${t.name}” comes in asking only for who does the work`, () => {
      const made = instantiateTemplate(app, t, { objectTypeId: type.id, binding: suggestBinding(t, type.fields), groups: design.groups, users: design.users, kind: 'process' })
      const target = {
        ...app,
        workflows: [...app.workflows, made.workflow],
        objectTypes: app.objectTypes.map((x) => (x.id === type.id ? { ...x, fields: [...x.fields, ...made.newFields] } : x)),
        lists: [...app.lists, ...made.newLists],
      }
      const before = validate(made.workflow, target, design.groups, design.users, design.services)
      expect(before.filter((i) => i.level === 'error' && !/needs a group/.test(i.text)).map((i) => i.text)).toEqual([])
      // Every people step, and every automated step that hands its failures to a person.
      expect(stepsNeedingGroup(made.workflow, design.groups, design.users)).toBe(made.workflow.nodes.filter((n) => n.type === 'user' || (n.type === 'auto' && n.data.onFailure === 'manual')).length)

      // Once every step has a group, the check is clean: no errors and no loose ends.
      const group = design.groups[0]!.id
      for (const n of made.workflow.nodes) {
        if (n.type === 'user') n.data.groupId = group
        if (n.type === 'auto') n.data.fallbackGroupId = group
      }
      const after = validate(made.workflow, target, design.groups, design.users, design.services)
      expect(after.filter((i) => !/No one in .* is available|needs a distribution group/.test(i.text)).map((i) => i.text)).toEqual([])
    })
  }
})

describe('a design saved before the library grew', () => {
  it('gains the new templates once, and the first six take their new names unless someone renamed them', () => {
    const all = seedTemplates()
    const six = ['tpl_two_level', 'tpl_parallel_review', 'tpl_onboarding', 'tpl_ai_hitl', 'tpl_three_way', 'tpl_incident'].map((id) => all.find((t) => t.id === id)!)
    const saved = six.map((t) => ({ ...t }))
    saved[0]!.name = 'Two-level approval'
    saved[1]!.name = 'Our contract sign-off' // renamed by the organization
    saved.push({ ...six[2]!, id: 'tpl_mine', name: 'Ours', builtIn: false })
    const out = addStarterTemplates(saved)
    expect(out).toHaveLength(51)
    expect(out.find((t) => t.id === 'tpl_two_level')!.name).toBe('Purchase request')
    expect(out.find((t) => t.id === 'tpl_parallel_review')!.name).toBe('Our contract sign-off')
    expect(out.find((t) => t.id === 'tpl_mine')!.name).toBe('Ours')
    expect(addStarterTemplates(out)).toHaveLength(51)
  })
})
