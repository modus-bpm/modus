// Designing on a server. In Live the Studio's designer pages edit a working copy of the server's
// design (held in the design store, like the browser's own design in Simulation), and Save sends
// it back. This file moves the design store between the two, and is the one place that saves.

import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { SimState } from '@modus-bpm/core'
import type { Design, Id } from '@modus-bpm/core/model/types'
import { designStore, type DesignState } from '../../server/design'
import { liveStore } from '../../server/live'
import { carryOver, changedParts, describeParts, type Part } from '../../server/rebase'
import { useLive } from '../../server/useLive'
import { useDesign } from '../../store/design'
import { useSim, useSimState } from '../../store/sim'
import { useUi } from '../../store/ui'
import { isLive } from '../monitor/source'

export function useServerDesign<T>(selector: (s: DesignState) => T): T {
  return useStore(designStore, selector)
}

/** The designer pages are editing the server's design, not this browser's own. */
export function designingOnServer(): boolean {
  return isLive(liveStore.getState()) && useDesign.getState().source === 'server'
}

/** The simulation belongs to one design: a different one starts it over. */
function freshSimulation() {
  useSim.getState().pause()
  useSim.setState({ sims: {}, views: {}, flights: [] })
}

/** Unsaved changes to the server's design, kept while the Studio shows Simulation, to pick up again. */
let parked: { base: Design; work: Design } | undefined

/** The parts of the server's design changed here and not yet saved. */
export function unsavedParts(): Part[] {
  const { base } = designStore.getState()
  const d = useDesign.getState()
  return base && d.source === 'server' ? changedParts(base, d.design) : []
}

async function enter() {
  const design = await designStore.getState().load(liveStore.getState().actingAdmin)
  if (!design || !isLive(liveStore.getState())) return
  let work = design
  if (parked) {
    // What was being changed before the switch to Simulation, on top of what the server holds now.
    const carried = carryOver(parked.base, parked.work, design, 'theirs')
    work = carried.design
    if (carried.conflicts.length) useUi.getState().toast(`Someone else changed ${describeParts(carried.conflicts)} meanwhile, so your unsaved changes there were dropped.`, 'warn')
    parked = undefined
  }
  freshSimulation()
  useDesign.getState().enterServer(work)
  const ui = useUi.getState()
  if (!design.apps.some((a) => a.id === ui.appId) && design.apps[0]) ui.setApp(design.apps[0].id)
}

function leave() {
  const { base } = designStore.getState()
  const d = useDesign.getState()
  if (d.source !== 'server') return
  parked = base && changedParts(base, d.design).length ? { base, work: d.design } : undefined
  freshSimulation()
  d.leaveServer()
  designStore.getState().reset()
  const ui = useUi.getState()
  const own = useDesign.getState().design
  if (!own.apps.some((a) => a.id === ui.appId) && own.apps[0]) ui.setApp(own.apps[0].id)
}

/**
 * Save the working copy to the server. A workflow's map is saved as its draft; the rest of the
 * design takes effect at once. Says what happened; true when it is stored.
 */
export async function saveToServer(quiet = false): Promise<boolean> {
  const ui = useUi.getState()
  const store = designStore.getState()
  if (!designingOnServer() || store.status !== 'ready') return false
  const changed = unsavedParts()
  if (!changed.length) return true
  const sent = useDesign.getState().design
  let r = await store.save(sent)
  if (!r.ok && 'conflicts' in r) {
    const mine = window.confirm(
      `Someone else also changed ${describeParts(r.conflicts)} since you loaded the design.\n\nOK: keep your version of ${r.conflicts.length === 1 ? 'it' : 'them'} and save.\nCancel: take theirs (your other changes are still saved).`,
    )
    r = await store.save(sent, mine ? 'mine' : 'theirs')
  }
  if (!r.ok) {
    ui.toast('error' in r ? r.error : 'The design wasn’t saved.', 'warn')
    return false
  }
  // Edits made while the save was on its way stay on top of what was stored.
  const now = useDesign.getState().design
  useDesign.getState().setServerDesign(now === sent ? r.design : carryOver(sent, now, r.design).design)
  if (!quiet) {
    const drafts = changed.filter((p) => p.kind === 'workflow').length
    const rest = changed.length - drafts
    ui.toast(
      `Saved ${describeParts(changed)}.${drafts ? ` ${drafts === 1 ? 'The workflow is' : 'The workflows are'} saved as ${drafts === 1 ? 'a draft' : 'drafts'}: publish to make ${drafts === 1 ? 'it' : 'them'} live.` : ''}${rest ? ' The rest is live now.' : ''}`,
      'success',
    )
  }
  return true
}

