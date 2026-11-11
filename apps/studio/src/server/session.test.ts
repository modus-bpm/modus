import { describe, expect, it } from 'vitest'
import type { Fetch } from './client'
import { createLiveStore } from './live'
import { createSessionStore } from './session'

// What the Studio knows about signing in to its server.

type Call = { url: string; method: string; body?: unknown }

function server(mode: 'none' | 'password' | 'oidc' | 'old', password = 'kick-the-tires') {
  const calls: Call[] = []
  let signedIn = false
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch: Fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (url === '/api/health') return json({ ok: true, apps: 1 })
    if (url !== '/api/session' || mode === 'old') return json({ ok: false, error: 'No route' }, 404)
    if (method === 'DELETE') return (signedIn = false), json({ ok: true })
    if (method === 'POST') {
      if ((body as { password?: string }).password !== password) return json({ ok: false, error: 'That isn’t the password.' }, 401)
      return (signedIn = true), json({ ok: true })
    }
    if (mode === 'none') return json({ auth: 'none', signedIn: true, choose: true })
    if (mode === 'password') return json({ auth: 'password', signedIn, choose: true })
    return json({ auth: 'oidc', signedIn: true, choose: false, signIn: '/api/auth/login', user: { id: 'u_pat', name: 'Pat' } })
  }
  return { fetch, calls }
}

describe('the Studio’s session', () => {
  it('reads as open before the server is asked, on a server that signs nobody in, and on one from before sign-in', async () => {
    for (const mode of ['none', 'old'] as const) {
      const store = createSessionStore({ fetch: server(mode).fetch })
      expect(store.getState()).toMatchObject({ loaded: false, auth: 'none', signedIn: true, choose: true })
      await store.getState().load()
      expect(store.getState()).toMatchObject({ loaded: true, auth: 'none', signedIn: true, choose: true })
    }
  })

  it('counts a server that can’t be reached as open, so nothing blocks the simulation', async () => {
    const store = createSessionStore({
      fetch: async () => {
        throw new Error('offline')
      },
    })
    expect(await store.getState().load()).toEqual({ auth: 'none', signedIn: true, choose: true })
  })

  it('signs in with the shared password, says why not, and signs out', async () => {
    const { fetch, calls } = server('password')
    const store = createSessionStore({ fetch })
    await store.getState().load()
    expect(store.getState()).toMatchObject({ auth: 'password', signedIn: false, choose: true })
    expect(await store.getState().signIn('guess')).toBe('That isn’t the password.')
    expect(store.getState().signedIn).toBe(false)
    expect(await store.getState().signIn('kick-the-tires')).toBeUndefined()
    expect(store.getState().signedIn).toBe(true)
    await store.getState().signOut()
    expect(store.getState().signedIn).toBe(false)
    // The password goes in the body of one request, never in an address.
    expect(calls.filter((c) => c.url.includes('kick'))).toEqual([])
  })

  it('knows who the server says this browser is, and where to sign in', async () => {
    const store = createSessionStore({ fetch: server('oidc').fetch })
    await store.getState().load()
    expect(store.getState()).toMatchObject({ auth: 'oidc', signedIn: true, choose: false, user: { id: 'u_pat', name: 'Pat' }, signInUrl: '/api/auth/login' })
  })
})

describe('Live and signing in', () => {
  it('is off until this browser is signed in', async () => {
    const { fetch } = server('password')
    let signedIn = false
    const live = createLiveStore({ fetch, storage: null, signedIn: async () => signedIn })
    expect(await live.getState().detect()).toBe(false)
    expect(live.getState().available).toBe(false)
    signedIn = true
    expect(await live.getState().detect()).toBe(true)
  })
})
