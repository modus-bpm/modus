// How this server signs people in (its MODUS_AUTH), and whether this browser is signed in.
//
//   none      nobody signs in; the Studio says who it acts as (`x-user-id`)
//   password  one shared password lets the browser in; the Studio still says who it acts as
//   oidc      people sign in with the identity provider, and the server says who they are
//
// A vanilla zustand store (no React) so tests drive it directly.

import { createStore } from 'zustand/vanilla'
import type { Id } from '@modus-bpm/core'
import { type Fetch, getSession, onUnauthorized, passwordSignIn, type ServerSession, signOut } from './client'

export interface SessionState extends Omit<ServerSession, 'signIn'> {
  /** Where to send the browser to sign in (oidc). */
  signInUrl?: string
  /** The server has been asked. Before that (and off a server) the rest reads as `none`. */
  loaded: boolean
  /** Ask the server. Never throws: a server that can't say counts as `none`, as before sign-in existed. */
  load: () => Promise<ServerSession>
  /** Sign in with the shared password. Returns what went wrong, or nothing when in. */
  signIn: (password: string) => Promise<string | undefined>
  signOut: () => Promise<void>
}

const OPEN = { auth: 'none', signedIn: true, choose: true } as const satisfies ServerSession

export function createSessionStore(deps: { fetch?: Fetch } = {}) {
  const f = deps.fetch ?? ((input, init) => fetch(input, init))
  return createStore<SessionState>()((set, get) => ({
    ...OPEN,
    loaded: false,
    load: async () => {
      let s: ServerSession = OPEN
      try {
        s = await getSession(f)
      } catch {}
      set({ auth: s.auth, signedIn: s.signedIn, choose: s.choose, user: s.user, signInUrl: s.signIn, loaded: true })
      return s
    },
    signIn: async (password) => {
      const error = await passwordSignIn(password, f)
      if (!error) await get().load()
      return error
    },
    signOut: async () => {
      await signOut(f)
      await get().load()
    },
  }))
}

/** The Studio's one session. */
export const sessionStore = createSessionStore()

// A request the server answered 401: the sign-in may have run out. Ask again, once at a time.
let asking: Promise<unknown> | undefined
onUnauthorized(() => {
  const s = sessionStore.getState()
  if (!s.loaded || s.auth === 'none' || !s.signedIn) return
  asking ??= s.load().finally(() => (asking = undefined))
})

/** The person the server says this browser is (oidc). Undefined where the Studio chooses who to act as. */
export function signedInAs(): Id | undefined {
  const s = sessionStore.getState()
  return s.loaded && !s.choose ? s.user?.id : undefined
}
