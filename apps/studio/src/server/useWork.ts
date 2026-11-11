import { useStore } from 'zustand'
import { workStore, type WorkState } from './work'

/** The live Workspace's store, for React. */
export function useWork<T>(selector: (s: WorkState) => T): T {
  return useStore(workStore, selector)
}
