#!/usr/bin/env node
// Apply the GrapesID branding to Zitadel itself: colours, logo and icon (light + dark). These are the official branding
// settings, so they also reach the admin console and the e-mails Zitadel sends. The look of the sign-in pages (glass card,
// fonts, background) is added by branding/grapesid.css, installed by deploy/brand.sh.
//
//   scripts/brand.mjs              apply
//   scripts/brand.mjs --dry-run    show what would change
//
// Safe to run again: it only writes what differs, and always ends by activating the policy.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, client, die, parseArgs } from './lib.mjs'

const args = parseArgs()
const DRY = args.has('dry-run')
const { api, upload } = client({ url: args.get('grapesid-url') })

const POLICY = {
  primaryColor: '#8b3fd1', backgroundColor: '#f7f2fd', fontColor: '#2a1246', warnColor: '#cd3d56',
  primaryColorDark: '#b98ee0', backgroundColorDark: '#0b0613', fontColorDark: '#f4ecff', warnColorDark: '#ff6b81',
  hideLoginNameSuffix: true, // people sign in with "andi", not "andi@grapes.<domain>"
  disableWatermark: true,
  themeMode: 'THEME_MODE_AUTO',
}
const ASSETS = [
  ['/assets/v1/instance/policy/label/logo', 'logo-light.png'],
  ['/assets/v1/instance/policy/label/logo/dark', 'logo-dark.png'],
  ['/assets/v1/instance/policy/label/icon', 'icon-dark.png'],
  ['/assets/v1/instance/policy/label/icon/dark', 'icon-dark.png'],
]

const current = (await api('GET', '/admin/v1/policies/label')).policy || die('could not read the current branding policy')
const diff = Object.entries(POLICY).filter(([k, v]) => current[k] !== v)
console.log(diff.length ? `Colours and options to change: ${diff.map(([k, v]) => `${k} ${current[k]} -> ${v}`).join(', ')}` : 'Colours and options already match.')
for (const [route, file] of ASSETS) if (!existsSync(join(ROOT, 'branding', file))) die(`missing branding/${file}`)

if (DRY) { console.log(`Would upload ${ASSETS.length} images and activate the policy. (dry run: nothing changed)`); process.exit(0) }

if (diff.length) {
  await api('PUT', '/admin/v1/policies/label', POLICY)
  console.log('Updated colours and options.')
}
for (const [route, file] of ASSETS) {
  await upload(route, join(ROOT, 'branding', file), 'image/png')
  console.log(`Uploaded ${file} -> ${route.split('/label/')[1]}`)
}
await api('POST', '/admin/v1/policies/label/_activate', {})
console.log('Branding activated.')
