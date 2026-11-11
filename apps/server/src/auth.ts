// Who is calling. MODUS_AUTH picks how the server finds out:
//
//   none      The caller names themselves in the `x-user-id` header. For a laptop or a closed
//             network only: anyone who can reach the server can act as anyone.
//   password  One shared password lets a browser in; inside, people still choose who to work as
//             (`x-user-id`). For demos: it keeps strangers out, it does not tell people apart.
//   oidc      People sign in with the organization's identity provider (Keycloak, Entra ID, Okta,
//             Google…). The server knows who each caller is; `x-user-id` is ignored.
//
// In every mode a machine (a worker, a script) can send `Authorization: Bearer <token>` for a token
// listed in MODUS_API_TOKENS, and acts as the person that token names.
//
// A browser's sign-in is a signed cookie (HMAC-SHA256 with MODUS_SESSION_SECRET), so any server
// sharing the secret accepts it and nothing is stored.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as oidc from 'openid-client'
import { z } from 'zod'
import type { Design, Id, User } from '@modus-bpm/core'
import type { Runtime } from './runtime'

export type AuthMode =
  | { mode: 'none' }
  | { mode: 'password'; password: string }
  | {
      mode: 'oidc'
      issuer: string
      clientId: string
      /** Unset for a public client (PKCE only). */
      clientSecret?: string
      /** The claim that names the person: matched against a person's sign-in name, then their id. */
      claim: string
      scopes: string
      /** Claim values that become administrators the first time they sign in, if the design doesn't know them. */
      admins: string[]
      /** Accept an issuer over plain http (a local Keycloak). */
      allowHttp: boolean
    }

export interface AuthSettings {
  auth: AuthMode
  /** Signs the cookies. Every server behind one address needs the same one. */
  sessionSecret: string
  sessionHours: number
  /** Where browsers reach this server, e.g. https://modus.example.org. Required for oidc (its redirect address). */
  publicUrl?: string
  /** Machine tokens: sha256(token) in hex → the person the token acts as. */
  tokens: Map<string, Id>
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Settings for a server nobody configured: today's `x-user-id`, no tokens. */
export const openAuth = (): AuthSettings => ({ auth: { mode: 'none' }, sessionSecret: randomBytes(32).toString('hex'), sessionHours: 12, tokens: new Map() })

export class Unauthorized extends Error {}

declare module 'fastify' {
  interface FastifyRequest {
    /** The person this request acts as, once known. */
    modusUser?: Id
  }
}

/** The person a request acts as; 401 when it names nobody. */
export function who(req: FastifyRequest): Id {
  if (!req.modusUser) throw new Unauthorized('Say who you are working as in the x-user-id header.')
  return req.modusUser
}

// ---------- Signed values ----------

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')

function seal(secret: string, payload: object): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

function unseal(secret: string, value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  const dot = value.indexOf('.')
  if (dot < 1) return undefined
  const body = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1), 'base64url')
  const want = createHmac('sha256', secret).update(body).digest()
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const p = payload as Record<string, unknown>
    return typeof p.exp === 'number' && p.exp > Date.now() ? p : undefined
  } catch {
    return undefined
  }
}

const sameText = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

// ---------- Cookies ----------

const SESSION = 'modus_session'
const FLOW = 'modus_oidc'

function cookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

// ---------- People ----------

const norm = (s: string) => s.trim().toLowerCase()

/** The person a claim value names: by sign-in name first, then by id. */
export function personFor(users: User[], value: string): User | undefined {
  const v = norm(value)
  return users.find((u) => u.login && norm(u.login) === v) ?? users.find((u) => norm(u.id) === v)
}

const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2']

/** The design with a new administrator who signs in as `login`. */
export function withAdministrator(design: Design, login: string, name: string | undefined): { design: Design; user: User } {
  const slug = norm(login).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'admin'
  let id = `u_${slug}`
  for (let n = 2; design.users.some((u) => u.id === id); n++) id = `u_${slug}_${n}`
  const user: User = { id, name: name?.trim() || login, title: 'Administrator', color: PALETTE[design.users.length % PALETTE.length]!, roles: ['admin'], speed: 1, available: true, login }
  return { design: { ...design, users: [...design.users, user] }, user }
}

// ---------- The plugin ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(reply: FastifyReply, status: number, title: string, text: string) {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Modus</title>` +
        `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1e293b"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">Back to Modus</a></p>`,
    )
}

