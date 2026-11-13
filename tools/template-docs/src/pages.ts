// Writes docs/templates/<slug>.md for every starter template, from the template itself, and
// links each name in docs/TEMPLATES.md to its page. Run it again after changing a template.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describeCondition } from '@modus-bpm/core/model/conditions'
import { appFromTemplate, seedDesign } from '@modus-bpm/core/model/seed'
import { TEMPLATE_CATEGORIES } from '@modus-bpm/core/model/seed-templates'
import { AUTO_FAILURE } from '@modus-bpm/core/model/types'
import type { App, FieldDef, ObjectType, UserStepData, WfEdge, WfNode, Workflow } from '@modus-bpm/core/model/types'
import { type Entry, library, PAGES, ROOT } from './library'

const design = seedDesign()

const KIND: Record<WfNode['type'], string> = {
  start: 'Start',
  user: 'Person',
  auto: 'Automated',
  decision: 'Decision',
  split: 'Parallel split',
  join: 'Join',
  subflow: 'Subflow',
  wait: 'Timer',
  end: 'End',
}

const TRIGGER = {
  form: 'Someone fills in the form.',
  api: 'Another system creates the item through the API.',
  event: 'Every message on an event stream becomes an item.',
  schedule: 'Items are created on a schedule.',
  email: 'Every email that arrives in a mailbox becomes an item.',
}

const FIELD_TYPE: Record<FieldDef['type'], string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  boolean: 'Yes / No',
  choice: 'Choice',
  user: 'Person',
  email: 'Email',
  attachment: 'Attachment',
  table: 'Table',
}

