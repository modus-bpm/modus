import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { memoryStorage } from './adapters/memory'
import { type AuthSettings, hashToken, localPath, personFor, withAdministrator } from './auth'
import { ConfigError, describeConfig, loadConfig } from './config'
import { buildServer } from './http'
import { Runtime } from './runtime'

// How the server learns who is calling: the header (none), a shared password, or OIDC sign-in,
// and machine tokens in each.

const SECRET = 'a-session-secret-of-at-least-32-characters'
const settings = (auth: AuthSettings['auth'], more: Partial<AuthSettings> = {}): AuthSettings => ({ auth, sessionSecret: SECRET, sessionHours: 12, tokens: new Map(), ...more })

async function serverWith(auth: AuthSettings) {
  process.env.NODE_ENV = 'test'
  const rt = await Runtime.create({ storage: memoryStorage() })
  return { rt, api: buildServer(rt, { auth }) }
}

/** The `name=value` of a cookie the server set, to send back. */
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const set = res.headers['set-cookie']
  const all = Array.isArray(set) ? (set as string[]) : set ? [String(set)] : []
  return all.find((c) => c.startsWith(`${name}=`))?.split(';')[0]
}

describe('MODUS_AUTH=none', () => {
  let rt: Runtime
  let api: FastifyInstance
  beforeAll(async () => ({ rt, api } = await serverWith(settings({ mode: 'none' }, { tokens: new Map([[hashToken('a-machine-token-of-24-chars!'), 'u_worker']]) }))))
  afterAll(async () => {
    await api.close()
    await rt.stop()
  })

  it('takes the caller at their word, and asks for a name', async () => {
    expect((await api.inject({ url: '/api/design' })).statusCode).toBe(401)
    expect((await api.inject({ url: '/api/design', headers: { 'x-user-id': rt.design.users[0]!.id } })).statusCode).toBe(200)
    expect((await api.inject({ url: '/api/session' })).json()).toEqual({ auth: 'none', signedIn: true, choose: true })
  })

  it('lets a machine in by its token, as the person the token names, and refuses an unknown one', async () => {
    const admin = rt.design.users.find((u) => u.roles?.includes('admin'))!
    const withToken = buildServer(rt, { auth: settings({ mode: 'none' }, { tokens: new Map([[hashToken('a-machine-token-of-24-chars!'), admin.id]]) }) })
    // The token says who: the header doesn't override it.
    const ok = await withToken.inject({ url: '/api/admin/outbox', headers: { authorization: 'Bearer a-machine-token-of-24-chars!', 'x-user-id': 'someone-else' } })
    expect(ok.statusCode).toBe(200)
    const bad = await withToken.inject({ url: '/api/design', headers: { authorization: 'Bearer not-a-token-this-server-has', 'x-user-id': admin.id } })
    expect(bad.statusCode).toBe(401)
    await withToken.close()
  })
})

