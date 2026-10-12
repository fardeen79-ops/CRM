#!/usr/bin/env bash
# Update the running CRM to the latest commit on its branch: pull, refresh packages, restart.
# The database (/var/lib/sourcing-crm) and /etc/sourcing-crm.env are not touched.
# Run as root:  sudo bash /opt/sourcing-crm/deploy/update.sh
set -euo pipefail
APP=${APP:-/opt/sourcing-crm}
SERVICE=${SERVICE:-sourcing-crm}
cd "$APP"
[ -d .git ] || { echo "$APP is not a git checkout: run deploy/switch-to-git.sh once first"; exit 1; }
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BEFORE=$(git rev-parse --short HEAD)
echo "Branch $BRANCH at $BEFORE; fetching..."
git fetch -q origin "$BRANCH"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then echo "Already up to date."; exit 0; fi
git log --oneline "HEAD..origin/$BRANCH"
git merge -q --ff-only "origin/$BRANCH"
AFTER=$(git rev-parse --short HEAD)
# Packages and scanner files are not in git; refresh them only when their inputs changed.
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^package'; then echo "package.json changed: npm ci"; npm ci --omit=dev; fi
[ -f public/vendor/tesseract/tesseract.min.js ] || npm run setup:ocr
id crm >/dev/null 2>&1 && chown -R crm:crm "$APP"
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --lines=5 status "$SERVICE" || true
echo "Updated $BEFORE -> $AFTER"
