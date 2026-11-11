// Configuration: every setting is an environment variable, read and checked
// once at startup. This file is the reference; docs/DEPLOYMENT.md lists the
// same variables for operators. Secrets (ANTHROPIC_API_KEY, DATABASE_URL, webhook
// secrets, the sign-in password, session secret and tokens) come only from the environment
// (or WEBHOOKS_FILE) and are never logged.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { type AuthMode, type AuthSettings, hashToken } from './auth'
import { type Endpoint, loadEndpoints } from './webhooks'

export const ROLES = ['api', 'engine', 'automation', 'scheduler', 'ingest', 'realtime'] as const
export type Role = (typeof ROLES)[number]

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const DIALECTS = ['memory', 'postgres', 'mssql', 'oracle'] as const

/** Connection-string schemes accepted for each SQL dialect. */
const URL_SCHEMES: Record<Exclude<(typeof DIALECTS)[number], 'memory'>, string[]> = {
  postgres: ['postgres:', 'postgresql:'],
  mssql: ['mssql:', 'sqlserver:'],
  oracle: ['oracle:'],
}

const env = z.object({
  /** Port the HTTP server listens on. */
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Interface to bind. 127.0.0.1 for local development; the container image sets 0.0.0.0. */
  HOST: z.string().default('127.0.0.1'),
  /** Where the in-memory store snapshots its state (design.json, state-*.json, meta-*.json, events.jsonl). Unset: nothing is written. */
  DATA_DIR: z.string().optional(),
  /** Simulated minutes per real minute for timers and due dates. 1 = real time. */
  TIME_SCALE: z.coerce.number().positive().default(1),
  /** A built studio (apps/studio/dist) to serve at `/`, with SPA fallback. Unset: API only. */
  STATIC_DIR: z.string().optional(),
  /** Turns on the language-model assistant. Unset: the built-in assistant answers. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Claude model for the assistant. */
  MODUS_ASSISTANT_MODEL: z.string().default('claude-opus-5-5'),
  /** Reasoning effort for the assistant (`off` leaves it to the model's default, for models without effort). */
  MODUS_ASSISTANT_EFFORT: z.enum([...EFFORTS, 'off']).default('medium'),
  /** Server-side refusal fallback (`default` lets the API pick a fallback model; `off` for models or platforms without it). */
  MODUS_ASSISTANT_FALLBACKS: z.enum(['default', 'off']).default('default'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Storage backend: `memory` (JSON snapshots in DATA_DIR) or `postgres` (DATABASE_URL). `mssql` and `oracle` are validated and refused. */
  DB_DIALECT: z.enum(DIALECTS).default('memory'),
  DATABASE_URL: z.string().optional(),
  /** Most connections in each process's database pool (postgres). It also keeps one more open to listen for other replicas. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).optional(),
  /** `multi` is planned (tenant id in every key); accepted with a warning, runs as one tenant. */
  TENANT_MODE: z.enum(['single', 'multi']).default('single'),
  /** Comma-separated roles this process plays. Every process runs all of them today. */
  MODUS_ROLES: z.string().default(ROLES.join(',')),
  // Webhook endpoints (WEBHOOK_URL, WEBHOOK_SECRET, WEBHOOKS_FILE, WEBHOOKS_ALLOW_HTTP and the secretEnv variables) are read by loadEndpoints in webhooks.ts.
  /** Days to keep messages once delivered everywhere (or skipped). */
  WEBHOOKS_KEEP_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** Days to keep messages with a failed delivery, for the admin retry. */
  WEBHOOKS_KEEP_FAILED_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /**
   * How the server learns who is calling. `none`: the caller says, in the x-user-id header (a laptop or a closed network only).
   * `password`: one shared password lets a browser in, and people still choose who to work as (demos).
   * `oidc`: people sign in with an identity provider, and the server knows who each one is.
   */
  MODUS_AUTH: z.enum(['none', 'password', 'oidc']).default('none'),
  /** The shared password for MODUS_AUTH=password. */
  MODUS_AUTH_PASSWORD: z.string().min(8).optional(),
  /** Signs the sign-in cookies. Unset: a random one per start, so sign-ins end at a restart and servers don't accept each other's. */
  MODUS_SESSION_SECRET: z.string().min(32).optional(),
  /** Hours a sign-in lasts. */
  MODUS_SESSION_HOURS: z.coerce.number().positive().max(24 * 90).default(12),
  /** Where browsers reach this server, e.g. https://modus.example.org. Required for oidc: the provider sends people back to <it>/api/auth/callback. */
  MODUS_PUBLIC_URL: z.string().optional(),
  /** The identity provider's issuer address, e.g. https://id.example.org/realms/modus. */
  MODUS_OIDC_ISSUER: z.string().optional(),
  MODUS_OIDC_CLIENT_ID: z.string().optional(),
  /** Unset for a public client (PKCE only). */
  MODUS_OIDC_CLIENT_SECRET: z.string().optional(),
  /** The claim that names the person; matched against each person's sign-in name (People page), then their id. */
  MODUS_OIDC_CLAIM: z.string().default('email'),
  MODUS_OIDC_SCOPES: z.string().default('openid email profile'),
  /** Comma-separated claim values that become administrators at their first sign-in, when the design doesn't know them. */
  MODUS_OIDC_ADMINS: z.string().optional(),
  /** `true` accepts an issuer over plain http (a local Keycloak). */
  MODUS_OIDC_ALLOW_HTTP: z.enum(['true', 'false']).default('false'),
  /** Machine tokens, comma-separated `personId:token` (24+ characters each). A caller sending `Authorization: Bearer <token>` acts as that person. */
  MODUS_API_TOKENS: z.string().optional(),
})

export interface Config {
  port: number
  host: string
  dataDir?: string
  timeScale: number
  staticDir?: string
  logLevel: (typeof LOG_LEVELS)[number]
  db: { dialect: 'memory' } | { dialect: 'postgres'; url: string; poolMax: number }
  tenantMode: 'single' | 'multi'
  roles: Role[]
  assistant: {
    apiKey?: string
    model: string
    effort?: (typeof EFFORTS)[number]
    fallbacks: boolean
  }
  auth: AuthSettings
  webhooks: Endpoint[]
  webhooksKeepDays: number
  webhooksKeepFailedDays: number
}

export class ConfigError extends Error {}

/** Read and check the configuration. Throws ConfigError with every problem listed; returns warnings to log. */
export function loadConfig(
  source: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): { config: Config; warnings: string[] } {
  // An empty variable counts as unset, so `FOO=` in a compose file means "use the default".
  const vars = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const parsed = env.safeParse(vars)
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  let webhooks: Endpoint[] = []
  try {
    webhooks = loadEndpoints(vars, readFile)
  } catch (err) {
    // loadEndpoints lists one problem per line, never quoting a secret or URL.
    problems.push(...(err instanceof Error ? err.message : String(err)).split('\n'))
  }
  if (!parsed.success || problems.length) throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  const e = parsed.data
  const warnings: string[] = []

  if (e.DB_DIALECT !== 'memory') {
    if (!e.DATABASE_URL) throw new ConfigError(`DATABASE_URL is required when DB_DIALECT=${e.DB_DIALECT}.`)
    let scheme: string
    try {
      scheme = new URL(e.DATABASE_URL).protocol
    } catch {
      throw new ConfigError('DATABASE_URL is not a valid URL.')
    }
    if (!URL_SCHEMES[e.DB_DIALECT].includes(scheme))
      throw new ConfigError(`DATABASE_URL should start with ${URL_SCHEMES[e.DB_DIALECT].map((s) => `${s}//`).join(' or ')} for DB_DIALECT=${e.DB_DIALECT}.`)
    if (e.DB_DIALECT !== 'postgres')
      throw new ConfigError(`DB_DIALECT=${e.DB_DIALECT} is planned but not implemented in this build. Use DB_DIALECT=postgres or memory.`)
    if (e.DATA_DIR) warnings.push(`DATA_DIR is ignored: DB_DIALECT=${e.DB_DIALECT} keeps everything in the database.`)
  } else {
    if (e.DATABASE_URL) warnings.push('DATABASE_URL is ignored: DB_DIALECT=memory.')
    if (e.DB_POOL_MAX !== undefined) warnings.push('DB_POOL_MAX is ignored: DB_DIALECT=memory.')
  }
  if (e.TENANT_MODE === 'multi') warnings.push('TENANT_MODE=multi is planned and not enforced yet; running as a single tenant.')

  const roles = [
    ...new Set(
      e.MODUS_ROLES.split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const unknown = roles.filter((r) => !(ROLES as readonly string[]).includes(r))
  if (unknown.length) throw new ConfigError(`MODUS_ROLES has unknown roles: ${unknown.join(', ')}. Known: ${ROLES.join(', ')}.`)
  if (roles.length < ROLES.length) warnings.push(`MODUS_ROLES=${roles.join(',')}: splitting roles across processes is planned; this process runs every role.`)

  const httpUrl = (name: string, value: string | undefined, plainOk: boolean): string | undefined => {
    if (!value) return undefined
    let u: URL | undefined
    try {
      u = new URL(value)
    } catch {}
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new ConfigError(`${name} is not a valid http(s) URL.`)
    if (u.protocol === 'http:' && !plainOk) throw new ConfigError(`${name} must start with https:// (set MODUS_OIDC_ALLOW_HTTP=true for a local identity provider).`)
    return value.replace(/\/+$/, '')
  }
  const publicUrl = httpUrl('MODUS_PUBLIC_URL', e.MODUS_PUBLIC_URL, true)
  let mode: AuthMode
  if (e.MODUS_AUTH === 'password') {
    if (!e.MODUS_AUTH_PASSWORD) throw new ConfigError('MODUS_AUTH_PASSWORD is required when MODUS_AUTH=password.')
    mode = { mode: 'password', password: e.MODUS_AUTH_PASSWORD }
  } else if (e.MODUS_AUTH === 'oidc') {
    const missing = (['MODUS_OIDC_ISSUER', 'MODUS_OIDC_CLIENT_ID', 'MODUS_PUBLIC_URL'] as const).filter((k) => !e[k])
    if (missing.length) throw new ConfigError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required when MODUS_AUTH=oidc.`)
    const allowHttp = e.MODUS_OIDC_ALLOW_HTTP === 'true'
    const admins = (e.MODUS_OIDC_ADMINS ?? '').split(',').map((a) => a.trim()).filter(Boolean)
    mode = { mode: 'oidc', issuer: httpUrl('MODUS_OIDC_ISSUER', e.MODUS_OIDC_ISSUER, allowHttp)!, clientId: e.MODUS_OIDC_CLIENT_ID!, clientSecret: e.MODUS_OIDC_CLIENT_SECRET, claim: e.MODUS_OIDC_CLAIM, scopes: e.MODUS_OIDC_SCOPES, admins, allowHttp }
    if (!admins.length) warnings.push('MODUS_OIDC_ADMINS is empty: only people whose sign-in name is already in the design can sign in.')
  } else {
    mode = { mode: 'none' }
    if (!['127.0.0.1', 'localhost', '::1'].includes(e.HOST)) warnings.push('MODUS_AUTH=none: anyone who can reach this server can act as anyone, administrators included. Set MODUS_AUTH=password or oidc before exposing it.')
    if (e.MODUS_AUTH_PASSWORD) warnings.push('MODUS_AUTH_PASSWORD is ignored: MODUS_AUTH=none.')
  }
  if (mode.mode !== 'none' && !e.MODUS_SESSION_SECRET) warnings.push('MODUS_SESSION_SECRET is not set: sign-ins end when this server restarts, and several servers won’t accept each other’s.')
  const tokens = new Map<string, string>()
  for (const entry of (e.MODUS_API_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const colon = entry.indexOf(':')
    const person = entry.slice(0, colon)
    const token = entry.slice(colon + 1)
    // Never quote the entry: it holds a secret.
    if (colon < 1 || token.length < 24 || /\s/.test(token)) throw new ConfigError(`MODUS_API_TOKENS: entry ${tokens.size + 1} should be personId:token, with a token of 24 or more characters and no spaces.`)
    tokens.set(hashToken(token), person)
  }

  return {
    config: {
      auth: { auth: mode, sessionSecret: e.MODUS_SESSION_SECRET ?? randomBytes(32).toString('hex'), sessionHours: e.MODUS_SESSION_HOURS, publicUrl, tokens },
      port: e.PORT,
      host: e.HOST,
      dataDir: e.DATA_DIR,
      timeScale: e.TIME_SCALE,
      staticDir: e.STATIC_DIR,
      logLevel: e.LOG_LEVEL,
      db: e.DB_DIALECT === 'postgres' ? { dialect: 'postgres', url: e.DATABASE_URL!, poolMax: e.DB_POOL_MAX ?? 10 } : { dialect: 'memory' },
      tenantMode: e.TENANT_MODE,
      roles: roles as Role[],
      assistant: {
        apiKey: e.ANTHROPIC_API_KEY,
        model: e.MODUS_ASSISTANT_MODEL,
        effort: e.MODUS_ASSISTANT_EFFORT === 'off' ? undefined : e.MODUS_ASSISTANT_EFFORT,
        fallbacks: e.MODUS_ASSISTANT_FALLBACKS === 'default',
      },
      webhooks,
      webhooksKeepDays: e.WEBHOOKS_KEEP_DAYS,
      webhooksKeepFailedDays: e.WEBHOOKS_KEEP_FAILED_DAYS,
    },
    warnings,
  }
}

/** Where a database URL points (host, port, database), without the user name or password. */
function dbTarget(url: string): string {
  const u = new URL(url)
  return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`
}

/** An endpoint for the startup log: its name, host and filters. Never the path or query (they may carry a token) nor the secret. */
function describeEndpoint(e: Endpoint): string {
  const filters = [...(e.apps ?? []), ...(e.kinds ?? [])]
  return `${e.name} → ${new URL(e.url).host}${filters.length ? ` (${filters.join(', ')})` : ''}`
}

/** One line for the startup log. Never includes secrets. */
export function describeConfig(c: Config): string {
  const assistant = c.assistant.apiKey ? `model ${c.assistant.model}` : 'built-in (no ANTHROPIC_API_KEY)'
  const storage = c.db.dialect === 'postgres' ? `postgres → ${dbTarget(c.db.url)} (pool ${c.db.poolMax})` : `memory${c.dataDir ? ` → ${c.dataDir}` : ' (not persisted)'}`
  const a = c.auth.auth
  const signIn = a.mode === 'oidc' ? `oidc → ${new URL(a.issuer).host} (by ${a.claim})` : a.mode
  return `sign-in ${signIn}${c.auth.tokens.size ? `, ${c.auth.tokens.size} machine token${c.auth.tokens.size === 1 ? '' : 's'}` : ''}; storage ${storage}; studio ${c.staticDir ?? 'not served'}; assistant ${assistant}; tenancy ${c.tenantMode}; time ×${c.timeScale}; webhooks ${c.webhooks.length ? c.webhooks.map(describeEndpoint).join(', ') : 'none'}`
}
