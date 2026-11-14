// Templates as files. A template file is JSON holding one template or several, so a template can
// leave one design and enter another: exported from the Studio, kept in a repository, sent to a
// colleague, imported somewhere else. The starter library is fifty such files (`templates/` at
// the root of the repository).
//
//   { "format": "modus-template", "version": 1, "templates": [ { "id": "tpl_…", "name": "…", … } ] }

import type { FieldDef, Template, WfNode } from './types'
import { uid } from './util'

export const TEMPLATE_FILE_FORMAT = 'modus-template'
/** Goes up when the shape of a template changes in a way an older Modus could not read. */
export const TEMPLATE_FILE_VERSION = 1

export interface TemplateFile {
  format: typeof TEMPLATE_FILE_FORMAT
  version: number
  templates: Template[]
}

/** The file for these templates. `builtIn` stays behind: it says where a template came from in one design, not what it is. */
export function templateFile(templates: Template[]): TemplateFile {
  return {
    format: TEMPLATE_FILE_FORMAT,
    version: TEMPLATE_FILE_VERSION,
    templates: templates.map((t) => {
      const { builtIn: _builtIn, ...rest } = structuredClone(t)
      return rest
    }),
  }
}

/** A file's text, laid out so a change to one step is a small change to the file. */
export const templateFileText = (templates: Template[]) => `${JSON.stringify(templateFile(templates), null, 2)}\n`

/** A file name for a template: `invoice-approval`. */
export const templateFileName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'template'

const NODE_TYPES: ReadonlySet<string> = new Set<WfNode['type']>(['start', 'user', 'auto', 'decision', 'split', 'join', 'subflow', 'wait', 'end'])
const FIELD_TYPES: ReadonlySet<string> = new Set<FieldDef['type']>(['text', 'textarea', 'number', 'currency', 'date', 'boolean', 'choice', 'user', 'email', 'attachment', 'table'])
const MAX_TEMPLATES = 1000
const MAX_STEPS = 500

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

/**
 * What stops this from being a template the designer can open: an empty list means it is one.
 * It checks the shape, not the design: a template may still have a step nobody is assigned to
 * or a rule not yet written, as any map being worked on may.
 */
export function templateProblems(t: unknown): string[] {
  if (!isObject(t)) return ['It is not a template.']
  const out: string[] = []
  if (!isText(t.id, 200)) out.push('It has no id.')
  if (!isText(t.name)) out.push('It has no name.')
  if (typeof t.description !== 'string') out.push('It has no description.')
  if (!isText(t.category)) out.push('It has no category.')
  if (t.tags !== undefined && !(Array.isArray(t.tags) && t.tags.every((x) => typeof x === 'string'))) out.push('Its tags are not a list of words.')

  const fieldIds = new Set<string>()
  if (!Array.isArray(t.fields)) out.push('It has no list of fields.')
  else
    for (const f of t.fields) {
      if (!isObject(f) || !isText(f.id, 200) || !isText(f.label) || typeof f.type !== 'string' || !FIELD_TYPES.has(f.type)) {
        out.push(`A field is not one Modus knows: ${isObject(f) && typeof f.label === 'string' ? f.label : 'unnamed'}.`)
        continue
      }
      if (fieldIds.has(f.id)) out.push(`Two fields share the id ${f.id}.`)
      fieldIds.add(f.id)
    }

  const nodeIds = new Set<string>()
  const types = new Map<string, string>()
  if (!Array.isArray(t.nodes) || t.nodes.length === 0) out.push('It has no steps.')
  else if (t.nodes.length > MAX_STEPS) out.push(`It has more than ${MAX_STEPS} steps.`)
  else
    for (const n of t.nodes) {
      const label = isObject(n) && isObject(n.data) && typeof n.data.label === 'string' ? n.data.label : undefined
      if (!isObject(n) || !isText(n.id, 200) || typeof n.type !== 'string' || !NODE_TYPES.has(n.type) || label === undefined) {
        out.push(`A step is not one Modus knows: ${label ?? 'unnamed'}.`)
        continue
      }
      if (!isObject(n.position) || typeof n.position.x !== 'number' || typeof n.position.y !== 'number') out.push(`“${label}” has no place on the map.`)
      if (n.type === 'user' && !(isObject(n.data) && Array.isArray(n.data.outcomes))) out.push(`“${label}” has no list of outcomes.`)
      if (nodeIds.has(n.id)) out.push(`Two steps share the id ${n.id}.`)
      nodeIds.add(n.id)
      types.set(n.id, n.type)
    }
  if (nodeIds.size && ![...types.values()].includes('start')) out.push('It has no start.')

  const edgeIds = new Set<string>()
  if (!Array.isArray(t.edges)) out.push('It has no list of paths.')
  else
    for (const e of t.edges) {
      if (!isObject(e) || !isText(e.id, 200) || typeof e.source !== 'string' || typeof e.target !== 'string' || !isObject(e.data)) {
        out.push('A path is not one Modus knows.')
        continue
      }
      // With no steps at all, that is already said once.
      if (nodeIds.size && (!nodeIds.has(e.source) || !nodeIds.has(e.target))) out.push(`The path ${e.id} leads to or from a step that isn't there.`)
      if (edgeIds.has(e.id)) out.push(`Two paths share the id ${e.id}.`)
      edgeIds.add(e.id)
    }
  return out
}

