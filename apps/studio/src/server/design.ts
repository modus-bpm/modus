// The server's design, for the Studio's designer pages in Live: load it, save the designer's copy
// back, publish a workflow's draft, and count and move the items in flight for the version panels.
// A vanilla zustand store (no React) so tests drive it directly.
//
// `base` is the design as the server holds it; the designer's working copy lives in the Studio's
// design store and is handed in when saving. A save is made from `base`'s revision. When someone
// else saved meanwhile the server refuses, and the designer's changes are carried over to the newer
// design part by part (rebase.ts) and saved again; parts both changed are the caller's to decide.

import { createStore } from 'zustand/vanilla'
import type { Id, Migration, PublishPreview, SimState } from '@modus-bpm/core'
import { workspaceState } from '@modus-bpm/core'
import type { Design } from '@modus-bpm/core/model/types'
import { ApiError, DesignConflictError, forecastWorkflow, getDesign, getVersionItems, migrateWorkflowItems, publishWorkflowDraft, saveDesign, type ApiOptions, type Fetch, type Published, type ServerDesign } from './client'
import { carryOver, type Part } from './rebase'
import { signedInAs } from './session'

export type DesignStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The server's design as the designer pages hold it: services carry no connection details there. */
export const asDesign = (d: ServerDesign): Design => ({ apps: d.apps, users: d.users, groups: d.groups, templates: d.templates, services: d.services.map((s) => ({ endpoint: '', ...s })), ...(d.theme ? { theme: d.theme } : {}) })

export type SaveResult =
  /** Stored. `design` is the design as the server holds it now: the working copy should become it. */
  | { ok: true; design: Design; revision: number }
  /** Someone else changed the same parts. Nothing was stored; call again with `keep` to decide. */
  | { ok: false; conflicts: Part[]; theirs: Design }
  | { ok: false; error: string }

export interface DesignState {
  status: DesignStatus
  error?: string
  /** Who the Studio designs as (`x-user-id`) until OIDC: an administrator of the server's design, or a designer. */
  actor?: Id
  /** May the actor move items in flight (an administrator)? */
  admin: boolean
  /** The design as the server holds it, and its revision. */
  base?: Design
  revision: number
  saving: boolean
  /** A newer revision the server announced that hasn't been loaded yet. */
  behind?: number

  /** Load the server's design as `actor` (or the first administrator or designer it has). */
  load: (actor?: Id) => Promise<Design | undefined>
  /** Save the working copy. On a conflict with someone else's save, `keep` says whose parts win; without it the conflicts come back. */
  save: (work: Design, keep?: 'mine' | 'theirs') => Promise<SaveResult>
  /** The server's design changed: load it and carry `work` over. Returns the working copy to show, or the conflicts. */
  catchUp: (work: Design) => Promise<{ design: Design; conflicts: Part[] } | undefined>
  /** Note that the server announced a revision (from a stream). */
  heard: (revision: number) => void
  publish: (appId: Id, workflowId: Id, opts: { note?: string; who: 'new' | 'all'; stepMap?: Record<Id, Id> }) => Promise<{ ok: true; published: Published; design: Design } | { ok: false; error: string }>
  /** The items in flight that run a workflow, as an engine state for the version panels' counts. */
  items: (appId: Id, workflowId: Id) => Promise<SimState>
  migrate: (appId: Id, workflowId: Id, opts: { toVersion: number; objectIds?: Id[]; stepMap?: Record<Id, Id> }) => Promise<{ ok: true; value: Migration } | { ok: false; error: string }>
  forecast: (appId: Id, workflowId: Id, opts: { who: 'new' | 'all'; stepMap?: Record<Id, Id>; hours: number }) => Promise<PublishPreview>
  reset: () => void
}

