#!/usr/bin/env node
// Register an app with GrapesID ("Sign in with GrapesID") and print the settings it needs. See INTEGRATION.md.
//
//   scripts/register-app.mjs <name> <app-url> [options]                       server-side web app (default)
//   scripts/register-app.mjs <name> <app-url> --type spa                      browser-only app (no backend)
//   scripts/register-app.mjs <name> --type native --redirect com.you.app:/cb  Android / iOS / desktop app
//
// Options:
//   --type web|spa|native  web: confidential client with a secret (default). spa / native: public clients, no secret
//   --callback /path       redirect path on the app (web default /api/auth/grapesid/callback, spa default /auth/callback)
//   --redirect URI         full redirect URI (repeatable); replaces the default. Required for --type native: a custom
//                          scheme such as com.example.app:/oauth2redirect, or an https:// App Link
//   --logout-redirect URI  where to land after sign-out (repeatable; default <app-url>/)
//   --refresh              also allow refresh tokens (on by default for native; clients then ask for offline_access)
//   --rotate-secret        web only, the app exists already: issue a new client secret (the old one stops working)
//   --dev URL              also allow this origin's callback (e.g. http://localhost:5173) and plain-http redirects
//   --dry-run              print what would be sent and change nothing
//
// It creates one project per app (named after the app) holding one OIDC client: Authorization Code + PKCE, with the
// profile claims (preferred_username, name, email, email_verified) in the ID token. A web client authenticates to the token
// endpoint with its secret (HTTP Basic); spa and native clients are public and rely on PKCE alone.
// Safe to run again: an existing app is left as is (its redirect URIs and settings are updated).
import { client, die, parseArgs } from './lib.mjs'

