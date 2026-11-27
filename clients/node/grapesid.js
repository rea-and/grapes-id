// GrapesID client for Node servers: OpenID Connect, Authorization Code + PKCE, confidential client. Zero npm dependencies.
// Copy this file into an app (Ignite uses the same file as server/grapesid.js). See docs/connect-an-app.md.
//
// The app stays a "backend for frontend": the browser only holds the app's own session cookie. This module redirects to
// GrapesID, exchanges the code, and verifies the ID token itself (RS256 against the issuer's JWKS).
//
// Env vars: GRAPESID_ISSUER, GRAPESID_CLIENT_ID, GRAPESID_CLIENT_SECRET (from scripts/register-app.mjs) and PUBLIC_URL
// (the app's own origin; the redirect URI is PUBLIC_URL + CALLBACK_PATH).
import { createHash, createPublicKey, randomBytes, verify as verifySig } from 'node:crypto'

const ISSUER = (process.env.GRAPESID_ISSUER || '').replace(/\/+$/, '')
const CLIENT_ID = process.env.GRAPESID_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GRAPESID_CLIENT_SECRET || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')

export const ssoEnabled = !!ISSUER
export const CALLBACK_PATH = '/api/auth/grapesid/callback'
export const accountUrl = ISSUER ? `${ISSUER}/ui/console/users/me` : null

if (ssoEnabled) {
  const missing = ['GRAPESID_CLIENT_ID', 'GRAPESID_CLIENT_SECRET', 'PUBLIC_URL'].filter((k) => !process.env[k])
  if (missing.length) throw new Error(`GRAPESID_ISSUER is set, but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing (see .env.example)`)
}

const redirectUri = () => `${PUBLIC_URL}${CALLBACK_PATH}`
const b64url = (buf) => Buffer.from(buf).toString('base64url')

// ---------- discovery + keys (cached) ----------

let discovery = null
let discoveredAt = 0
async function config() {
  if (discovery && Date.now() - discoveredAt < 3600e3) return discovery
  const r = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`GrapesID discovery failed: HTTP ${r.status}`)
  const d = await r.json()
  if (d.issuer.replace(/\/+$/, '') !== ISSUER) throw new Error(`GrapesID issuer mismatch: ${d.issuer} != ${ISSUER}`)
  discovery = d
  discoveredAt = Date.now()
  return d
}

let jwks = new Map() // kid -> KeyObject
let jwksAt = 0
async function keyFor(kid) {
  // Refetch on an unknown kid (key rotation), but at most once a minute.
  if (!jwks.has(kid) && Date.now() - jwksAt > 60e3) {
    const r = await fetch((await config()).jwks_uri, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`GrapesID JWKS fetch failed: HTTP ${r.status}`)
    const { keys } = await r.json()
    jwks = new Map(keys.filter((k) => k.kty === 'RSA' && (!k.use || k.use === 'sig')).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]))
    jwksAt = Date.now()
  }
  const key = jwks.get(kid)
  if (!key) throw new Error('ID token signed with an unknown key')
  return key
}

async function verifyIdToken(token, nonce) {
  const parts = String(token).split('.')
  if (parts.length !== 3) throw new Error('malformed ID token')
  const [h, p, s] = parts
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
  if (header.alg !== 'RS256') throw new Error(`unexpected ID token algorithm ${header.alg}`)
  const ok = verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), await keyFor(header.kid), Buffer.from(s, 'base64url'))
  if (!ok) throw new Error('ID token signature is invalid')
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  const now = Math.floor(Date.now() / 1000)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (String(claims.iss).replace(/\/+$/, '') !== ISSUER) throw new Error('ID token issuer mismatch')
  if (!aud.includes(CLIENT_ID)) throw new Error('ID token audience mismatch')
  if (aud.length > 1 && claims.azp && claims.azp !== CLIENT_ID) throw new Error('ID token azp mismatch')
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('ID token expired')
  if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch')
  if (!claims.sub) throw new Error('ID token has no subject')
  return claims
}

// ---------- the login round trip ----------

const pending = new Map() // state -> { verifier, nonce, expires }
const PENDING_MS = 10 * 60e3
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k) }, 60e3).unref()
export const STATE_COOKIE = 'grapesid_state'

/** Where to send the browser to sign in. The returned `state` must be set as a short-lived cookie by the caller. */
export async function startLogin() {
  const { authorization_endpoint } = await config()
  const state = b64url(randomBytes(24))
  const nonce = b64url(randomBytes(24))
  const verifier = b64url(randomBytes(32))
  if (pending.size > 10_000) pending.clear() // flood guard; real users just retry
  pending.set(state, { verifier, nonce, expires: Date.now() + PENDING_MS })
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })
  return { url: `${authorization_endpoint}?${q}`, state, maxAge: PENDING_MS / 1000 }
}

/**
 * Finish the round trip: check state against the browser's cookie, exchange the code, verify the ID token.
 * Returns { sub, username, name, email, idToken }.
 */
export async function finishLogin({ code, state, cookieState }) {
  const p = state && pending.get(state)
  if (!p || p.expires < Date.now() || state !== cookieState) throw new Error('This sign-in link expired or was opened in another browser. Please try again.')
  pending.delete(state)
  const { token_endpoint } = await config()
  const r = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri(), code_verifier: p.verifier }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body.id_token) throw new Error(`GrapesID token exchange failed: ${body.error_description || body.error || `HTTP ${r.status}`}`)
  const c = await verifyIdToken(body.id_token, p.nonce)
  return {
    sub: String(c.sub),
    username: String(c.preferred_username || c.email || c.sub),
    name: c.name ? String(c.name) : null,
    email: c.email ? String(c.email) : null,
    idToken: body.id_token,
  }
}

/** URL that also ends the GrapesID session (single sign-out), then comes back to the app. */
export async function logoutUrl(idToken) {
  const { end_session_endpoint } = await config().catch(() => ({}))
  if (!end_session_endpoint) return null
  const q = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: `${PUBLIC_URL}/` })
  if (idToken) q.set('id_token_hint', idToken)
  return `${end_session_endpoint}?${q}`
}
