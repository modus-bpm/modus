// Form layout. An object type's fields say what a form holds; its layout says where: sections,
// each a grid of fields, with headings, paragraphs, dividers and pictures between them. Without a
// layout the form is every field in order, two to a row, as it always was.
//
// The layout never decides who may see or change a field: that stays with field security. A field
// hidden from someone is left out of their form wherever the layout put it, and a field the layout
// forgot is still shown, at the end, so adding a field can't lose it.

import type { FieldAccess, FieldDef, FormItem, FormLayout, FormSection, Id, ObjectType } from './types'
import { uid } from './util'

/** The layout a type has when nobody has laid it out: one section, two columns, wide fields across both. */
export function defaultLayout(type: Pick<ObjectType, 'fields'>): FormLayout {
  return { sections: [{ id: 'sec_main', columns: 2, items: type.fields.map((f) => fieldItem(f, `fi_${f.id}`)) }] }
}

/** A layout item for a field, as wide as the field asks. */
export function fieldItem(field: FieldDef, id: Id = uid('fi')): Extract<FormItem, { kind: 'field' }> {
  return { id, kind: 'field', fieldId: field.id, ...(field.width === 'full' || field.type === 'table' ? { span: 2 as const } : {}) }
}

/** The fields a layout doesn't place. */
export function unplacedFields(type: ObjectType, layout: FormLayout | undefined = type.form): FieldDef[] {
  if (!layout) return []
  const placed = new Set(layout.sections.flatMap((s) => s.items).flatMap((i) => (i.kind === 'field' ? [i.fieldId] : [])))
  return type.fields.filter((f) => !placed.has(f.id))
}

/** One thing on a form, ready to draw. */
export type PlannedItem =
  | { id: Id; kind: 'field'; field: FieldDef; span: number; label: string; help?: string; placeholder?: string }
  | { id: Id; kind: 'heading' | 'text'; text: string; span: number }
  | { id: Id; kind: 'divider'; span: number }
  | { id: Id; kind: 'image'; url: string; alt: string; height?: number; span: number }

export interface PlannedSection {
  id: Id
  title?: string
  description?: string
  columns: 1 | 2 | 3
  collapsed: boolean
  items: PlannedItem[]
}

export interface FormPlan {
  sections: PlannedSection[]
  /** Fields this person may not see at this step. */
  hidden: number
}

export interface PlanOptions {
  /** Include fields set by the process (not shown on a create form). */
  includeSystem?: boolean
  /** Field access at a step; a hidden field is left out. */
  access?: Record<Id, FieldAccess>
}

/**
 * The form to draw for a type: its layout with every field resolved, hidden and system fields
 * left out, fields the layout doesn't place added in a last section, and sections left with
 * nothing but decoration dropped.
 */
export function formPlan(type: ObjectType, opts: PlanOptions = {}): FormPlan {
  const shown = (f: FieldDef) => (opts.includeSystem || !f.system) && opts.access?.[f.id] !== 'hidden'
  const hidden = opts.access ? type.fields.filter((f) => (opts.includeSystem || !f.system) && opts.access![f.id] === 'hidden').length : 0
  const layout = type.form ?? defaultLayout(type)
  const byId = new Map(type.fields.map((f) => [f.id, f]))
  const placed = new Set<Id>()

  const plan = (s: FormSection): PlannedSection => {
    const items: PlannedItem[] = []
    for (const item of s.items) {
      if (item.kind === 'field') {
        const field = byId.get(item.fieldId)
        // A field that is gone, or placed twice, is skipped; one this person may not see is too.
        if (!field || placed.has(field.id)) continue
        placed.add(field.id)
        if (!shown(field)) continue
        const span = field.type === 'table' ? s.columns : Math.min(item.span ?? 1, s.columns)
        items.push({ id: item.id, kind: 'field', field, span, label: item.label?.trim() || field.label, help: item.help?.trim() || field.helpText, placeholder: item.placeholder?.trim() || undefined })
      } else if (item.kind === 'image') {
        if (item.url) items.push({ id: item.id, kind: 'image', url: item.url, alt: item.alt ?? '', height: item.height, span: s.columns })
      } else if (item.kind === 'divider') items.push({ id: item.id, kind: 'divider', span: s.columns })
      else if (item.text.trim()) items.push({ id: item.id, kind: item.kind, text: item.text, span: s.columns })
    }
    const required = items.some((i) => i.kind === 'field' && i.field.required)
    return { id: s.id, title: s.title?.trim() || undefined, description: s.description?.trim() || undefined, columns: s.columns, collapsed: !!s.collapsed && !required, items }
  }

  const sections = layout.sections.map(plan)
  const rest = type.fields.filter((f) => !placed.has(f.id) && shown(f))
  if (rest.length) {
    sections.push({
      id: 'sec_rest',
      title: layout.sections.length && type.form ? 'More' : undefined,
      columns: 2,
      collapsed: false,
      items: rest.map((field) => ({ id: `fi_${field.id}`, kind: 'field', field, span: field.width === 'full' || field.type === 'table' ? 2 : 1, label: field.label, help: field.helpText })),
    })
  }
  // A section with no field left in it (all hidden at this step) would be a title over nothing.
  return { sections: sections.filter((s) => s.items.some((i) => i.kind === 'field')), hidden }
}

/** A layout without the items of fields the type no longer has. The layout passed in is not changed. */
export function tidyLayout(type: ObjectType, layout: FormLayout): FormLayout {
  const known = new Set(type.fields.map((f) => f.id))
  return { sections: layout.sections.map((s) => ({ ...s, items: s.items.filter((i) => i.kind !== 'field' || known.has(i.fieldId)) })) }
}

/** What is wrong with a layout as data (an import, a save from elsewhere); empty when nothing is. */
export function layoutProblems(layout: unknown): string[] {
  const out: string[] = []
  const l = layout as FormLayout | undefined
  if (!l || !Array.isArray(l.sections)) return ['The form layout has no sections.']
  const ids = new Set<Id>()
  for (const s of l.sections) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.items) || ![1, 2, 3].includes(s.columns)) {
      out.push('A section of the form layout is not one Modus knows.')
      continue
    }
    for (const i of s.items) {
      if (!i || typeof i.id !== 'string' || !['field', 'heading', 'text', 'divider', 'image'].includes(i.kind)) out.push('Something on the form layout is not a kind Modus knows.')
      else if (ids.has(i.id)) out.push(`Two things on the form layout share the id ${i.id}.`)
      else ids.add(i.id)
      if (i?.kind === 'image' && typeof i.url === 'string' && i.url && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);/.test(i.url)) out.push('A picture on the form is not an image kept in the design.')
    }
  }
  return out
}
