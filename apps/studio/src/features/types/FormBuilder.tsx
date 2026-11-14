import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Heading, ImageUp, LayoutPanelTop, Minus, Plus, RotateCcw, Text, Trash2 } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { FIELD_TYPE_LABEL } from '@modus-bpm/core/model/format'
import { defaultLayout, fieldItem, unplacedFields } from '@modus-bpm/core/model/forms'
import type { App, FormItem, FormLayout, FormSection, ObjectType } from '@modus-bpm/core/model/types'
import { uid } from '@modus-bpm/core/model/util'
import { FIELD_ICONS } from '../../components/icons'
import { Button, Card, cx, Field, IconButton, Input, Segmented, Select, Textarea, Toggle } from '../../components/ui'
import { useDesign } from '../../store/design'
import { useUi } from '../../store/ui'
import { readImage } from '../branding/look'

// The forms builder: where each field goes on an object type's form. Sections with a title and
// one to three columns, fields at the width you give them, and headings, instructions, dividers
// and pictures between them. The preview beside it is the form people get, in the Workspace's look.
//
// The layout only arranges. Who may see or change a field stays with field security, and a field
// left off the layout is still shown at the end of the form, so nothing can be lost here.

const DRAG = 'application/x-modus-form-item'

interface Props {
  app: App
  type: ObjectType
  selectedFieldId: string | null
  onSelectField: (fieldId: string | null) => void
}

