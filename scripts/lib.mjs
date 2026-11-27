// Shared helpers for the GrapesID admin scripts: reads ../.env and talks to the API with the automation token
// (secrets/admin.pat, copied out of the container by deploy.sh). Zero npm dependencies; Node 22+.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function die(msg) {
  console.error(`grapesid: ${msg}`)
  process.exit(1)
}

export function readEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8').split('\n')
      .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')]),
  )
}

/** Simple flag parser: --name value, --flag (boolean), repeated flags collected with all(). */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional = []
  const flags = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags.push([a.slice(2), next]); i++ } else flags.push([a.slice(2), true])
  }
  return {
    positional,
    get: (name) => flags.findLast(([k]) => k === name)?.[1],
    has: (name) => flags.some(([k]) => k === name),
    all: (name) => flags.filter(([k]) => k === name).map(([, v]) => v),
  }
}

/**
 * API client. Talks to Zitadel on its local port with the public Host header (Zitadel picks the instance by host),
 * so the scripts work on the server even before DNS/HTTPS are in place. Override with --grapesid-url.
 */
export function client({ url, tokenFile } = {}) {
  const env = readEnv()
  if (!env.GRAPESID_DOMAIN && !url) die('no .env found: run ./deploy.sh --setup <domain> first (or pass --grapesid-url)')
  const publicUrl = env.GRAPESID_PUBLIC_URL || `https://${env.GRAPESID_DOMAIN}`
  const base = (url || `http://127.0.0.1:${env.GRAPESID_API_PORT || 8180}`).replace(/\/+$/, '')
  const local = !url
  const file = tokenFile || join(ROOT, 'secrets', 'admin.pat')
  if (!existsSync(file)) die(`admin token ${file} not found (./deploy.sh copies it there after the first start)`)
  const token = readFileSync(file, 'utf8').trim()
  const hostHeader = env.GRAPESID_HOST || env.GRAPESID_DOMAIN
  const scheme = env.GRAPESID_SCHEME || 'https'

  async function api(method, path, body, { orgId } = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(local ? { Host: hostHeader, 'X-Forwarded-Proto': scheme, 'X-Forwarded-Host': hostHeader } : {}),
        ...(orgId ? { 'x-zitadel-orgid': orgId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : {} } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${r.status} ${json?.message || text.slice(0, 300)}`), { status: r.status, body: json })
    return json
  }

  /** The automation account's own organization (where apps and people live by default). */
  async function myOrgId() {
    const me = await api('GET', '/auth/v1/users/me')
    return me.user?.details?.resourceOwner || die('could not determine the organization of the admin token')
  }

  return { api, myOrgId, publicUrl, env }
}
