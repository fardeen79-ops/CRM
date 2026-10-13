#!/usr/bin/env bash
# One-off: turn an /opt/sourcing-crm that was extracted from an archive into a git checkout,
# so that future updates are "deploy/update.sh" instead of a new archive.
# The database (/var/lib/sourcing-crm) and /etc/sourcing-crm.env are not touched.
# Run as root:  sudo bash /opt/sourcing-crm/deploy/switch-to-git.sh [git-url]
set -euo pipefail
APP=${APP:-/opt/sourcing-crm}
BRANCH=${BRANCH:-production}   # the branch the server follows; development happens on claude/sales-sourcing-crm-workflow-rdlw4h
URL=${1:-https://github.com/fardeen79-ops/crm.git}
command -v git >/dev/null || { echo "git is not installed: apt-get install -y git"; exit 1; }
[ -d "$APP" ] || { echo "$APP not found"; exit 1; }
if [ -d "$APP/.git" ]; then echo "$APP is already a git checkout"; exit 0; fi
cd "$APP"
git init -q
git remote add origin "$URL"
echo "Fetching $BRANCH from $URL (a private repository asks for a GitHub username and token)..."
git fetch -q origin "$BRANCH"
# Files already here that match the branch stay as they are; local edits would be lost, so refuse if any differ.
git reset -q "origin/$BRANCH"
if git status --porcelain --untracked-files=no | grep -qv '^ D'; then
  echo "These files differ from the branch; back them up first, then re-run with them restored from the branch:"; git status --short --untracked-files=no | grep -v '^ D'; exit 1
fi
git checkout -q -- .      # files the archive left out (deck sources, demo tooling) come back from the branch
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git config --global --add safe.directory "$APP" || true
id crm >/dev/null 2>&1 && chown -R crm:crm "$APP"
echo "Done. $APP now tracks origin/$BRANCH. Update with: sudo bash $APP/deploy/update.sh"
