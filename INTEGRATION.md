# Integrating an app with GrapesID

How to add "Sign in with GrapesID" to a web app, a browser-only app or an Android app, and what a client must (and must not) do to get it right.

GrapesID is a standard **OpenID Connect (OIDC)** provider (Zitadel underneath). If your platform has an OIDC library, you need configuration, not custom protocol code. This document tells you which configuration, which checks are your responsibility, and where the pitfalls are.

**Contents**

1. [The 60-second version](#1-the-60-second-version)
2. [What GrapesID gives you](#2-what-grapesid-gives-you)
3. [Register your app](#3-register-your-app)
4. [The sign-in flow, step by step](#4-the-sign-in-flow-step-by-step)
5. [Web app with a backend](#5-web-app-with-a-backend-recommended-for-websites)
6. [Browser-only app (SPA)](#6-browser-only-app-spa)
7. [Android app](#7-android-app)
8. [Protecting your own API](#8-protecting-your-own-api)
9. [People and accounts: what your app has to decide](#9-people-and-accounts-what-your-app-has-to-decide)
10. [Sign-out and sessions](#10-sign-out-and-sessions)
11. [Security checklist](#11-security-checklist)
12. [Testing and troubleshooting](#12-testing-and-troubleshooting)
13. [Reference](#13-reference)

---

## 1. The 60-second version

| You are building | Client type | Secret? | Register with | Section |
|---|---|---|---|---|
| A website with a server (Node, Python, PHP, Java, .NET, Go…) | **web** (confidential) | Yes, on the server only | `scripts/register-app.mjs <name> <url>` | [5](#5-web-app-with-a-backend-recommended-for-websites) |
| A website with **no** backend (static files + JavaScript) | **spa** (public) | No | `… --type spa` | [6](#6-browser-only-app-spa) |
| An Android app | **native** (public) | No | `… --type native --redirect <scheme>:/…` | [7](#7-android-app) |

Rules that apply to everything:

- Use **Authorization Code flow with PKCE (S256)**. That is the only flow GrapesID is meant to be used with. No implicit flow, no password grant, no embedded login forms.
- Sign-in always happens **in the browser** on `account.carlevato.net`, never in your UI and never in a WebView. Your app never sees a password.
- Identify people by the **`sub`** claim. Not by username, not by email.
- **Validate the ID token** (signature, issuer, audience, expiry, nonce) and **require `email_verified == true`** before accepting a *new* person.
- A public client (SPA, Android) has **no secret**. If something asks you to embed one, you chose the wrong client type.

---

## 2. What GrapesID gives you

**Issuer:** `https://account.carlevato.net`. Every OIDC library can configure itself from the discovery document:

```
https://account.carlevato.net/.well-known/openid-configuration
```

| Endpoint | URL |
|---|---|
| Authorization | `https://account.carlevato.net/oauth/v2/authorize` |
| Token | `https://account.carlevato.net/oauth/v2/token` |
| UserInfo | `https://account.carlevato.net/oidc/v1/userinfo` |
| End session (sign-out) | `https://account.carlevato.net/oidc/v1/end_session` |
| JWKS (signing keys) | `https://account.carlevato.net/oauth/v2/keys` |
| Introspection | `https://account.carlevato.net/oauth/v2/introspect` |
| Revocation | `https://account.carlevato.net/oauth/v2/revoke` |

Read these from discovery at startup rather than hard-coding them, apart from the issuer.

**Behaviour you can rely on**

| | |
|---|---|
| PKCE | `S256` only (`code_challenge_methods_supported: ["S256"]`) |
| Scopes | `openid`, `profile`, `email`, `offline_access` (refresh tokens). `phone` and `address` exist but carry nothing for most people |
| Token endpoint authentication | Web clients: `client_secret_basic`. SPA and native clients: `none` (PKCE only) |
| ID token signature | Asymmetric. Verify against the JWKS. Reject `none` and any HMAC algorithm. GrapesID signs with `RS256` by default |
| Profile in the ID token | Yes: `preferred_username`, `name`, `email`, `email_verified` are included, so you need no extra UserInfo call |
| Email verification | The sign-in pages **require a verified email address** before a sign-in completes (a code is emailed and entered once). You must still check the claim, see [section 9](#9-people-and-accounts-what-your-app-has-to-decide) |
| One account, many apps | Signing in to one app signs the person in everywhere (single sign-on). Each app keeps its own session and its own data |

**Claims you get**

| Claim | Meaning | Use it for |
|---|---|---|
| `sub` | Stable, unique person id | **The key for your user record.** Never changes |
| `preferred_username` | Login name. Plain (`reaand`) for people created or migrated by the admin; **the email address** for people who sign themselves up | Display only. Can change; do not key on it |
| `name` | Display name | Greeting, avatar initial |
| `email`, `email_verified` | Address and whether GrapesID has verified it | Contact, and the verification gate |
| `iss`, `aud`, `exp`, `iat`, `nonce`, `azp`, `auth_time` | Standard validation claims | Token validation (section 4) |

---

## 3. Register your app

On the GrapesID server, in `~/projects/grapes-id` (needs `secrets/admin.pat`, created by `./deploy.sh`):

```bash
# A website with a backend: confidential client, prints a secret ONCE
scripts/register-app.mjs myapp https://myapp.example.com [--dev http://localhost:5173]

# A browser-only app: public client, no secret
scripts/register-app.mjs myapp-web https://myapp.example.com --type spa [--dev http://localhost:5173]

# An Android app: public client, custom-scheme redirect (your package name is a good scheme)
scripts/register-app.mjs myapp-android --type native \
    --redirect com.example.myapp:/oauth2redirect \
    --logout-redirect com.example.myapp:/logout
```

What each one creates, in Zitadel terms:

| | web | spa | native |
|---|---|---|---|
| Application type | Web | User agent | Native |
| Token endpoint auth | client secret (Basic) | none | none |
| Grants | authorization code | authorization code (+ refresh with `--refresh`) | authorization code + refresh token |
| Default redirect URI | `<url>/api/auth/grapesid/callback` | `<url>/auth/callback` | the one you pass |
| Default post-logout URI | `<url>/` | `<url>/` | the ones you pass |

Useful options: `--callback /path` (a different callback path), `--redirect URI` (repeatable, replaces the default), `--refresh`, `--rotate-secret` (web only: issue a new secret, the old one stops working), `--dry-run` (print what would be sent). Running a command again is safe: it updates the existing app.

**Redirect URIs are matched exactly.** `https://myapp.example.com/cb` and `https://myapp.example.com/cb/` are different. A mismatch is the most common integration error ([troubleshooting](#12-testing-and-troubleshooting)). Plain `http://` redirects are only accepted for apps registered with `--dev`, which also allows `http://localhost`.

**Output you keep:**

- **web:** `GRAPESID_ISSUER`, `GRAPESID_CLIENT_ID`, `GRAPESID_CLIENT_SECRET`, `PUBLIC_URL`. Put them in the server's environment (e.g. `.env`, mode 600, git-ignored). The secret is shown only when created.
- **spa / native:** issuer, client id, redirect URI, scopes. None of it is secret.

---

## 4. The sign-in flow, step by step

This is the protocol that every client type follows. The library you use does this for you; read it once so you know what to configure and check.

```
 App                      Browser                    GrapesID
  │ 1. make state, nonce,    │                            │
  │    code_verifier         │                            │
  │ 2. redirect ────────────►│── GET /authorize?… ───────►│
  │                          │◄── sign-in pages ─────────►│  (username, password,
  │                          │    (+ email code if new)   │   email verification)
  │                          │◄── 302 redirect_uri?code=…&state=…
  │ 3. receive code, check   │                            │
  │    state                 │                            │
  │ 4. POST /token  (code + code_verifier [+ secret]) ───►│
  │◄── id_token, access_token [, refresh_token] ──────────│
  │ 5. validate id_token                                  │
  │ 6. create your own session / store tokens             │
```

### 4.1 Authorization request

Send the browser to the authorization endpoint with these query parameters:

| Parameter | Value |
|---|---|
| `client_id` | From registration |
| `response_type` | `code` |
| `redirect_uri` | One of the registered URIs, byte for byte |
| `scope` | `openid profile email` (add `offline_access` for refresh tokens) |
| `state` | Random, unguessable, **bound to the user's browser** (cookie or app storage). Checked on return |
| `nonce` | Random. Will come back inside the ID token and must match |
| `code_challenge` | `base64url(SHA-256(code_verifier))`, no padding |
| `code_challenge_method` | `S256` |

`code_verifier` is a fresh random string of 43–128 characters (`A–Z a–z 0–9 - . _ ~`), generated per sign-in and kept until step 4. Generate it with a cryptographic random source.

Optional parameters, all supported:

| Parameter | Effect |
|---|---|
| `prompt=create` | Open the **registration** form instead of sign-in. Works only while self-service sign-up is on (`scripts/signup.mjs status`); otherwise the person sees "Registration disabled" |
| `prompt=login` | Ignore the existing GrapesID session and ask for credentials again. Use before sensitive actions |
| `prompt=none` | Never show UI: return the code if a session exists, otherwise an `login_required` error (for silent checks) |
| `login_hint` | Pre-fill the login name |
| `max_age=<seconds>` | Require authentication newer than this; check `auth_time` in the ID token |

### 4.2 Callback

GrapesID redirects to your `redirect_uri` with **either**:

- `?code=…&state=…`: success, continue; **or**
- `?error=…&error_description=…&state=…`: the person cancelled or something failed. Show a friendly message; never put `error_description` into HTML unescaped.

First check that `state` matches what you stored for this browser. If not, stop: this is a forged or stale callback. Each `code` is single-use and short-lived.

### 4.3 Token request

Back-channel `POST` to the token endpoint, `Content-Type: application/x-www-form-urlencoded`:

```
grant_type=authorization_code
code=<code from the callback>
redirect_uri=<exactly the one used in 4.1>
code_verifier=<the verifier from 4.1>
client_id=<id>                       # public clients only
```

- **web client:** authenticate with HTTP Basic: `Authorization: Basic base64(urlencode(client_id) + ":" + urlencode(client_secret))`.
- **spa / native:** no authentication; the `code_verifier` is the proof.

```bash
curl -s https://account.carlevato.net/oauth/v2/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code -d code="$CODE" \
  -d redirect_uri="https://myapp.example.com/api/auth/grapesid/callback" \
  -d code_verifier="$VERIFIER"
```

The response contains `id_token`, `access_token`, `expires_in`, and `refresh_token` if you asked for `offline_access` and the client allows it.

### 4.4 Validate the ID token

A JWT with three dot-separated parts. Check **all** of these, in this order, before trusting any claim:

1. **Signature.** Verify with the key whose `kid` matches the token header, from the JWKS endpoint. Accept only asymmetric algorithms you expect (`RS256`). Cache the JWKS, and refetch it **once** when you meet an unknown `kid` (keys rotate).
2. **`iss`** equals `https://account.carlevato.net` (compare after removing any trailing slash).
3. **`aud`** contains your `client_id`. If there are several audiences, `azp` must equal your `client_id`.
4. **`exp`** is in the future (allow about 60 seconds of clock skew).
5. **`nonce`** equals the one you sent in 4.1.
6. **`sub`** is present.

If you use a maintained OIDC library, it performs 1–6 when configured with the issuer and client id; confirm that nonce checking is on. If you write it yourself, `clients/node/grapesid.js` and Ignite's `server/grapesid.js` are tested references (about 150 lines, no dependencies).

> Because the ID token arrives directly from the token endpoint over TLS, the signature check is technically optional in the OIDC specification for the code flow, and some mobile libraries skip it. **Servers should still verify it**; it costs nothing and protects against a misconfigured proxy.

### 4.5 Email verification gate

Before you create a *new* account for someone, require `email_verified === true` (a real boolean, or the string `"true"`). Treat a missing claim as **not verified**. If the claim is absent from the ID token, ask the UserInfo endpoint with the access token before deciding. Details in [section 9](#9-people-and-accounts-what-your-app-has-to-decide).

### 4.6 Refreshing

With `offline_access` you get a `refresh_token`. When the access token expires:

```
POST /oauth/v2/token   grant_type=refresh_token&refresh_token=…&client_id=…   (+ Basic auth for web clients)
```

Store the **new** refresh token from each response if one is returned. If refresh fails with `invalid_grant`, the session is gone (signed out, revoked, expired): send the person through sign-in again.

---

## 5. Web app with a backend (recommended for websites)

The pattern is "backend for frontend": **the server** does the whole OIDC dance, and the browser only ever holds **your app's own session cookie**. GrapesID tokens never reach JavaScript. This is how Ignite works and what we recommend for any site that has a server.

### 5.1 The three routes

| Route | Does |
|---|---|
| `GET /api/auth/grapesid/start` | Creates `state`, `nonce`, `code_verifier`; stores them server-side keyed by `state`; sets a short-lived `HttpOnly; Secure; SameSite=Lax` cookie containing `state`; redirects to GrapesID (4.1) |
| `GET /api/auth/grapesid/callback` | Checks the `state` cookie equals the `state` parameter **and** is known and unexpired; exchanges the code (4.3); validates the ID token (4.4); finds or creates your user (section 9); starts your session; redirects home |
| `POST /api/auth/logout` | Destroys your session, then sends the browser to GrapesID's end-session URL (section 10) |

Details that matter:

- The state/nonce/verifier store may be in memory with a 10-minute expiry for a single-process server. Use a shared store if you run several instances.
- Use **`SameSite=Lax`** (not `Strict`) for the state cookie: the callback is a top-level navigation coming *from another site*, and `Strict` would drop the cookie.
- Never log tokens, codes or the client secret.
- Return the person to a fixed, known path after sign-in. If you support "return to the page I was on", validate that it is a **relative** path on your own site (open redirects).

### 5.2 Node, with no dependencies

Copy `clients/node/grapesid.js` into your project and set the four environment variables from registration:

```js
import * as grapesid from './grapesid.js'

// GET /api/auth/grapesid/start
const { url, state, maxAge } = await grapesid.startLogin()          // startLogin({ create: true }) opens registration
res.writeHead(302, {
  Location: url,
  'Set-Cookie': `${grapesid.STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/grapesid; Max-Age=${maxAge}`,
}).end()

// GET /api/auth/grapesid/callback
const q = new URL(req.url, 'http://x').searchParams
if (q.get('error')) return showError(q.get('error_description'))
const id = await grapesid.finishLogin({
  code: q.get('code'), state: q.get('state'), cookieState: cookieOf(req, grapesid.STATE_COOKIE),
})
// id = { sub, username, name, email, emailVerified, idToken }
const user = await findOrCreateUserBySub(id)                         // section 9
startSession(res, user, { idToken: id.idToken })                     // keep idToken for sign-out

// POST /api/auth/logout
const logoutUrl = await grapesid.logoutUrl(session.idToken)          // ends the GrapesID session as well
destroySession(req); redirect(res, logoutUrl)
```

### 5.3 Other languages

Use a maintained library and configure: issuer (discovery), client id, client secret, redirect URI, scopes `openid profile email`, **PKCE on**, and nonce validation on.

| Platform | Library |
|---|---|
| Python | Authlib, or `oic` |
| Java / Kotlin | Spring Security (`spring-boot-starter-oauth2-client`), or Nimbus |
| .NET | `Microsoft.AspNetCore.Authentication.OpenIdConnect` |
| PHP | `league/oauth2-client` with a generic provider, or `jumbojett/openid-connect-php` |
| Go | `github.com/coreos/go-oidc` + `golang.org/x/oauth2` (use `oauth2.S256ChallengeOption`) |
| Ruby | `omniauth_openid_connect` |

Whatever you use, verify you can see: the `code_challenge` in the authorization URL, `nonce` in the ID token check, and that the library rejects a token with the wrong audience.

---

## 6. Browser-only app (SPA)

If your app is static files plus JavaScript and **has no server at all**, it must be a **public client** (`--type spa`): there is nowhere to hide a secret. Security then rests on PKCE and on where you keep tokens.

> **Prefer a tiny backend if you can.** Tokens in browser JavaScript can be stolen by any cross-site-scripting bug or malicious dependency. With the backend pattern of [section 5](#5-web-app-with-a-backend-recommended-for-websites) there is nothing to steal. Use the SPA pattern only when a backend is genuinely impossible.

With [`oidc-client-ts`](https://github.com/authts/oidc-client-ts):

```ts
import { UserManager, WebStorageStateStore } from 'oidc-client-ts'

export const auth = new UserManager({
  authority: 'https://account.carlevato.net',           // discovery is automatic
  client_id: 'YOUR_CLIENT_ID',
  redirect_uri: `${location.origin}/auth/callback`,     // exactly as registered
  post_logout_redirect_uri: `${location.origin}/`,
  response_type: 'code',                                 // PKCE (S256) is on by default
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),   // not localStorage: shorter exposure
})

// sign in
auth.signinRedirect()                                    // auth.signinRedirect({ extraQueryParams: { prompt: 'create' } }) to register

// on /auth/callback
const user = await auth.signinRedirectCallback()
if (!user.profile.email_verified) { /* show "verify your email" */ }
history.replaceState({}, '', '/')                        // drop ?code=&state= from the address bar

// sign out
auth.signoutRedirect()
```

SPA rules:

- Keep tokens in memory or `sessionStorage`; never put them in cookies without `HttpOnly`, never in URLs, never in logs.
- Protect the app with a strict **Content-Security-Policy** (`script-src 'self'`, no inline scripts, no third-party script hosts).
- `redirect_uri` must be an exact registered origin and path. During development register `--dev http://localhost:5173`.
- If the browser reports a cross-origin (CORS) failure calling the token endpoint, check that the page's origin matches the origin of a registered redirect URI.
- Do not use `offline_access`/long-lived refresh tokens unless you accept that a stolen refresh token means a stolen session; if you do, register with `--refresh`.

---

## 7. Android app

An Android app is a **native public client**. The proven way is [**AppAuth for Android**](https://github.com/openid/AppAuth-Android): it opens the sign-in page in a **Chrome Custom Tab** (the system browser, which shares the person's GrapesID single-sign-on session), handles PKCE, state and nonce, and keeps the token state.

Never use a WebView for sign-in: the app could read the password, there is no shared session, password managers don't work, and it violates the OAuth standards for native apps (RFC 8252).

### 7.1 Register

```bash
scripts/register-app.mjs myapp-android --type native \
    --redirect com.example.myapp:/oauth2redirect \
    --logout-redirect com.example.myapp:/logout
```

Use your reverse-domain package name as the scheme. Note the single slash after the colon. Native clients get refresh tokens by default.

### 7.2 Gradle

```kotlin
// app/build.gradle.kts
android {
    defaultConfig {
        // The scheme part of your redirect URI. AppAuth wires an intent filter for it automatically.
        manifestPlaceholders["appAuthRedirectScheme"] = "com.example.myapp"
    }
}
dependencies {
    implementation("net.openid:appauth:0.11.1")        // check for the latest release
}
```

### 7.3 Sign in

The code below is illustrative and follows AppAuth's documented API; compile it against the version you use.

```kotlin
const val ISSUER = "https://account.carlevato.net"
const val CLIENT_ID = "YOUR_CLIENT_ID"
const val REDIRECT = "com.example.myapp:/oauth2redirect"
const val LOGOUT_REDIRECT = "com.example.myapp:/logout"

class AuthRepo(private val context: Context) {
    private val service = AuthorizationService(context)

    /** Step 1: discover the endpoints, build the request, open the Custom Tab. */
    fun startSignIn(launcher: ActivityResultLauncher<Intent>, register: Boolean = false) {
        AuthorizationServiceConfiguration.fetchFromIssuer(Uri.parse(ISSUER)) { config, ex ->
            if (config == null) { /* show "can't reach GrapesID" */ return@fetchFromIssuer }
            val request = AuthorizationRequest.Builder(
                config, CLIENT_ID, ResponseTypeValues.CODE, Uri.parse(REDIRECT),
            )
                .setScope("openid profile email offline_access")
                .also { if (register) it.setPrompt("create") }   // opens the registration form
                .build()                                          // PKCE (S256), state and nonce are generated for you
            launcher.launch(service.getAuthorizationRequestIntent(request))
        }
    }

    /** Step 2: in the ActivityResult callback. */
    fun handleResult(data: Intent?, onDone: (AuthState?) -> Unit) {
        val response = data?.let(AuthorizationResponse::fromIntent)
        val error = data?.let(AuthorizationException::fromIntent)
        val state = AuthState(response, error)
        if (response == null) { onDone(null); return }            // cancelled or failed: `error` says why
        service.performTokenRequest(response.createTokenExchangeRequest()) { tokenResponse, tokenError ->
            state.update(tokenResponse, tokenError)
            val idToken = tokenResponse?.idToken
            // AppAuth has already checked iss, aud, exp and nonce of the ID token.
            val verified = idToken?.let { jwtClaim(it, "email_verified") } == "true"
            if (!verified) { /* tell the person to verify their email, then sign in again */ onDone(null); return@performTokenRequest }
            persist(state)                                        // see 7.4
            onDone(state)
        }
    }
}
```

`jwtClaim` stands for reading one claim from the ID token payload (base64url-decode the middle part). The signature was delivered over TLS directly from the token endpoint, which is why this is acceptable on a device; verify it on any server that receives the ID token from the app.

### 7.4 Keep the session

- Persist `authState.jsonSerializeString()` in **EncryptedSharedPreferences** (Android Keystore backed), never plain `SharedPreferences`, never a file in shared storage, never logs. Restore with `AuthState.jsonDeserialize(...)`.
- Do not back it up: exclude the preferences file in `android:fullBackupContent` / `dataExtractionRules`.
- Use `authState.performActionWithFreshTokens(service, action)` before every API call: it refreshes the access token when needed and gives you a valid one.
- If refresh fails with `invalid_grant`, clear the stored state and show the sign-in screen.
- Survive process death: the sign-in Activity may be killed while the Custom Tab is open. Keep the pending request in `onSaveInstanceState` as AppAuth's samples do, and handle the redirect when the app restarts.

### 7.5 Calling your backend

Send `Authorization: Bearer <access token>` and see [section 8](#8-protecting-your-own-api) for how the server must check it. The app never sends the ID token to the server as proof of identity *for API calls* (use the access token), except when handing it over once to a backend that wants to verify the person.

### 7.6 Sign out

```kotlin
fun signOut(activity: Activity, state: AuthState) {
    val config = state.authorizationServiceConfiguration ?: return
    val request = EndSessionRequest.Builder(config)
        .setIdTokenHint(state.idToken)
        .setPostLogoutRedirectUri(Uri.parse(LOGOUT_REDIRECT))
        .build()
    clearStoredState()                                           // forget locally first
    activity.startActivity(service.getEndSessionRequestIntent(request))   // ends the GrapesID session too
}
```

Optional but good: also call the **revocation endpoint** with the refresh token so it stops working at once (`POST /oauth/v2/revoke`, `token=…&token_type_hint=refresh_token&client_id=…`).

### 7.7 Alternatives and notes

- **HTTPS App Links instead of a custom scheme:** register `--redirect https://myapp.example.com/oauth2redirect`, host a Digital Asset Links file at `/.well-known/assetlinks.json`, and declare an `autoVerify` intent filter. More robust against another app claiming your scheme, because custom schemes are not exclusive. PKCE already prevents a stolen code from being useful, so a custom scheme is acceptable.
- **Emulator and testing:** sign in on an emulator with Google Play (it needs Chrome). The redirect only works if the scheme in the manifest placeholder equals the one you registered.
- **Biometric unlock** of the stored session is a good addition on top: require it before releasing the refresh token.

---

## 8. Protecting your own API

If your Android app (or SPA) talks to a backend you control, that backend must decide who is calling. The client sends the **access token**; the server must verify it. GrapesID access tokens are **opaque** (not JWTs), so use one of these:

| Option | How | Notes |
|---|---|---|
| **UserInfo** (simplest) | `GET https://account.carlevato.net/oidc/v1/userinfo` with `Authorization: Bearer <token>`. A `200` gives `sub`, `email`, `email_verified`, `preferred_username`; `401` means invalid or expired | One round trip per check: cache the answer for a minute or so, keyed by a hash of the token |
| **Introspection** (strict) | `POST /oauth/v2/introspect` with the token, authenticated as an **API application** you create in the GrapesID console | The response says `active` and `client_id`, so you can accept only tokens issued to *your* app |

The caveat with UserInfo: it confirms the token belongs to a valid GrapesID session, but not *which app it was issued to*. In a household of your own apps that is usually fine. If your API must accept tokens from one specific client only (another app's token must be refused), use introspection and compare `client_id`.

Always: reject missing and expired tokens with `401`; map the caller by `sub`; enforce authorisation yourself (a valid token means "this is person X", not "person X may do this"); never accept a token passed in a URL; send API traffic over HTTPS only.

---

## 9. People and accounts: what your app has to decide

GrapesID answers "who is this?" and "is their email verified?". Everything about what that person may do in *your* app is yours.

### 9.1 Identity key

Store `sub` on your user record (Ignite calls it `grapesId`) and look people up by it. Usernames and emails are display data that can change in GrapesID; if you key on them, someone who changes their email loses their data, and someone who takes over a released address inherits another person's.

Refresh the display data (`name`, `preferred_username`, `email`) from the ID token at each sign-in.

### 9.2 First sign-in: create the account or refuse

On a sign-in whose `sub` you do not know:

1. If your app is **invite-only**, refuse with a clear message ("ask the owner to add you"). Have a switch (Ignite: `ALLOW_REGISTRATION`).
2. Otherwise require `email_verified === true`. If not, **do not create anything**; tell the person to open the link or code GrapesID emailed them and sign in again. (GrapesID's own sign-in pages already require verification, so this is defence in depth, but do not rely on it: it can be switched off, and other identity configurations differ.)
3. Apply a ceiling on how many accounts you will create while sign-up is open (Ignite: `MAX_ACCOUNTS`).
4. Create the record with `sub`, display data and an empty workspace.

Existing accounts you already linked keep working even if their email later becomes unverified; the gate is for *new* accounts.

### 9.3 Opening or closing sign-up

Two independent switches decide whether a stranger can end up with an account in your app:

| Switch | Where | Effect |
|---|---|---|
| Self-service sign-up | GrapesID: `scripts/signup.mjs on\|off` | Whether people can create a GrapesID account at all. Needs working email: `scripts/smtp.mjs` |
| New plans/accounts in your app | Your app (Ignite: `ALLOW_REGISTRATION`) | Whether a GrapesID person you have not seen gets an account **here** |

You can have sign-up on in GrapesID and still keep a given app invite-only. Show a "Create an account" button in your app only when both are open: it should start sign-in with `prompt=create`.

### 9.4 Migrating people who already have accounts in your app

Link them, do not duplicate them: create each person in GrapesID with their existing password hash, store the returned id as `sub` on your record, and nothing else about their data changes. Use `migrations/ignite/` as the template:

1. Read the app's users.
2. Create each one in GrapesID (`POST /v2/users/new`) with `human.hashedPassword.hash` set to their existing hash in [Modular Crypt Format](https://zitadel.com/docs/guides/migrate/users). Supported: bcrypt (`$2a$`/`$2b$`), argon2, scrypt (`$scrypt$ln=..,r=..,p=..$<b64 salt>$<b64 hash>`), pbkdf2, sha2 crypt, md5, phpass. To accept a new family, add it to `ZITADEL_SYSTEMDEFAULTS_PASSWORDHASHER_VERIFIERS` in `docker-compose.yml` and run `./deploy.sh --no-pull`.
3. Pass real addresses (`--email user=address`) so the accounts are **verified**; otherwise those people are asked to verify once at their next sign-in.
4. Write the returned user id back as `sub` on the app's record, so existing data stays attached.

If a username already exists in GrapesID, the migration links to that user instead of creating a duplicate: that is "one account across apps" when it is the same person, and an **account takeover** when it is not. Read the `~` lines in the dry run and apply only once each is really the same person.

### 9.5 Changing a password, name or email

These live in GrapesID, not in your app. Link to the account page (`https://account.carlevato.net/ui/console/users/me`) from your settings screen. Remove any local password, reset-password and change-email screens; keep a read-only display of who is signed in.

### 9.6 Deleting a person

Deleting someone in GrapesID does not tell your app. Decide what your app does with data whose person no longer exists, and offer the person a way to delete their data in your app.

---

## 10. Sign-out and sessions

There are two sessions: **yours** (cookie or stored tokens) and **GrapesID's** (the single sign-on session in the person's browser). "Sign out" should end both, otherwise the next "Sign in" signs them straight back in with no prompt.

**RP-initiated logout.** Send the browser to the end-session endpoint:

```
GET https://account.carlevato.net/oidc/v1/end_session
      ?id_token_hint=<the id_token you received>
      &post_logout_redirect_uri=<a registered post-logout URI>
      &client_id=<client id>
      [&state=<anything to get back>]
```

- Destroy your own session **first**, then redirect.
- `post_logout_redirect_uri` must be registered (`--logout-redirect`, or the default `<url>/`).
- Without `id_token_hint` GrapesID may ask the person to confirm the sign-out; with it, sign-out is normally immediate. Keep the ID token for this (server-side session, or in the app's encrypted state).
- Signing out through the end-session endpoint ends the GrapesID session, so the person is signed out of GrapesID. Other apps keep their *own* sessions until those expire or the person signs out there, because each app owns its session. If an app needs "sign out everywhere now", it has to check with GrapesID periodically (`prompt=none`, or refresh-token use) and end its session when that fails.

**Session lifetimes.** After a password check, GrapesID treats the person as signed in for the password-check lifetime of its login policy (currently 10 days; adjustable in the console under Default settings → Login behavior). Within it, sign-in to any app is immediate. Your own session length is your decision: keep it shorter than your risk tolerance and re-run sign-in with `prompt=login` before sensitive actions (changing settings, deleting data, exporting).

---

## 11. Security checklist

Tick every line before you ship.

**All clients**
- [ ] Authorization Code flow with **PKCE S256**; no implicit, no password grant
- [ ] A fresh random `state`, **bound to the browser/app instance** and verified on return
- [ ] A fresh random `nonce`, verified inside the ID token
- [ ] `redirect_uri` registered exactly; no wildcards, no open "return to" parameters
- [ ] ID token: signature (from JWKS, asymmetric only), `iss`, `aud`/`azp`, `exp`, `nonce`
- [ ] New accounts require `email_verified == true`; a missing claim counts as unverified
- [ ] Users keyed by `sub`
- [ ] Tokens, codes and secrets never appear in logs, URLs, analytics or crash reports
- [ ] All traffic over HTTPS
- [ ] Errors from the callback (`?error=`) are handled and escaped
- [ ] Sign-out ends your session **and** GrapesID's

**Web app with a backend**
- [ ] Client secret only on the server (env/secret store, not in git, not in the client bundle)
- [ ] Your own session cookie: `HttpOnly; Secure; SameSite=Lax` (or stricter), random id, rotated at sign-in
- [ ] State cookie `SameSite=Lax`, short-lived, scoped to the callback path
- [ ] Protect state-changing routes against CSRF (JSON-only + same-origin checks, or tokens)
- [ ] Rate-limit the start and callback routes

**SPA**
- [ ] Strict Content-Security-Policy, no inline scripts, minimal dependencies
- [ ] Tokens in memory/`sessionStorage`, never `localStorage` or readable cookies
- [ ] Considered a backend first (section 6)

**Android**
- [ ] Sign-in in a Custom Tab / system browser, **never a WebView**
- [ ] No client secret in the APK (there is none)
- [ ] `AuthState` in EncryptedSharedPreferences, excluded from backups
- [ ] Redirect scheme equals the registered URI; consider App Links
- [ ] Refresh failure (`invalid_grant`) returns the person to sign-in
- [ ] Server validates access tokens on every API call (section 8)
- [ ] Release builds: no logging of tokens, no `debuggable`

---

## 12. Testing and troubleshooting

**Smoke tests from a terminal**

```bash
# Is GrapesID up, and what does it advertise?
curl -s https://account.carlevato.net/.well-known/openid-configuration | head -c 400

# Does the authorization endpoint accept your parameters? (opens the sign-in page: 302 or 200, not an error page)
curl -sI "https://account.carlevato.net/oauth/v2/authorize?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=$REDIRECT&code_challenge=$(openssl rand -hex 16)&code_challenge_method=S256&state=x" | head -3

# Look inside a token (decode only; this does NOT verify anything)
echo "$ID_TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
```

**Common problems**

| What you see | Usual cause | Fix |
|---|---|---|
| An error page saying the redirect URI is not registered or is invalid | Registered URI differs from what you send (trailing slash, `http` vs `https`, port, case) | Compare byte for byte; re-run `register-app.mjs` with the right `--callback`/`--redirect` |
| `invalid_client` at the token endpoint | Wrong client id or secret; secret not URL-encoded in Basic auth; secret rotated | Re-check `.env`; `--rotate-secret` if lost |
| `invalid_grant` | Code used twice, expired, or `code_verifier`/`redirect_uri` differ from the authorization request | Generate the verifier once per sign-in; reuse exactly the same `redirect_uri` |
| Callback says your *state* is unknown/expired | Cookie dropped (`SameSite=Strict`, wrong `Path`, third-party blocking), server restarted mid sign-in, or two browsers | `SameSite=Lax`; cookie `Path` must include the callback; use a shared state store if you run several instances |
| ID token "nonce mismatch" | You stored the nonce per session, not per sign-in attempt | Keep state, nonce and verifier together, keyed by `state` |
| ID token expired or "not yet valid" | Server clock off | Run NTP; allow about 60 seconds of skew |
| "Registration disabled" after `prompt=create` | Self-service sign-up is off on GrapesID (or was switched on less than a minute ago) | `scripts/signup.mjs status`/`on`; wait a minute, the sign-in pages cache settings briefly |
| Sign-in loops on a "verify your email" screen | The address is unverified and email is not delivering | `scripts/smtp.mjs status`; check the inbox and spam; the admin can mark the address verified in the console |
| Your app says "please verify your email" after the person did sign in | The claim is `false` or absent for that account | Check the account in the console; if the claim is absent from the ID token, fall back to UserInfo |
| Browser blocks the token request with a cross-origin error (SPA) | Page origin is not the origin of a registered redirect URI | Register the exact origin (`--dev` for localhost) |
| Android: Custom Tab never returns to the app | Manifest placeholder scheme differs from the registered redirect scheme; another app claims the scheme | Make them identical; use App Links |
| Works for the admin but not for a new person | The person has no account in your app and the app is invite-only | Section 9.2 |

**Logs on the server** (as the GrapesID user): `docker compose logs -f zitadel login`. The sign-in pages log under `login`, the token and authorization endpoints under `zitadel`.

---

## 13. Reference

**Parameters at a glance**

| Authorization request | | Token request (code) | |
|---|---|---|---|
| `client_id` | required | `grant_type=authorization_code` | required |
| `response_type=code` | required | `code` | required |
| `redirect_uri` | required | `redirect_uri` | required, same as before |
| `scope` | required, includes `openid` | `code_verifier` | required |
| `state`, `nonce` | required in practice | `client_id` | public clients |
| `code_challenge`, `code_challenge_method=S256` | required | `Authorization: Basic …` | web clients |
| `prompt`, `login_hint`, `max_age` | optional | | |

**Scopes**

| Scope | Gives |
|---|---|
| `openid` | An ID token with `sub` |
| `profile` | `name`, `given_name`, `family_name`, `preferred_username`, `locale` |
| `email` | `email`, `email_verified` |
| `offline_access` | A refresh token (client must allow the refresh grant; native clients do by default) |

**Client types as registered**

| | web | spa | native |
|---|---|---|---|
| Zitadel app type | Web | User agent | Native |
| `authMethodType` | Basic | None | None |
| Secret | yes | no | no |
| Refresh by default | no (`--refresh`) | no (`--refresh`) | yes |

**Files in this repository that help**

| | |
|---|---|
| `clients/node/grapesid.js` | Dependency-free OIDC client for Node servers (PKCE, state, nonce, ID-token verification, logout URL) |
| `scripts/register-app.mjs` | Register or update an app (web, spa, native) |
| `scripts/signup.mjs`, `scripts/smtp.mjs` | Turn self-service sign-up on or off; set up the email that verification needs |
| `migrations/ignite/` | A worked example of moving an existing app's accounts, with their passwords, into GrapesID |
| Ignite's `server/grapesid.js` and routes in `server/index.js` | A complete production integration (web client) |

**Standards**

[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) · [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636) · [RFC 8252 OAuth for native apps](https://www.rfc-editor.org/rfc/rfc8252) · [RFC 9700 OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700) · [OIDC RP-initiated logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
