import { produce } from 'immer'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedDesign } from '@modus-bpm/core/model/seed'
import { addStarterTemplates } from '@modus-bpm/core/model/seed-templates'
import { upgradeDesign } from '@modus-bpm/core/model/upgrade'
import { ensureVersions } from '@modus-bpm/core/model/versions'
import type { App, Design, Id, ObjectType, ServiceDef, Template, Workflow } from '@modus-bpm/core/model/types'

interface DesignStore {
  /** The design being edited: this browser's own, or (in Live) a working copy of the server's. */
  design: Design
  /** Whose design `design` is. */
  source: 'local' | 'server'
  /** This browser's own design, put aside while the server's is being edited. */
  stash?: Design
  /** Start editing the server's design; this browser's own is put aside untouched. */
  enterServer: (d: Design) => void
  /** Replace the working copy of the server's design (after a save, or when someone else saved). */
  setServerDesign: (d: Design) => void
  /** Go back to this browser's own design. */
  leaveServer: () => void
  /** Mutate the whole design (org, users, groups, apps, services, templates) with an immer recipe. */
  update: (fn: (d: Design) => void) => void
  updateApp: (appId: Id, fn: (app: App) => void) => void
  updateWorkflow: (appId: Id, workflowId: Id, fn: (wf: Workflow) => void) => void
  updateType: (appId: Id, typeId: Id, fn: (t: ObjectType) => void) => void
  updateService: (serviceId: Id, fn: (s: ServiceDef) => void) => void
  updateTemplate: (templateId: Id, fn: (t: Template) => void) => void
  replace: (d: Design) => void
  reset: () => void
}

/** Older saved designs may predate the service registry or the template library. */
function withRegistries(d: Design): Design {
  const seed = seedDesign()
  return {
    ...d,
    services: Array.isArray(d.services) ? d.services : seed.services,
    templates: Array.isArray(d.templates) ? d.templates : seed.templates,
  }
}

/** Fill in what older saved designs lack; every workflow starts at version 1, published, from its map. */
export function normalizeDesign(d: Design): Design {
  return versioned(withRegistries(d))
}

// When a workflow first gets its version 1 (on load, or when one is created), in simulation minutes.
let clock = () => 0
export function setPublishClock(fn: () => number) {
  clock = fn
}

/** Workflows created from now on (blank, from a template, blown out of a step) start at version 1, published. */
const versioned = (d: Design) => ensureVersions(d, clock())

export const useDesign = create<DesignStore>()(
  persist(
    (set) => ({
      design: versioned(seedDesign()),
      source: 'local',
      enterServer: (d) => set((s) => ({ design: d, source: 'server', stash: s.source === 'local' ? s.design : s.stash })),
      setServerDesign: (d) => set((s) => (s.source === 'server' ? { design: d } : {})),
      leaveServer: () => set((s) => (s.source === 'server' ? { design: s.stash ?? versioned(seedDesign()), source: 'local', stash: undefined } : {})),
      update: (fn) => set((s) => ({ design: versioned(produce(s.design, fn)) })),
      updateApp: (appId, fn) =>
        set((s) => ({
          design: versioned(
            produce(s.design, (d) => {
              const app = d.apps.find((a) => a.id === appId)
              if (app) fn(app)
            }),
          ),
        })),
      updateWorkflow: (appId, workflowId, fn) =>
        set((s) => ({
          design: produce(s.design, (d) => {
            const wf = d.apps.find((a) => a.id === appId)?.workflows.find((w) => w.id === workflowId)
            if (wf) fn(wf)
          }),
        })),
      updateType: (appId, typeId, fn) =>
        set((s) => ({
          design: produce(s.design, (d) => {
            const t = d.apps.find((a) => a.id === appId)?.objectTypes.find((x) => x.id === typeId)
            if (t) fn(t)
          }),
        })),
      updateService: (serviceId, fn) =>
        set((s) => ({
          design: produce(s.design, (d) => {
            const svc = d.services.find((x) => x.id === serviceId)
            if (svc) fn(svc)
          }),
        })),
      updateTemplate: (templateId, fn) =>
        set((s) => ({
          design: produce(s.design, (d) => {
            const t = d.templates.find((x) => x.id === templateId)
            if (t) fn(t)
          }),
        })),
      replace: (design) => set({ design: normalizeDesign(design) }),
      // The sample replaces this browser's own design only: a server's is never reset from here.
      reset: () => set((s) => (s.source === 'server' ? {} : { design: versioned(seedDesign()) })),
    }),
    {
      name: 'modus-design',
      // Bump when saved designs need something added once
      // (version 2: line items, roles, supervisors, expedite from the sample data;
      // version 3: workflow versions, made from each saved map as it stands;
      // version 4: the starter library of fifty templates).
      version: 4,
      // Only this browser's own design is kept here; the server's working copy lives in memory until saved.
      partialize: (s) => ({ design: s.source === 'server' ? (s.stash ?? s.design) : s.design }),
      migrate: (persisted, from) => {
        const p = persisted as { design?: Design } | undefined
        if (!p?.design) return p
        // The sample-data upgrade runs once, so things deleted after it stay deleted.
        const design = from < 2 ? upgradeDesign(withRegistries(p.design), seedDesign()) : withRegistries(p.design)
        // Added once, so a template someone deleted afterwards stays deleted.
        if (from < 4) design.templates = addStarterTemplates(design.templates)
        return { ...p, design: versioned(design) }
      },
      merge: (persisted, current) => {
        const p = persisted as { design?: Design } | undefined
        return p?.design ? { ...current, design: normalizeDesign(p.design) } : current
      },
    },
  ),
)

export function useApp(appId: Id): App | undefined {
  return useDesign((s) => s.design.apps.find((a) => a.id === appId))
}
