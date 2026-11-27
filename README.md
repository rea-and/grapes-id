# GrapesID

One account for all your apps. GrapesID is a self-hosted single sign-on server built on [Zitadel](https://zitadel.com).
Apps use standard OpenID Connect: people click "Continue with GrapesID", sign in once, and are signed in everywhere.

```
             https://account.carlevato.net  (Apache, HTTPS)
               │
               ├── /ui/v2/login/*  ──►  login    sign-in pages (Zitadel Login V2)       127.0.0.1:8180+1
               └── everything else ─►  zitadel  OIDC, admin console, APIs              127.0.0.1:8180
                                         │
                                         └──►  db  Postgres (Docker network only)
  apps (Ignite, …) ── OIDC code flow + PKCE ──► GrapesID
```

## What's here

| Path | What it is |
|---|---|
| `deploy.sh` | First-time setup and updates on the server (Docker + Apache + certbot) |
| `docker-compose.yml` | Postgres, Zitadel, the login pages. Instance named **GrapesID**, sign-up closed, plain usernames |
| `deploy/apache-grapesid.conf` | Apache site template (installed by `deploy.sh --setup`) |
| `deploy/backup.sh` | Database dump to `backups/` (runs before every update; cron it for daily backups) |
| `scripts/register-app.mjs` | Register an app, print its `GRAPESID_*` settings |
| `migrations/ignite/` | Move Ignite's accounts into GrapesID **with their existing passwords** and link them |
| `clients/node/grapesid.js` | Drop-in, zero-dependency OIDC client for Node apps |
| `docs/connect-an-app.md` | How to connect the next app |

## Set up (once)

Requirements on the server: Docker with Compose v2 (your user in the `docker` group), Apache, certbot, Node 22+ (for the scripts).

1. DNS: `account.carlevato.net` already points at the server (157.230.244.80).
2. Run:
   ```bash
   ./deploy.sh --setup --admin-email you@example.com     # domain defaults to account.carlevato.net
   ```
   This does the following:
   - writes `.env` with fresh secrets;
   - installs the Apache site and gets an HTTPS certificate;
   - starts the containers and creates the GrapesID instance;
   - saves the automation token to `secrets/admin.pat`.
3. Sign in at `https://account.carlevato.net/ui/console` as `admin`, using the password in `secrets/admin-password.txt`. Change the password, then delete that file.
4. **Back up `.env`** somewhere safe. `GRAPESID_MASTERKEY` encrypts secrets in the database, so database backups can't be restored without it.
5. Optional: set up SMTP in the console (*Default settings → SMTP provider*) so password resets and e-mail verification work.

## Update

```bash
./deploy.sh              # back up the DB, pull images, restart, health-check
```

To upgrade Zitadel, set `ZITADEL_VERSION` in `.env` and run `./deploy.sh`. Run `./deploy.sh --status` to see container health.

## Migrating Ignite (first use-case)

Ignite kept its own accounts, with scrypt password hashes in `ignite/data/users.json`. The migration copies those hashes into GrapesID unchanged, re-encoded in the `$scrypt$…` format Zitadel verifies. Everyone keeps their username and password. Zitadel replaces each hash with its own (bcrypt) at that person's first sign-in. Plans are not touched.

```bash
# 1. Register Ignite as an app; this prints four GRAPESID_* lines
scripts/register-app.mjs ignite https://ignite.carlevato.net

# 2. Dry run, then the real thing. GrapesID needs an e-mail per user: pass real ones with --email,
#    otherwise the user gets a placeholder (<user>@users.<domain>) they can change later.
migrations/ignite/migrate.mjs --ignite-data ~/projects/ignite/data --email reaand=you@example.com
migrations/ignite/migrate.mjs --ignite-data ~/projects/ignite/data --email reaand=you@example.com --apply

# 3. Turn on SSO in Ignite: paste the printed lines into ~/projects/ignite/.env, then deploy it
cd ~/projects/ignite && ./deploy.sh
```

What the migration does to Ignite's data:

- It backs up `users.json` (to `users.json.before-grapesid-<time>`).
- It adds a `grapesId` field to each user. That field is how Ignite finds each person's existing plan.

Running the migration again is safe:

- users that are already linked are skipped;
- if GrapesID already has a user with the same username, that user is linked and their password is left alone.

**Rollback:** empty `GRAPESID_ISSUER` in Ignite's `.env` and run `./deploy.sh` again. Local password sign-in comes back, because the old hashes are kept.

After the switch:

- **New people:** GrapesID users without an Ignite plan get a new, empty one, unless `ALLOW_REGISTRATION=false` is set in Ignite's `.env`. Create people in the GrapesID console.
- **Passwords and profiles** are managed in GrapesID. Ignite's account menu links there.
- **Sign-out** signs out of GrapesID as well.

## Sign-in branding

The sign-in pages carry the GrapesID look (logo, glass card, light and dark). It is installed by `deploy/brand.sh`, which runs after every `./deploy.sh`; see [`branding/`](branding/README.md) to change or switch it off (`./deploy.sh --brand`, `deploy/brand.sh --remove`).

## Notes

- **Signing in:** people sign in with their plain username (`reaand`), not `reaand@grapes.<domain>`. Self sign-up is off (`GRAPESID_ALLOW_SIGNUP=false`). That setting only applies on the first start; after that, change it in the console under *Default settings → Login behavior*.
- **HTTP/2:** Apache proxies over HTTP/1.1, because this server runs `mpm_prefork` for PHP and prefork can't serve HTTP/2. Browsers, the console and OIDC all work. Only native gRPC clients would need HTTP/2.
- **Data:** it lives in the Docker volumes `grapesid_pgdata` and `grapesid_bootstrap`. Deploys never remove them.
- **Logs:** `docker compose logs -f zitadel login`.
