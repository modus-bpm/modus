// A design in parts, for two things: counting what a designer has changed and not yet saved, and
// carrying those changes over to a design someone else saved meanwhile. A part is the unit a person
// thinks of as one thing: a workflow, an object type, a list, an application's own settings, a
// person, a group, a service, a template. Nothing is merged inside a part.

import type { App, Design, Workflow } from '@modus-bpm/core/model/types'

/** What kind of thing a part is, for saying what changed. */
export type PartKind = 'application' | 'workflow' | 'object type' | 'list' | 'person' | 'group' | 'service' | 'template'

export interface Part {
  key: string
  kind: PartKind
  name: string
}

type Loose = Pick<Design, 'apps' | 'users' | 'groups'> & { services: Array<{ id: string; name: string }>; templates: Array<{ id: string; name?: string }> }

/** A workflow without what the server owns: its versions and which one is published. */
const drafted = (w: Workflow) => ({ ...w, versions: undefined, published: undefined })

/** An application's own settings: everything but its workflows, object types and lists. */
const settings = (a: App) => ({ ...a, workflows: undefined, objectTypes: undefined, lists: undefined })

interface Held extends Part {
  /** The part, as text: two parts are the same when this is. */
  text: string
}

function partsOf(d: Loose): Map<string, Held> {
  const out = new Map<string, Held>()
  const put = (key: string, kind: PartKind, name: string, value: unknown) => out.set(key, { key, kind, name, text: JSON.stringify(value) })
  for (const a of d.apps) {
    put(`app:${a.id}`, 'application', a.name, settings(a))
    for (const w of a.workflows) put(`wf:${a.id}/${w.id}`, 'workflow', w.name, drafted(w))
    for (const t of a.objectTypes) put(`type:${a.id}/${t.id}`, 'object type', t.name, t)
    for (const l of a.lists) put(`list:${a.id}/${l.id}`, 'list', l.name, l)
  }
  for (const u of d.users) put(`user:${u.id}`, 'person', u.name, u)
  for (const g of d.groups) put(`group:${g.id}`, 'group', g.name, g)
  for (const s of d.services) put(`service:${s.id}`, 'service', s.name, s)
  for (const t of d.templates) put(`template:${t.id}`, 'template', t.name ?? t.id, t)
  return out
}

/** The parts that differ between two designs: changed, added or removed. Order within a list doesn't count. */
export function changedParts(from: Loose, to: Loose): Part[] {
  if (from === to) return []
  const a = partsOf(from)
  const b = partsOf(to)
  const out: Part[] = []
  for (const [key, p] of b) if (a.get(key)?.text !== p.text) out.push({ key, kind: p.kind, name: p.name })
  for (const [key, p] of a) if (!b.has(key)) out.push({ key, kind: p.kind, name: p.name })
  return out
}

/** "the workflow Invoice Approval, 2 object types and a person" */
export function describeParts(parts: Part[]): string {
  if (parts.length <= 3) return list(parts.map((p) => `the ${p.kind} “${p.name}”`))
  const counts = new Map<PartKind, number>()
  for (const p of parts) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
  return list([...counts].map(([kind, n]) => `${n} ${n === 1 ? kind : kind === 'person' ? 'people' : `${kind}s`}`))
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? 'nothing') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

export interface CarriedOver<D> {
  /** `theirs` with the designer's own changes applied (all but the conflicts they gave up). */
  design: D
  /** Parts both sides changed, differently. */
  conflicts: Part[]
}

/**
 * Carry a designer's changes (`base` → `mine`) over to `theirs`, a design saved by someone else
 * from the same `base`. Parts only the designer changed keep their changes; everything else is
 * theirs. A part both changed differently is a conflict: `keep` decides whose it is ('mine' or
 * 'theirs') for all of them.
 */
export function carryOver<D extends Loose>(base: D, mine: D, theirs: D, keep: 'mine' | 'theirs' = 'mine'): CarriedOver<D> {
  const b = partsOf(base)
  const m = partsOf(mine)
  const t = partsOf(theirs)
  const conflicts: Part[] = []
  /** Keys of mine to apply onto theirs. */
  const take = new Set<string>()
  for (const key of new Set([...b.keys(), ...m.keys()])) {
    const was = b.get(key)?.text
    const now = m.get(key)?.text
    if (was === now) continue
    const their = t.get(key)?.text
    if (their !== was && their !== now) {
      const p = m.get(key) ?? b.get(key)!
      conflicts.push({ key, kind: p.kind, name: p.name })
      if (keep === 'theirs') continue
    }
    take.add(key)
  }
  if (!take.size) return { design: theirs, conflicts }

  const has = (key: string) => m.has(key)
  /** A list of theirs, with mine applied: my version of what I changed, mine added, mine removed. */
  const merged = <X extends { id: string }>(prefix: string, theirList: X[], myList: X[], fix: (my: X, their: X | undefined) => X = (x) => x): X[] => {
    const out: X[] = []
    for (const x of theirList) {
      const key = `${prefix}${x.id}`
      if (!take.has(key)) out.push(x)
      else if (has(key)) out.push(fix(myList.find((y) => y.id === x.id)!, x))
    }
    for (const y of myList) if (take.has(`${prefix}${y.id}`) && !theirList.some((x) => x.id === y.id)) out.push(fix(y, undefined))
    return out
  }
  // A workflow of mine keeps the versions the server holds for it.
  const withVersions = (my: Workflow, their: Workflow | undefined): Workflow => (their ? { ...my, versions: their.versions, published: their.published } : my)

  const apps: App[] = []
  const appOf = (a: App, my: App | undefined): App => {
    const own = take.has(`app:${a.id}`) && my ? { ...my } : { ...a }
    return {
      ...own,
      workflows: merged(`wf:${a.id}/`, a.workflows, my?.workflows ?? [], withVersions),
      objectTypes: merged(`type:${a.id}/`, a.objectTypes, my?.objectTypes ?? []),
      lists: merged(`list:${a.id}/`, a.lists, my?.lists ?? []),
    }
  }
  for (const a of theirs.apps) {
    const my = mine.apps.find((x) => x.id === a.id)
    // Removed by me (and that removal is mine to keep).
    if (take.has(`app:${a.id}`) && !my) continue
    apps.push(appOf(a, my))
  }
  // Applications I added.
  for (const my of mine.apps) if (take.has(`app:${my.id}`) && !theirs.apps.some((a) => a.id === my.id)) apps.push(my)

  const design = {
    ...theirs,
    apps,
    users: merged('user:', theirs.users, mine.users),
    groups: merged('group:', theirs.groups, mine.groups),
    services: merged('service:', theirs.services, mine.services),
    templates: merged('template:', theirs.templates, mine.templates),
  }
  return { design, conflicts }
}