/** A path on this server to go back to after signing in; anything else becomes `/`. */
export function localPath(wanted: string | undefined): string {
  if (!wanted || !wanted.startsWith('/') || wanted.startsWith('//') || wanted.includes('\\') || /[\u0000-\u001f]/.test(wanted)) return '/'
  return wanted
}

const PUBLIC = new Set(['/api/health', '/api/ready', '/api/session'])
const isPublic = (path: string) => PUBLIC.has(path) || path.startsWith('/api/auth/')

/** Wrong passwords allowed per minute: from one address, and from everywhere. */
const TRIES_EACH = 5
const TRIES_ALL = 30

export function registerAuth(app: FastifyInstance, rt: Runtime, s: AuthSettings) {
  const { auth } = s
  const secure = (req: FastifyRequest) => !!s.publicUrl?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https'
  const setCookie = (req: FastifyRequest, reply: FastifyReply, name: string, value: string, maxAgeS: number, path = '/') => {
    const set = `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure(req) ? '; Secure' : ''}`
    const had = reply.getHeader('set-cookie')
    reply.header('set-cookie', had ? [...(Array.isArray(had) ? had : [String(had)]), set] : set)
  }

  /** A valid sign-in from this request's cookie: `u` is the person in oidc mode. */
  const session = (req: FastifyRequest): { u?: Id } | undefined => {
    const p = unseal(s.sessionSecret, cookie(req, SESSION))
    if (!p || p.k !== 'session' || p.m !== auth.mode) return undefined
    if (auth.mode === 'oidc') {
      // Removed from the design since: no longer anyone here.
      if (typeof p.u !== 'string' || !rt.design.users.some((u) => u.id === p.u)) return undefined
      return { u: p.u }
    }
    return {}
  }
  const startSession = (req: FastifyRequest, reply: FastifyReply, user?: Id) => {
    const exp = Date.now() + s.sessionHours * 3_600_000
    setCookie(req, reply, SESSION, seal(s.sessionSecret, { k: 'session', m: auth.mode, u: user, exp }), Math.floor(s.sessionHours * 3600))
  }

  const headerUser = (req: FastifyRequest): Id | undefined => {
    const h = req.headers['x-user-id']
    return typeof h === 'string' && h.length > 0 ? h : undefined
  }

  app.decorateRequest('modusUser', undefined)

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!
    if (path !== '/api' && !path.startsWith('/api/')) return

    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (bearer) {
      const user = s.tokens.get(hashToken(bearer))
      if (!user) return reply.code(401).send({ ok: false, error: 'That token isn’t one this server knows.' })
      req.modusUser = user
      return
    }
    if (auth.mode === 'none') {
      req.modusUser = headerUser(req)
      return
    }
    if (isPublic(path)) return

    const signedIn = session(req)
    if (!signedIn) return reply.code(401).send({ ok: false, error: 'Sign in first.', auth: auth.mode })
    // The cookie rides along on requests other sites make the browser send; those may not change anything.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ ok: false, error: 'That request came from another site.' })
    req.modusUser = auth.mode === 'oidc' ? signedIn.u : headerUser(req)
  })

  // ----- The session, for the Studio -----

  app.get('/api/session', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    if (auth.mode === 'none') return { auth: 'none', signedIn: true, choose: true }
    const signedIn = session(req)
    if (auth.mode === 'password') return { auth: 'password', signedIn: !!signedIn, choose: true }
    const user = signedIn && rt.design.users.find((u) => u.id === signedIn.u)
    return { auth: 'oidc', signedIn: !!user, choose: false, signIn: '/api/auth/login', ...(user ? { user: { id: user.id, name: user.name } } : {}) }
  })

  const failures = new Map<string, number[]>()
  const recent = (key: string, now: number) => {
    const kept = (failures.get(key) ?? []).filter((t) => now - t < 60_000)
    if (kept.length) failures.set(key, kept)
    else failures.delete(key)
    return kept
  }

  app.post('/api/session', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    if (auth.mode !== 'password') return reply.code(404).send({ ok: false, error: 'This server doesn’t sign people in with a password.' })
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ ok: false, error: 'That request came from another site.' })
    const now = Date.now()
    if (recent(req.ip, now).length >= TRIES_EACH || recent('*', now).length >= TRIES_ALL) return reply.code(429).header('retry-after', '60').send({ ok: false, error: 'Too many wrong passwords. Wait a minute and try again.' })
    const body = z.object({ password: z.string().max(1000) }).parse(req.body)
    if (!sameText(body.password, auth.password)) {
      for (const key of [req.ip, '*']) failures.set(key, [...recent(key, now), now])
      return reply.code(401).send({ ok: false, error: 'That isn’t the password.' })
    }
    startSession(req, reply)
    return { ok: true }
  })

  app.delete('/api/session', async (req, reply) => {
    setCookie(req, reply, SESSION, '', 0)
    return { ok: true }
  })

  if (auth.mode !== 'oidc') return

  // ----- OIDC: authorization code with PKCE -----

  const redirectUri = `${s.publicUrl!.replace(/\/+$/, '')}/api/auth/callback`
  let provider: Promise<oidc.Configuration> | undefined
  /** The provider's configuration, read once; a failed read is tried again on the next sign-in. */
  const discover = () => {
    provider ??= oidc
      .discovery(new URL(auth.issuer), auth.clientId, auth.clientSecret, auth.clientSecret ? undefined : oidc.None(), auth.allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((err) => {
        provider = undefined
        throw err
      })
    return provider
  }

  app.get('/api/auth/login', async (req, reply) => {
    const q = z.object({ return: z.string().max(2000).optional() }).parse(req.query)
    let config: oidc.Configuration
    try {
      config = await discover()
    } catch (err) {
      req.log.error({ err }, 'The identity provider could not be reached')
      return page(reply, 502, 'Sign-in isn’t available', 'Modus couldn’t reach the identity provider. Try again in a moment.')
    }
    const verifier = oidc.randomPKCECodeVerifier()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: auth.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    })
    setCookie(req, reply, FLOW, seal(s.sessionSecret, { k: 'flow', state, verifier, nonce, ret: localPath(q.return), exp: Date.now() + 600_000 }), 600, '/api/auth')
    return reply.header('cache-control', 'no-store').redirect(url.href)
  })

  app.get('/api/auth/callback', async (req, reply) => {
    const flow = unseal(s.sessionSecret, cookie(req, FLOW))
    setCookie(req, reply, FLOW, '', 0, '/api/auth')
    if (!flow || flow.k !== 'flow' || typeof flow.state !== 'string' || typeof flow.verifier !== 'string' || typeof flow.nonce !== 'string')
      return page(reply, 400, 'Sign-in didn’t finish', 'The sign-in took too long or was started in another browser. Start again.')

    let claims: Record<string, unknown>
    try {
      const config = await discover()
      const tokens = await oidc.authorizationCodeGrant(config, new URL(redirectUri + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true })
      claims = { ...tokens.claims() }
      // Some providers keep the e-mail address out of the ID token and give it at the userinfo endpoint.
      if (typeof claims[auth.claim] !== 'string' && typeof claims.sub === 'string' && config.serverMetadata().userinfo_endpoint) {
        claims = { ...(await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)), ...claims }
      }
    } catch (err) {
      req.log.warn({ err }, 'A sign-in was refused')
      return page(reply, 400, 'Sign-in didn’t finish', 'The identity provider didn’t confirm who you are. Start again.')
    }

    const value = claims[auth.claim]
    if (typeof value !== 'string' || !value.trim()) return page(reply, 403, 'You can’t sign in yet', `The identity provider didn’t say what your ${auth.claim} is, and that is how Modus knows people.`)
    if (auth.claim === 'email' && claims.email_verified === false) return page(reply, 403, 'You can’t sign in yet', 'Your e-mail address isn’t verified with the identity provider.')

    let person = personFor(rt.design.users, value)
    if (!person && auth.admins.some((a) => norm(a) === norm(value))) {
      // The first sign-in of someone named in MODUS_OIDC_ADMINS: the design gets them as an administrator.
      await rt.changeDesign(undefined, (design) => {
        const known = personFor(design.users, value)
        if (known) return ((person = known), design)
        const added = withAdministrator(design, value.trim(), typeof claims.name === 'string' ? claims.name : undefined)
        person = added.user
        return added.design
      })
    }
    if (!person) return page(reply, 403, 'You aren’t a person in Modus yet', `You signed in as ${value}, and no person in Modus has that sign-in name. Ask an administrator to add it to you on the People page.`)

    startSession(req, reply, person.id)
    return reply.header('cache-control', 'no-store').redirect(localPath(typeof flow.ret === 'string' ? flow.ret : undefined))
  })
}
