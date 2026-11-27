#!/usr/bin/env node
// Set up outgoing e-mail for GrapesID: verification codes for new accounts, password resets, notifications.
// The password is never a command-line argument: it is read from $SMTP_PASSWORD or typed at a hidden prompt, and goes
// straight to GrapesID, which stores it encrypted in its database (not in .env, not in git).
//
//   scripts/smtp.mjs --host smtp.example.com:587 --user apikey --from no-reply@example.com [--from-name GrapesID]
//                    [--no-tls] [--test you@example.com]
//   scripts/smtp.mjs status
//
// Most providers want port 587 (STARTTLS) or 465 (TLS) and an app-specific password or API key as the password.
// The sender address must be one the provider lets you send from (a verified domain or sender).
import readline from 'node:readline'
import { client, die, parseArgs } from './lib.mjs'

const args = parseArgs()
const { api } = client({ url: args.get('grapesid-url') })

async function list() { return (await api('POST', '/admin/v1/smtp/_search', {})).result || [] }

if (args.positional[0] === 'status') {
  const all = await list()
  if (!all.length) { console.log('E-mail: NOT configured.'); process.exit(0) }
  for (const c of all) console.log(`E-mail: ${c.state === 'SMTP_CONFIG_ACTIVE' ? 'ACTIVE' : c.state}  ${c.host}  from ${c.senderAddress}  user ${c.user}`)
  process.exit(0)
}

const host = args.get('host'), user = args.get('user'), from = args.get('from')
if (!host || host === true || !from || from === true || !String(from).includes('@')) die('usage: scripts/smtp.mjs --host smtp.example.com:587 --user <login> --from no-reply@your.domain [--from-name GrapesID] [--test you@example.com]')
if (!/^[a-z0-9.-]+:\d+$/i.test(String(host))) die('--host must look like smtp.example.com:587 (host and port)')

async function readPassword() {
  if (process.env.SMTP_PASSWORD) return process.env.SMTP_PASSWORD
  if (!process.stdin.isTTY) die('set SMTP_PASSWORD, or run this in a terminal to type the password at a hidden prompt')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl._writeToOutput = (s) => { if (s.includes('\n')) process.stdout.write('\n') }
  process.stdout.write('SMTP password (hidden): ')
  return new Promise((ok) => rl.question('', (a) => { rl.close(); ok(a) }))
}
const password = await readPassword()
if (!password) die('empty password')

const body = {
  senderAddress: String(from),
  senderName: String(args.get('from-name') || 'GrapesID'),
  tls: !args.has('no-tls'),
  host: String(host),
  user: user && user !== true ? String(user) : '',
  password,
  description: 'GrapesID outgoing mail',
}
const existing = (await list())[0]
let id
if (existing) {
  id = existing.id
  await api('PUT', `/admin/v1/smtp/${id}`, body) // the update call carries the new password too
  console.log(`Updated the existing e-mail settings (${existing.host} -> ${body.host}).`)
} else {
  id = (await api('POST', '/admin/v1/smtp', body)).id
  console.log('Added the e-mail settings.')
}
await api('POST', `/admin/v1/smtp/${id}/_activate`, {}).catch((e) => { if (!/already active|already/i.test(e.message)) throw e })
console.log('E-mail is active.')

if (args.get('test') && args.get('test') !== true) {
  try {
    await api('POST', `/admin/v1/smtp/${id}/_test`, { receiverAddress: String(args.get('test')) })
    console.log(`Test message sent to ${args.get('test')}. Check the inbox (and spam).`)
  } catch (e) { console.error(`The test message failed: ${e.message}\nCheck the host, port, login and that the sender address is allowed by the provider.`); process.exit(1) }
} else console.log('Tip: add --test you@example.com to send a test message.')
