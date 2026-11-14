import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GripVertical, Heading, ImageUp, LayoutPanelTop, Megaphone, Minus, MoveVertical, Plus, RotateCcw, Square, Text, Trash2 } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useMemo, useRef, useState } from 'react'
import { type DesignHooks, FormRenderer } from '../../components/FormRenderer'
import { FIELD_ICONS } from '../../components/icons'
import { Themed } from '../../components/Themed'
import { Button, cx, Field, IconButton, Input, Segmented, Select, Textarea, Toggle } from '../../components/ui'
import { generateData } from '@modus-bpm/core/engine/generate'
import { FIELD_TYPE_LABEL } from '@modus-bpm/core/model/format'
import { defaultLayout, fieldItem, type PlannedItem, unplacedFields } from '@modus-bpm/core/model/forms'
import { isHex } from '@modus-bpm/core/model/theme'
import type { App, FormItem, FormLayout, FormSection, FormStyle, ObjectType, SectionStyle } from '@modus-bpm/core/model/types'
import { uid } from '@modus-bpm/core/model/util'
import { useDesign } from '../../store/design'
import { useUi } from '../../store/ui'
import { readImage, useDesignLook } from '../branding/look'

// The forms designer. The form itself is the canvas, drawn by the same code and in the same look
// as the Workspace draws it: drag fields and elements onto it, drag them about, pull an edge to
// make one wider, and click anything to set how it looks. What you see is the form people get.
//
// The designer only arranges and styles. Who may see or change a field stays with field security,
// and a field left off the form is still shown to people at its end, so nothing can be lost here.

type Selection = { kind: 'form' } | { kind: 'section'; id: string } | { kind: 'item'; id: string }
type Span = 1 | 2 | 3 | 4
type ElementKind = 'heading' | 'text' | 'callout' | 'divider' | 'spacer' | 'image'
/** What is being dragged: something already on the form, a field not yet on it, or a new element. */
type Dragged = { t: 'item'; id: string } | { t: 'field'; fieldId: string } | { t: 'new'; kind: ElementKind }
/** Where it would land. */
type Target = { at: 'item'; id: string; side: 'before' | 'after' | 'above' | 'below' } | { at: 'section'; id: string } | { at: 'new' }

const DRAG = 'application/x-modus-form-designer'

const ELEMENTS: Array<{ kind: ElementKind; label: string; hint: string; icon: typeof Heading }> = [
  { kind: 'heading', label: 'Heading', hint: 'A title inside a section', icon: Heading },
  { kind: 'text', label: 'Paragraph', hint: 'Instructions or small print', icon: Text },
  { kind: 'callout', label: 'Callout', hint: 'Something not to miss', icon: Megaphone },
  { kind: 'divider', label: 'Divider', hint: 'A line across the section', icon: Minus },
  { kind: 'spacer', label: 'Space', hint: 'Room, or an empty cell', icon: MoveVertical },
  { kind: 'image', label: 'Picture', hint: 'A logo, a diagram, a seal', icon: ImageUp },
]

const WIDTHS = { wide: undefined, tablet: 720, phone: 390 } as const

function newElement(kind: ElementKind): FormItem {
  const id = uid('fi')
  switch (kind) {
    case 'heading':
      return { id, kind: 'heading', text: '' }
    case 'text':
      return { id, kind: 'text', text: '' }
    case 'callout':
      return { id, kind: 'text', text: '', tone: 'note' }
    case 'divider':
      return { id, kind: 'divider' }
    case 'spacer':
      return { id, kind: 'spacer', height: 24, span: 1 }
    case 'image':
      return { id, kind: 'image', url: '' }
  }
}

/** The layout a form already has while it lays itself out: the first change keeps it and builds on it. */
const startingLayout = (type: ObjectType): FormLayout => structuredClone(defaultLayout(type))

interface Props {
  app: App
  type: ObjectType
  /** The Fields / Form design switch, shown in the designer's bar. */
  tabs: ReactNode
  /** Open a field's own settings (the Fields tab). */
  onEditField: (fieldId: string) => void
}

