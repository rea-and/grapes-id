#!/usr/bin/env bash
# Install the GrapesID sign-in branding: copy branding/ to /var/www/grapesid-brand, add the Apache snippet to the GrapesID
# virtual hosts, and apply Zitadel's own branding settings (colours, logo, icon) through its API. Safe to run any time.
# ./deploy.sh runs it after every update; run it alone with `./deploy.sh --brand` or `deploy/brand.sh`.
#
#   deploy/brand.sh --remove    take the sign-in styling out again (Apache only; Zitadel's colours/logo stay)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SITE_NAME=grapesid
WEBROOT=/var/www/grapesid-brand
INC=/etc/apache2/grapesid-brand.inc
INCLUDE_LINE="    IncludeOptional $INC"
SITES=("/etc/apache2/sites-available/$SITE_NAME.conf" "/etc/apache2/sites-available/$SITE_NAME-le-ssl.conf")

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'brand: %s\n' "$*" >&2; exit 1; }
# Normally run as the owner of this folder (uses $SUDO where needed). Also fine as root: then no sudo, and the API
# script still runs as the folder's owner so it can read secrets/admin.pat.
if [[ $EUID -eq 0 ]]; then SUDO=""; OWNER="$(stat -c %U .)"; RUN_AS=(runuser -u "$OWNER" --); else SUDO="sudo"; RUN_AS=(); fi
command -v apache2ctl >/dev/null || die "Apache is not installed"

BACKUPS=()   # "site:backup" pairs made during this run, restored if Apache rejects the result
reload_apache() {
  if ! $SUDO apache2ctl configtest >/dev/null 2>&1; then
    $SUDO apache2ctl configtest 2>&1 | tail -5 >&2
    for pair in "${BACKUPS[@]:-}"; do
      [[ -n "$pair" ]] && $SUDO cp "${pair#*:}" "${pair%%:*}" && echo "Restored ${pair%%:*}" >&2
    done
    die "Apache rejected the new configuration, so the previous one was restored and nothing was reloaded"
  fi
  $SUDO systemctl reload apache2
}

if [[ "${1:-}" == "--remove" ]]; then
  log "Removing the sign-in styling"
  for f in "${SITES[@]}"; do
    [[ -f "$f" ]] && $SUDO grep -q "grapesid-brand.inc" "$f" && $SUDO sed -i.bak-brand '\#grapesid-brand\.inc#d' "$f" && echo "Removed the include from $f"
  done
  reload_apache
  echo "Done. (Files left in $WEBROOT and $INC; harmless without the include line.)"
  exit 0
fi

[[ -d branding ]] || die "no branding/ folder here"
log "Installing branding files to $WEBROOT"
$SUDO install -d -m 755 "$WEBROOT" "$WEBROOT/fonts"
for f in grapesid.css logo-dark.png logo-light.png icon.png icon-dark.png grape-mark.svg; do $SUDO install -m 644 "branding/$f" "$WEBROOT/$f"; done
for f in branding/fonts/*.woff2; do $SUDO install -m 644 "$f" "$WEBROOT/fonts/$(basename "$f")"; done
if [[ -f "$INC" ]]; then $SUDO cp "$INC" "$INC.prev"; BACKUPS+=("$INC:$INC.prev"); fi
$SUDO install -m 644 deploy/apache-brand.inc "$INC"

log "Adding the snippet to the GrapesID Apache sites"
$SUDO a2enmod -q substitute headers alias proxy proxy_http >/dev/null
changed=0
for f in "${SITES[@]}"; do
  [[ -f "$f" ]] || continue
  if $SUDO grep -q "grapesid-brand.inc" "$f"; then echo "Already in $f"; continue; fi
  bak="$f.bak.$(date +%Y%m%d%H%M%S)"; $SUDO cp "$f" "$bak"; BACKUPS+=("$f:$bak")
  # Right after ServerName, so it comes before the ProxyPass lines (the first matching ProxyPass wins).
  $SUDO sed -i "/^[[:space:]]*ServerName /a\\
$INCLUDE_LINE" "$f"
  echo "Added to $f"; changed=1
done
reload_apache

if [[ -s secrets/admin.pat ]]; then
  log "Applying Zitadel's branding (colours, logo, icon)"
  "${RUN_AS[@]}" node scripts/brand.mjs || echo "warning: could not apply the branding policy (the sign-in styling still works)" >&2
else
  echo "note: no secrets/admin.pat yet, so Zitadel's own colours/logo were not applied" >&2
fi
echo; echo "Branding installed. Open the sign-in page in a private window to see it."
