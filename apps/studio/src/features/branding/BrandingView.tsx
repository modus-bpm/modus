import { ImageUp, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { generateData } from '@modus-bpm/core/engine/generate'
import { contrast, cssProblem, DEFAULT_THEME, isHex, MAX_CSS_CHARS, onColor, THEME_FONTS, themeFor } from '@modus-bpm/core/model/theme'
import type { App, Theme, ThemeFont } from '@modus-bpm/core/model/types'
import { FormRenderer } from '../../components/FormRenderer'
import { Themed } from '../../components/Themed'
import { Button, Card, cx, Field, Input, Segmented, Select, Textarea } from '../../components/ui'
import { useApp, useDesign } from '../../store/design'
import { useUi } from '../../store/ui'
import { readImage } from './look'

// The look of the Workspace: the screens people work and enter data in. An administrator sets it
// for the organization, an application can differ, and the preview is drawn with the same rules
// the Workspace uses, so what is shown here is what people get.

const PRESETS: Array<{ name: string; look: Partial<Theme> }> = [
  { name: 'Modus', look: {} },
  { name: 'Civic', look: { primary: '#1d4ed8', background: '#f3f6fb', radius: 'square', labels: 'bold', header: 'brand' } },
  { name: 'Forest', look: { primary: '#15803d', background: '#f4f7f2', surface: '#ffffff', text: '#14261a', radius: 'round', font: 'system' } },
  { name: 'Clay', look: { primary: '#b45309', background: '#faf6f0', surface: '#fffdf9', text: '#292017', font: 'serif', fields: 'underlined', labels: 'caps' } },
  { name: 'Night', look: { primary: '#818cf8', background: '#0b1020', surface: '#151b2e', text: '#e7eaf3', fields: 'filled', header: 'dark' } },
  { name: 'High contrast', look: { primary: '#000000', background: '#ffffff', surface: '#ffffff', text: '#000000', radius: 'square', labels: 'bold', density: 'roomy' } },
]

const COLOURS: Array<{ key: 'primary' | 'background' | 'surface' | 'text'; label: string; hint: string }> = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, links and what is selected.' },
  { key: 'background', label: 'Page', hint: 'Behind everything.' },
  { key: 'surface', label: 'Surface', hint: 'Cards, forms and fields.' },
  { key: 'text', label: 'Text', hint: 'Greys and borders are mixed from it.' },
]

type Scope = 'org' | 'app'