describe('MODUS_AUTH=password', () => {
  let rt: Runtime
  let api: FastifyInstance
  const PASSWORD = 'kick-the-tires'
  beforeAll(async () => ({ rt, api } = await serverWith(settings({ mode: 'password', password: PASSWORD }))))
  afterAll(async () => {
    await api.close()
    await rt.stop()
  })
  const signIn = async (from = api) => cookieFrom(await from.inject({ method: 'POST', url: '/api/session', payload: { password: PASSWORD } }), 'modus_session')!

  it('keeps everything but the probes and the session behind the password', async () => {
    const user = rt.design.users[0]!.id
    // The same route written other ways is the same route.
    for (const url of ['/api', '/api/apps', '/api/design', '/api/apps/app_invoice/overview', '/api/no-such-route', '/%61pi/design', '/api/%64esign', '/api/design/', '/api/session/../design', '/api/auth/../design']) {
      const res = await api.inject({ url, headers: { 'x-user-id': user } })
      // Refused, or no route at all: never the design.
      expect([url, [401, 404].includes(res.statusCode)]).toEqual([url, true])
      expect(res.body).not.toContain('"users"')
    }
    expect((await api.inject({ url: '/api/health' })).statusCode).toBe(200)
    expect((await api.inject({ url: '/api/session' })).json()).toEqual({ auth: 'password', signedIn: false, choose: true })
  })

  it('lets a browser in with the password, and people then choose who to work as', async () => {
    const res = await api.inject({ method: 'POST', url: '/api/session', payload: { password: PASSWORD } })
    expect(res.statusCode).toBe(200)
    const set = String(res.headers['set-cookie'])
    expect(set).toMatch(/^modus_session=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/)
    const cookie = set.split(';')[0]!
    expect((await api.inject({ url: '/api/session', headers: { cookie } })).json()).toMatchObject({ signedIn: true, choose: true })
    // In, but nobody yet: the header still says who.
    expect((await api.inject({ url: '/api/design', headers: { cookie } })).statusCode).toBe(401)
    expect((await api.inject({ url: '/api/design', headers: { cookie, 'x-user-id': rt.design.users[0]!.id } })).statusCode).toBe(200)
  })

  it('marks the cookie Secure behind https', async () => {
    const res = await api.inject({ method: 'POST', url: '/api/session', payload: { password: PASSWORD }, headers: { 'x-forwarded-proto': 'https' } })
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure$/)
  })

  it('refuses a wrong password, a forged cookie, an expired one, and one from another server', async () => {
    expect((await api.inject({ method: 'POST', url: '/api/session', payload: { password: 'guess' } })).statusCode).toBe(401)
    const cookie = await signIn()
    const user = { 'x-user-id': rt.design.users[0]!.id }
    const [body, mac] = cookie.slice('modus_session='.length).split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ k: 'session', m: 'password', exp: Date.now() + 1e9 })).toString('base64url')
    expect((await api.inject({ url: '/api/design', headers: { ...user, cookie: `modus_session=${forged}.${mac}` } })).statusCode).toBe(401)
    expect((await api.inject({ url: '/api/design', headers: { ...user, cookie: `modus_session=${body}.` } })).statusCode).toBe(401)

    const short = buildServer(rt, { auth: settings({ mode: 'password', password: PASSWORD }, { sessionHours: 1e-9 }) })
    const expired = await signIn(short)
    await new Promise((r) => setTimeout(r, 20))
    expect((await short.inject({ url: '/api/design', headers: { ...user, cookie: expired } })).statusCode).toBe(401)
    await short.close()

    const other = buildServer(rt, { auth: settings({ mode: 'password', password: PASSWORD }, { sessionSecret: 'another-servers-secret-of-32-characters!' }) })
    expect((await other.inject({ url: '/api/design', headers: { ...user, cookie } })).statusCode).toBe(401)
    await other.close()
  })

  it('refuses a change another site makes the browser send', async () => {
    const cookie = await signIn()
    const admin = rt.design.users.find((u) => u.roles?.includes('admin'))!.id
    const res = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/my/next', headers: { cookie, 'x-user-id': admin, 'sec-fetch-site': 'cross-site' }, payload: {} })
    expect(res.statusCode).toBe(403)
    const own = await api.inject({ method: 'POST', url: '/api/apps/app_invoice/my/next', headers: { cookie, 'x-user-id': admin, 'sec-fetch-site': 'same-origin' }, payload: {} })
    expect(own.statusCode).not.toBe(403)
  })

  it('signs out', async () => {
    const cookie = await signIn()
    const out = await api.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
    expect(String(out.headers['set-cookie'])).toMatch(/^modus_session=; .*Max-Age=0/)
  })

  it('slows down guessing', async () => {
    const guarded = buildServer(rt, { auth: settings({ mode: 'password', password: PASSWORD }) })
    const tries = []
    for (let i = 0; i < 7; i++) tries.push((await guarded.inject({ method: 'POST', url: '/api/session', payload: { password: `guess-${i}` } })).statusCode)
    expect(tries).toEqual([401, 401, 401, 401, 401, 429, 429])
    // Even the right one waits.
    expect((await guarded.inject({ method: 'POST', url: '/api/session', payload: { password: PASSWORD } })).statusCode).toBe(429)
    await guarded.close()
  })
})

// ---------- A small identity provider ----------

interface Grant {
  claims: Record<string, unknown>
  nonce: string
  challenge: string
}

