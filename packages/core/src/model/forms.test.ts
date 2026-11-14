import { describe, expect, it } from 'vitest'
import { defaultLayout, formPlan, layoutProblems, tidyLayout, unplacedFields } from './forms'
import { contrast, cssProblem, DEFAULT_THEME, isDefaultTheme, mix, onColor, scopedCss, themeFor, themeProblems, themeVars } from './theme'
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
    // A picture's address must be text, and a picture kept in the design: anything else is refused and never drawn.
    const odd = { sections: [{ id: 's', columns: 1, items: [{ id: 'p', kind: 'image', url: ['https://evil.example/a.png'] }, { id: 'f', kind: 'field', fieldId: 'a' }] }] }
    expect(layoutProblems(odd)).toHaveLength(1)
    expect(formPlan(type([f('a')], odd as unknown as FormLayout)).sections[0]!.items.map((i) => i.kind)).toEqual(['field'])
  })
})

describe('a designed form', () => {
  const layout: FormLayout = {
    style: { width: 'medium', labels: 'beside', spacing: 'airy' },
    sections: [
      {
        id: 's1',
        title: 'Who',
        columns: 4,
        style: { look: 'tinted', accent: '#0f766e', title: 'large', rule: true },
        items: [
          { id: 'i1', kind: 'field', fieldId: 'a', span: 3, emphasis: true },
          { id: 'i2', kind: 'spacer', height: 9999, span: 1 },
          { id: 'i3', kind: 'text', text: 'Mind this.', tone: 'warning', span: 2 },
          { id: 'i4', kind: 'heading', text: 'Big', size: 'large' },
          { id: 'i5', kind: 'image', url: 'data:image/png;base64,AAAA', align: 'center', span: 2 },
        ],
      },
      { id: 's2', columns: 2, items: [{ id: 'i6', kind: 'heading', text: '' }, { id: 'i7', kind: 'image', url: '' }] },
    ],
  }
  const t = type([f('a'), f('b')], layout)

  it('carries every choice about how it looks, filled in and within bounds', () => {
    const plan = formPlan(t)
    expect(plan).toMatchObject({ width: 'medium', labels: 'beside', spacing: 'airy' })
    const s = plan.sections[0]!
    expect(s).toMatchObject({ columns: 4, look: 'tinted', accent: '#0f766e', titleSize: 'large', rule: true })
    expect(s.items[0]).toMatchObject({ kind: 'field', span: 3, emphasis: true })
    expect(s.items[1]).toMatchObject({ kind: 'spacer', height: 400, span: 1 })
    expect(s.items[2]).toMatchObject({ kind: 'text', tone: 'warning', span: 2 })
    // Without a width of its own, a heading takes the row.
    expect(s.items[3]).toMatchObject({ kind: 'heading', size: 'large', span: 4 })
    expect(s.items[4]).toMatchObject({ kind: 'image', align: 'center', span: 2 })
    expect(formPlan(type([f('a')]))).toMatchObject({ width: 'full', labels: 'above', spacing: 'normal' })
  })

  it('falls back to the plain choice for a value it does not know, so nothing unknown is ever drawn', () => {
    const odd = { style: { width: 'huge', labels: 7 }, sections: [{ id: 's', columns: 9, style: { look: 'neon', accent: 'red; background: url(x)', title: 'giant' }, items: [{ id: 'i', kind: 'field', fieldId: 'a', span: 40 }, { id: 't', kind: 'text', text: 'x', tone: 'shouty' }] }] }
    const plan = formPlan(type([f('a')], odd as unknown as FormLayout))
    expect(plan).toMatchObject({ width: 'full', labels: 'above' })
    expect(plan.sections[0]).toMatchObject({ columns: 2, look: 'plain', accent: undefined, titleSize: 'medium' })
    expect(plan.sections[0]!.items[0]).toMatchObject({ span: 2 })
    expect(plan.sections[0]!.items[1]).toMatchObject({ tone: 'plain' })
    expect(layoutProblems(odd)).toHaveLength(2)
    expect(layoutProblems(layout)).toEqual([])
  })

  it('shows people only what is finished, and the designer everything', () => {
    // People: the second section has no field, and its heading and picture are empty.
    expect(formPlan(t).sections.map((s) => s.id)).toEqual(['s1', 'sec_rest'])
    // The designer: every section and placeholder, and no “More” (it offers unplaced fields itself).
    const design = formPlan(t, { design: true })
    expect(design.sections.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(design.sections[1]!.items.map((i) => i.kind)).toEqual(['heading', 'image'])
    expect(unplacedFields(t).map((x) => x.id)).toEqual(['b'])
    // The designer shows fields a step would hide, and never starts a section closed.
    const closed: FormLayout = { sections: [{ id: 's', columns: 1, collapsed: true, items: [{ id: 'i', kind: 'field', fieldId: 'a' }] }] }
    const d = formPlan(type([f('a', { system: true })], closed), { design: true, access: { a: 'hidden' } })
    expect(d.sections[0]).toMatchObject({ collapsed: false })
    expect(d.sections[0]!.items).toHaveLength(1)
    expect(d.hidden).toBe(0)
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

  it('uses the organization’s own style rules as written, inside the Workspace, or not at all', () => {
    expect(scopedCss('')).toBe('')
    expect(scopedCss('button { border-radius: 0 }')).toBe('.modus-themed {\nbutton { border-radius: 0 }\n}')
    const fine = '/* our look { */ .form-label::before { content: "} «" } a > b { background: url("data:image/png;base64,AAAA") }'
    expect(cssProblem(fine)).toBeUndefined()
    expect(scopedCss(fine, '[x]')).toBe(`[x] {\n${fine}\n}`)
  })

  it('refuses rules that could close the Workspace’s scope and restyle the Studio', () => {
    // A stray brace, and braces a browser would not count: in quoted text and in comments.
    expect(scopedCss('a { color: red } } body { display: none } .x {')).toBe('')
    expect(scopedCss('a { color: red')).toBe('')
    expect(scopedCss('x { content: "{" } } body { display: none } y { content: "}" ')).toBe('')
    expect(scopedCss('x { color: red } /* { */ } body { display: none } /* } */ y {')).toBe('')
    expect(cssProblem('a { content: "open }')).toMatch(/quote/)
    expect(cssProblem('a { color: red } /* open')).toMatch(/comment/)
    // Nothing is cleaned up, so nothing can be put together by the cleaning: these are refused whole.
    expect(cssProblem('a { color: red } /<b>* { *<b>/ } body { display: none }')).toMatch(/angle bracket/)
    expect(cssProblem('a { color: red } /\\* { *\\/ }')).toMatch(/backslash/)
    expect(scopedCss('</style><script>alert(1)</script>')).toBe('')
  })

  it('refuses rules that could load anything', () => {
    expect(cssProblem('@import url(https://evil.example/x.css);')).toBeDefined()
    expect(cssProblem('@import "https://evil.example/x.css";')).toMatch(/@import/)
    expect(cssProblem('a { background: url(https://evil.example/?q=1) }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: URL( "https://evil.example/x" ) }')).toMatch(/url\(\)/)
    // An unquoted url() is read by a browser with rules of its own, where a comment is not a comment: none is allowed.
    expect(cssProblem('a { background: url(data:image/png;base64,AAAA) }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: url(data:image/png;base64,AA/*) } } body { display: none } x { y: url(*/) }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: url("data:image/png;base64,AAAA" ), url(//evil.example/x) }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: url("data:image/png;base64,AA A") }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: url (https://evil.example/x) }')).toMatch(/url\(\)/)
    expect(cssProblem('/* url(https://evil.example/x) */ a { color: red }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: url("data:text/html;base64,AAAA") }')).toMatch(/url\(\)/)
    expect(cssProblem('a { background: u\\72l(https://evil.example/x) }')).toMatch(/backslash/)
    expect(cssProblem('a { background: image-set("https://evil.example/x" 1x) }')).toMatch(/loads/)
    expect(cssProblem('a { background: -webkit-image-set("https://evil.example/x" 1x) }')).toMatch(/loads/)
    expect(cssProblem('@font-face { font-family: x; src: url(https://evil.example/f.woff) }')).toBeDefined()
    // A word split by a comment is two words to a browser too: not a url() at all, and it loads nothing.
    expect(cssProblem('a { background: u/**/rl(https://evil.example/x) }')).toBeUndefined()
  })

  it('says what is wrong with a look that is not one', () => {
    expect(themeProblems(undefined)).toEqual([])
    expect(themeProblems(DEFAULT_THEME)).toEqual([])
    expect(themeProblems({ primary: 'blue', radius: 'wavy', logo: 'https://example.com/logo.png' })).toHaveLength(3)
    expect(themeProblems({ css: 'a { background: url(https://evil.example/x) }' })).toHaveLength(1)
    expect(themeProblems({ css: '.form-label { color: red }' })).toEqual([])
  })
})