const RESULT = { completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled' }

/** A table cell: no pipe may end it early. */
const cell = (s: string) => s.replace(/\|/g, '\\|')
const quoted = (s: string) => `“${s}”`

function duration(minutes: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (minutes % 1440 === 0) return unit(minutes / 1440, 'day')
  if (minutes % 60 === 0) return unit(minutes / 60, 'hour')
  return unit(minutes, 'minute')
}

interface Ctx {
  app: App
  wf: Workflow
  type: ObjectType
}

const labelOf = (c: Ctx, nodeId: string) => c.wf.nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId
const fieldLabel = (c: Ctx, fieldId: string | undefined) => c.type.fields.find((f) => f.id === fieldId)?.label ?? 'a field'
const pathsFrom = (c: Ctx, n: WfNode) => c.wf.edges.filter((e) => e.source === n.id)

/** Decision and inclusive-split paths in the order the engine checks them, the default last. */
function inOrder(edges: WfEdge[]): WfEdge[] {
  return [...edges].sort((a, b) => (!!a.data.isDefault !== !!b.data.isDefault ? (a.data.isDefault ? 1 : -1) : (a.data.order ?? 0) - (b.data.order ?? 0)))
}

function handedOut(c: Ctx, d: UserStepData): string {
  switch (d.distribution) {
    case 'load-balance':
      return 'Load balanced: each item goes to the member with the fewest open items.'
    case 'queue':
      return 'A queue: any member of the group claims it.'
    case 'manager':
      return 'A dispatcher hands each item to someone.'
    case 'direct':
      return 'Goes to one named person.'
    case 'field':
      return `Goes to the person named in ${quoted(fieldLabel(c, d.assigneeFieldId))}.`
  }
}

/** What the step does, in a sentence or two. */
function does(c: Ctx, n: WfNode): string {
  switch (n.type) {
    case 'start':
      return TRIGGER[n.data.trigger ?? 'form']
    case 'user': {
      const d = n.data
      const out = [handedOut(c, d)]
      if (d.slaHours) out.push(`Due in ${duration(d.slaHours * 60)}.`)
      if (d.escalateAfterHours) out.push(`Escalates after ${duration(d.escalateAfterHours * 60)}.`)
      if (d.separateFrom?.length) out.push(`Not the person who did ${d.separateFrom.map((id) => quoted(labelOf(c, id))).join(' or ')}.`)
      return out.join(' ')
    }
    case 'auto': {
      const service = design.services.find((s) => s.id === n.data.serviceId)
      if (!service) return '**Your system.** A placeholder until you point it at a service of your own; until then it takes its time and passes the item on.'
      const failed = pathsFrom(c, n).some((e) => e.data.outcomeId === AUTO_FAILURE)
      const after = failed ? '' : n.data.onFailure === 'manual' ? ' If the call fails, a person does the step by hand.' : n.data.onFailure === 'stuck' ? ' If the call fails, it stops for an administrator.' : ''
      return `Calls the sample service ${quoted(service.name)}.${after}`
    }
    case 'decision':
      return 'Checks its rules from the top; the first one that matches wins.'
    case 'split':
      return n.data.mode === 'all' ? 'Starts every path at the same time.' : 'Starts every path whose rule matches, at the same time.'
    case 'join': {
      const of = c.wf.edges.filter((e) => e.target === n.id).length
      const rest = n.data.cancelRemaining ? ' The branches still running are withdrawn.' : ''
      if (n.data.mode === 'all') return 'Waits for every branch.'
      if (n.data.mode === 'any') return `Continues with the first branch to arrive.${rest}`
      return `Continues when ${n.data.count ?? 1} of ${of} branches have arrived.${rest}`
    }
    case 'subflow':
      return 'Runs a subflow on the same item.'
    case 'wait':
      return `Waits ${duration(n.data.minutes)}.`
    case 'end':
      return `Ends the item as ${RESULT[n.data.result]}.`
  }
}

/** Where the step's paths lead, one per line. */
function then(c: Ctx, n: WfNode): string {
  const edges = pathsFrom(c, n)
  const to = (e: WfEdge) => labelOf(c, e.target)
  if (n.type === 'user') {
    return n.data.outcomes
      .flatMap((o) => edges.filter((e) => e.data.outcomeId === o.id).map((e) => `**${o.label}**${o.requireComment ? ' (with a comment)' : ''} → ${to(e)}`))
      .concat(edges.filter((e) => !n.data.outcomes.some((o) => o.id === e.data.outcomeId)).map((e) => `→ ${to(e)}`))
      .join('<br>')
  }
  if (n.type === 'decision' || (n.type === 'split' && n.data.mode === 'inclusive')) {
    return inOrder(edges)
      .map((e) => `**${e.data.isDefault ? 'Otherwise' : describeCondition(e.data.condition, { type: c.type, lists: c.app.lists, users: [] })}** → ${to(e)}`)
      .join('<br>')
  }
  if (n.type === 'auto' && edges.some((e) => e.data.outcomeId === AUTO_FAILURE)) {
    return edges.map((e) => `**${e.data.outcomeId === AUTO_FAILURE ? 'Failed' : 'Succeeded'}** → ${to(e)}`).join('<br>')
  }
  return edges.map((e) => `→ ${to(e)}`).join('<br>')
}

function fieldNotes(c: Ctx, f: FieldDef): string {
  const notes: string[] = []
  if (f.required) notes.push('Required')
  if (f.summary) notes.push('Shown on work cards')
  if (f.system) notes.push('Set by the process')
  if (f.type === 'table' && f.columns?.length) notes.push(`Columns: ${f.columns.map((col) => col.label).join(', ')}`)
  if (f.total) notes.push(`The sum of a column of ${quoted(fieldLabel(c, f.total.tableFieldId))}`)
  return notes.join(' · ')
}

function page(entries: Entry[], i: number): string {
  const { template: t, slug } = entries[i]!
  const app = appFromTemplate(t, { groups: [], users: [] })
  const c: Ctx = { app, wf: app.workflows[0]!, type: app.objectTypes[0]! }
  // Left to right, top to bottom: the order the map reads in.
  const nodes = [...c.wf.nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
  const steps = nodes.filter((n) => n.type !== 'start' && n.type !== 'end')
  const people = nodes.filter((n) => n.type === 'user').length
  const yours = nodes.filter((n) => n.type === 'auto' && !n.data.serviceId).length
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const facts = [count(steps.length, 'step'), count(people, 'people step')]
  if (yours) facts.push(count(yours, 'step for a system of yours', 'steps for systems of yours'))
  const fields = t.fields.map((f) => c.type.fields.find((x) => x.label === f.label) ?? f)
  const item = t.item?.one ?? 'Request'
  const prev = entries[i - 1]
  const next = entries[i + 1]

  const lines = [
    `# ${t.name}`,
    '',
    `[Starter templates](../TEMPLATES.md) › ${t.category}`,
    '',
    t.description,
    '',
    `![The ${t.name} map in the Modus designer](images/${slug}.png)`,
    '',
    `${facts.join(' · ')}. Each item is ${/^[aeiou]/i.test(item) ? 'an' : 'a'} **${item}**.${t.tags?.length ? ` Tags: ${t.tags.join(', ')}.` : ''}`,
    '',
    '## Steps',
    '',
    '| Step | Kind | What it does | Then |',
    '| --- | --- | --- | --- |',
    ...nodes.map((n) => `| **${cell(n.data.label)}** | ${KIND[n.type]} | ${cell(does(c, n))} | ${cell(then(c, n))} |`),
    '',
  ]
  if (fields.length) {
    lines.push('## Fields', '', '| Field | Type | Notes |', '| --- | --- | --- |', ...fields.map((f) => `| ${cell(f.label)} | ${FIELD_TYPE[f.type]} | ${cell(fieldNotes(c, f))} |`), '')
  }
  lines.push(
    '## Use it',
    '',
    `In the Studio, open **Templates** and find **${t.name}**. Start a new application from it, or add it to an application you have and map its fields onto yours.`,
    '',
    `Then make it your own: ${people ? 'pick the group that does each people step, ' : ''}${yours ? 'point the steps marked *your system* at your services, ' : ''}change the thresholds and deadlines, publish, and run the simulation to watch work move through it.`,
    '',
    '---',
    '',
    [prev && `← [${prev.template.name}](${prev.slug}.md)`, '[All templates](../TEMPLATES.md)', next && `[${next.template.name}](${next.slug}.md) →`].filter(Boolean).join(' · '),
    '',
  )
  return lines.join('\n')
}

const entries = library()
mkdirSync(`${PAGES}/images`, { recursive: true })
const wanted = new Set(entries.map((e) => `${e.slug}.md`))
for (const f of readdirSync(PAGES)) if (f.endsWith('.md') && !wanted.has(f)) rmSync(`${PAGES}/${f}`)
entries.forEach((e, i) => writeFileSync(`${PAGES}/${e.slug}.md`, page(entries, i)))

// The list: link each template's name to its page.
const listPath = `${ROOT}/docs/TEMPLATES.md`
let list = readFileSync(listPath, 'utf8')
const missing: string[] = []
for (const { template: t, slug } of entries) {
  const linked = `| [**${t.name}**](templates/${slug}.md) |`
  if (list.includes(linked)) continue
  const plain = `| **${t.name}** |`
  if (list.includes(plain)) list = list.replace(plain, linked)
  else missing.push(t.name)
}
writeFileSync(listPath, list)

const byCategory = TEMPLATE_CATEGORIES.map((cat) => `${cat}: ${entries.filter((e) => e.template.category === cat).length}`).join(', ')
console.log(`Wrote ${entries.length} pages to docs/templates (${byCategory}).`)
if (missing.length) console.log(`Not in docs/TEMPLATES.md, add a row for: ${missing.join(', ')}`)
