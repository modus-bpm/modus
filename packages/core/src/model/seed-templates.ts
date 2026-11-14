import { STARTER_FILES } from './starter-library'
import type { Template } from './types'

// Starter library: fifty workflows named for the work they handle, grouped by department.
// Each is a template file in `templates/` (see template-files.ts and starter-library.ts), the
// same kind of file the Studio exports and imports. Groups are left for the person using the
// template to pick (their organization's groups), so each comes in with a friendly "pick a
// group" check rather than someone else's org chart.

/** Departments, in the order the gallery lists them. */
export const TEMPLATE_CATEGORIES = [
  'Finance and AP',
  'Purchasing and contracts',
  'People and HR',
  'IT and security',
  'Facilities, fleet and safety',
  'Government and public safety',
  'Customers and operations',
] as const

/** What the first six were called before the library grew; a saved design still carrying one of these names gets the new one. */
const EARLIER_NAMES: Record<string, string> = {
  tpl_two_level: 'Two-level approval',
  tpl_parallel_review: 'Parallel review',
  tpl_onboarding: 'Employee onboarding',
  tpl_ai_hitl: 'AI triage with human review',
  tpl_three_way: 'Three-way match',
  tpl_incident: 'Incident report',
}

/**
 * Bring a saved template list up to the starter library: add the built-in templates it lacks,
 * and give the first six their new names and departments unless someone renamed them.
 * Templates an organization saved or changed are left as they are. Run once per saved design.
 */
export function addStarterTemplates(saved: Template[]): Template[] {
  const seed = seedTemplates()
  const out = saved.map((t) => {
    const now = seed.find((x) => x.id === t.id)
    if (!now || !t.builtIn || t.name !== EARLIER_NAMES[t.id]) return t
    return { ...t, name: now.name, description: now.description, category: now.category, tags: now.tags }
  })
  for (const t of seed) if (!out.some((x) => x.id === t.id)) out.push(structuredClone(t))
  return out
}

/** The starter library as templates, each marked built in. A fresh copy every call. */
export function seedTemplates(): Template[] {
  return STARTER_FILES.flatMap((f) => f.templates).map((t) => ({ ...structuredClone(t), builtIn: true }))
}
