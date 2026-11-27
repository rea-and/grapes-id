// Ignite stored passwords as   hash = scrypt(password, salt, 64 bytes)   using Node's defaults (N=2^14, r=8, p=1),
// where `salt` is a 32-char hex *string* that Node used as-is (its UTF-8 bytes), and `hash` is hex.
// GrapesID (Zitadel / passwap) verifies scrypt hashes written as
//   $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>       salt/hash: standard base64 alphabet, no padding
// so the conversion is pure re-encoding; the passwords themselves are never needed.
export const NODE_SCRYPT = { ln: 14, r: 8, p: 1 }

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '')

export function scryptHashFromNode({ saltUtf8, hashHex, ln = NODE_SCRYPT.ln, r = NODE_SCRYPT.r, p = NODE_SCRYPT.p }) {
  if (typeof saltUtf8 !== 'string' || !saltUtf8) throw new Error('missing salt')
  if (typeof hashHex !== 'string' || !/^[0-9a-f]+$/i.test(hashHex) || hashHex.length % 2) throw new Error('hash is not hex')
  return `$scrypt$ln=${ln},r=${r},p=${p}$${b64(Buffer.from(saltUtf8, 'utf8'))}$${b64(Buffer.from(hashHex, 'hex'))}`
}
