# User management in GrapesID

Everything about people in GrapesID: where they come from, how they sign in, how you manage them, what the apps keep on their own, and what to watch out for. The values below were read from the running server on 2026-11-27 unless a line says otherwise.

**Contents**

1. [The model: two layers](#1-the-model-two-layers)
2. [What identifies a person](#2-what-identifies-a-person)
3. [How people get an account](#3-how-people-get-an-account)
4. [Signing in](#4-signing-in)
5. [Email verification](#5-email-verification)
6. [Account states and lifecycle](#6-account-states-and-lifecycle)
7. [Administration](#7-administration)
8. [Runbooks](#8-runbooks)
9. [Who can join: the switches](#9-who-can-join-the-switches)
10. [Apps and their own accounts (Ignite)](#10-apps-and-their-own-accounts-ignite)
11. [Service accounts](#11-service-accounts)
12. [Data, privacy and backups](#12-data-privacy-and-backups)
13. [Known gaps and recommendations](#13-known-gaps-and-recommendations)
14. [Troubleshooting](#14-troubleshooting)
15. [Command reference](#15-command-reference)

---

## 1. The model: two layers

```
  ┌────────────────────────────── GrapesID ───────────────────────────────┐
  │  Identity: who someone is                                              │
  │  username · name · email (+ verified?) · password / passkey · state    │
  │  one record per person, one id (`sub`)                                 │
  └───────────────┬──────────────────────────────────┬────────────────────┘
                  │ "this is person 401447…"          │
        ┌─────────▼─────────┐              ┌─────────▼─────────┐
        │  Ignite           │              │  any other app    │
        │  Account: plan,   │              │  its own account, │
        │  check-ins, …     │              │  its own data     │
        └───────────────────┘              └───────────────────┘
```

- **GrapesID** knows *who* a person is and proves it at sign-in. It never holds an app's data.
- **Each app** keeps its own account record for that person, linked by the person's id, plus all the data the app is about. An app decides for itself whether to give a new person an account.
- Consequence: **changes in GrapesID do not reach into the apps.** Deactivating or deleting someone in GrapesID stops their sign-in; the data they created in an app stays in that app until the app's owner removes it ([section 10](#10-apps-and-their-own-accounts-ignite)).

GrapesID is Zitadel underneath. There is one organization, **Grapes**, and every person lives in it. Apps are registered as separate projects in the same organization.

---

## 2. What identifies a person

| Field | What it is | Can it change? | Who uses it |
|---|---|---|---|
| **User id** (`sub`) | A long number, e.g. `401447436188385283`. Shown by `scripts/users.mjs list` | **Never** | Apps store it to find the person. It is the real identity |
| **Username** (login name) | What the person types to sign in | Yes, by an admin in the console | Sign-in screen, display |
| **Email** | Where codes and resets go | Yes | Verification, resets, notifications |
| **Name** | Display name | Yes | Greetings, avatars |
| **State** | active, inactive, locked, initial | Admin | See [section 6](#6-account-states-and-lifecycle) |

Things that surprise people:

- **Two kinds of username.** People an admin created or migrated have a plain username (`reaand`). People who **sign themselves up** get their **email address as their username** (`name@example.com`). Apps must not assume either form; they show the name and key on the id.
- **Typing `admin` works** even though the stored username is `admin@grapes.account.carlevato.net`: the sign-in pages hide the domain suffix on purpose, so plain names work.
- **An email address can belong to more than one account.** Today `reaand` and `admin` share one address. Signing in with that *email* then fails with **"Multiple users found"**. Sign in with the **username** instead (`reaand`, `admin`). Keep one address per person where you can, and when you create extra accounts for yourself, use a different address or tell people to type the username.
- **Plus-addresses are different addresses.** `name+test@gmail.com` and `name@gmail.com` are two identities to GrapesID, although both reach the same mailbox. That is handy for testing, and a way for one person to hold two accounts.
- **Changing a username or email does not change the id**, so the person keeps their data in every app. Apps refresh the display name and username at the person's next sign-in.

---

## 3. How people get an account

There are four routes. Which are open is controlled by the switches in [section 9](#9-who-can-join-the-switches).

### 3.1 You create them (invite-only)

Console → **Users → New**. Give a username, name, email, and either a password you tell them or let them set it themselves.

- Mark the address **verified** if you know it is theirs; otherwise they are asked to verify once at first sign-in (GrapesID emails a code).
- Choose a password that meets the rules in [section 4](#4-signing-in), or let the person pick one through the reset link.
- The person still needs an account **inside each app**, and each app decides whether to create it (see 3.4). An app that is invite-only needs you to add the person there too.

### 3.2 Migrated from an app

`migrations/ignite/migrate.mjs` moved Ignite's existing accounts into GrapesID **with their passwords**, linked by username. After a migration the people sign in with the same username and password. Details and safety rules (never link two different people by accident) are in `INTEGRATION.md`, section 9.4. Migrated accounts got a placeholder email unless a real one was passed with `--email`; those people are asked to verify an address once.

### 3.3 They sign themselves up

Only while **self-service sign-up is on** (`scripts/signup.mjs on`; it refuses to turn on unless email works). The path a new person takes from an app that offers it (Ignite shows **Create a GrapesID account**):

1. The app sends them to GrapesID with `prompt=create`; the **registration form** opens: first name, last name, email, and the sign-in method (**passkey** or **password**).
2. If they choose a password it must meet the policy: at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol.
3. GrapesID **emails a verification message** to the address they gave and shows the verify page. The sign-in does not complete until the address is verified.
4. After verifying, they return to the app. If the app is open to new people, it creates their account there now; if not, it tells them it is by invitation.

Their username is their email address. Anyone who can reach the page and receive email at an address can do this, so turn sign-up on only when you mean it ([section 13](#13-known-gaps-and-recommendations)).

### 3.4 First sign-in to an app

When a GrapesID person signs in to an app for the first time, the **app** decides. Ignite's rules, in order:

1. Already linked (their id is known)? Sign them in. Nothing else is checked.
2. Not known, and Ignite is invite-only (`ALLOW_REGISTRATION=false`)? Refuse: "ask the owner to enable new accounts".
3. Email not verified? Refuse: "verify your email first". No account is created.
4. More than `MAX_ACCOUNTS` (default 100) accounts already? Refuse.
5. Otherwise create the account and an empty plan.

---

## 4. Signing in

| Setting | Value on this server |
|---|---|
| Login name | Plain username (domain suffix hidden); email address for self-signed-up people |
| Password rules | Minimum 8 characters; must contain uppercase, lowercase, number and symbol |
| Password expiry | None (password age policy not set) |
| Wrong-password lockout | **None.** The lockout policy has no attempt limit, so repeated wrong passwords never lock an account ([section 13](#13-known-gaps-and-recommendations)) |
| Passkeys | Allowed. People can register one instead of a password |
| Second factor | Allowed (authenticator app, security key) but **not required** |
| Signed-in session at GrapesID | 10 days after a password check, then the password is asked again (login policy; adjustable) |
| Email on password change | Sent |
| Password storage | Stored hashed. Passwords imported from Ignite arrive as scrypt hashes and are **upgraded to bcrypt at that person's next sign-in** |

**Single sign-on.** Within the 10-day window, a person already signed in to GrapesID gets into any connected app without typing anything. Each app keeps its own session on top of that; Ignite's lasts up to 60 days.

**Forgot password.** The password page has **Reset Password**: GrapesID emails a link (needs working email). You can also trigger one (`scripts/users.mjs password-reset <user>`) or set one directly (`set-password`).

---

## 5. Email verification

A verified address matters because it is how people recover accounts and how you know a sign-up is a real mailbox.

**Where it is enforced (two independent places)**

1. **GrapesID's sign-in pages** (`EMAIL_VERIFICATION: "true"` on the login service in `docker-compose.yml`): someone with an unverified address is sent a code and must enter it before the sign-in completes. This applies to every app.
2. **Each app's own check.** Ignite only creates a *new* account for a person whose ID token says `email_verified: true`. A missing claim counts as unverified. Already-linked people are not re-checked.

**What it depends on:** outgoing email. It is configured through `scripts/smtp.mjs` (credentials are typed at a hidden prompt and stored encrypted inside GrapesID's database, not in `.env`). Without working email nobody new can verify, and sign-up refuses to turn on. Check with `scripts/smtp.mjs status`.

**Special cases**

- *They cannot get the email* (typo, spam, mailbox gone): an admin can mark the address verified: `scripts/users.mjs verify-email <user>`, or change the address first in the console.
- *Migrated or console-created accounts with a placeholder address* are asked to verify once at next sign-in.
- Verification state is shown by `scripts/users.mjs list` in the VERIFIED column.

---

## 6. Account states and lifecycle

| State | Meaning | How it happens | Can sign in? | How to change |
|---|---|---|---|---|
| **active** | Normal | Default | Yes | n/a |
| **inactive** | Blocked by an admin | `users.mjs deactivate`, or console | **No** | `reactivate` |
| **locked** | Too many wrong passwords | Only if a lockout policy is set (none is now) | No | Unlock in the console |
| **initial** | Created without a password or verified email; not finished | Console-created account that has not been set up | After setup | Person completes setup, or admin sets a password |
| *(deleted)* | Gone | `users.mjs delete <user> --yes`, or console | No | Cannot be undone; the id is never reused |

**What each action does to the apps**

| Action in GrapesID | Effect on the person's data in apps | Effect on their open sessions in apps |
|---|---|---|
| Deactivate | None: data stays | **Existing app sessions keep working until they expire** (Ignite: up to 60 days). Only new sign-ins are blocked |
| Delete | None: the app keeps an orphaned account and its data | Same as above |
| Change username / email / name | None; apps refresh display data at next sign-in | None |
| Change password | None | None |

So "deactivate" cuts *future* access, not access already granted. To remove access at once you also have to end the app-side session ([section 8.4](#84-remove-someone-who-has-left)).

---

## 7. Administration

### 7.1 Web console

https://account.carlevato.net/ui/console. Sign in as **`admin`** (type just `admin`; do not use the email address, see [section 2](#2-what-identifies-a-person)). The first password was written to `secrets/admin-password.txt` at setup; change it after your first sign-in and delete the file.

What lives where (menu names may differ slightly between Zitadel versions):

| To… | Go to |
|---|---|
| List, search, open people | **Users** |
| Edit name, username, email; deactivate; set or reset a password; delete; view sessions and security | the person's page |
| Create someone | **Users → New** |
| See connected apps, their redirect URIs and client ids; rotate an app's secret | **Projects** → an app |
| Turn self-registration, passkeys, second factors on or off; set the session lifetime | **Default settings → Login behavior** |
| Password rules and lockout | **Default settings** (password complexity, lockout) |
| Outgoing email | **Default settings → SMTP** (or `scripts/smtp.mjs`) |
| Branding of the sign-in pages and emails | **Default settings → Branding** (managed by `scripts/brand.mjs`; edit the repo instead) |

### 7.2 Command line

On the server, in `~/projects/grapes-id` (they use the automation token in `secrets/admin.pat`):

```
scripts/users.mjs list                   # everyone: username, state, email, verified, created, id
scripts/users.mjs show <user>            # one person in detail
scripts/users.mjs deactivate <user>      # block sign-in (reversible)
scripts/users.mjs reactivate <user>
scripts/users.mjs verify-email <user>    # mark the address verified
scripts/users.mjs password-reset <user>  # email them a reset link
scripts/users.mjs set-password <user>    # choose a password now (typed hidden)
scripts/users.mjs delete <user> --yes    # permanent
```

`<user>` is a username, an email address, or the id from `list`. If an email matches more than one person (as `andrea.carlevato@gmail.com` does today) the command stops and asks you to use the username or id. Reads can lag a few seconds behind a write. `password-reset` and `set-password` were not exercised against a live account when this was written.

### 7.3 What an admin can *not* do from here

- See anyone's password (they are hashed).
- Merge two accounts into one (see [8.7](#87-two-accounts-for-one-person)).
- Move a person's data between apps.
- Get a history of who changed what from `users.mjs`. The console and the container logs (`docker compose logs zitadel`) are the trail.

---

## 8. Runbooks

### 8.1 Add a person (invite-only)

1. Console → **Users → New**: username, name, email; mark the email verified only if you are sure it is theirs.
2. Send them the username, then let them set their password via **Reset Password** on the sign-in page (or `set-password` and tell them privately).
3. If the app is invite-only, add them there too (Ignite: temporarily `ALLOW_REGISTRATION=true`, they sign in once, then back to `false`; or leave it open if you accept new accounts).

### 8.2 Let strangers sign themselves up

```
scripts/smtp.mjs status                  # must say ACTIVE
scripts/signup.mjs on                    # refuses if email is not set up
# Ignite: ALLOW_REGISTRATION=true in its .env, then ./deploy.sh --no-pull
```
Sign-in pages can take a minute to notice the switch. Turn it back off with `scripts/signup.mjs off` and `ALLOW_REGISTRATION=false`. Read [section 13](#13-known-gaps-and-recommendations) first.

### 8.3 Someone forgot their password

Tell them to use **Reset Password** on the sign-in page. If email does not reach them: `scripts/users.mjs set-password <user>`, give them the new password, and ask them to change it at once.

### 8.4 Remove someone who has left

1. `scripts/users.mjs deactivate <user>` (stops new sign-ins; reversible).
2. End their open sessions in each app. In Ignite there is no screen for this; sessions are in `data/sessions.json` and last up to 60 days. To cut access immediately: find the person's Ignite id in `data/users.json`, then, with Ignite stopped, remove the entries in `data/sessions.json` whose `userId` equals that id, and start Ignite again. Make a copy of the file first. *This procedure is manual and was not run when this document was written.*
3. Decide about their data: leave it, export it for them (their plan file), or delete it (below).
4. Only then, if you want them gone for good: `scripts/users.mjs delete <user> --yes`.

### 8.5 Delete a person's data in an app

Ignite has no delete-account feature. Their account is an entry in `data/users.json` and their plan is `data/workspaces/<ignite user id>.json` (plus daily snapshots in `data/backups/<id>/`). Removal is manual: stop Ignite, back up `data/`, delete those entries and files, start Ignite. Treat this as an operation to do carefully and rarely. A proper delete-account feature in Ignite would be the better answer if you expect to need it.

### 8.6 Change someone's username or email

Console → their page → edit. Their id stays, so they keep their data everywhere. If you change their email, verify the new one (the person gets a code, or use `verify-email`). They will see the new name in apps after their next sign-in.

### 8.7 Two accounts for one person

GrapesID cannot merge accounts, and apps link to one id each. Pick the account that owns the data you care about (the one the app is linked to), tell the person to use only that one, and deactivate the other. Do not point an app's record at a different id by hand unless you understand the consequences: whoever holds that id inherits the data.

### 8.8 You lost the admin password

On the server: `scripts/users.mjs set-password admin`. Or use **Reset Password** on the sign-in page (the admin's email address must receive mail). The automation token in `secrets/admin.pat` keeps working regardless.

### 8.9 Check what Ignite thinks of each person

On the server, in `~/projects/ignite`:

```
node -e "for (const x of Object.values(JSON.parse(require('fs').readFileSync('data/users.json','utf8')))) console.log(x.username.padEnd(34), x.grapesId ? 'linked to GrapesID' : 'NOT linked (local password only)')"
```

Compare with `scripts/users.mjs list`. A person present in GrapesID but absent here has no plan in Ignite (normal for people who never signed in there).

---

## 9. Who can join: the switches

| Switch | Where | Controls |
|---|---|---|
| **Self-service sign-up** | GrapesID: `scripts/signup.mjs on\|off` | Whether strangers can create a GrapesID account at all |
| **Outgoing email** | GrapesID: `scripts/smtp.mjs` | Verification codes and resets; sign-up needs it |
| **Email verification at sign-in** | GrapesID: `EMAIL_VERIFICATION` in `docker-compose.yml` | Unverified people cannot finish signing in |
| **New accounts in an app** | The app (Ignite: `ALLOW_REGISTRATION`) | Whether a GrapesID person the app has not seen gets an account there |
| **Account cap** | The app (Ignite: `MAX_ACCOUNTS`, default 100) | Stops creating accounts beyond that number |

The useful combinations:

| You want | Self-service sign-up | App `ALLOW_REGISTRATION` |
|---|---|---|
| Only people you add | off | false |
| Anyone can get a GrapesID account, but only you give out plans | on | false |
| Anyone can sign up and get a plan in the app | on | true (and keep `MAX_ACCOUNTS` sensible) |

Current setting (2026-11-27): self-service sign-up **on**, Ignite `ALLOW_REGISTRATION` **true** unless you changed it since; check with `scripts/signup.mjs status`.

---

## 10. Apps and their own accounts (Ignite)

For Ignite, each person has an entry in `~/projects/ignite/data/users.json`:

| Field | Meaning |
|---|---|
| `id` | Ignite's own id; names the plan file `data/workspaces/<id>.json` |
| `grapesId` | The person's GrapesID id (`sub`). This is the link |
| `username`, `name` | Display data, refreshed from GrapesID at each sign-in |
| `salt`, `hash` | Only on accounts that existed before GrapesID: the old local password, kept so Ignite can be rolled back to local sign-in. Not used while GrapesID sign-in is on |
| `createdAt` | When the account was made |

Plans are never touched by GrapesID. The link is what carries a person from GrapesID to their plan: break it (wrong id, deleted person re-created with a new id) and the person gets a **new empty plan** next time they sign in, while the old plan stays orphaned in `data/workspaces/`. Rolling back: clear `GRAPESID_ISSUER` in Ignite's `.env` and redeploy; local sign-in returns for accounts that kept their old hash.

Ignite sessions last 60 days and are separate from GrapesID's session (section 4).

---

## 11. Service accounts

Two non-human accounts exist (they appear in the console as machine users, not in `users.mjs list`):

| Account | Used by | Notes |
|---|---|---|
| `login-client` | The sign-in pages, to talk to GrapesID | Token in the Docker volume; not for you to use |
| `grapesid-automation` | `scripts/*.mjs` and `deploy.sh` | Token in `secrets/admin.pat` on the server. **It can do anything an instance owner can**: treat it like a root key, never copy it elsewhere, never commit it. It does not expire before 2099 |

---

## 12. Data, privacy and backups

**What is stored about a person**

| Where | Data |
|---|---|
| GrapesID database | Username, name, email and its verification state, password hash and/or passkeys, second factors, sign-in sessions, a record of events |
| Ignite server | Username, name, link id, session records, and the **plan itself** (all the financial figures they enter), plus daily snapshots of it |
| Email provider | Copies of the verification and reset messages sent to them |
| Server logs | Sign-in activity and IP addresses |

**Where it lives:** the GrapesID database is in the Docker volume `grapesid_pgdata` (secrets inside are encrypted with `GRAPESID_MASTERKEY` from `.env`). Ignite's data is in `~/projects/ignite/data/`.

**Backups: none exist yet for GrapesID** (checked 2026-11-27: the `backups/` folder is empty and there is no scheduled job). A backup is made automatically whenever `./deploy.sh` runs a full update, and you can make one any time:

```
deploy/backup.sh                          # writes backups/grapesid-<time>.sql.gz, keeps the newest 14
# daily at 03:15, add with `crontab -e`:
15 3 * * * /home/andi/projects/grapes-id/deploy/backup.sh >/dev/null
```

A backup restores only together with `GRAPESID_MASTERKEY` from `.env`: **keep a copy of `.env` somewhere safe, separate from the dumps.** Every account lives only in this database; losing it means everyone re-registering and every app's links being rebuilt by hand.

**If someone asks for their data to be erased:** delete their GrapesID account (`delete --yes`), remove their data in each app ([8.5](#85-delete-a-persons-data-in-an-app)), and remember the copies in backups, logs and the email provider, which age out on their own schedules.

---

## 13. Known gaps and recommendations

Honest list, most important first.

1. **No database backups yet.** Everything about people is in one database. Run `deploy/backup.sh` now and schedule it ([section 12](#12-data-privacy-and-backups)).
2. **No password lockout.** GrapesID currently accepts unlimited wrong passwords. With public sign-up on, accounts can be guessed at in the open. Set a limit in the console (Default settings → Lockout, for example 10 attempts), and keep the password rules as they are.
3. **Second factor and passkeys are optional.** Accounts that matter (`admin`, `reaand`) should have an authenticator app or a security key. Requiring it for everyone is a console setting; it would force every new person through setup.
4. **Public sign-up is open.** Anyone with an email address can create a GrapesID account, and with `ALLOW_REGISTRATION=true` also an Ignite plan. `MAX_ACCOUNTS` caps the damage; there is no per-IP limit on registrations at GrapesID itself. Turn it off when you do not need it.
5. **Deactivating someone does not end their app sessions** (up to 60 days in Ignite). Cutting access immediately is manual ([8.4](#84-remove-someone-who-has-left)). A future improvement would be Ignite re-checking with GrapesID periodically.
6. **Shared email between `admin` and `reaand`.** It makes email sign-in ambiguous and reset emails ambiguous. Give the admin account its own address (console → the admin's page).
7. **One admin.** If that account is lost and email also fails, recovery needs shell access to the server (`set-password`). Fine for a personal server, worth knowing.
8. **No delete-account feature in Ignite** ([8.5](#85-delete-a-persons-data-in-an-app)).
9. **The root-equivalent token** in `secrets/admin.pat` is a single point of failure ([section 11](#11-service-accounts)). Keep the server's file permissions as set (private to the user).

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Multiple users found" at sign-in | The email typed belongs to more than one account | Sign in with the **username** |
| "Registration disabled" | Self-service sign-up is off, or was switched on less than a minute ago | `scripts/signup.mjs status`; wait a minute |
| Person never gets the verification email | Email not configured, in spam, typo in the address | `scripts/smtp.mjs status`; check spam; correct the address in the console and `verify-email` if needed |
| App says "verify your email first" | The address is not verified yet | They open the email; or `verify-email <user>` |
| App says it is by invitation | App-level switch is off | Section 9 |
| Person signed in and got an **empty plan** | Their id is not linked to their old plan (account re-created, wrong link) | Section 10; do not let them enter data in the new plan until fixed |
| Cannot sign in at all | Account is inactive or locked, wrong password, or session at the app expired | `users.mjs show <user>` for the state; reset the password |
| Sign-in pages look unstyled | Branding snippet off | `./deploy.sh --brand` |
| `users.mjs` says "no such user" right after creating one | Reads lag a few seconds | Wait and retry |

Logs: `docker compose logs -f zitadel login` (sign-in pages log under `login`; accounts and tokens under `zitadel`).

---

## 15. Command reference

| Purpose | Command (in `~/projects/grapes-id` unless noted) |
|---|---|
| Who is registered | `scripts/users.mjs list` |
| One person | `scripts/users.mjs show <user>` |
| Block / unblock | `scripts/users.mjs deactivate <user>` / `reactivate <user>` |
| Verify an email by hand | `scripts/users.mjs verify-email <user>` |
| Send a password reset | `scripts/users.mjs password-reset <user>` |
| Set a password | `scripts/users.mjs set-password <user>` |
| Delete permanently | `scripts/users.mjs delete <user> --yes` |
| Sign-up on / off / state | `scripts/signup.mjs on` / `off` / `status` |
| Email setup / state | `scripts/smtp.mjs --host … --user … --from … --test …` / `scripts/smtp.mjs status` |
| Register an app | `scripts/register-app.mjs <name> <url> [--type spa\|native …]` |
| Branding | `./deploy.sh --brand` (install) · `deploy/brand.sh --remove` (off) |
| Back up the database | `deploy/backup.sh` |
| Update GrapesID | `git pull && ./deploy.sh` |
| Container status / logs | `./deploy.sh --status` · `docker compose logs -f zitadel login` |
| Migrate an app's accounts | `migrations/ignite/migrate.mjs --ignite-data <path>` (dry run first) |
| Integrate a new app | `INTEGRATION.md` |
