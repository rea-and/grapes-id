#!/usr/bin/env bash
# Dump GrapesID's database to backups/grapesid-<timestamp>.sql.gz (keeps the newest 14). deploy.sh runs it before
# every update; add it to cron for daily backups:
#   15 3 * * * /home/<you>/projects/grapes-id/deploy/backup.sh >/dev/null
#
# Restoring also needs GRAPESID_MASTERKEY from .env (it encrypts secrets inside the database): keep a copy of .env
# somewhere safe, separately from the dumps.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
KEEP="${KEEP:-14}"
mkdir -p backups
chmod 700 backups
OUT="backups/grapesid-$(date +%Y%m%d-%H%M%S).sql.gz"
umask 077
docker compose exec -T db pg_dump -U postgres --clean --if-exists zitadel | gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
ls -1t backups/grapesid-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm --
