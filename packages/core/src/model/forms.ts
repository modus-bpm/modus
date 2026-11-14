// Form layout. An object type's fields say what a form holds; its layout says where: sections,
// each a grid of fields, with headings, paragraphs, dividers and pictures between them. Without a
// layout the form is every field in order, two to a row, as it always was.
//
// The layout never decides who may see or change a field: that stays with field security. A field
// hidden from someone is left out of their form wherever the layout put it, and a field the layout
// forgot is still shown, at the end, so adding a field can't lose it.

import type { FieldAccess, FieldDef, FormItem, FormLayout, FormSection, FormStyle, Id, ObjectType, SectionStyle } from './types'
import { uid } from './util'

/** A picture kept in the design: a data URL of an image kind, and a string (never an address somewhere else). */
export const isOwnPicture = (url: unknown): url is string => typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp|svg\+xml);/.test(url)

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
  | { id: Id; kind: 'field'; field: FieldDef; span: number; label: string; help?: string; placeholder?: string; emphasis: boolean }
  | { id: Id; kind: 'heading'; text: string; size: 'small' | 'medium' | 'large'; span: number }
  | { id: Id; kind: 'text'; text: string; tone: 'plain' | 'note' | 'success' | 'warning'; span: number }
  | { id: Id; kind: 'divider'; span: number }
  | { id: Id; kind: 'spacer'; height: number; span: number }
  | { id: Id; kind: 'image'; url: string; alt: string; height?: number; align: 'left' | 'center' | 'right'; span: number }

export interface PlannedSection {
  id: Id
  title?: string
  description?: string
  columns: 1 | 2 | 3 | 4
  collapsed: boolean
  /** How it is drawn: every choice filled in, the accent only when it is a colour. */
  look: NonNullable<SectionStyle['look']>
  accent?: string
  titleSize: NonNullable<SectionStyle['title']>
  rule: boolean
  items: PlannedItem[]
}

export interface FormPlan {
  sections: PlannedSection[]
  /** Fields this person may not see at this step. */
  hidden: number
  width: NonNullable<FormStyle['width']>
  labels: NonNullable<FormStyle['labels']>
  spacing: NonNullable<FormStyle['spacing']>
}

export interface PlanOptions {
  /** Include fields set by the process (not shown on a create form). */
  includeSystem?: boolean
  /** Field access at a step; a hidden field is left out. */
  access?: Record<Id, FieldAccess>
  /**
   * For the designer: everything the layout holds is planned, placeholders included (an empty
   * section, a heading not yet written, a picture not yet chosen), and fields the layout doesn't
   * place are left out, since the designer offers them to be placed.
   */
  design?: boolean
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], or: T): T => (allowed.includes(v as T) ? (v as T) : or)
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const SIZES = ['small', 'medium', 'large'] as const

/**
 * The form to draw for a type: its layout with every field resolved, hidden and system fields
 * left out, fields the layout doesn't place added in a last section, and sections left with
 * nothing but decoration dropped. Every choice about how it looks is filled in and checked here,
 * so what draws the form never meets a value it doesn't know.
 */