async function identityProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const grants = new Map<string, Grant>()
  let issuer = ''
  let userinfo: Record<string, unknown> = {}
  const http: Server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const url = new URL(req.url!, issuer)
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      })
    if (url.pathname === '/jwks') return json({ keys: [jwk] })
    if (url.pathname === '/userinfo') return json(userinfo)
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        const form = new URLSearchParams(body)
        const grant = grants.get(form.get('code') ?? '')
        grants.delete(form.get('code') ?? '')
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!grant || grant.challenge !== challenge) return json({ error: 'invalid_grant' }, 400)
        const id_token = await new SignJWT({ ...grant.claims, nonce: grant.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('modus').setIssuedAt().setExpirationTime('5m').sign(privateKey)
        json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token })
      })
      return
    }
    json({ error: 'not_found' }, 404)
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  issuer = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  return {
    issuer,
    /** The person signs in at the provider: the code it would send the browser back with. */
    approve(authorizeUrl: string, claims: Record<string, unknown>, more: Record<string, unknown> = {}) {
      const q = new URL(authorizeUrl).searchParams
      const code = `code-${grants.size}-${Math.random().toString(36).slice(2)}`
      grants.set(code, { claims, nonce: q.get('nonce')!, challenge: q.get('code_challenge')! })
      userinfo = { sub: claims.sub, ...more }
      return { code, state: q.get('state')!, redirect: q.get('redirect_uri')! }
    },
    close: () => new Promise((r) => http.close(r)),
  }
}