export interface ReadTemplates {
  /** The templates that can be used. */
  templates: Template[]
  /** The ones that can't, each with why. */
  refused: Array<{ name: string; problems: string[] }>
}

export class NotATemplateFile extends Error {}

/**
 * Read a template file's text. Throws `NotATemplateFile`, with a message for the person who
 * picked the file, when it isn't one at all; a file with one bad template among good ones
 * gives the good ones and says what is wrong with the other.
 */
export function readTemplateFile(text: string): ReadTemplates {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new NotATemplateFile('That file is not JSON.')
  }
  if (isObject(doc) && Array.isArray(doc.apps) && Array.isArray(doc.users)) throw new NotATemplateFile('That is a whole design, not a template file. Use Import design in the settings menu.')
  if (!isObject(doc) || doc.format !== TEMPLATE_FILE_FORMAT || !Array.isArray(doc.templates)) throw new NotATemplateFile('That is not a Modus template file.')
  if (typeof doc.version !== 'number' || doc.version > TEMPLATE_FILE_VERSION) throw new NotATemplateFile('That template file was written by a newer Modus than this one.')
  if (doc.templates.length > MAX_TEMPLATES) throw new NotATemplateFile(`That file holds more than ${MAX_TEMPLATES} templates.`)

  const out: ReadTemplates = { templates: [], refused: [] }
  const seen = new Set<string>()
  for (const t of doc.templates as unknown[]) {
    const problems = templateProblems(t)
    const name = isObject(t) && isText(t.name) ? t.name : 'A template without a name'
    if (!problems.length && seen.has((t as Template).id)) problems.push('The file holds another template with the same id.')
    if (problems.length) out.refused.push({ name, problems })
    else {
      const { builtIn: _builtIn, ...rest } = structuredClone(t as Template)
      seen.add(rest.id)
      out.templates.push(rest)
    }
  }
  return out
}

/** What to do with an incoming template the library already has (the same id). */
export type OnExisting = 'replace' | 'copy' | 'skip'

export interface Imported {
  templates: Template[]
  added: string[]
  replaced: string[]
  copied: string[]
  skipped: string[]
}

/** Which of the incoming templates the library already has. */
export function alreadyThere(library: Template[], incoming: Template[]): Template[] {
  return incoming.filter((t) => library.some((x) => x.id === t.id))
}

/**
 * Add templates to a library. One the library already has is replaced where it stands, added
 * beside it as a copy under a new id, or left out. A replaced built-in template stays built in;
 * everything else arrives as the organization's own. The library passed in is not changed.
 */
export function importTemplates(library: Template[], incoming: Template[], onExisting: OnExisting, who?: string): Imported {
  const out: Imported = { templates: [...library], added: [], replaced: [], copied: [], skipped: [] }
  const taken = new Set(library.map((t) => t.name.trim().toLowerCase()))
  for (const raw of incoming) {
    const t: Template = { ...structuredClone(raw), builtIn: false }
    const at = out.templates.findIndex((x) => x.id === t.id)
    if (at < 0) {
      out.templates.push(t)
      out.added.push(t.name)
    } else if (onExisting === 'skip') {
      out.skipped.push(t.name)
    } else if (onExisting === 'replace') {
      out.templates[at] = { ...t, builtIn: out.templates[at]!.builtIn }
      out.replaced.push(t.name)
    } else {
      let name = `${t.name} (imported)`
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${t.name} (imported ${n})`
      out.templates.splice(at + 1, 0, { ...t, id: uid('tpl'), name, createdBy: who ?? t.createdBy })
      out.copied.push(name)
    }
    taken.add(out.templates[at < 0 ? out.templates.length - 1 : onExisting === 'copy' ? at + 1 : at]!.name.trim().toLowerCase())
  }
  return out
}