export function FormDesigner({ app, type, tabs, onEditField }: Props) {
  const updateType = useDesign((s) => s.updateType)
  const users = useDesign((s) => s.design.users)
  const toast = useUi((s) => s.toast)
  const look = useDesignLook(app.id)
  const [selected, setSelected] = useState<Selection>({ kind: 'form' })
  const [target, setTarget] = useState<Target | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [device, setDevice] = useState<keyof typeof WIDTHS>('wide')
  const [sample, setSample] = useState(false)
  const dragged = useRef<Dragged | null>(null)

  const layout = type.form ?? defaultLayout(type)
  const unplaced = type.form ? unplacedFields(type) : []
  const values = useMemo(() => (sample ? generateData({ rng: 11 }, type, app.lists, users, 0, `${type.numberPrefix}1001`) : {}), [sample, type, app.lists, users])

  /** Change the layout. A form that lays itself out gets the layout it already shows, then the change. */
  const change = (fn: (layout: FormLayout) => void) =>
    updateType(app.id, type.id, (t) => {
      t.form ??= startingLayout(t)
      fn(t.form)
    })

  const find = (l: FormLayout, itemId: string) => {
    for (const s of l.sections) {
      const at = s.items.findIndex((i) => i.id === itemId)
      if (at >= 0) return { section: s, at, item: s.items[at]! }
    }
    return undefined
  }
  const fieldOf = (id: string) => type.fields.find((f) => f.id === id)

  // ---------- Placing and moving ----------

  /** Put what is being dragged where it was dropped. */
  const place = (what: Dragged, where: Target) => {
    let made: string | undefined
    change((l) => {
      let item: FormItem | undefined
      if (what.t === 'item') {
        const from = find(l, what.id)
        if (!from || (where.at === 'item' && where.id === what.id)) return
        item = from.section.items.splice(from.at, 1)[0]
      } else if (what.t === 'field') {
        const f = fieldOf(what.fieldId)
        if (f && !l.sections.some((s) => s.items.some((i) => i.kind === 'field' && i.fieldId === f.id))) item = fieldItem(f)
      } else item = newElement(what.kind)
      if (!item) return
      made = item.id
      if (where.at === 'new') l.sections.push({ id: uid('sec'), columns: 2, items: [item] })
      else if (where.at === 'section') (l.sections.find((s) => s.id === where.id) ?? l.sections[l.sections.length - 1])?.items.push(item)
      else {
        const to = find(l, where.id)
        if (!to) l.sections[l.sections.length - 1]?.items.push(item)
        else to.section.items.splice(to.at + (where.side === 'after' || where.side === 'below' ? 1 : 0), 0, item)
      }
    })
    if (made) setSelected({ kind: 'item', id: made })
  }

  /** Add from the palette with a click: after what is selected, or at the end of the last section. */
  const addByClick = (what: Dragged) => {
    if (selected.kind === 'item' && find(layout, selected.id)) return place(what, { at: 'item', id: selected.id, side: 'after' })
    const section = selected.kind === 'section' ? selected.id : layout.sections[layout.sections.length - 1]?.id
    place(what, section ? { at: 'section', id: section } : { at: 'new' })
  }

  /** One place earlier or later: within its section, or into the next one at an edge. */
  const nudge = (itemId: string, by: -1 | 1) =>
    change((l) => {
      const from = find(l, itemId)
      if (!from) return
      const { section, at } = from
      const next = at + by
      const [item] = section.items.splice(at, 1)
      if (next >= 0 && next <= section.items.length) return void section.items.splice(next, 0, item!)
      const other = l.sections[l.sections.indexOf(section) + by]
      if (!other) return void section.items.splice(at, 0, item!)
      if (by < 0) other.items.push(item!)
      else other.items.unshift(item!)
    })

  const patchItem = (itemId: string, fn: (item: FormItem) => void) =>
    change((l) => {
      const hit = find(l, itemId)
      if (hit) fn(hit.item)
    })

  const removeItem = (itemId: string) => {
    change((l) => {
      const hit = find(l, itemId)
      if (hit) hit.section.items.splice(hit.at, 1)
    })
    setSelected({ kind: 'form' })
  }

  const patchSection = (id: string, fn: (s: FormSection) => void) =>
    change((l) => {
      const s = l.sections.find((x) => x.id === id)
      if (s) fn(s)
    })

  const moveSection = (id: string, by: -1 | 1) =>
    change((l) => {
      const at = l.sections.findIndex((s) => s.id === id)
      const to = at + by
      if (at < 0 || to < 0 || to >= l.sections.length) return
      l.sections.splice(to, 0, l.sections.splice(at, 1)[0]!)
    })

  const removeSection = (id: string) => {
    const fields = layout.sections.find((s) => s.id === id)?.items.filter((i) => i.kind === 'field').length ?? 0
    change((l) => {
      l.sections = l.sections.filter((s) => s.id !== id)
    })
    setSelected({ kind: 'form' })
    if (fields) toast(`Section removed. Its ${fields === 1 ? 'field is' : `${fields} fields are`} back in the list on the left, and still shown to people at the end of the form until you place ${fields === 1 ? 'it' : 'them'}.`)
  }

  const addSection = () => {
    const id = uid('sec')
    change((l) => void l.sections.push({ id, title: 'New section', columns: 2, items: [] }))
    setSelected({ kind: 'section', id })
  }

  const reset = () => {
    if (!window.confirm('Go back to the form that lays itself out? Your sections, styles, headings and widths are removed. The fields are not.')) return
    updateType(app.id, type.id, (t) => {
      t.form = undefined
    })
    setSelected({ kind: 'form' })
  }

  // ---------- Dragging ----------

  const startDrag = (e: DragEvent, what: Dragged) => {
    dragged.current = what
    e.dataTransfer.setData(DRAG, '1')
    e.dataTransfer.effectAllowed = 'move'
    if (what.t === 'item') setDragging(what.id)
  }
  const endDrag = () => {
    dragged.current = null
    setDragging(null)
    setTarget(null)
  }
  const over = (e: DragEvent, t: Target) => {
    if (!dragged.current) return
    e.preventDefault()
    e.stopPropagation()
    setTarget((was) => (JSON.stringify(was) === JSON.stringify(t) ? was : t))
  }
  const drop = (e: DragEvent, t: Target) => {
    const what = dragged.current
    if (!what) return
    e.preventDefault()
    e.stopPropagation()
    endDrag()
    place(what, t)
  }

  /** Pull a selected item's right edge to set how many columns it takes. */
  const resize = (e: PointerEvent<HTMLSpanElement>, itemId: string, columns: number) => {
    const handle = e.currentTarget
    const el = handle.parentElement
    const grid = el?.parentElement
    if (!el || !grid) return
    e.preventDefault()
    e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 16
    const col = (grid.clientWidth - gap * (columns - 1)) / columns
    const left = el.getBoundingClientRect().left
    const move = (ev: globalThis.PointerEvent) => {
      const span = Math.min(columns, Math.max(1, Math.round((ev.clientX - left + gap / 2) / (col + gap)))) as Span
      patchItem(itemId, (i) => {
        if (i.kind !== 'divider' && (i.span ?? (i.kind === 'field' ? 1 : columns)) !== span) i.span = span
      })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const describe = (item: PlannedItem) => (item.kind === 'field' ? `${item.label}, ${FIELD_TYPE_LABEL[item.field.type]}` : item.kind === 'heading' || item.kind === 'text' ? item.text || item.kind : item.kind)

  const onItemKey = (e: KeyboardEvent, itemId: string) => {
    if (e.key === 'Enter' || e.key === ' ') setSelected({ kind: 'item', id: itemId })
    else if (e.key === 'Delete' || e.key === 'Backspace') removeItem(itemId)
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) nudge(itemId, -1)
    else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) nudge(itemId, 1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const hooks: DesignHooks = {
    itemProps: (item, section) => ({
      draggable: true,
      tabIndex: 0,
      role: 'button',
      'aria-label': `${describe(item)}. Enter selects it, Alt and an arrow moves it, Delete takes it off the form.`,
      'aria-pressed': selected.kind === 'item' && selected.id === item.id,
      'data-selected': selected.kind === 'item' && selected.id === item.id ? '' : undefined,
      'data-dragging': dragging === item.id ? '' : undefined,
      'data-drop': target?.at === 'item' && target.id === item.id ? target.side : undefined,
      onClick: (e) => {
        e.stopPropagation()
        setSelected({ kind: 'item', id: item.id })
      },
      onKeyDown: (e) => onItemKey(e, item.id),
      onDragStart: (e) => {
        e.stopPropagation()
        startDrag(e, { t: 'item', id: item.id })
      },
      onDragEnd: endDrag,
      onDragOver: (e) => {
        const r = e.currentTarget.getBoundingClientRect()
        // Something that takes the whole row is passed above or below; anything narrower, before or after.
        const side = item.span >= section.columns ? (e.clientY < r.top + r.height / 2 ? 'above' : 'below') : e.clientX < r.left + r.width / 2 ? 'before' : 'after'
        over(e, { at: 'item', id: item.id, side })
      },
      onDrop: (e) => target?.at === 'item' && drop(e, target),
    }),
    itemExtras: (item, section) =>
      selected.kind === 'item' && selected.id === item.id && item.kind !== 'divider' && !(item.kind === 'field' && item.field.type === 'table') && section.columns > 1 ? (
        <span className="design-handle" role="separator" aria-orientation="vertical" aria-label="Drag to change the width" title="Drag to change the width" draggable={false} onPointerDown={(e) => resize(e, item.id, section.columns)} />
      ) : null,
    sectionProps: (section) => ({
      'data-selected': selected.kind === 'section' && selected.id === section.id ? '' : undefined,
      onClick: (e) => {
        e.stopPropagation()
        setSelected({ kind: 'section', id: section.id })
      },
    }),
    // A section is picked by its tag: its fields fill it edge to edge, so there may be nowhere else to click.
    sectionExtras: (section) => (
      <button
        type="button"
        className="design-section-tag"
        aria-pressed={selected.kind === 'section' && selected.id === section.id}
        onClick={(e) => {
          e.stopPropagation()
          setSelected({ kind: 'section', id: section.id })
        }}
      >
        {section.title || 'Section'} · {section.columns === 1 ? '1 column' : `${section.columns} columns`}
      </button>
    ),
    gridProps: (section) => ({
      'data-drop': target?.at === 'section' && target.id === section.id ? '' : undefined,
      onDragOver: (e) => over(e, { at: 'section', id: section.id }),
      onDrop: (e) => drop(e, { at: 'section', id: section.id }),
    }),
  }

  const selectedItem = selected.kind === 'item' ? find(layout, selected.id) : undefined
  const selectedSection = selected.kind === 'section' ? layout.sections.find((s) => s.id === selected.id) : undefined

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5">
        {tabs}
        <span className="text-sm font-semibold text-slate-900">{type.name} form</span>
        {!type.form && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Lays itself out until you change it</span>}
        <div className="flex-1" />
        <Toggle checked={sample} onChange={setSample} label={<span className="text-xs text-slate-600">Sample data</span>} />
        <Segmented<keyof typeof WIDTHS>
          size="sm"
          ariaLabel="Show the form as wide as"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'wide', label: 'Wide', title: 'As wide as the room here' },
            { value: 'tablet', label: 'Tablet', title: '720 pixels wide' },
            { value: 'phone', label: 'Phone', title: '390 pixels wide' },
          ]}
        />
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset} disabled={!type.form} title="Remove the design: every field in order, two to a row">
          Lay itself out
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ----- What can go on the form ----- */}
        <aside className="flex w-[232px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white" aria-label="Fields and elements to place">
          <PaletteGroup title={`Fields to place${unplaced.length ? ` · ${unplaced.length}` : ''}`}>
            {unplaced.length === 0 ? (
              <p className="px-1 text-[11px] leading-relaxed text-slate-500">{type.fields.length ? 'Every field is on the form. Add fields on the Fields tab.' : 'This type has no fields yet. Add them on the Fields tab.'}</p>
            ) : (
              unplaced.map((f) => {
                const Icon = FIELD_ICONS[f.type]
                return (
                  <PaletteChip key={f.id} icon={<Icon size={13} />} label={f.label} hint={FIELD_TYPE_LABEL[f.type]} onDragStart={(e) => startDrag(e, { t: 'field', fieldId: f.id })} onDragEnd={endDrag} onClick={() => addByClick({ t: 'field', fieldId: f.id })} />
                )
              })
            )}
          </PaletteGroup>
          <PaletteGroup title="Elements">
            {ELEMENTS.map((el) => (
              <PaletteChip key={el.kind} icon={<el.icon size={13} />} label={el.label} hint={el.hint} onDragStart={(e) => startDrag(e, { t: 'new', kind: el.kind })} onDragEnd={endDrag} onClick={() => addByClick({ t: 'new', kind: el.kind })} />
            ))}
          </PaletteGroup>
          <PaletteGroup title="Sections">
            <Button size="sm" className="w-full justify-start" icon={<Plus size={13} />} onClick={addSection}>
              Add a section
            </Button>
            <p className="mt-2 px-1 text-[11px] leading-relaxed text-slate-500">Drag onto the form, or click to add after what is selected. Pull a selected item’s right edge to make it wider.</p>
          </PaletteGroup>
        </aside>

        {/* ----- The form, as people get it ----- */}
        <div className="min-w-0 flex-1 overflow-auto bg-slate-100 p-6" onClick={() => setSelected({ kind: 'form' })}>
          <div className="mx-auto" style={{ maxWidth: WIDTHS[device] ?? 1100 }}>
            <Themed theme={look} className="rounded-xl bg-canvas p-3 shadow-sm ring-1 ring-black/10">
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <FormRenderer type={type} lists={app.lists} users={users} values={values} onChange={() => undefined} includeSystem design={hooks} />
              </div>
            </Themed>
            <div
              onDragOver={(e) => over(e, { at: 'new' })}
              onDrop={(e) => drop(e, { at: 'new' })}
              className={cx('mt-3 flex h-12 items-center justify-center rounded-lg border border-dashed text-xs', target?.at === 'new' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-500')}
            >
              Drop here to start a new section
            </div>
          </div>
        </div>

        {/* ----- How the selected thing looks ----- */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white" aria-label="Settings for what is selected">
          {selectedItem ? (
            <ItemSettings
              key={selectedItem.item.id}
              item={selectedItem.item}
              columns={selectedItem.section.columns}
              field={selectedItem.item.kind === 'field' ? fieldOf(selectedItem.item.fieldId) : undefined}
              onPatch={(fn) => patchItem(selectedItem.item.id, fn)}
              onNudge={(by) => nudge(selectedItem.item.id, by)}
              onRemove={() => removeItem(selectedItem.item.id)}
              onEditField={onEditField}
            />
          ) : selectedSection ? (
            <SectionSettings
              key={selectedSection.id}
              section={selectedSection}
              first={layout.sections[0]?.id === selectedSection.id}
              last={layout.sections[layout.sections.length - 1]?.id === selectedSection.id}
              onPatch={(fn) => patchSection(selectedSection.id, fn)}
              onMove={(by) => moveSection(selectedSection.id, by)}
              onRemove={() => removeSection(selectedSection.id)}
            />
          ) : (
            <FormSettings style={layout.style ?? {}} onPatch={(fn) => change((l) => void fn((l.style ??= {})))} />
          )}
        </aside>
      </div>
    </div>
  )
}

// ---------- The palette ----------

function PaletteGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-3 py-3 last:border-b-0">
      <h3 className="mb-2 px-1 text-[10.5px] font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function PaletteChip({ icon, label, hint, onDragStart, onDragEnd, onClick }: { icon: ReactNode; label: string; hint: string; onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onClick: () => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={`Drag onto the form, or click to add: ${label}`}
      className="flex w-full cursor-grab items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left hover:border-brand-300 hover:bg-brand-50/40 active:cursor-grabbing"
    >
      <GripVertical size={12} className="shrink-0 text-slate-300" aria-hidden />
      <span className="shrink-0 text-slate-500">{icon}</span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-medium text-slate-800">{label}</span>
        <span className="block truncate text-[10.5px] text-slate-500">{hint}</span>
      </span>
    </button>
  )
}

// ---------- Settings ----------

function Panel({ title, about, children }: { title: string; about?: string; children: ReactNode }) {
  return (
    <div>
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {about && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{about}</p>}
      </div>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </div>
  )
}

function Choice<T extends string | number>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-600">{label}</div>
      <Segmented<T> size="sm" ariaLabel={label} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  )
}

function FormSettings({ style, onPatch }: { style: FormStyle; onPatch: (fn: (s: FormStyle) => void) => void }) {
  return (
    <Panel title="The whole form" about="Click a section or anything in it to style that. Colours, type and how fields are drawn are set once for every form, under Branding.">
      <Choice label="How wide it may grow" value={style.width ?? 'full'} onChange={(v) => onPatch((s) => void (s.width = v))} options={[['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide'], ['full', 'Full']]} />
      <Choice label="Labels" value={style.labels ?? 'above'} onChange={(v) => onPatch((s) => void (s.labels = v))} options={[['above', 'Above the field'], ['beside', 'Beside it']]} />
      <Choice label="Room between sections" value={style.spacing ?? 'normal'} onChange={(v) => onPatch((s) => void (s.spacing = v))} options={[['tight', 'Tight'], ['normal', 'Normal'], ['airy', 'Airy']]} />
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
        <LayoutPanelTop size={13} className="mt-px shrink-0 text-slate-400" />
        The form folds to fewer columns where there is less room. Try Tablet and Phone above.
      </p>
    </Panel>
  )
}

