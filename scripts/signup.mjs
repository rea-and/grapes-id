#!/usr/bin/env node
// Turn self-service sign-up on GrapesID on or off (people can then create their own account from the sign-in page).
//
//   scripts/signup.mjs status
//   scripts/signup.mjs on
//   scripts/signup.mjs off
//
// Off is the safe default: accounts are created by you in the console (Users) or by migrations.
// Turning it on means anyone who can reach the sign-in page can register, so also decide which apps hand out a plan
// to new people (Ignite: ALLOW_REGISTRATION in its .env). Without e-mail (SMTP) configured in the console, GrapesID
// cannot send verification codes or password-reset links; the script warns about it.
import { client, die, parseArgs } from './lib.mjs'

const args = parseArgs()
const cmd = args.positional[0]
if (!['status', 'on', 'off'].includes(cmd)) die('usage: scripts/signup.mjs status|on|off')
const { api } = client({ url: args.get('grapesid-url') })

const { policy } = await api('GET', '/admin/v1/policies/login')
const now = !!policy.allowRegister
const smtp = await api('GET', '/admin/v1/smtp').then((r) => !!r.smtpConfig).catch(() => false)

if (cmd === 'status') {
  console.log(`Self-service sign-up: ${now ? 'ON' : 'off'}`)
  console.log(`E-mail (SMTP):        ${smtp ? 'configured' : 'NOT configured (no verification codes or password resets can be sent)'}`)
  process.exit(0)
}

const want = cmd === 'on'
if (now === want) { console.log(`Sign-up is already ${want ? 'on' : 'off'}.`); process.exit(0) }
// The update replaces the whole login policy, so send back everything we read with the one change.
const keep = ['allowUsernamePassword', 'allowExternalIdp', 'forceMfa', 'forceMfaLocalOnly', 'passwordlessType', 'hidePasswordReset',
  'ignoreUnknownUsernames', 'defaultRedirectUri', 'passwordCheckLifetime', 'externalLoginCheckLifetime', 'mfaInitSkipLifetime',
  'secondFactorCheckLifetime', 'multiFactorCheckLifetime', 'allowDomainDiscovery', 'disableLoginWithEmail', 'disableLoginWithPhone']
const body = Object.fromEntries(keep.filter((k) => policy[k] !== undefined).map((k) => [k, policy[k]]))
await api('PUT', '/admin/v1/policies/login', { ...body, allowRegister: want })
console.log(`Self-service sign-up is now ${want ? 'ON' : 'off'}.`)
if (want && !smtp) console.log('Note: e-mail (SMTP) is not configured, so new people cannot receive verification codes. Set it up in the console under Default settings > SMTP.')