describe('MODUS_AUTH=oidc', () => {
  let rt: Runtime
  let api: FastifyInstance
  let idp: Awaited<ReturnType<typeof identityProvider>>
  beforeAll(async () => {
    idp = await identityProvider()
    ;({ rt, api } = await serverWith(
      settings(
        { mode: 'oidc', issuer: idp.issuer, clientId: 'modus', clientSecret: 'client-secret', claim: 'email', scopes: 'openid email profile', admins: ['Boss@Example.org'], allowHttp: true, trustEmail: false },
        { publicUrl: 'https://modus.example.org' },
      ),
    ))
  })
  afterAll(async () => {
    await api.close()
    await rt.stop()
    await idp.close()
  })

  /** Start a sign-in, approve it at the provider as `claims`, and come back. */
  async function signIn(claims: Record<string, unknown>, opts: { back?: string; userinfo?: Record<string, unknown> } = {}) {
    const start = await api.inject({ url: `/api/auth/login${opts.back ? `?return=${encodeURIComponent(opts.back)}` : ''}` })
    expect(start.statusCode).toBe(302)
    const flow = cookieFrom(start, 'modus_oidc')!
    const { code, state, redirect } = idp.approve(String(start.headers.location), { sub: 'sub-1', ...claims }, opts.userinfo)
    expect(redirect).toBe('https://modus.example.org/api/auth/callback')
    const back = await api.inject({ url: `/api/auth/callback?code=${code}&state=${state}`, headers: { cookie: flow } })
    return { back, cookie: cookieFrom(back, 'modus_session'), flow, start }
  }

  it('sends an unsigned browser to sign in, with a code challenge, state and nonce', async () => {
    expect((await api.inject({ url: '/api/design', headers: { 'x-user-id': rt.design.users[0]!.id } })).statusCode).toBe(401)
    expect((await api.inject({ url: '/api/session' })).json()).toEqual({ auth: 'oidc', signedIn: false, choose: false, signIn: '/api/auth/login' })
    const start = await api.inject({ url: '/api/auth/login' })
    const to = new URL(String(start.headers.location))
    expect(to.origin + to.pathname).toBe(`${idp.issuer}/authorize`)
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: 'modus', response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256', redirect_uri: 'https://modus.example.org/api/auth/callback' })
    for (const k of ['state', 'nonce', 'code_challenge']) expect(to.searchParams.get(k)).toMatch(/^[\w-]{20,}$/)
    expect(String(start.headers['set-cookie'])).toMatch(/^modus_oidc=.*Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/)
  })

  it('signs in a person by their sign-in name, and from then on the server says who they are', async () => {
    const someone = rt.design.users.find((u) => !u.roles?.includes('admin'))!
    await rt.changeDesign(undefined, (d) => ({ ...d, users: d.users.map((u) => (u.id === someone.id ? { ...u, login: 'pat@example.org' } : u)) }))
    const { back, cookie } = await signIn({ email: 'Pat@Example.org', email_verified: true }, { back: '/#/workspace' })
    expect(back.statusCode).toBe(302)
    expect(back.headers.location).toBe('/#/workspace')
    expect((await api.inject({ url: '/api/session', headers: { cookie: cookie! } })).json()).toEqual({ auth: 'oidc', signedIn: true, choose: false, signIn: '/api/auth/login', user: { id: someone.id, name: someone.name } })

    // The header no longer decides: claiming to be the administrator changes nothing.
    const admin = rt.design.users.find((u) => u.roles?.includes('admin'))!
    const res = await api.inject({ url: '/api/admin/outbox', headers: { cookie: cookie!, 'x-user-id': admin.id } })
    expect(res.statusCode).toBe(403)
    expect((await api.inject({ url: '/api/design', headers: { cookie: cookie! } })).statusCode).toBe(200)
  })

  it('makes someone named in MODUS_OIDC_ADMINS an administrator at their first sign-in, once', async () => {
    const before = rt.design.users.length
    const first = await signIn({ email: 'boss@example.org', email_verified: true, name: 'The Boss' })
    expect(first.back.statusCode).toBe(302)
    const boss = rt.design.users.find((u) => u.login === 'boss@example.org')!
    expect(boss).toMatchObject({ id: 'u_boss_example_org', name: 'The Boss', roles: ['admin'], available: true })
    expect((await api.inject({ url: '/api/admin/outbox', headers: { cookie: first.cookie! } })).statusCode).toBe(200)
    await signIn({ email: 'boss@example.org', email_verified: true })
    expect(rt.design.users).toHaveLength(before + 1)
  })

  it('reads the claim from the userinfo endpoint when the ID token leaves it out', async () => {
    const { back } = await signIn({}, { userinfo: { email: 'boss@example.org', email_verified: true } })
    expect(back.statusCode).toBe(302)
  })

  it('turns away someone the design doesn’t know, and an unverified address', async () => {
    const stranger = await signIn({ email: 'stranger@example.org', email_verified: true })
    expect(stranger.back.statusCode).toBe(403)
    expect(stranger.back.body).toContain('You signed in as stranger@example.org')
    expect(stranger.cookie).toBeUndefined()
    // Not verified, or not said to be: the address could be anyone's.
    for (const claims of [{ email: 'boss@example.org', email_verified: false }, { email: 'boss@example.org' }]) {
      const unverified = await signIn(claims)
      expect(unverified.back.statusCode).toBe(403)
      expect(unverified.back.body).toContain('hasn’t verified your e-mail address')
      expect(unverified.cookie).toBeUndefined()
    }
    // A person's id is not a sign-in name.
    const byId = await signIn({ email: rt.design.users[0]!.id, email_verified: true })
    expect(byId.back.statusCode).toBe(403)
  })

  it('refuses an answer for another sign-in: wrong state, a used code, no flow cookie', async () => {
    const start = await api.inject({ url: '/api/auth/login' })
    const flow = cookieFrom(start, 'modus_oidc')!
    const { code, state } = idp.approve(String(start.headers.location), { sub: 's', email: 'boss@example.org', email_verified: true })
    expect((await api.inject({ url: `/api/auth/callback?code=${code}&state=someone-elses`, headers: { cookie: flow } })).statusCode).toBe(400)
    expect((await api.inject({ url: `/api/auth/callback?code=${code}&state=${state}` })).statusCode).toBe(400)
    expect((await api.inject({ url: `/api/auth/callback?code=${code}&state=${state}`, headers: { cookie: flow } })).statusCode).toBe(302)
    expect((await api.inject({ url: `/api/auth/callback?code=${code}&state=${state}`, headers: { cookie: flow } })).statusCode).toBe(400)
  })

  it('ends the sign-in of someone removed from the design', async () => {
    const { cookie } = await signIn({ email: 'boss@example.org', email_verified: true })
    expect((await api.inject({ url: '/api/design', headers: { cookie: cookie! } })).statusCode).toBe(200)
    await rt.changeDesign(undefined, (d) => ({ ...d, users: d.users.filter((u) => u.login !== 'boss@example.org') }))
    expect((await api.inject({ url: '/api/design', headers: { cookie: cookie! } })).statusCode).toBe(401)
  })

  it('goes back only to a path on this server', () => {
    expect(localPath('/#/studio')).toBe('/#/studio')
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', undefined]) expect(localPath(bad)).toBe('/')
  })

  it('says so when the identity provider can’t be reached', async () => {
    const down = buildServer(rt, { auth: settings({ mode: 'oidc', issuer: 'http://127.0.0.1:9', clientId: 'modus', claim: 'email', scopes: 'openid', admins: [], allowHttp: true, trustEmail: false }, { publicUrl: 'https://modus.example.org' }) })
    const res = await down.inject({ url: '/api/auth/login' })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('couldn’t reach the identity provider')
    await down.close()
  })
})