export function BrandingView() {
  const appId = useUi((s) => s.appId)
  const app = useApp(appId)
  const orgLook = useDesign((s) => s.design.theme)
  const update = useDesign((s) => s.update)
  const toast = useUi((s) => s.toast)
  const [scope, setScope] = useState<Scope>('org')
  const logoRef = useRef<HTMLInputElement>(null)

  const design = useDesign((s) => s.design)
  // What people see: the organization's look, with this application's changes over it.
  const shown = useMemo(() => themeFor(design, scope === 'app' ? app : undefined), [design, app, scope])
  const own = scope === 'app' ? (app?.theme ?? {}) : (orgLook ?? {})
  const changed = Object.values(own).some((v) => v !== undefined && v !== '')

  /** Set one part of the look. For an application, a part equal to the organization's is not kept: it follows it. */
  const set = <K extends keyof Theme>(key: K, value: Theme[K] | undefined) =>
    update((d) => {
      if (scope === 'org') {
        const next = { ...DEFAULT_THEME, ...d.theme, [key]: value }
        if (value === undefined || value === '') delete next[key]
        d.theme = next
        return
      }
      const a = d.apps.find((x) => x.id === appId)
      if (!a) return
      const inherited = themeFor(d)[key]
      const next: Partial<Theme> = { ...a.theme, [key]: value }
      if (value === undefined || value === '' || value === inherited) delete next[key]
      a.theme = Object.keys(next).length ? next : undefined
    })

  const apply = (look: Partial<Theme>) =>
    update((d) => {
      if (scope === 'org') d.theme = { ...DEFAULT_THEME, ...look, name: d.theme?.name, logo: d.theme?.logo, css: d.theme?.css }
      else {
        const a = d.apps.find((x) => x.id === appId)
        if (a) a.theme = { ...look, name: a.theme?.name, logo: a.theme?.logo, css: a.theme?.css }
      }
    })

  const reset = () => {
    update((d) => {
      if (scope === 'org') d.theme = undefined
      else {
        const a = d.apps.find((x) => x.id === appId)
        if (a) a.theme = undefined
      }
    })
    toast(scope === 'org' ? 'The Workspace is back to the product’s own look.' : `${app?.name ?? 'This application'} follows the organization’s look again.`)
  }

  const pickLogo = async (file: File | undefined) => {
    if (!file) return
    try {
      set('logo', await readImage(file))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That picture could not be used.', 'warn')
    }
  }

  // Colours that would be hard to read, said before anyone has to squint.
  const warnings = [
    contrast(shown.text, shown.surface) < 4.5 && `Text on the surface has a contrast of ${contrast(shown.text, shown.surface).toFixed(1)}:1. Body text wants 4.5:1 or more.`,
    contrast(shown.text, shown.background) < 4.5 && `Text on the page has a contrast of ${contrast(shown.text, shown.background).toFixed(1)}:1. Body text wants 4.5:1 or more.`,
    contrast(shown.primary, shown.surface) < 3 && `The primary colour barely stands out from the surface (${contrast(shown.primary, shown.surface).toFixed(1)}:1). Links and outlines want 3:1 or more.`,
  ].filter((w): w is string => !!w)
  const cssWhy = cssProblem(shown.css)

  if (!app) return null
  const inherits = (key: keyof Theme) => scope === 'app' && (app.theme?.[key] === undefined || app.theme?.[key] === '')

  return (
    <div className="flex h-full">
      <div className="w-[400px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h1 className="text-base font-semibold text-slate-900">Branding</h1>
          <p className="mt-0.5 text-xs text-slate-500">How the Workspace looks to the people who work and enter data in it. The Studio keeps its own look.</p>
          <div className="mt-3">
            <Segmented<Scope>
              ariaLabel="Whose look"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'org', label: 'Organization', title: 'The look every application starts from' },
                { value: 'app', label: app.name, title: `Where ${app.name} differs from the organization` },
              ]}
            />
          </div>
          {scope === 'app' && <p className="mt-2 text-[11px] text-slate-500">Anything you don’t change here follows the organization’s look.</p>}
        </div>

        <div className="space-y-6 px-5 py-4">
          <Group title="Start from">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const t = { ...DEFAULT_THEME, ...p.look }
                return (
                  <button key={p.name} type="button" onClick={() => apply(p.look)} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50" title={`Use the ${p.name} look`}>
                    <span className="flex h-4 w-6 overflow-hidden rounded-sm ring-1 ring-black/10" aria-hidden>
                      <span className="flex-1" style={{ background: t.background }} />
                      <span className="flex-1" style={{ background: t.surface }} />
                      <span className="flex-1" style={{ background: t.primary }} />
                    </span>
                    {p.name}
                  </button>
                )
              })}
            </div>
          </Group>

          <Group title="Name and logo">
            <Field label="Name" hint={scope === 'org' ? 'Shown at the top of the Workspace. Leave empty to show none.' : inherits('name') ? 'Follows the organization’s.' : undefined}>
              <Input value={own.name ?? ''} maxLength={80} placeholder={scope === 'app' ? (orgLook?.name ?? 'The organization’s name') : 'e.g. City of Riverton'} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex h-12 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-1.5">
                {shown.logo ? <img src={shown.logo} alt="The logo" className="max-h-full max-w-full object-contain" /> : <span className="text-[11px] text-slate-400">No logo</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" icon={<ImageUp size={13} />} onClick={() => logoRef.current?.click()}>
                  {own.logo ? 'Change' : 'Choose a logo'}
                </Button>
                {own.logo && (
                  <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => set('logo', undefined)}>
                    Remove
                  </Button>
                )}
              </div>
              <input
                ref={logoRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                className="hidden"
                aria-label="Logo picture"
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">PNG, JPEG, GIF, WebP or SVG, up to 300 KB. It is kept in the design.</p>
          </Group>

          <Group title="Colours">
            <div className="grid grid-cols-2 gap-3">
              {COLOURS.map((c) => (
                <ColourField key={c.key} label={c.label} hint={inherits(c.key) ? 'Follows the organization’s.' : c.hint} value={shown[c.key]} onChange={(v) => set(c.key, v)} />
              ))}
            </div>
            {warnings.map((w) => (
              <p key={w} className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700" role="status">
                <TriangleAlert size={12} className="mt-px shrink-0" /> {w}
              </p>
            ))}
          </Group>

          <Group title="Type and shape">
            <Field label="Typeface">
              <Select value={shown.font} onChange={(e) => set('font', e.target.value as ThemeFont)}>
                {(Object.keys(THEME_FONTS) as ThemeFont[]).map((f) => (
                  <option key={f} value={f}>
                    {THEME_FONTS[f].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Choice label="Corners" value={shown.radius} onChange={(v) => set('radius', v)} options={[['square', 'Square'], ['soft', 'Soft'], ['round', 'Round'], ['pill', 'Pill']]} />
            <Choice label="Room in forms" value={shown.density} onChange={(v) => set('density', v)} options={[['compact', 'Compact'], ['comfortable', 'Comfortable'], ['roomy', 'Roomy']]} />
          </Group>

          <Group title="Forms">
            <Choice label="Fields" value={shown.fields} onChange={(v) => set('fields', v)} options={[['outlined', 'Outlined'], ['filled', 'Filled'], ['underlined', 'Underlined']]} />
            <Choice label="Labels" value={shown.labels} onChange={(v) => set('labels', v)} options={[['plain', 'Plain'], ['bold', 'Bold'], ['caps', 'Small caps']]} />
            <p className="mt-2 text-[11px] text-slate-500">
              Where each field goes on a form, its sections, headings and instructions are set per object type: <span className="font-medium text-slate-700">Object Types › Form layout</span>.
            </p>
          </Group>

          <Group title="Side panel">
            <Choice label="The Workspace’s side panel" value={shown.header} onChange={(v) => set('header', v)} options={[['light', 'Like the page'], ['brand', 'Primary colour'], ['dark', 'Dark']]} />
          </Group>

          <Group title="Your own style rules">
            <Field
              label="CSS"
              hint="For whatever the choices above don’t reach. The rules apply inside the Workspace only, exactly as written, and can’t load anything from elsewhere (no @import, no url() to a site, no backslashes). On a server, only an administrator can change them."
            >
              <Textarea
                className="min-h-[140px] font-mono text-xs"
                spellCheck={false}
                maxLength={MAX_CSS_CHARS}
                value={own.css ?? ''}
                placeholder={'.form-section-title {\n  border-bottom: 2px solid var(--color-brand-600);\n  padding-bottom: 4px;\n}'}
                onChange={(e) => set('css', e.target.value)}
              />
            </Field>
            {cssWhy && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700" role="status">
                <TriangleAlert size={12} className="mt-px shrink-0" /> These rules are not being used. {cssWhy}
              </p>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              Useful names: <code>.form-section-title</code>, <code>.form-label</code>, <code>.form-grid</code>, <code>.form-heading</code>, <code>.form-text</code>, <code>.theme-side</code>, and the colours as <code>var(--color-brand-600)</code>,{' '}
              <code>var(--color-white)</code>, <code>var(--color-slate-200)</code>.
            </p>
          </Group>

          <div className="border-t border-slate-200 pt-4">
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset} disabled={!changed}>
              {scope === 'org' ? 'Back to the product’s look' : 'Follow the organization’s look'}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto bg-slate-100 p-6">
        <div className="mx-auto max-w-[900px]">
          <p className="mb-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Preview · the Workspace{scope === 'app' ? ` of ${app.name}` : ''}</p>
          <Preview app={app} look={shown} />
        </div>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Choice<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 text-xs font-medium text-slate-600">{label}</div>
      <Segmented<T> size="sm" ariaLabel={label} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  )
}

/** A colour, by picker or by hex. What is typed is kept only once it is a colour. */
function ColourField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const [typed, setTyped] = useState<string>()
  const text = typed ?? value
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <input type="color" aria-label={`${label} colour`} value={isHex(value) && value.length === 7 ? value : DEFAULT_THEME.primary} onChange={(e) => onChange(e.target.value)} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white p-0.5" />
        <Input
          className="font-mono text-xs"
          value={text}
          aria-label={`${label} colour as hex`}
          aria-invalid={!isHex(text)}
          onChange={(e) => {
            const v = e.target.value.trim()
            setTyped(v)
            if (isHex(v)) onChange(v.toLowerCase())
          }}
          onBlur={() => setTyped(undefined)}
        />
      </div>
    </Field>
  )
}

/** The Workspace in small: its side panel, a card of work and a form of this application, drawn in the look. */
function Preview({ app, look }: { app: App; look: Theme }) {
  const users = useDesign((s) => s.design.users)
  const type = app.objectTypes[0]
  const values = useMemo(() => (type ? generateData({ rng: 7 }, type, app.lists, users, 0, `${type.numberPrefix}1001`) : {}), [type, app.lists, users])
  const [draft, setDraft] = useState<Record<string, unknown>>()
  return (
    <Themed theme={look} className="overflow-hidden rounded-xl shadow-lg ring-1 ring-black/10">
      <div className="flex min-h-[560px] bg-canvas">
        <aside className="theme-side hidden w-[200px] shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
          {(look.name || look.logo) && (
            <div className="flex items-center gap-2.5 border-b border-slate-200 px-3.5 py-3">
              {look.logo && <img src={look.logo} alt="" className="h-7 max-w-[110px] shrink-0 object-contain" />}
              {look.name && <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{look.name}</span>}
            </div>
          )}
          <nav className="space-y-0.5 p-2" aria-label="Preview of the Workspace’s pages">
            {['Home', 'My work', 'Queues', 'My requests'].map((label, i) => (
              <div key={label} className={cx('flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium', i === 1 ? 'bg-brand-50 text-brand-700' : 'text-slate-600')}>
                <span className="flex-1">{label}</span>
                {i === 1 && <span className="rounded-full bg-brand-600 px-1.5 text-[10.5px] font-semibold text-white">3</span>}
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 space-y-4 p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{type ? `${type.name} ${type.numberPrefix}1001` : app.name}</h2>
            <p className="text-xs text-slate-500">Due tomorrow · High priority</p>
          </div>
          <Card className="p-4">
            {type ? <FormRenderer type={type} lists={app.lists} users={users} values={draft ?? values} onChange={setDraft} /> : <p className="text-sm text-slate-500">Add an object type to see its form here.</p>}
          </Card>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Approve</Button>
            <Button>Return for changes</Button>
            <a className="ml-auto text-xs font-medium text-brand-700 underline-offset-2 hover:underline" href="#/studio" onClick={(e) => e.preventDefault()}>
              See the history
            </a>
          </div>
          <p className="text-[11px] text-slate-500">
            Text on the primary colour is drawn in {onColor(look.primary) === '#ffffff' ? 'white' : 'black'}, whichever reads better.
          </p>
        </div>
      </div>
    </Themed>
  )
}
