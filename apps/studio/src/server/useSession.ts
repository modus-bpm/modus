import { useStore } from 'zustand'
import { sessionStore, type SessionState } from './session'

/** The session in React. Select single fields: a new object each time loops. */
export function useSession<T>(selector: (s: SessionState) => T): T {
  return useStore(sessionStore, selector)
}