describe('people and sign-in names', () => {
  const users = [
    { id: 'u_ada', name: 'Ada', title: '', color: '', speed: 1, available: true, login: 'Ada@Example.org' },
    { id: 'ada@example.org', name: 'Impostor', title: '', color: '', speed: 1, available: true },
    { id: 'u_bo', name: 'Bo', title: '', color: '', speed: 1, available: true },
  ]
  it('finds a person by sign-in name, whatever the case, and never by id', () => {
    expect(personFor(users, ' ada@example.org')?.id).toBe('u_ada')
    expect(personFor(users, 'u_bo')).toBeUndefined()
    expect(personFor(users, 'nobody')).toBeUndefined()
    expect(personFor([{ ...users[2]!, login: '' }], '')).toBeUndefined()
  })
  it('adds an administrator with an id nobody has', () => {
    const d = { apps: [], users: [...users, { ...users[2]!, id: 'u_bo_example_org' }], groups: [], services: [], templates: [] }
    expect(withAdministrator(d, 'bo@example.org', undefined).user).toMatchObject({ id: 'u_bo_example_org_2', name: 'bo@example.org', login: 'bo@example.org', roles: ['admin'] })
  })
})

describe('sign-in configuration', () => {
  it('defaults to none, and warns when that is reachable from elsewhere', () => {
    expect(loadConfig({}).config.auth.auth).toEqual({ mode: 'none' })
    expect(loadConfig({ HOST: '0.0.0.0' }).warnings.join(' ')).toMatch(/MODUS_AUTH=none: anyone who can reach this server/)
  })

  it('needs a password for password, and warns about a missing session secret', () => {
    expect(() => loadConfig({ MODUS_AUTH: 'password' })).toThrow(/MODUS_AUTH_PASSWORD is required/)
    expect(() => loadConfig({ MODUS_AUTH: 'password', MODUS_AUTH_PASSWORD: 'short' })).toThrow(ConfigError)
    const { config, warnings } = loadConfig({ MODUS_AUTH: 'password', MODUS_AUTH_PASSWORD: 'kick-the-tires', HOST: '0.0.0.0' })
    expect(config.auth.auth).toEqual({ mode: 'password', password: 'kick-the-tires' })
    expect(config.auth.sessionSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(warnings).toEqual([expect.stringMatching(/MODUS_SESSION_SECRET is not set/)])
    expect(loadConfig({ MODUS_AUTH: 'password', MODUS_AUTH_PASSWORD: 'kick-the-tires', MODUS_SESSION_SECRET: SECRET }).warnings).toEqual([])
  })

  it('needs an issuer, a client and a public address for oidc, over https unless allowed', () => {
    expect(() => loadConfig({ MODUS_AUTH: 'oidc' })).toThrow(/MODUS_OIDC_ISSUER, MODUS_OIDC_CLIENT_ID, MODUS_PUBLIC_URL are required/)
    const base = { MODUS_AUTH: 'oidc', MODUS_OIDC_CLIENT_ID: 'modus', MODUS_PUBLIC_URL: 'https://modus.example.org/', MODUS_SESSION_SECRET: SECRET, MODUS_OIDC_ADMINS: 'a@example.org, b@example.org' }
    expect(() => loadConfig({ ...base, MODUS_OIDC_ISSUER: 'http://keycloak:8080/realms/modus' })).toThrow(/must start with https/)
    const { config, warnings } = loadConfig({ ...base, MODUS_OIDC_ISSUER: 'http://keycloak:8080/realms/modus', MODUS_OIDC_ALLOW_HTTP: 'true' })
    expect(config.auth).toMatchObject({ publicUrl: 'https://modus.example.org', auth: { mode: 'oidc', claim: 'email', admins: ['a@example.org', 'b@example.org'], allowHttp: true } })
    expect(warnings).toEqual([])
    expect(describeConfig(config)).toMatch(/^sign-in oidc → keycloak:8080 \(by email\);/)
  })

  it('reads machine tokens without ever quoting one', () => {
    const { config } = loadConfig({ MODUS_API_TOKENS: 'u_worker:a-machine-token-of-24-chars!, u_other:another:token-with-a-colon-in-it' })
    expect(config.auth.tokens.get(hashToken('a-machine-token-of-24-chars!'))).toBe('u_worker')
    expect(config.auth.tokens.get(hashToken('another:token-with-a-colon-in-it'))).toBe('u_other')
    expect(describeConfig(config)).toMatch(/^sign-in none, 2 machine tokens;/)
    let message = ''
    try {
      loadConfig({ MODUS_API_TOKENS: 'u_worker:too-short-secret' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/entry 1 should be personId:token/)
    expect(message).not.toContain('too-short-secret')
  })
})
