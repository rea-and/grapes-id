#!/usr/bin/env node
// Move Ignite's local accounts into GrapesID, keeping everyone's password, and link them back to Ignite.
//
//   migrations/ignite/migrate.mjs --ignite-data ~/projects/ignite/data            # dry run: shows what would happen
//   migrations/ignite/migrate.mjs --ignite-data ~/projects/ignite/data --apply    # do it
//
// Options:
//   --email <user>=<address>   real e-mail address for a user, marked verified (repeatable). GrapesID requires an
//                              e-mail; without one the user gets <username>@users.<GRAPESID_DOMAIN> as a placeholder
//                              (unverified) and can set the real one in their GrapesID account.
//
// For every Ignite user it:
//   1. creates a GrapesID user with the same username and the *same password*: Ignite's scrypt hash is re-encoded
//      into the "$scrypt$..." format GrapesID verifies (see hash.mjs), so nobody has to reset anything. GrapesID
//      upgrades it to its own hash at that person's first sign-in;
//   2. stores the new GrapesID user id in Ignite's users.json as `grapesId` (after a timestamped backup). That is
//      how Ignite finds the existing plan when the person signs in through GrapesID.
// Running it again is safe: linked users are skipped, and a GrapesID user that already has the username is linked
// (its password is left alone). Plans are never touched: they stay keyed by Ignite's own user id.
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { client, die, parseArgs } from '../../scripts/lib.mjs'
import { scryptHashFromNode } from './hash.mjs'

const args = parseArgs()
if (args.has('help') || !args.get('ignite-data')) {
  console.log('usage: migrations/ignite/migrate.mjs --ignite-data <ignite/data> [--email user=addr ...] [--apply]')
  process.exit(args.has('help') ? 0 : 2)
}
const APPLY = args.has('apply')
const emails = new Map()
for (const v of args.all('email')) {
  const [u, e] = String(v).split('=')
  if (!u || !e?.includes('@')) die(`--email expects user=address, got "${v}"`)
  emails.set(u.trim().toLowerCase(), e.trim())
}
const USERS_FILE = join(resolve(String(args.get('ignite-data'))), 'users.json')
if (!existsSync(USERS_FILE)) die(`${USERS_FILE} not found`)

const { api, myOrgId, publicUrl, env } = client({ url: args.get('grapesid-url') })
const orgId = await myOrgId().catch((e) => die(`the admin token does not work: ${e.message}`))
const placeholderDomain = `users.${env.GRAPESID_DOMAIN || new URL(publicUrl).hostname}`

async function findByUsername(username) {
  const res = await api('POST', '/v2/users', {
    query: { limit: 2 },
    queries: [{ userNameQuery: { userName: username, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }],
  })
  return res.result?.[0] || null
}

async function createUser(u) {
  const email = emails.get(u.username)
  const res = await api('POST', '/v2/users/new', {
    organizationId: orgId,
    username: u.username,
    human: {
      // GrapesID wants a first and last name; Ignite only knew usernames. Editable in the account page.
      profile: { givenName: u.username, familyName: '-', displayName: u.username },
      email: email ? { email, isVerified: true } : { email: `${u.username}@${placeholderDomain}`, returnCode: {} },
      hashedPassword: { hash: scryptHashFromNode({ saltUtf8: u.salt, hashHex: u.hash }), changeRequired: false },
    },
  })
  const id = res.id || res.userId
  if (!id) throw new Error(`unexpected response: ${JSON.stringify(res).slice(0, 200)}`)
  // Remember where the account came from (shown in the console under the user's metadata).
  await api('POST', `/v2/users/${id}/metadata`, { metadata: [{ key: 'migrated_from', value: Buffer.from(`ignite:${u.id}`).toString('base64') }] })
    .catch((e) => console.log(`  (could not set metadata: ${e.message})`))
  return id
}

const users = JSON.parse(await readFile(USERS_FILE, 'utf8'))
const list = Object.values(users)
console.log(`GrapesID ${publicUrl} · organization ${orgId}`)
console.log(`Ignite: ${list.length} user(s) in ${USERS_FILE}${APPLY ? '' : '   [dry run: add --apply to make changes]'}\n`)

const links = new Map() // ignite id -> grapesId
let failed = 0
for (const u of list) {
  const label = `${String(u.username).padEnd(20)} (ignite ${u.id})`
  if (u.grapesId) { console.log(`= ${label} already linked to ${u.grapesId}`); continue }
  try {
    const existing = await findByUsername(u.username)
    if (existing) {
      console.log(`~ ${label} GrapesID user ${existing.userId} already has this username: ${APPLY ? 'linked' : 'would link'} (password unchanged)`)
      if (APPLY) links.set(u.id, existing.userId)
      continue
    }
    if (!u.salt || !u.hash) { console.log(`! ${label} has no password hash; skipped`); continue }
    const mail = emails.get(u.username) || `${u.username}@${placeholderDomain} (placeholder)`
    if (!APPLY) { console.log(`+ ${label} would be created with its current password, e-mail ${mail}`); continue }
    const id = await createUser(u)
    links.set(u.id, id)
    console.log(`+ ${label} created GrapesID user ${id}, e-mail ${mail}`)
  } catch (e) {
    failed++
    console.log(`x ${label} ${e.message}`)
  }
}

if (links.size) {
  // Re-read right before writing, so anything Ignite saved meanwhile is kept; only the links are added.
  const fresh = JSON.parse(await readFile(USERS_FILE, 'utf8'))
  for (const [igniteId, grapesId] of links) if (fresh[igniteId]) fresh[igniteId].grapesId = grapesId
  const backup = `${USERS_FILE}.before-grapesid-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  await copyFile(USERS_FILE, backup)
  const tmp = `${USERS_FILE}.migrate.tmp`
  await writeFile(tmp, JSON.stringify(fresh, null, 1), { mode: 0o600 })
  await rename(tmp, USERS_FILE)
  console.log(`\nLinked ${links.size} account(s) in ${USERS_FILE}\nBackup of the previous file: ${backup}`)
  console.log('Next: turn on GrapesID in Ignite\'s .env and run its ./deploy.sh (the restart loads the links).')
}
if (failed) { console.log(`\n${failed} user(s) failed. Fix the cause and run again; finished users are skipped.`); process.exit(1) }
