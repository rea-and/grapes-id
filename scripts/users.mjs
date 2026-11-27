#!/usr/bin/env node
// Look at and manage the people registered in GrapesID. Run it on the server, in this folder.
//
//   scripts/users.mjs list                          everyone, newest last: username, state, email, verified?
//   scripts/users.mjs show <user>                   one person in detail
//   scripts/users.mjs deactivate <user>             block sign-in (reversible); their apps keep the data
//   scripts/users.mjs reactivate <user>             let them sign in again
//   scripts/users.mjs verify-email <user>           mark their email address as verified (when they can't receive the code)
//   scripts/users.mjs password-reset <user>         email them a link to choose a new password (needs scripts/smtp.mjs)
//   scripts/users.mjs set-password <user>           choose a new password for them right now (typed hidden; use for admin recovery)
//   scripts/users.mjs delete <user> --yes           delete the account for good (their data inside apps is NOT deleted)
//
// <user> is a username, an email address, or the user id shown by `list`. Reads can lag a few seconds behind writes.
import { client, die, parseArgs } from './lib.mjs'
import { askHidden } from './prompt.mjs'

const args = parseArgs()
const [cmd, who] = args.positional
const COMMANDS = ['list', 'show', 'deactivate', 'reactivate', 'verify-email', 'password-reset', 'set-password', 'delete']
if (!COMMANDS.includes(cmd)) die(`usage: scripts/users.mjs ${COMMANDS.join('|')} [<user>] [--yes]`)
const { api } = client({ url: args.get('grapesid-url') })

const state = (u) => String(u.state || '').replace('USER_STATE_', '').toLowerCase()
const email = (u) => u.human?.email?.email || ''
const verified = (u) => (u.human?.email?.isVerified ? 'verified' : 'NOT verified')
const created = (u) => String(u.details?.creationDate || '').slice(0, 10)
const name = (u) => u.username || u.userName || ''

async function all() {
  const res = await api('POST', '/v2/users', { query: { limit: 500 }, queries: [{ typeQuery: { type: 'TYPE_HUMAN' } }] })
  return res.result || []
}
async function find(ref) {
  if (!ref) die(`${cmd} needs a user (username, email or id)`)
  const needle = ref.toLowerCase()
  const hits = (await all()).filter((u) => [u.userId, name(u), email(u)].some((v) => String(v || '').toLowerCase() === needle))
  if (!hits.length) die(`no such user: ${ref} (try \`scripts/users.mjs list\`)`)
  if (hits.length > 1) die(`"${ref}" matches ${hits.length} people (${hits.map((h) => name(h)).join(', ')}): use the username or id instead`)
  return hits[0]
}

if (cmd === 'list') {
  const users = (await all()).sort((a, b) => created(a).localeCompare(created(b)))
  const w = Math.max(8, ...users.map((u) => name(u).length))
  console.log(`${users.length} registered ${users.length === 1 ? 'person' : 'people'}\n`)
  console.log(`${'USERNAME'.padEnd(w)}  ${'STATE'.padEnd(9)}  ${'EMAIL'.padEnd(34)}  ${'VERIFIED'.padEnd(12)}  CREATED     ID`)
  for (const u of users) console.log(`${name(u).padEnd(w)}  ${state(u).padEnd(9)}  ${email(u).padEnd(34)}  ${verified(u).padEnd(12)}  ${created(u).padEnd(10)}  ${u.userId}`)
  process.exit(0)
}

try {
const u = await find(who)
const label = `${name(u)} <${email(u)}>`
if (cmd === 'show') {
  const p = u.human?.profile || {}
  console.log(`Username:   ${name(u)}\nName:       ${p.displayName || [p.givenName, p.familyName].filter(Boolean).join(' ')}\nEmail:      ${email(u)} (${verified(u)})\nState:      ${state(u)}\nCreated:    ${created(u)}\nUser id:    ${u.userId}   (this is the \`sub\` apps store)`)
} else if (cmd === 'deactivate') {
  await api('POST', `/v2/users/${u.userId}/deactivate`, {})
  console.log(`Deactivated ${label}. They can no longer sign in; reactivate any time.`)
} else if (cmd === 'reactivate') {
  await api('POST', `/v2/users/${u.userId}/reactivate`, {})
  console.log(`Reactivated ${label}.`)
} else if (cmd === 'verify-email') {
  if (u.human?.email?.isVerified) die(`${email(u)} is already verified`)
  // Ask GrapesID for a verification code without emailing it, then confirm it ourselves.
  const { verificationCode } = await api('POST', `/v2/users/${u.userId}/email/resend`, { returnCode: {} })
  if (!verificationCode) die('GrapesID did not return a verification code')
  await api('POST', `/v2/users/${u.userId}/email/verify`, { verificationCode })
  console.log(`Marked ${email(u)} as verified for ${name(u)}.`)
} else if (cmd === 'password-reset') {
  await api('POST', `/v2/users/${u.userId}/password_reset`, { sendLink: {} })
  console.log(`Sent a password-reset link to ${email(u)}.`)
} else if (cmd === 'set-password') {
  if (!process.stdin.isTTY) die('run this in a terminal: the new password is typed at a hidden prompt')
  const pw = await askHidden(`New password for ${name(u)} (hidden): `)
  if (pw.length < 8) die('use at least 8 characters, with upper and lower case, a number and a symbol')
  if (pw !== (await askHidden('Again: '))) die('the two entries differ; nothing changed')
  await api('POST', `/v2/users/${u.userId}/password`, { newPassword: { password: pw, changeRequired: false } })
  console.log(`Password changed for ${name(u)}. Any existing sessions keep working until they expire.`)
} else if (cmd === 'delete') {
  if (!args.has('yes')) die(`this deletes ${label} for good. Their data inside apps (for example an Ignite plan) stays where it is. Add --yes to go ahead.`)
  await api('DELETE', `/v2/users/${u.userId}`)
  console.log(`Deleted ${label}.`)
}
} catch (e) { die(e.message) }