export function formPlan(type: ObjectType, opts: PlanOptions = {}): FormPlan {
  const shown = (f: FieldDef) => opts.design || ((opts.includeSystem || !f.system) && opts.access?.[f.id] !== 'hidden')
  const hidden = opts.access && !opts.design ? type.fields.filter((f) => (opts.includeSystem || !f.system) && opts.access![f.id] === 'hidden').length : 0
  const layout = type.form ?? defaultLayout(type)
  const byId = new Map(type.fields.map((f) => [f.id, f]))
  const placed = new Set<Id>()

  const plan = (s: FormSection): PlannedSection => {
    const columns = oneOf(String(s.columns), ['1', '2', '3', '4'], '2')
    const cols = Number(columns) as 1 | 2 | 3 | 4
    const spanOf = (span: unknown, whole: boolean) => (whole || typeof span !== 'number' ? cols : Math.min(Math.max(Math.round(span), 1), cols))
    const items: PlannedItem[] = []
    for (const item of s.items) {
      if (item.kind === 'field') {
        const field = byId.get(item.fieldId)
        // A field that is gone, or placed twice, is skipped; one this person may not see is too.
        if (!field || placed.has(field.id)) continue
        placed.add(field.id)
        if (!shown(field)) continue
        const span = field.type === 'table' ? cols : Math.min(item.span ?? 1, cols)
        items.push({ id: item.id, kind: 'field', field, span, label: item.label?.trim() || field.label, help: item.help?.trim() || field.helpText, placeholder: item.placeholder?.trim() || undefined, emphasis: item.emphasis === true })
      } else if (item.kind === 'image') {
        // Only a picture kept in the design is ever drawn: never an address somewhere else.
        const url = isOwnPicture(item.url) ? item.url : ''
        if (url || opts.design) items.push({ id: item.id, kind: 'image', url, alt: typeof item.alt === 'string' ? item.alt : '', height: typeof item.height === 'number' ? Math.min(Math.max(item.height, 16), 800) : undefined, align: oneOf(item.align, ['left', 'center', 'right'], 'left'), span: spanOf(item.span, item.span === undefined) })
      } else if (item.kind === 'divider') items.push({ id: item.id, kind: 'divider', span: cols })
      else if (item.kind === 'spacer') items.push({ id: item.id, kind: 'spacer', height: typeof item.height === 'number' ? Math.min(Math.max(item.height, 4), 400) : 24, span: spanOf(item.span, item.span === undefined) })
      else if (item.kind === 'heading') {
        if ((typeof item.text === 'string' && item.text.trim()) || opts.design) items.push({ id: item.id, kind: 'heading', text: typeof item.text === 'string' ? item.text : '', size: oneOf(item.size, SIZES, 'medium'), span: spanOf(item.span, item.span === undefined) })
      } else if (item.kind === 'text') {
        if ((typeof item.text === 'string' && item.text.trim()) || opts.design) items.push({ id: item.id, kind: 'text', text: typeof item.text === 'string' ? item.text : '', tone: oneOf(item.tone, ['plain', 'note', 'success', 'warning'], 'plain'), span: spanOf(item.span, item.span === undefined) })
      }
    }
    const required = items.some((i) => i.kind === 'field' && i.field.required)
    const style = s.style ?? {}
    return {
      id: s.id,
      title: s.title?.trim() || undefined,
      description: s.description?.trim() || undefined,
      columns: cols,
      collapsed: !!s.collapsed && !required && !opts.design,
      look: oneOf(style.look, ['plain', 'card', 'tinted', 'outlined'], 'plain'),
      accent: typeof style.accent === 'string' && HEX.test(style.accent) ? style.accent : undefined,
      titleSize: oneOf(style.title, SIZES, 'medium'),
      rule: style.rule === true,
      items,
    }
  }

  const sections = layout.sections.map(plan)
  const rest = opts.design ? [] : type.fields.filter((f) => !placed.has(f.id) && shown(f))
  if (rest.length) {
    sections.push({
      id: 'sec_rest',
      title: layout.sections.length && type.form ? 'More' : undefined,
      columns: 2,
      collapsed: false,
      look: 'plain',
      titleSize: 'medium',
      rule: false,
      items: rest.map((field) => ({ id: `fi_${field.id}`, kind: 'field', field, span: field.width === 'full' || field.type === 'table' ? 2 : 1, label: field.label, help: field.helpText, emphasis: false })),
    })
  }
  const style = type.form?.style ?? {}
  return {
    // A section with no field left in it (all hidden at this step) would be a title over nothing.
    sections: opts.design ? sections : sections.filter((s) => s.items.some((i) => i.kind === 'field')),
    hidden,
    width: oneOf(style.width, ['narrow', 'medium', 'wide', 'full'], 'full'),
    labels: oneOf(style.labels, ['above', 'beside'], 'above'),
    spacing: oneOf(style.spacing, ['tight', 'normal', 'airy'], 'normal'),
  }
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
  const text = (x: unknown) => x === undefined || typeof x === 'string'
  const span = (x: unknown) => x === undefined || [1, 2, 3, 4].includes(x as number)
  const pick = (x: unknown, allowed: readonly string[]) => x === undefined || allowed.includes(x as string)
  if (l.style !== undefined && (typeof l.style !== 'object' || l.style === null || !pick(l.style.width, ['narrow', 'medium', 'wide', 'full']) || !pick(l.style.labels, ['above', 'beside']) || !pick(l.style.spacing, ['tight', 'normal', 'airy'])))
    out.push('The form’s style is not one Modus knows.')
  const ids = new Set<Id>()
  for (const s of l.sections) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.items) || ![1, 2, 3, 4].includes(s.columns) || !text(s.title) || !text(s.description)) {
      out.push('A section of the form layout is not one Modus knows.')
      continue
    }
    const st = s.style
    if (st !== undefined && (typeof st !== 'object' || st === null || !pick(st.look, ['plain', 'card', 'tinted', 'outlined']) || !pick(st.title, SIZES) || (st.accent !== undefined && !(typeof st.accent === 'string' && HEX.test(st.accent))) || (st.rule !== undefined && typeof st.rule !== 'boolean')))
      out.push('A section’s style is not one Modus knows.')
    for (const i of s.items) {
      if (!i || typeof i.id !== 'string' || !['field', 'heading', 'text', 'divider', 'spacer', 'image'].includes(i.kind)) {
        out.push('Something on the form layout is not a kind Modus knows.')
        continue
      }
      if (ids.has(i.id)) out.push(`Two things on the form layout share the id ${i.id}.`)
      else ids.add(i.id)
      if (i.kind !== 'divider' && !span(i.span)) out.push('Something on the form layout has a width that is not one.')
      if (i.kind === 'image' && i.url !== undefined && i.url !== '' && !isOwnPicture(i.url)) out.push('A picture on the form is not an image kept in the design.')
      if (i.kind === 'image' && (!text(i.alt) || (i.height !== undefined && typeof i.height !== 'number') || !pick(i.align, ['left', 'center', 'right']))) out.push('A picture on the form has a description, height or place that is not one.')
      if (i.kind === 'heading' && (typeof i.text !== 'string' || !pick(i.size, SIZES))) out.push('A heading on the form is not written the way Modus knows.')
      if (i.kind === 'text' && (typeof i.text !== 'string' || !pick(i.tone, ['plain', 'note', 'success', 'warning']))) out.push('A paragraph on the form is not written the way Modus knows.')
      if (i.kind === 'spacer' && i.height !== undefined && typeof i.height !== 'number') out.push('A space on the form has a height that is not one.')
      if (i.kind === 'field' && (typeof i.fieldId !== 'string' || !text(i.label) || !text(i.help) || !text(i.placeholder) || (i.emphasis !== undefined && typeof i.emphasis !== 'boolean'))) out.push('A field on the form layout is not placed the way Modus knows.')
    }
  }
  return out
}
