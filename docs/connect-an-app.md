# Connecting an app to GrapesID

GrapesID speaks standard OpenID Connect, so any OIDC library works. For the zero-dependency Node apps in this family,
the pattern below is what Ignite uses (see `ignite/server/index.js`, section "GrapesID single sign-on").

## 1. Register the app

```bash
scripts/register-app.mjs <name> https://app.example.com [--dev http://localhost:5173]
```

This prints `GRAPESID_ISSUER`, `GRAPESID_CLIENT_ID`, `GRAPESID_CLIENT_SECRET` and `PUBLIC_URL`; put them in the app's `.env`.
The client is confidential (secret via HTTP Basic), uses Authorization Code + PKCE (S256), and carries
`preferred_username`, `name` and `email` in the ID token. Redirect URI: `<app>/api/auth/grapesid/callback`;
post-logout redirect: `<app>/`. Re-running is safe; `--rotate-secret` issues a new secret.

## 2. Server side (Node, no dependencies)

Copy `clients/node/grapesid.js` into the app, then add three routes:

```js
import * as grapesid from './grapesid.js'

// GET /api/auth/grapesid/start  → redirect to GrapesID
const { url, state, maxAge } = await grapesid.startLogin()
res.writeHead(302, { Location: url, 'Set-Cookie':
  `${grapesid.STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/grapesid; Max-Age=${maxAge}` }).end()

// GET /api/auth/grapesid/callback → verify, find/create the local user, start the app's own session
const q = new URL(req.url, 'http://x').searchParams
const id = await grapesid.finishLogin({ code: q.get('code'), state: q.get('state'), cookieState: cookieOf(req, grapesid.STATE_COOKIE) })
// id = { sub, username, name, email, idToken }; key your users by id.sub (stable), not by username (can change).

// POST /api/auth/logout → drop the local session, then send the browser to:
const logoutUrl = await grapesid.logoutUrl(session.idToken)   // ends the GrapesID session too
```

Rules of thumb:

- **Identity = `sub`.** Store it on your user record (`grapesId`). Usernames and e-mails may change in GrapesID.
- Keep your own session cookie; don't hand GrapesID tokens to the browser.
- "Change password / profile" becomes a link to `${GRAPESID_ISSUER}/ui/console/users/me`.

## 3. Migrating an app that already has accounts

Follow `migrations/ignite/` as a template:

1. Read the app's users.
2. Create each one in GrapesID with `POST /v2/users/new` and `human.hashedPassword.hash` set to the existing hash in
   [Modular Crypt Format](https://zitadel.com/docs/guides/migrate/users). Supported: bcrypt (`$2a$`/`$2b$`), argon2,
   scrypt (`$scrypt$ln=..,r=..,p=..$<b64 salt>$<b64 hash>`), pbkdf2, sha2 crypt, md5, phpass. To accept a
   new family, add it to `ZITADEL_SYSTEMDEFAULTS_PASSWORDHASHER_VERIFIERS` in `docker-compose.yml` (comma-separated)
   and run `./deploy.sh --no-pull`.
3. Write the returned user id back into the app as its `grapesId`, so existing data stays attached.

If a username already exists in GrapesID, `migrate.mjs` links to that user instead of creating a duplicate: that's
"one account across apps" when it's the same person. It is an account takeover when it isn't, so read the `~` lines
in the dry run and only `--apply` once each of them is really the same person (otherwise rename one side first).
