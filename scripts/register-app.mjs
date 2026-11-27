#!/usr/bin/env node
// Register an app with GrapesID ("Sign in with GrapesID") and print the settings it needs.
//
//   scripts/register-app.mjs <name> <app-url> [options]
//   scripts/register-app.mjs ignite https://ignite.carlevato.net
//
// Options:
//   --callback /path       redirect path on the app (default /api/auth/grapesid/callback)
//   --rotate-secret        the app exists already: issue a new client secret (the old one stops working)
//   --dev URL              also allow this origin's callback (e.g. http://localhost:5173) and plain-http redirects
//
// It creates one project per app (named after the app) holding one confidential OIDC web client:
// Authorization Code + PKCE, client secret via HTTP Basic, profile claims (preferred_username, name, email) in the
// ID token. Safe to run again: an existing app is left as is (its redirect URIs are updated).
import { client, die, parseArgs } from './lib.mjs'

const args = parseArgs()
const [name, appUrlRaw] = args.positional
if (!name || !appUrlRaw || args.has('help')) {
  console.log('usage: scripts/register-app.mjs <name> <app-url> [--callback /path] [--rotate-secret] [--dev http://localhost:5173]')
  process.exit(name ? 0 : 2)
}
if (!/^[a-z0-9][a-z0-9 ._-]{0,60}$/i.test(name)) die('the app name may contain letters, numbers, space . _ -')
let appUrl
try { appUrl = new URL(appUrlRaw).origin } catch { die(`not a URL: ${appUrlRaw}`) }
const callback = String(args.get('callback') || '/api/auth/grapesid/callback')
const dev = args.get('dev') ? new URL(String(args.get('dev'))).origin : null

const { api, myOrgId, publicUrl } = client({ url: args.get('grapesid-url') })
const orgId = await myOrgId()

const redirectUris = [`${appUrl}${callback}`, ...(dev ? [`${dev}${callback}`] : [])]
const postLogoutRedirectUris = [`${appUrl}/`, ...(dev ? [`${dev}/`] : [])]
const oidc = {
  redirectUris,
  postLogoutRedirectUris,
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
  appType: 'OIDC_APP_TYPE_WEB',
  authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
  version: 'OIDC_VERSION_1_0',
  accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
  // Put the profile (preferred_username, name, email) into the ID token, so apps need no extra userinfo call.
  idTokenUserinfoAssertion: true,
  devMode: !!dev || appUrl.startsWith('http:'),
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
console.log(`\nAdd to the app's .env:\n`)
console.log(`GRAPESID_ISSUER=${publicUrl}`)
console.log(`GRAPESID_CLIENT_ID=${clientId}`)
console.log(clientSecret ? `GRAPESID_CLIENT_SECRET=${clientSecret}` : '# GRAPESID_CLIENT_SECRET: unchanged (shown only when created; use --rotate-secret for a new one)')
console.log(`PUBLIC_URL=${appUrl}`)
