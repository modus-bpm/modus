// The starter library as the pages and the pictures see it: each template with the file name
// its page and its picture share.

import { fileURLToPath } from 'node:url'
import { seedTemplates } from '@modus-bpm/core/model/seed-templates'
import type { Template } from '@modus-bpm/core/model/types'

/** The repository root. */
export const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
/** Where the pages go; the pictures go in `images` beside them. */
export const PAGES = `${ROOT}/docs/templates`

export interface Entry {
  template: Template
  /** `invoice-approval`: the page is `<slug>.md`, the picture `images/<slug>.png`. */
  slug: string
}

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Every starter template, in the gallery's order. Two templates may not share a name. */
export function library(): Entry[] {
  const entries = seedTemplates().map((template) => ({ template, slug: slugOf(template.name) }))
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.slug)) throw new Error(`Two templates would share the page ${e.slug}.md.`)
    seen.add(e.slug)
  }
  return entries
}
