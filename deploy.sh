#!/usr/bin/env bash
# Deploy GrapesID (Zitadel + its login pages + Postgres, in Docker) on the Ubuntu server, behind Apache.
# Run it from this folder on the server, as the normal user (it uses sudo for Apache only):
#
#   ./deploy.sh --setup [domain] [--admin-email you@example.com]   first time: secrets, Apache site, HTTPS, start
#                                     (domain defaults to account.carlevato.net)
#   ./deploy.sh                       updates: git pull (if a git checkout), back up the database, pull images, restart
#   ./deploy.sh --no-pull             restart with the current files (e.g. after editing .env or docker-compose.yml)
#   ./deploy.sh --setup <domain> --no-https    skip certbot (you manage certificates yourself)
#   ./deploy.sh --status              show containers and health
#
# To upgrade Zitadel, change ZITADEL_VERSION in .env and run ./deploy.sh. Data lives in Docker volumes
# (grapesid_pgdata, grapesid_bootstrap); deploys never delete them. Secrets live in .env and secrets/ (both private).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
SITE_NAME=grapesid
SITE="/etc/apache2/sites-available/$SITE_NAME.conf"
SSL_SITE="/etc/apache2/sites-available/$SITE_NAME-le-ssl.conf"

DEFAULT_DOMAIN=account.carlevato.net
SETUP=0; DOMAIN=""; PULL=1; HTTPS=1; ADMIN_EMAIL=""; STATUS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup) SETUP=1; if [[ -n "${2:-}" && "$2" != -* ]]; then DOMAIN="$2"; shift; fi ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift ;;
    --no-pull) PULL=0 ;;
    --no-https) HTTPS=0 ;;
    --status) STATUS=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) printf 'deploy: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
envget() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }

if [[ $STATUS == 1 ]]; then docker compose ps; exit 0; fi

# ---------------------------------------------------------------- preflight
[[ "$(uname -s)" == Linux ]] || die "run this on the Ubuntu server, not on your laptop"
[[ $EUID -ne 0 ]] || die "run as the normal user that owns this folder (it uses sudo where needed), not as root"
for bin in docker curl openssl sudo; do command -v "$bin" >/dev/null || die "$bin is not installed"; done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (sudo apt install docker-compose-plugin)"
docker info >/dev/null 2>&1 || die "can't talk to Docker: add yourself to the docker group (sudo usermod -aG docker $USER, then log in again)"