function SectionSettings({ section, first, last, onPatch, onMove, onRemove }: { section: FormSection; first: boolean; last: boolean; onPatch: (fn: (s: FormSection) => void) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const style = section.style ?? {}
  const setStyle = (fn: (s: SectionStyle) => void) => onPatch((s) => void fn((s.style ??= {})))
  return (
    <Panel title="Section">
      <Field label="Title" hint="Leave empty for none.">
        <Input value={section.title ?? ''} onChange={(e) => onPatch((s) => void (s.title = e.target.value))} />
      </Field>
      <Field label="A sentence under the title">
        <Textarea className="min-h-[56px]" value={section.description ?? ''} onChange={(e) => onPatch((s) => void (s.description = e.target.value))} />
      </Field>
      <Choice<Span> label="Columns" value={section.columns} onChange={(v) => onPatch((s) => void (s.columns = v))} options={[[1, '1'], [2, '2'], [3, '3'], [4, '4']]} />
      <Choice label="Look" value={style.look ?? 'plain'} onChange={(v) => setStyle((s) => void (s.look = v))} options={[['plain', 'Plain'], ['card', 'Card'], ['tinted', 'Tinted'], ['outlined', 'Outlined']]} />
      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Its own colour</div>
        <div className="flex items-center gap-2">
          <input type="color" aria-label="The section’s colour" value={isHex(style.accent) && style.accent.length === 7 ? style.accent : '#4f46e5'} onChange={(e) => setStyle((s) => void (s.accent = e.target.value))} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white p-0.5" />
          <span className="min-w-0 flex-1 font-mono text-xs text-slate-600">{style.accent ?? 'The look’s primary'}</span>
          {style.accent && (
            <Button size="sm" variant="ghost" onClick={() => setStyle((s) => void delete s.accent)}>
              Clear
            </Button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">For its title, its tint and its edge.</p>
      </div>
      <Choice label="Title size" value={style.title ?? 'medium'} onChange={(v) => setStyle((s) => void (s.title = v))} options={[['small', 'Small caps'], ['medium', 'Medium'], ['large', 'Large']]} />
      <Toggle checked={!!style.rule} onChange={(v) => setStyle((s) => void (s.rule = v || undefined))} label={<span className="text-xs text-slate-700">A rule under the title</span>} />
      <Toggle
        checked={!!section.collapsed}
        onChange={(v) => onPatch((s) => void (s.collapsed = v || undefined))}
        label={<span className="text-xs text-slate-700" title="People open it when they need it. A section with a required field always starts open.">Starts closed</span>}
      />
      <div className="flex items-center gap-1.5 border-t border-slate-100 pt-3">
        <Button size="sm" icon={<ArrowUp size={13} />} disabled={first} onClick={() => onMove(-1)}>
          Up
        </Button>
        <Button size="sm" icon={<ArrowDown size={13} />} disabled={last} onClick={() => onMove(1)}>
          Down
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="hover:bg-rose-50 hover:text-rose-600" icon={<Trash2 size={13} />} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </Panel>
  )
}

const TITLES: Record<FormItem['kind'], string> = { field: 'Field', heading: 'Heading', text: 'Paragraph', divider: 'Divider', spacer: 'Space', image: 'Picture' }

function ItemSettings({
  item,
  columns,
  field,
  onPatch,
  onNudge,
  onRemove,
  onEditField,
}: {
  item: FormItem
  columns: number
  field?: ObjectType['fields'][number]
  onPatch: (fn: (item: FormItem) => void) => void
  onNudge: (by: -1 | 1) => void
  onRemove: () => void
  onEditField: (fieldId: string) => void
}) {
  const toast = useUi((s) => s.toast)
  const fileRef = useRef<HTMLInputElement>(null)
  const pick = async (file: File | undefined) => {
    if (!file) return
    try {
      const url = await readImage(file)
      onPatch((i) => i.kind === 'image' && (i.url = url))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That picture could not be used.', 'warn')
    }
  }
  const table = field?.type === 'table'
  const span = item.kind === 'divider' ? columns : Math.min(item.span ?? (item.kind === 'field' ? 1 : columns), columns)
  return (
    <Panel title={item.kind === 'text' && item.tone && item.tone !== 'plain' ? 'Callout' : TITLES[item.kind]} about={field ? `${field.label} · ${FIELD_TYPE_LABEL[field.type]}` : undefined}>
      {item.kind === 'field' && (
        <>
          <Field label="Label on this form" hint="Leave empty to use the field’s own.">
            <Input value={item.label ?? ''} placeholder={field?.label} onChange={(e) => onPatch((i) => i.kind === 'field' && (i.label = e.target.value || undefined))} />
          </Field>
          <Field label="Shown in the empty field" hint="For text, number and email fields.">
            <Input value={item.placeholder ?? ''} placeholder="e.g. PO-12345" onChange={(e) => onPatch((i) => i.kind === 'field' && (i.placeholder = e.target.value || undefined))} />
          </Field>
          <Field label="Guidance under the field" hint="Leave empty to use the field’s own.">
            <Input value={item.help ?? ''} placeholder={field?.helpText ?? 'What to enter, in a few words'} onChange={(e) => onPatch((i) => i.kind === 'field' && (i.help = e.target.value || undefined))} />
          </Field>
          <Toggle checked={!!item.emphasis} onChange={(v) => onPatch((i) => i.kind === 'field' && (i.emphasis = v || undefined))} label={<span className="text-xs text-slate-700">Draw it larger</span>} />
        </>
      )}
      {item.kind === 'heading' && (
        <>
          <Field label="Heading">
            <Input autoFocus value={item.text} placeholder="e.g. Payment details" onChange={(e) => onPatch((i) => i.kind === 'heading' && (i.text = e.target.value))} />
          </Field>
          <Choice label="Size" value={item.size ?? 'medium'} onChange={(v) => onPatch((i) => i.kind === 'heading' && (i.size = v))} options={[['small', 'Small caps'], ['medium', 'Medium'], ['large', 'Large']]} />
        </>
      )}
      {item.kind === 'text' && (
        <>
          <Field label="Text" hint="Shown as written, line breaks included.">
            <Textarea autoFocus value={item.text} placeholder="e.g. Attach the signed quote before you send this for approval." onChange={(e) => onPatch((i) => i.kind === 'text' && (i.text = e.target.value))} />
          </Field>
          <Choice label="Drawn as" value={item.tone ?? 'plain'} onChange={(v) => onPatch((i) => i.kind === 'text' && (i.tone = v))} options={[['plain', 'Text'], ['note', 'Note'], ['success', 'Good'], ['warning', 'Warning']]} />
        </>
      )}
      {item.kind === 'spacer' && (
        <Field label="Height (pixels)">
          <Input type="number" min={4} max={400} value={item.height ?? 24} onChange={(e) => onPatch((i) => i.kind === 'spacer' && (i.height = e.target.value === '' ? undefined : Number(e.target.value)))} />
        </Field>
      )}
      {item.kind === 'image' && (
        <>
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-1.5">
              {item.url ? <img src={item.url} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[11px] text-slate-400">None</span>}
            </div>
            <Button size="sm" icon={<ImageUp size={13} />} onClick={() => fileRef.current?.click()}>
              {item.url ? 'Change' : 'Choose a picture'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              className="hidden"
              aria-label="Picture for the form"
              onChange={(e) => {
                void pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
          <p className="-mt-2 text-[11px] text-slate-500">Up to 300 KB; kept in the design.</p>
          <Field label="What it shows" hint="Read out to people who can’t see it. Leave empty if it is decoration.">
            <Input value={item.alt ?? ''} onChange={(e) => onPatch((i) => i.kind === 'image' && (i.alt = e.target.value || undefined))} />
          </Field>
          <Field label="Height at most (pixels)">
            <Input type="number" min={16} max={800} value={item.height ?? ''} placeholder="160" onChange={(e) => onPatch((i) => i.kind === 'image' && (i.height = e.target.value === '' ? undefined : Number(e.target.value)))} />
          </Field>
          <Choice label="Placed" value={item.align ?? 'left'} onChange={(v) => onPatch((i) => i.kind === 'image' && (i.align = v))} options={[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]} />
        </>
      )}
      {item.kind === 'divider' && <p className="text-xs text-slate-500">A line across the section.</p>}

      {item.kind !== 'divider' && !table && columns > 1 && (
        <Field label="Width" hint="Or pull its right edge on the form.">
          <Select value={span} onChange={(e) => onPatch((i) => i.kind !== 'divider' && (i.span = Number(e.target.value) as Span))}>
            {Array.from({ length: columns }, (_, n) => n + 1).map((n) => (
              <option key={n} value={n}>
                {n === columns ? 'The whole row' : n === 1 ? '1 column' : `${n} columns`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {table && <p className="text-[11px] text-slate-500">A table always takes the whole row.</p>}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
        <IconButton label="Move earlier (Alt + left arrow)" onClick={() => onNudge(-1)}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton label="Move later (Alt + right arrow)" onClick={() => onNudge(1)}>
          <ArrowRight size={14} />
        </IconButton>
        {field && (
          <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => onEditField(field.id)} title="Its type, whether it is required, its list and the rest">
            The field itself
          </Button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="hover:bg-rose-50 hover:text-rose-600" icon={<Trash2 size={13} />} onClick={onRemove} title={field ? 'It goes back to the list on the left. It is not deleted.' : undefined}>
          {field ? 'Take off' : 'Remove'}
        </Button>
      </div>
    </Panel>
  )
}
