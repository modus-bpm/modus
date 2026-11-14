import { describe, expect, it } from 'vitest'
import { defaultLayout, formPlan, layoutProblems, tidyLayout, unplacedFields } from './forms'
import { contrast, DEFAULT_THEME, isDefaultTheme, mix, onColor, scopedCss, themeFor, themeProblems, themeVars } from './theme'
import type { FieldDef, FormLayout, ObjectType } from './types'

const f = (id: string, extra: Partial<FieldDef> = {}): FieldDef => ({ id, label: id.toUpperCase(), type: 'text', width: 'half', ...extra })
const type = (fields: FieldDef[], form?: FormLayout): ObjectType => ({ id: 't', name: 'T', pluralName: 'Ts', icon: 'file', color: '#000', numberPrefix: 'T-', fields, permissions: {}, form })
const fieldsOf = (t: ObjectType, opts = {}) => formPlan(t, opts).sections.map((s) => s.items.flatMap((i) => (i.kind === 'field' ? [i.field.id] : [])))

describe('a form without a layout', () => {
  const t = type([f('a'), f('b', { width: 'full' }), f('c', { system: true }), f('rows', { type: 'table' })])

  it('is every field in order, two to a row, wide fields and tables across both', () => {
    const plan = formPlan(t, { includeSystem: true })
    expect(plan.sections).toHaveLength(1)
    expect(plan.sections[0]!.title).toBeUndefined()
    expect(plan.sections[0]!.items.map((i) => [i.kind === 'field' && i.field.id, i.span])).toEqual([['a', 1], ['b', 2], ['c', 1], ['rows', 2]])
  })

  it('leaves out fields set by the process on a create form, and fields hidden at a step', () => {
    expect(fieldsOf(t)).toEqual([['a', 'b', 'rows']])
    const plan = formPlan(t, { includeSystem: true, access: { a: 'hidden', b: 'read' } })
    expect(plan.hidden).toBe(1)
    expect(plan.sections[0]!.items.map((i) => i.kind === 'field' && i.field.id)).toEqual(['b', 'c', 'rows'])
  })

  it('has a default layout that draws the same form', () => {
    expect(formPlan(type(t.fields, defaultLayout(t)), { includeSystem: true }).sections[0]!.items).toEqual(formPlan(t, { includeSystem: true }).sections[0]!.items)
  })
})

describe('a form with a layout', () => {
  const layout: FormLayout = {
    sections: [
      { id: 's1', title: 'Who', columns: 3, items: [{ id: 'i1', kind: 'heading', text: 'About you' }, { id: 'i2', kind: 'field', fieldId: 'b', span: 2, label: 'Your name', help: 'As on your badge' }, { id: 'i3', kind: 'field', fieldId: 'a' }] },
      { id: 's2', title: 'Payment', columns: 1, collapsed: true, items: [{ id: 'i4', kind: 'text', text: 'Only if you are paying.' }, { id: 'i5', kind: 'field', fieldId: 'c', span: 3 }, { id: 'i6', kind: 'divider' }, { id: 'i7', kind: 'field', fieldId: 'gone' }, { id: 'i8', kind: 'field', fieldId: 'a' }] },
    ],
  }
  const t = type([f('a'), f('b', { helpText: 'Full name' }), f('c'), f('d', { required: true })], layout)

  it('puts fields where the layout says, with its labels and guidance, and widths that fit the section', () => {
    const plan = formPlan(t)
    expect(plan.sections.map((s) => [s.title, s.columns, s.collapsed])).toEqual([['Who', 3, false], ['Payment', 1, true], ['More', 2, false]])
    const [who, pay] = plan.sections
    expect(who!.items[1]).toMatchObject({ kind: 'field', label: 'Your name', help: 'As on your badge', span: 2 })
    expect(who!.items[2]).toMatchObject({ kind: 'field', label: 'A', span: 1 })
    expect(pay!.items.map((i) => [i.kind, i.span])).toEqual([['text', 1], ['field', 1], ['divider', 1]])
  })

  it('still shows a field the layout forgot, and skips one that is gone or placed twice', () => {
    expect(fieldsOf(t)).toEqual([['b', 'a'], ['c'], ['d']])
    expect(unplacedFields(t).map((x) => x.id)).toEqual(['d'])
    expect(tidyLayout(t, layout).sections[1]!.items.map((i) => i.id)).toEqual(['i4', 'i5', 'i6', 'i8'])
  })

  it('never hides a field security hides, and drops a section left with only decoration', () => {
    const plan = formPlan(t, { access: { c: 'hidden', a: 'hidden' } })
    expect(plan.sections.map((s) => s.title)).toEqual(['Who', 'More'])
    expect(plan.hidden).toBe(2)
  })

  it('does not start a section closed when it holds a required field', () => {
    const closed: FormLayout = { sections: [{ id: 's', columns: 2, collapsed: true, items: [{ id: 'i', kind: 'field', fieldId: 'd' }] }] }
    expect(formPlan(type(t.fields, closed)).sections[0]!.collapsed).toBe(false)
  })

  it('says what is wrong with a layout that is not one', () => {
    expect(layoutProblems(layout)).toEqual([])
    expect(layoutProblems({})).toHaveLength(1)
    expect(layoutProblems({ sections: [{ id: 's', columns: 5, items: [] }] })).toHaveLength(1)
    expect(layoutProblems({ sections: [{ id: 's', columns: 1, items: [{ id: 'x', kind: 'image', url: 'https://example.com/a.png' }, { id: 'x', kind: 'divider' }] }] })).toHaveLength(2)
  })
})

