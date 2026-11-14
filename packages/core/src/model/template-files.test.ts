import { describe, expect, it } from 'vitest'
import { seedTemplates } from './seed-templates'
import { alreadyThere, importTemplates, NotATemplateFile, readTemplateFile, templateFile, templateFileText, templateProblems } from './template-files'
import type { Template } from './types'

const library = seedTemplates()
const own = (t: Template): Template => {
  const { builtIn: _builtIn, ...rest } = structuredClone(t)
  return rest
}

describe('a template file', () => {
  it('carries templates out and back unchanged, without where they came from', () => {
    const three = library.slice(0, 3)
    const file = templateFile(three)
    expect(file.templates.every((t) => !('builtIn' in t))).toBe(true)
    const back = readTemplateFile(templateFileText(three))
    expect(back.refused).toEqual([])
    expect(back.templates).toEqual(three.map(own))
  })

  it('says what it is when it is something else', () => {
    expect(() => readTemplateFile('not json')).toThrow(NotATemplateFile)
    expect(() => readTemplateFile('{"apps":[],"users":[],"groups":[]}')).toThrow(/whole design/)
    expect(() => readTemplateFile('{"hello":1}')).toThrow(/not a Modus template file/)
    expect(() => readTemplateFile(JSON.stringify({ ...templateFile([]), version: 99 }))).toThrow(/newer Modus/)
  })

  it('gives the good templates and says what is wrong with the others', () => {
    const good = own(library[0]!)
    const noSteps = { ...own(library[1]!), nodes: [] }
    const lostPath = own(library[2]!)
    lostPath.edges[0]!.target = 'nowhere'
    const twice = own(library[0]!)
    const read = readTemplateFile(JSON.stringify({ ...templateFile([]), templates: [good, noSteps, lostPath, twice, 7] }))
    expect(read.templates.map((t) => t.id)).toEqual([good.id])
    expect(read.refused.map((r) => r.name)).toEqual([noSteps.name, lostPath.name, twice.name, 'A template without a name'])
    expect(read.refused[0]!.problems).toEqual(['It has no steps.'])
    expect(read.refused[1]!.problems[0]).toMatch(/step that isn't there/)
    expect(read.refused[2]!.problems[0]).toMatch(/same id/)
  })

  it('finds nothing wrong with any starter template', () => {
    for (const t of library) expect(templateProblems(t), t.name).toEqual([])
  })
})

describe('importing templates', () => {
  const mine = library.slice(0, 2)
  const [a, b, c] = library.slice(0, 3).map(own) as [Template, Template, Template]
  const changed = { ...a, description: 'Ours now.' }

  it('adds the ones the library lacks as the organization’s own', () => {
    const done = importTemplates(mine, [c], 'copy')
    expect(done.added).toEqual([c.name])
    expect(done.templates).toHaveLength(3)
    expect(done.templates[2]).toEqual({ ...c, builtIn: false })
    expect(mine).toHaveLength(2)
  })

  it('knows which ones the library already has', () => {
    expect(alreadyThere(mine, [a, c]).map((t) => t.id)).toEqual([a.id])
  })

  it('replaces one in place, and a built-in template stays built in', () => {
    const done = importTemplates(mine, [changed, b], 'replace')
    expect(done.replaced).toEqual([a.name, b.name])
    expect(done.templates.map((t) => t.id)).toEqual(mine.map((t) => t.id))
    expect(done.templates[0]).toMatchObject({ description: 'Ours now.', builtIn: true })
  })

  it('keeps both: the copy sits beside the original under its own id and name', () => {
    const once = importTemplates(mine, [changed], 'copy', 'Maya')
    expect(once.copied).toEqual([`${a.name} (imported)`])
    expect(once.templates.map((t) => t.name)).toEqual([a.name, `${a.name} (imported)`, b.name])
    expect(once.templates[1]).toMatchObject({ description: 'Ours now.', builtIn: false, createdBy: 'Maya' })
    expect(once.templates[1]!.id).not.toBe(a.id)
    expect(once.templates[0]).toEqual(mine[0])
    const again = importTemplates(once.templates, [changed], 'copy')
    expect(again.copied).toEqual([`${a.name} (imported 2)`])
  })

  it('skips the ones it has and still adds the rest', () => {
    const done = importTemplates(mine, [changed, c], 'skip')
    expect(done.skipped).toEqual([a.name])
    expect(done.added).toEqual([c.name])
    expect(done.templates[0]).toEqual(mine[0])
  })
})
