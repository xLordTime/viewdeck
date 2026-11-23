#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec 9>".git/viewdeck-update.lock"
flock -n 9 || { echo 'Ein Update läuft bereits.' >&2; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
if [[ ! -f .env ]]; then
  (umask 077; cp .env.example .env)
  echo 'Bitte .env bearbeiten und danach bash update.sh erneut ausführen.'
  exit 1
fi
[[ $(git branch --show-current) == main ]] || { echo 'Bitte den Branch main auschecken.' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Lokale Änderungen zuerst sichern.' >&2; exit 1; }
git pull --ff-only origin main
docker compose config --quiet
docker compose build --pull web
docker compose up -d --no-build --wait --wait-timeout 100 web
docker compose ps web