describe('the look', () => {
  it('is the organization’s with the application’s changes over it', () => {
    expect(themeFor(undefined)).toEqual(DEFAULT_THEME)
    expect(isDefaultTheme(themeFor({}))).toBe(true)
    const t = themeFor({ theme: { ...DEFAULT_THEME, primary: '#0f766e', name: 'Riverton' } }, { theme: { primary: '#b91c1c', name: '' } })
    expect(t).toMatchObject({ primary: '#b91c1c', name: 'Riverton', font: 'inter' })
    expect(isDefaultTheme(t)).toBe(false)
  })

  it('mixes colours and knows what reads on them', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#fff', '#000', 0)).toBe('#ffffff')
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(onColor('#facc15')).toBe('#0f172a')
    expect(onColor('#4f46e5')).toBe('#ffffff')
  })

  it('becomes properties that take the place of the product’s palette, light or dark', () => {
    const light = themeVars({ ...DEFAULT_THEME, primary: '#0f766e', radius: 'pill', font: 'serif', header: 'brand' })
    expect(light['--color-brand-600']).toBe('#0f766e')
    expect(light['--theme-on-brand']).toBe('#ffffff')
    expect(light['--theme-side']).toBe('#0f766e')
    expect(light['--radius-md']).toBe('9999px')
    expect(light['--font-sans']).toMatch(/serif/)
    const dark = themeVars({ ...DEFAULT_THEME, surface: '#111827', background: '#030712', text: '#f9fafb' })
    expect(dark['--color-white']).toBe('#111827')
    expect(dark['--color-slate-900']).toBe('#f9fafb')
    // Greys still read on the surface they sit on.
    expect(contrast(dark['--color-slate-600']!, dark['--color-white']!)).toBeGreaterThan(4.5)
    expect(contrast(themeVars(DEFAULT_THEME)['--color-slate-600']!, '#ffffff')).toBeGreaterThan(4.5)
    // A colour that is not one falls back, so a bad value can't blank the page.
    expect(themeVars({ ...DEFAULT_THEME, primary: 'red; background: url(x)' })['--color-brand-600']).toBe(DEFAULT_THEME.primary)
  })

  it('keeps the organization’s own style rules inside the Workspace and inside the page', () => {
    expect(scopedCss('')).toBe('')
    expect(scopedCss('button { border-radius: 0 }')).toBe('.modus-themed {\nbutton { border-radius: 0 }\n}')
    const out = scopedCss('@import url(https://evil.example/x.css); a { background: url(https://evil.example/?q=1) } b { background: url("data:image/png;base64,AAAA") } </style><script>alert(1)</script>')
    expect(out).not.toMatch(/@import|evil\.example|<|script>/)
    expect(out).toMatch(/data:image\/png;base64,AAAA/)
    // Braces in quoted text and in comments are read as a browser reads them, so they can't close the scope early.
    expect(scopedCss('a::before { content: "}" }')).toMatch(/content: "}"/)
    expect(scopedCss('x { content: "{" } } body { display: none } y { content: "}" ')).toBe('')
    expect(scopedCss('x { color: red } /* { */ } body { display: none } /* } */ y {')).toBe('')
    expect(scopedCss('a { content: "open }')).toBe('')
    // Nothing that loads: not through a comment-split word, an escape, or a function other than url().
    // (What is left of a split or escaped word is not a function a browser knows, so it loads nothing.)
    expect(scopedCss('a { background: u/**/rl(https://evil.example/x) }')).not.toMatch(/url\(/i)
    expect(scopedCss('a { background: u\\72l(https://evil.example/x) }')).not.toMatch(/url\(/i)
    expect(scopedCss('a { background: UR/**/L(https://evil.example/x) }')).not.toMatch(/url\(/i)
    expect(scopedCss('a { background: image-set("https://evil.example/x" 1x) }')).toBe('')
    expect(scopedCss('a { background: -webkit-image-set("https://evil.example/x" 1x) }')).toBe('')
    expect(scopedCss('@font-face { font-family: x; src: url(https://evil.example/f.woff) }')).not.toMatch(/evil/)
    // A stray brace would close the scope and let the rest out: the whole sheet is dropped.
    expect(scopedCss('a { color: red } } body { display: none } .x {')).toBe('')
    expect(scopedCss('a { color: red')).toBe('')
  })

  it('says what is wrong with a look that is not one', () => {
    expect(themeProblems(undefined)).toEqual([])
    expect(themeProblems(DEFAULT_THEME)).toEqual([])
    expect(themeProblems({ primary: 'blue', radius: 'wavy', logo: 'https://example.com/logo.png' })).toHaveLength(3)
  })
})