/** Drop the unsaved changes and show the design as the server holds it. */
export async function discardUnsaved() {
  const design = await designStore.getState().load(designStore.getState().actor)
  if (design) useDesign.getState().setServerDesign(design)
}

/** The server said its design changed (or the page came back into view): take it in, keeping what is unsaved here. */
async function catchUp() {
  if (!designingOnServer()) return
  const carried = await designStore.getState().catchUp(useDesign.getState().design)
  if (carried && !carried.conflicts.length && designingOnServer()) useDesign.getState().setServerDesign(carried.design)
}

/** Mount once: keeps the design store on the right design, and the page from closing over unsaved changes. */
export function useServerDesignMode() {
  const live = useLive(isLive)
  const actor = useLive((s) => s.actingAdmin)
  useEffect(() => {
    if (!live) return
    void enter()
    return leave
  }, [live])

  // The Monitor's "acting as" is the designer's too: a different person, a fresh load.
  useEffect(() => {
    if (live && actor && designStore.getState().actor && actor !== designStore.getState().actor && !unsavedParts().length) void discardUnsaved()
  }, [live, actor])

  const behind = useServerDesign((s) => s.behind)
  useEffect(() => {
    if (behind !== undefined) void catchUp()
  }, [behind])

  useEffect(() => {
    if (!live) return
    const onShow = () => !document.hidden && void catchUp()
    const onLeave = (e: BeforeUnloadEvent) => {
      if (unsavedParts().length) e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || !(e.metaKey || e.ctrlKey) || e.altKey) return
      e.preventDefault()
      void saveToServer()
    }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('beforeunload', onLeave)
      window.removeEventListener('keydown', onKey)
    }
  }, [live])
}

/** How many parts of the server's design are changed here and not saved; 0 outside Live. */
export function useUnsavedCount(): number {
  const base = useServerDesign((s) => s.base)
  const source = useDesign((s) => s.source)
  const design = useDesign((s) => s.design)
  return useMemo(() => (base && source === 'server' ? changedParts(base, design).length : 0), [base, source, design])
}

// ---------- The version panels' items ----------

/** Bumped when items may have moved between versions, so the panels count again. */
const versionTick = createStore<{ n: number }>()(() => ({ n: 0 }))
export const versionsChanged = () => versionTick.setState((s) => ({ n: s.n + 1 }))

const itemsCache = createStore<{ key?: string; sim?: SimState }>()(() => ({}))

/**
 * The state the version panels count over (who runs which version, who is at a removed step):
 * the simulation, or in Live the server's items in flight for this workflow.
 */
export function useVersionSim(appId: Id, workflowId: Id): SimState | undefined {
  const live = useLive(isLive)
  const onServer = useDesign((s) => s.source === 'server')
  const local = useSimState()
  const tick = useStore(versionTick, (s) => s.n)
  const revision = useServerDesign((s) => s.revision)
  const ready = useServerDesign((s) => s.status === 'ready')
  const key = `${appId}/${workflowId}`
  const held = useStore(itemsCache, (s) => (s.key === key ? s.sim : undefined))
  useEffect(() => {
    if (!live || !onServer || !ready) return
    let dropped = false
    designStore
      .getState()
      .items(appId, workflowId)
      .then((sim) => !dropped && itemsCache.setState({ key, sim }))
      // A workflow not saved to the server yet has no items there.
      .catch(() => !dropped && itemsCache.setState({ key, sim: undefined }))
    return () => {
      dropped = true
    }
  }, [live, onServer, ready, appId, workflowId, key, tick, revision])
  return live && onServer ? held : local
}