const args = parseArgs()
const [name, appUrlRaw] = args.positional
if (!name || args.has('help')) {
  console.log('usage: scripts/register-app.mjs <name> [<app-url>] [--type web|spa|native] [--redirect URI] [--callback /path] [--refresh] [--rotate-secret] [--dev http://localhost:5173] [--dry-run]')
  process.exit(name ? 0 : 2)
}
if (!/^[a-z0-9][a-z0-9 ._-]{0,60}$/i.test(name)) die('the app name may contain letters, numbers, space . _ -')
const type = String(args.get('type') || 'web')
const TYPES = {
  web: { appType: 'OIDC_APP_TYPE_WEB', authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC', callback: '/api/auth/grapesid/callback' },
  spa: { appType: 'OIDC_APP_TYPE_USER_AGENT', authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE', callback: '/auth/callback' },
  native: { appType: 'OIDC_APP_TYPE_NATIVE', authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE', callback: null },
}
if (!TYPES[type]) die('--type must be web, spa or native')
const extraRedirects = args.all('redirect').map(String)
if (type === 'native' && !extraRedirects.length) die('a native app needs --redirect, e.g. --redirect com.example.app:/oauth2redirect (the scheme is usually your reverse-domain package name)')
if (type !== 'native' && !appUrlRaw) die(`a ${type} app needs its URL, e.g. scripts/register-app.mjs ${name} https://app.example.com`)
let appUrl = null
if (appUrlRaw) { try { appUrl = new URL(appUrlRaw).origin } catch { die(`not a URL: ${appUrlRaw}`) } }
for (const r of extraRedirects) if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(r) || /^(javascript|data):/i.test(r)) die(`not a usable redirect URI: ${r}`)
if (args.has('rotate-secret') && type !== 'web') die('--rotate-secret only applies to web clients (spa and native clients have no secret)')
const callback = String(args.get('callback') || TYPES[type].callback || '')
const dev = args.get('dev') ? new URL(String(args.get('dev'))).origin : null

const { api, myOrgId, publicUrl } = args.has('dry-run')
  ? { api: null, myOrgId: async () => '(dry run)', publicUrl: '(your GrapesID URL)' }
  : client({ url: args.get('grapesid-url') })
const orgId = await myOrgId()

const redirectUris = extraRedirects.length
  ? [...extraRedirects, ...(dev ? [`${dev}${callback}`] : [])]
  : [`${appUrl}${callback}`, ...(dev ? [`${dev}${callback}`] : [])]
const postLogoutRedirectUris = [...args.all('logout-redirect').map(String), ...(args.has('logout-redirect') ? [] : appUrl ? [`${appUrl}/`] : []), ...(dev ? [`${dev}/`] : [])]
const refresh = args.has('refresh') || type === 'native'
const oidc = {
  redirectUris,
  postLogoutRedirectUris,
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', ...(refresh ? ['OIDC_GRANT_TYPE_REFRESH_TOKEN'] : [])],
  appType: TYPES[type].appType,
  authMethodType: TYPES[type].authMethodType,
  version: 'OIDC_VERSION_1_0',
  accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
  // Put the profile (preferred_username, name, email) into the ID token, so apps need no extra userinfo call.
  idTokenUserinfoAssertion: true,
  devMode: !!dev || redirectUris.some((u) => u.startsWith('http:')),
}

if (!api) {
  console.log(`Dry run (nothing changed). Would register "${name}" as a ${type} client with:\n${JSON.stringify(oidc, null, 2)}`)
  process.exit(0)
}

// ---- project (one per app) ----
const projects = await api('POST', '/management/v1/projects/_search', {
  queries: [{ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
}, { orgId })
let projectId = projects.result?.[0]?.id
if (!projectId) {
  projectId = (await api('POST', '/management/v1/projects', { name, projectRoleAssertion: false, projectRoleCheck: false, hasProjectCheck: false }, { orgId })).id
  console.log(`Created project "${name}" (${projectId})`)
}

// ---- OIDC client ----
const apps = await api('POST', `/management/v1/projects/${projectId}/apps/_search`, {
  queries: [{ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
}, { orgId })
const existing = apps.result?.[0]
let clientId
let clientSecret = null
if (!existing) {
  const res = await api('POST', `/management/v1/projects/${projectId}/apps/oidc`, { name, ...oidc }, { orgId })
  clientId = res.clientId
  clientSecret = res.clientSecret
  console.log(`Created OIDC client "${name}"`)
} else {
  clientId = existing.oidcConfig?.clientId
  const { version, ...update } = oidc
  try {
    await api('PUT', `/management/v1/projects/${projectId}/apps/${existing.id}/oidc_config`, update, { orgId })
    console.log(`Updated OIDC client "${name}" (redirect URIs and settings)`)
  } catch (e) {
    if (!/No changes|COMMAND-1m88i|not changed/i.test(e.message)) throw e
    console.log(`OIDC client "${name}" is up to date`)
  }
  if (args.has('rotate-secret')) {
    clientSecret = (await api('POST', `/management/v1/projects/${projectId}/apps/${existing.id}/oidc_config/_generate_client_secret`, {}, { orgId })).clientSecret
    console.log('Issued a new client secret (the previous one no longer works)')
  }
}

console.log(`\nRedirect URIs: ${redirectUris.join(', ')}`)
if (type === 'web') {
  console.log(`\nAdd to the app's .env:\n`)
  console.log(`GRAPESID_ISSUER=${publicUrl}`)
  console.log(`GRAPESID_CLIENT_ID=${clientId}`)
  console.log(clientSecret ? `GRAPESID_CLIENT_SECRET=${clientSecret}` : '# GRAPESID_CLIENT_SECRET: unchanged (shown only when created; use --rotate-secret for a new one)')
  console.log(`PUBLIC_URL=${appUrl}`)
} else {
  console.log(`\nThis is a public client: there is no secret to keep. Configure the app with:\n`)
  console.log(`issuer:       ${publicUrl}`)
  console.log(`client id:    ${clientId}`)
  console.log(`redirect URI: ${redirectUris[0]}`)
  console.log(`scopes:       openid profile email${refresh ? ' offline_access' : ''}`)
}