export function FormBuilder({ app, type, selectedFieldId, onSelectField }: Props) {
  const updateType = useDesign((s) => s.updateType)
  const toast = useUi((s) => s.toast)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)

  /** Change the layout. A type without one gets the layout its form already has, then the change. */
  const change = (fn: (layout: FormLayout) => void) =>
    updateType(app.id, type.id, (t) => {
      t.form ??= freshLayout(t)
      fn(t.form)
    })

  if (!type.form) {
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <LayoutPanelTop size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">This form lays itself out</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Every field in order, two to a row, wide fields and tables across both. Lay it out yourself to group fields into sections, choose widths, and add headings, instructions and pictures. Colours, type and how
              fields are drawn are set once for every form, under <span className="font-medium text-slate-800">Branding</span>.
            </p>
            <div className="mt-3">
              <Button variant="primary" icon={<LayoutPanelTop size={14} />} onClick={() => change(() => undefined)} disabled={!type.fields.length}>
                Lay out this form
              </Button>
              {!type.fields.length && <span className="ml-2 text-xs text-slate-500">Add a field first.</span>}
            </div>
          </div>
        </div>
      </Card>
    )
  }

  const layout = type.form
  const unplaced = unplacedFields(type)
  const fieldOf = (id: string) => type.fields.find((f) => f.id === id)

  const find = (l: FormLayout, itemId: string) => {
    for (const s of l.sections) {
      const at = s.items.findIndex((i) => i.id === itemId)
      if (at >= 0) return { section: s, at }
    }
    return undefined
  }

  /** Move an item to just before another, or to the end of a section. */
  const move = (itemId: string, to: { before: string } | { section: string }) =>
    change((l) => {
      const from = find(l, itemId)
      if (!from || ('before' in to && to.before === itemId)) return
      const [item] = from.section.items.splice(from.at, 1)
      if ('before' in to) {
        const target = find(l, to.before)
        if (target) target.section.items.splice(target.at, 0, item!)
        else from.section.items.splice(from.at, 0, item!)
      } else (l.sections.find((s) => s.id === to.section) ?? from.section).items.push(item!)
    })

  /** One place up or down: within its section, or into the next one at an edge. */
  const nudge = (itemId: string, by: -1 | 1) =>
    change((l) => {
      const from = find(l, itemId)
      if (!from) return
      const { section, at } = from
      const next = at + by
      if (next >= 0 && next < section.items.length) {
        const [item] = section.items.splice(at, 1)
        section.items.splice(next, 0, item!)
        return
      }
      const other = l.sections[l.sections.indexOf(section) + by]
      if (!other) return
      const [item] = section.items.splice(at, 1)
      if (by < 0) other.items.push(item!)
      else other.items.unshift(item!)
    })

  const patchItem = (itemId: string, fn: (item: FormItem) => void) =>
    change((l) => {
      const hit = find(l, itemId)
      if (hit) fn(hit.section.items[hit.at]!)
    })

  const removeItem = (itemId: string) =>
    change((l) => {
      const hit = find(l, itemId)
      if (hit) hit.section.items.splice(hit.at, 1)
    })

  const add = (sectionId: string, item: FormItem) => {
    change((l) => void l.sections.find((s) => s.id === sectionId)?.items.push(item))
    if (item.kind !== 'field' && item.kind !== 'divider') setOpenItem(item.id)
  }

  const addSection = () => change((l) => void l.sections.push({ id: uid('sec'), title: 'New section', columns: 2, items: [] }))

  const removeSection = (s: FormSection) => {
    const fields = s.items.filter((i) => i.kind === 'field').length
    change((l) => {
      l.sections = l.sections.filter((x) => x.id !== s.id)
    })
    if (fields) toast(`Section removed. Its ${fields === 1 ? 'field is' : `${fields} fields are`} still on the form, at the end, until you place ${fields === 1 ? 'it' : 'them'}.`)
  }

  const reset = () => {
    if (!window.confirm('Go back to the form that lays itself out? Your sections, headings and widths are removed. The fields are not.')) return
    updateType(app.id, type.id, (t) => {
      t.form = undefined
    })
  }

  const onDrop = (e: React.DragEvent, to: { before: string } | { section: string }) => {
    const id = e.dataTransfer.getData(DRAG)
    setDropAt(null)
    if (!id) return
    e.preventDefault()
    move(id, to)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-slate-500">Drag to rearrange, or use the arrows. The preview on the right is the form people get.</p>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset} title="Remove the layout: every field in order, two to a row">
          Lay itself out
        </Button>
      </div>

      {layout.sections.map((s, si) => (
        <Card key={s.id} className="overflow-hidden">
          <div className="space-y-2 border-b border-slate-200 bg-slate-50/60 px-3.5 py-3">
            <div className="flex items-center gap-2">
              <Input className="flex-1 font-medium" value={s.title ?? ''} placeholder="Section title (leave empty for none)" aria-label="Section title" onChange={(e) => change((l) => void (l.sections[si]!.title = e.target.value))} />
              <Segmented<1 | 2 | 3>
                size="sm"
                ariaLabel="Columns in this section"
                value={s.columns}
                onChange={(v) => change((l) => void (l.sections[si]!.columns = v))}
                options={[
                  { value: 1, label: '1 col', title: 'One column' },
                  { value: 2, label: '2', title: 'Two columns' },
                  { value: 3, label: '3', title: 'Three columns' },
                ]}
              />
              <IconButton label="Move section up" disabled={si === 0} onClick={() => change((l) => void l.sections.splice(si - 1, 0, l.sections.splice(si, 1)[0]!))}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label="Move section down" disabled={si === layout.sections.length - 1} onClick={() => change((l) => void l.sections.splice(si + 1, 0, l.sections.splice(si, 1)[0]!))}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={`Remove the section ${s.title || si + 1}`} className="hover:bg-rose-50 hover:text-rose-600" onClick={() => removeSection(s)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            <div className="flex items-center gap-3">
              <Input className="flex-1 text-xs" value={s.description ?? ''} placeholder="A sentence under the title (optional)" aria-label="Section description" onChange={(e) => change((l) => void (l.sections[si]!.description = e.target.value))} />
              <Toggle
                checked={!!s.collapsed}
                onChange={(v) => change((l) => void (l.sections[si]!.collapsed = v || undefined))}
                label={<span className="text-xs text-slate-600" title="People open it when they need it. A section with a required field always starts open.">Starts closed</span>}
              />
            </div>
          </div>

          <ul className="divide-y divide-slate-100">
            {s.items.map((item) => {
              const field = item.kind === 'field' ? fieldOf(item.fieldId) : undefined
              if (item.kind === 'field' && !field) return null
              const open = openItem === item.id
              const Icon = field ? FIELD_ICONS[field.type] : item.kind === 'heading' ? Heading : item.kind === 'text' ? Text : item.kind === 'image' ? ImageUp : Minus
              return (
                <li
                  key={item.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG, item.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG)) return
                    e.preventDefault()
                    setDropAt(item.id)
                  }}
                  onDragLeave={() => setDropAt((d) => (d === item.id ? null : d))}
                  onDrop={(e) => onDrop(e, { before: item.id })}
                  className={cx('bg-white', dropAt === item.id && 'shadow-[inset_0_2px_0_0_var(--color-brand-500)]', field && selectedFieldId === field.id && 'bg-brand-50/60')}
                >
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <GripVertical size={14} className="shrink-0 cursor-grab text-slate-300" aria-hidden />
                    <Icon size={14} className="shrink-0 text-slate-400" />
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-sm text-slate-800" onClick={() => (field ? onSelectField(field.id) : setOpenItem(open ? null : item.id))}>
                      {item.kind === 'field' ? (
                        <>
                          {item.label?.trim() || field!.label}
                          <span className="ml-1.5 text-[11px] text-slate-400">{FIELD_TYPE_LABEL[field!.type]}</span>
                          {field!.system && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500">set by workflow</span>}
                        </>
                      ) : item.kind === 'divider' ? (
                        <span className="text-slate-500">Divider</span>
                      ) : item.kind === 'image' ? (
                        <span className={item.url ? '' : 'text-slate-400'}>{item.url ? item.alt || 'Picture' : 'Picture: choose one'}</span>
                      ) : (
                        <span className={cx(item.kind === 'heading' && 'font-semibold', !item.text && 'text-slate-400')}>{item.text || (item.kind === 'heading' ? 'Heading: write it' : 'Paragraph: write it')}</span>
                      )}
                    </button>
                    {item.kind === 'field' && field!.type !== 'table' && s.columns > 1 && (
                      <Select className="h-7 w-[92px] text-xs" aria-label={`Width of ${field!.label}`} value={Math.min(item.span ?? 1, s.columns)} onChange={(e) => patchItem(item.id, (i) => i.kind === 'field' && (i.span = Number(e.target.value) as 1 | 2 | 3))}>
                        {Array.from({ length: s.columns }, (_, n) => n + 1).map((n) => (
                          <option key={n} value={n}>
                            {n === s.columns ? 'Full row' : n === 1 ? '1 column' : `${n} columns`}
                          </option>
                        ))}
                      </Select>
                    )}
                    {item.kind !== 'divider' && (
                      <IconButton label={open ? 'Close' : `Options for ${field?.label ?? item.kind}`} active={open} onClick={() => setOpenItem(open ? null : item.id)}>
                        <ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />
                      </IconButton>
                    )}
                    <IconButton label="Move up" onClick={() => nudge(item.id, -1)}>
                      <ArrowUp size={14} />
                    </IconButton>
                    <IconButton label="Move down" onClick={() => nudge(item.id, 1)}>
                      <ArrowDown size={14} />
                    </IconButton>
                    <IconButton label={field ? `Take ${field.label} off this section` : 'Remove'} className="hover:bg-rose-50 hover:text-rose-600" onClick={() => removeItem(item.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                  {open && <ItemOptions item={item} fieldLabel={field?.label} fieldHelp={field?.helpText} onPatch={(fn) => patchItem(item.id, fn)} />}
                </li>
              )
            })}
            <li
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG)) return
                e.preventDefault()
                setDropAt(`end:${s.id}`)
              }}
              onDragLeave={() => setDropAt((d) => (d === `end:${s.id}` ? null : d))}
              onDrop={(e) => onDrop(e, { section: s.id })}
              className={cx('flex flex-wrap items-center gap-1.5 px-2.5 py-2', dropAt === `end:${s.id}` && 'bg-brand-50')}
            >
              {!s.items.length && <span className="mr-1 text-xs text-slate-400">Nothing here yet. Drop something in, or add:</span>}
              {unplaced.length > 0 && (
                <Select
                  className="h-7 w-auto max-w-[190px] text-xs"
                  aria-label="Add a field to this section"
                  value=""
                  onChange={(e) => {
                    const f = fieldOf(e.target.value)
                    if (f) add(s.id, { ...fieldItem(f), span: f.width === 'full' || f.type === 'table' ? (s.columns as 1 | 2 | 3) : undefined })
                  }}
                >
                  <option value="">+ Field…</option>
                  {unplaced.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              )}
              <AddButton icon={<Heading size={12} />} onClick={() => add(s.id, { id: uid('fi'), kind: 'heading', text: '' })}>
                Heading
              </AddButton>
              <AddButton icon={<Text size={12} />} onClick={() => add(s.id, { id: uid('fi'), kind: 'text', text: '' })}>
                Paragraph
              </AddButton>
              <AddButton icon={<Minus size={12} />} onClick={() => add(s.id, { id: uid('fi'), kind: 'divider' })}>
                Divider
              </AddButton>
              <AddButton icon={<ImageUp size={12} />} onClick={() => add(s.id, { id: uid('fi'), kind: 'image', url: '' })}>
                Picture
              </AddButton>
            </li>
          </ul>
        </Card>
      ))}

      <Button icon={<Plus size={14} />} onClick={addSection}>
        Add a section
      </Button>

      {unplaced.length > 0 && (
        <p className="text-xs leading-relaxed text-slate-500">
          <span className="font-medium text-slate-700">Not placed yet:</span> {unplaced.map((f) => f.label).join(', ')}. {unplaced.length === 1 ? 'It is' : 'They are'} still on the form, at the end{layout.sections.length ? ', under “More”' : ''}, until you add{' '}
          {unplaced.length === 1 ? 'it' : 'them'} to a section.
        </p>
      )}
    </div>
  )
}