if [[ $SETUP == 1 ]]; then
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  [[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "usage: ./deploy.sh --setup [your.domain.com]"
  command -v apache2ctl >/dev/null || die "Apache (apache2) is not installed"
  if ! getent hosts "$DOMAIN" >/dev/null; then
    echo "warning: $DOMAIN does not resolve yet. Add a DNS A record pointing to this server before requesting HTTPS." >&2
  fi
fi

# ---------------------------------------------------------------- configuration (.env)
umask 077
mkdir -p secrets
chmod 700 secrets
if [[ ! -f .env ]]; then
  [[ $SETUP == 1 ]] || die "no .env yet: run ./deploy.sh --setup first"
  log "Creating .env with fresh secrets"
  ADMIN_PASSWORD="Gr4pe-$(openssl rand -hex 12)!"   # meets Zitadel's default complexity policy
  pick_port() { local p=$1; while ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; do p=$((p + 1)); done; echo "$p"; }
  API_PORT="$(pick_port 8180)"
  LOGIN_PORT="$(pick_port $((API_PORT + 1)))"
  cat > .env <<EOF
# GrapesID settings, created by ./deploy.sh --setup on $(date -u +%Y-%m-%d). Private: keep a copy somewhere safe.
# GRAPESID_MASTERKEY encrypts secrets in the database: it can never change, and backups are useless without it.

GRAPESID_DOMAIN=$DOMAIN
GRAPESID_PUBLIC_URL=https://$DOMAIN
GRAPESID_EXTERNAL_PORT=443
GRAPESID_EXTERNAL_SECURE=true
GRAPESID_SCHEME=https

# Local ports Apache proxies to (127.0.0.1 only)
GRAPESID_API_PORT=$API_PORT
GRAPESID_LOGIN_PORT=$LOGIN_PORT

ZITADEL_VERSION=v4.20.6

# Applied when the instance is first created; change them in the console afterwards.
GRAPESID_ORG_NAME=Grapes
GRAPESID_ADMIN_USERNAME=admin
GRAPESID_ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$DOMAIN}
GRAPESID_ADMIN_PASSWORD=$ADMIN_PASSWORD
GRAPESID_ALLOW_SIGNUP=false

GRAPESID_MASTERKEY=$(openssl rand -hex 16)
GRAPESID_LOGIN_COOKIE_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF
  chmod 600 .env
  printf '%s\n' "$ADMIN_PASSWORD" > secrets/admin-password.txt
  FIRST_START=1
else
  FIRST_START=0
  if [[ $SETUP == 1 && "$(envget GRAPESID_DOMAIN)" != "$DOMAIN" ]]; then
    die ".env is set up for $(envget GRAPESID_DOMAIN), not $DOMAIN. The instance is bound to its domain; to add a second domain use the console (Instance > Domains)."
  fi
fi
DOMAIN="$(envget GRAPESID_DOMAIN)"
API_PORT="$(envget GRAPESID_API_PORT)"; API_PORT="${API_PORT:-8180}"
LOGIN_PORT="$(envget GRAPESID_LOGIN_PORT)"; LOGIN_PORT="${LOGIN_PORT:-8181}"
for k in GRAPESID_MASTERKEY POSTGRES_PASSWORD GRAPESID_LOGIN_COOKIE_SECRET GRAPESID_ADMIN_PASSWORD GRAPESID_ADMIN_EMAIL; do
  [[ -n "$(envget $k)" ]] || die "$k is empty in .env"
done
[[ "$(envget GRAPESID_MASTERKEY | tr -d '\n' | wc -c)" == 32 ]] || die "GRAPESID_MASTERKEY must be exactly 32 characters"

# ---------------------------------------------------------------- code
if [[ $PULL == 1 && -d .git ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    die "the working tree has local changes; commit or stash them first (or use --no-pull)"
  fi
  log "Pulling latest changes"
  BEFORE="$(git rev-parse --short HEAD)"
  git pull --ff-only
  echo "$BEFORE -> $(git rev-parse --short HEAD)"
fi
docker compose config --quiet || die "docker-compose.yml / .env are invalid (see above)"

# ---------------------------------------------------------------- Apache (first time only)
if [[ $SETUP == 1 && -f "$SSL_SITE" ]]; then
  log "Apache site for $DOMAIN already has HTTPS (certbot); leaving it unchanged"
  HTTPS=0
elif [[ $SETUP == 1 ]]; then
  log "Configuring Apache for $DOMAIN"
  RENDERED="$(mktemp)"
  trap 'rm -f "$RENDERED"' EXIT
  sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__API_PORT__#$API_PORT#g" -e "s#__LOGIN_PORT__#$LOGIN_PORT#g" \
    deploy/apache-grapesid.conf > "$RENDERED"
  if [[ -f "$SITE" ]] && ! sudo cmp -s "$RENDERED" "$SITE"; then
    sudo cp "$SITE" "$SITE.bak.$(date +%Y%m%d%H%M%S)"
    echo "Existing $SITE backed up"
  fi
  sudo install -m 644 "$RENDERED" "$SITE"
  sudo a2enmod -q proxy proxy_http headers >/dev/null
  sudo a2ensite -q "$SITE_NAME" >/dev/null
  sudo apache2ctl configtest || die "Apache config test failed; the site was installed but Apache was not reloaded"
  sudo systemctl reload apache2
fi

# ---------------------------------------------------------------- containers
if [[ $FIRST_START == 0 ]] && docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  log "Backing up the database"
  deploy/backup.sh
fi

log "Pulling images ($(envget ZITADEL_VERSION))"
docker compose pull --quiet

log "Starting GrapesID (the first start creates the instance and takes a minute or two)"
if ! docker compose up -d --remove-orphans --wait --wait-timeout 420; then
  echo "GrapesID did not become healthy. Recent logs:" >&2
  docker compose logs --tail 40 zitadel login >&2 || true
  exit 1
fi

# The automation token is written into the bootstrap volume on the first start; keep a private copy for the scripts.
if docker compose cp zitadel:/zitadel/bootstrap/admin.pat secrets/admin.pat.new >/dev/null 2>&1 && [[ -s secrets/admin.pat.new ]]; then
  mv secrets/admin.pat.new secrets/admin.pat
  chmod 600 secrets/admin.pat
else
  rm -f secrets/admin.pat.new
  [[ -f secrets/admin.pat ]] || echo "warning: no admin token found in the container; the scripts in ./scripts won't work" >&2
fi

log "Checking http://127.0.0.1:$API_PORT as $DOMAIN"
ISSUER="$(curl -fsS -H "Host: $DOMAIN" -H "X-Forwarded-Proto: https" "http://127.0.0.1:$API_PORT/.well-known/openid-configuration" \
  | sed -nE 's/.*"issuer":"([^"]+)".*/\1/p' || true)"
[[ "$ISSUER" == "https://$DOMAIN" ]] || die "unexpected OIDC issuer '$ISSUER' (expected https://$DOMAIN). See: docker compose logs zitadel"
echo "GrapesID is up: issuer $ISSUER"

# ---------------------------------------------------------------- HTTPS (first time only)
if [[ $SETUP == 1 && $HTTPS == 1 ]]; then
  if command -v certbot >/dev/null; then
    log "Requesting an HTTPS certificate for $DOMAIN"
    if ! sudo certbot --apache -d "$DOMAIN" --redirect; then
      echo "certbot did not finish (see above). Check DNS for $DOMAIN, then retry: sudo certbot --apache -d $DOMAIN --redirect" >&2
    fi
  else
    echo "certbot is not installed: sudo apt install certbot python3-certbot-apache && sudo certbot --apache -d $DOMAIN --redirect"
  fi
fi

if [[ $SETUP == 1 ]]; then
  cat <<EOF

GrapesID is ready.
  Console:   https://$DOMAIN/ui/console
  Admin:     $(envget GRAPESID_ADMIN_USERNAME)  /  password in secrets/admin-password.txt (change it after signing in, then delete that file)

Next steps:
  1. Register an app:        scripts/register-app.mjs ignite https://ignite.carlevato.net
  2. Migrate its accounts:   migrations/ignite/migrate.mjs --ignite-data ~/projects/ignite/data   (dry run, then --apply)
  3. Optional: e-mail (password resets, verification) in the console under Default Settings > SMTP
EOF
fi