export interface DesignDeps {
  fetch?: Fetch
  /** Where the acting person is remembered (shared with the Monitor); null for nowhere. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

/** The Monitor's key: one "acting as" for the administrator pages. */
export const ACTOR_KEY = 'modus-live-admin'

const words = (e: unknown) => (e instanceof ApiError && e.status < 500 ? e.message : 'The server couldn’t be reached, so nothing was changed. Try again.')

export function createDesignStore(deps: DesignDeps = {}) {
  const f = deps.fetch ?? ((input, init) => fetch(input, init))
  let storage = deps.storage
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage ?? null
    } catch {
      storage = null
    }
  }
  const remembered = () => {
    try {
      return storage?.getItem(ACTOR_KEY) ?? undefined
    } catch {
      return undefined
    }
  }
  let gen = 0

  return createStore<DesignState>()((set, get) => {
    const opts = (): ApiOptions => ({ user: get().actor!, fetch: f })

    /** The newest design as the actor gets it. */
    const fetchDesign = async () => {
      const d = await getDesign(opts())
      return { design: asDesign(d), revision: d.revision ?? 0 }
    }

    const adopt = (design: Design, revision: number) => set((s) => ({ base: design, revision, behind: s.behind !== undefined && s.behind > revision ? s.behind : undefined }))

    return {
      status: 'idle',
      admin: false,
      revision: 0,
      saving: false,

      load: async (actor) => {
        const g = ++gen
        set({ status: 'loading', error: undefined })
        try {
          // Anyone named may read the design; whom to act as is chosen from it.
          const first = await getDesign({ user: actor ?? remembered() ?? 'studio', fetch: f })
          if (g !== gen) return undefined
          const can = (id: Id | undefined, role: 'admin' | 'designer') => !!id && !!first.users.find((u) => u.id === id)?.roles?.includes(role)
          // Signed in as someone: they design as themselves or not at all.
          const me = signedInAs()
          const wanted = me ?? actor ?? remembered()
          const chosen = can(wanted, 'admin') || can(wanted, 'designer') ? wanted : me ? undefined : (first.users.find((u) => u.roles?.includes('admin')) ?? first.users.find((u) => u.roles?.includes('designer')))?.id
          if (!chosen) {
            set({ status: 'error', error: me ? 'You aren’t a designer or an administrator, so you can’t change the server’s design.' : 'The server’s design has no administrator or designer, so it can’t be changed from here.', base: undefined })
            return undefined
          }
          set({ actor: chosen, admin: can(chosen, 'admin') })
          // Again as them: only designers and administrators are sent the drafts.
          const { design, revision } = await fetchDesign()
          if (g !== gen) return undefined
          set({ status: 'ready', base: design, revision, behind: undefined, error: undefined })
          return design
        } catch (e) {
          if (g !== gen) return undefined
          set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
          return undefined
        }
      },

      save: async (work, keep) => {
        const { base } = get()
        if (!base || get().status !== 'ready') return { ok: false, error: 'The server’s design hasn’t loaded yet.' }
        if (get().saving) return { ok: false, error: 'A save is already under way.' }
        set({ saving: true })
        try {
          let from = base
          let revision = get().revision
          let sending = work
          // Each round is one newer design from someone else; a few in a row is already unusual.
          for (let round = 0; round < 5; round++) {
            try {
              const stored = await saveDesign(revision, sending, opts())
              const design = asDesign(stored)
              adopt(design, stored.revision)
              return { ok: true, design, revision: stored.revision }
            } catch (e) {
              if (!(e instanceof DesignConflictError)) throw e
              const theirs = await fetchDesign()
              const carried = carryOver(from, sending, theirs.design, keep ?? 'mine')
              if (carried.conflicts.length && !keep) return { ok: false, conflicts: carried.conflicts, theirs: theirs.design }
              // What the server holds is the base now, whether or not this save goes on to succeed.
              adopt(theirs.design, theirs.revision)
              from = theirs.design
              revision = theirs.revision
              sending = carried.design
            }
          }
          return { ok: false, error: 'The design keeps changing on the server. Try saving again in a moment.' }
        } catch (e) {
          return { ok: false, error: words(e) }
        } finally {
          set({ saving: false })
        }
      },

      catchUp: async (work) => {
        const { base } = get()
        if (!base || get().status !== 'ready' || get().saving) return undefined
        try {
          const theirs = await fetchDesign()
          if (theirs.revision <= get().revision) return set({ behind: undefined }), undefined
          const carried = carryOver(base, work, theirs.design)
          // Changed on both sides: leave it for the save, which asks whose to keep.
          if (carried.conflicts.length) return { design: work, conflicts: carried.conflicts }
          adopt(theirs.design, theirs.revision)
          return carried
        } catch {
          return undefined
        }
      },

      heard: (revision) => {
        if (revision > get().revision) set({ behind: revision })
      },

      publish: async (appId, workflowId, o) => {
        try {
          const published = await publishWorkflowDraft(appId, workflowId, { revision: get().revision, ...o }, opts())
          const { design, revision } = await fetchDesign()
          adopt(design, revision)
          return { ok: true, published, design }
        } catch (e) {
          return { ok: false, error: e instanceof DesignConflictError ? 'Someone else changed the design just now. Save again, then publish.' : words(e) }
        }
      },

      items: async (appId, workflowId) => {
        const r = await getVersionItems(appId, workflowId, opts())
        return workspaceState(appId, r.clock, r.items)
      },

      migrate: async (appId, workflowId, o) => {
        try {
          return { ok: true, value: await migrateWorkflowItems(appId, workflowId, o, opts()) }
        } catch (e) {
          return { ok: false, error: words(e) }
        }
      },

      forecast: (appId, workflowId, o) => forecastWorkflow(appId, workflowId, o, opts()),

      reset: () => {
        gen++
        set({ status: 'idle', error: undefined, base: undefined, revision: 0, saving: false, behind: undefined })
      },
    }
  })
}

/** The Studio's one server design. */
export const designStore = createDesignStore()
