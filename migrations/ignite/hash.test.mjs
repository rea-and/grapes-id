// node --test migrations/ignite/hash.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { scryptHashFromNode } from './hash.mjs'

// Re-implements passwap's scrypt verifier (github.com/zitadel/passwap/scrypt) to prove the encoding round-trips.
function passwapVerify(encoded, password) {
  const m = encoded.match(/^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/)
  assert.ok(m, `not in passwap format: ${encoded}`)
  const [, ln, r, p, salt, hash] = m
  const want = Buffer.from(hash, 'base64')
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: 1 << Number(ln), r: Number(r), p: Number(p) })
  return got.equals(want)
}

test('an Ignite hash verifies with the same password, and only that one', () => {
  // Exactly what Ignite's server does at registration.
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync('correct horse battery', salt, 64).toString('hex')
  const encoded = scryptHashFromNode({ saltUtf8: salt, hashHex: hash })
  assert.ok(encoded.startsWith('$scrypt$ln=14,r=8,p=1$'))
  assert.ok(!encoded.includes('='.repeat(1) + '$') && !encoded.endsWith('='))
  assert.equal(passwapVerify(encoded, 'correct horse battery'), true)
  assert.equal(passwapVerify(encoded, 'Correct horse battery'), false)
})

test('matches passwap\'s own test vector layout', () => {
  assert.match(scryptHashFromNode({ saltUtf8: 'randomsaltishard', hashHex: '00ff' }), /^\$scrypt\$ln=14,r=8,p=1\$cmFuZG9tc2FsdGlzaGFyZA\$AP8$/)
})