/** The layout a form already has when it lays itself out, with ids of its own so two types never share one. */
function freshLayout(type: ObjectType): FormLayout {
  const base = defaultLayout(type)
  return { sections: base.sections.map((s) => ({ ...s, id: uid('sec'), items: s.items.map((i) => ({ ...i, id: uid('fi') })) })) }
}

function AddButton({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-xs font-medium text-slate-600 hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700">
      {icon}
      {children}
    </button>
  )
}

/** What can be set about one thing on the form. */
function ItemOptions({ item, fieldLabel, fieldHelp, onPatch }: { item: FormItem; fieldLabel?: string; fieldHelp?: string; onPatch: (fn: (item: FormItem) => void) => void }) {
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
  return (
    <div className="grid grid-cols-2 gap-3 border-t border-slate-100 bg-slate-50/50 px-3.5 py-3">
      {item.kind === 'field' && (
        <>
          <Field label="Label on this form" hint="Leave empty to use the field’s own.">
            <Input value={item.label ?? ''} placeholder={fieldLabel} onChange={(e) => onPatch((i) => i.kind === 'field' && (i.label = e.target.value || undefined))} />
          </Field>
          <Field label="Shown in the empty field" hint="For text, number and email fields.">
            <Input value={item.placeholder ?? ''} placeholder="e.g. PO-12345" onChange={(e) => onPatch((i) => i.kind === 'field' && (i.placeholder = e.target.value || undefined))} />
          </Field>
          <div className="col-span-2">
            <Field label="Guidance under the field" hint="Leave empty to use the field’s own.">
              <Input value={item.help ?? ''} placeholder={fieldHelp ?? 'What to enter, in a few words'} onChange={(e) => onPatch((i) => i.kind === 'field' && (i.help = e.target.value || undefined))} />
            </Field>
          </div>
        </>
      )}
      {item.kind === 'heading' && (
        <div className="col-span-2">
          <Field label="Heading">
            <Input autoFocus value={item.text} placeholder="e.g. Payment details" onChange={(e) => onPatch((i) => i.kind === 'heading' && (i.text = e.target.value))} />
          </Field>
        </div>
      )}
      {item.kind === 'text' && (
        <div className="col-span-2">
          <Field label="Paragraph" hint="Instructions, a notice, the small print. Shown as written, line breaks included.">
            <Textarea autoFocus value={item.text} placeholder="e.g. Attach the signed quote before you send this for approval." onChange={(e) => onPatch((i) => i.kind === 'text' && (i.text = e.target.value))} />
          </Field>
        </div>
      )}
      {item.kind === 'image' && (
        <>
          <div className="col-span-2 flex items-center gap-3">
            <div className="flex h-14 w-32 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 bg-white p-1.5">
              {item.url ? <img src={item.url} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[11px] text-slate-400">No picture</span>}
            </div>
            <Button size="sm" icon={<ImageUp size={13} />} onClick={() => fileRef.current?.click()}>
              {item.url ? 'Change' : 'Choose a picture'}
            </Button>
            <span className="text-[11px] text-slate-500">Up to 300 KB; kept in the design.</span>
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
          <Field label="What it shows" hint="Read out to people who can’t see it. Leave empty if it is decoration.">
            <Input value={item.alt ?? ''} onChange={(e) => onPatch((i) => i.kind === 'image' && (i.alt = e.target.value || undefined))} />
          </Field>
          <Field label="Height at most (pixels)">
            <Input type="number" min={16} max={800} value={item.height ?? ''} placeholder="160" onChange={(e) => onPatch((i) => i.kind === 'image' && (i.height = e.target.value === '' ? undefined : Number(e.target.value)))} />
          </Field>
        </>
      )}
    </div>
  )
}
