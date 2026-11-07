#!/usr/bin/env bash
# Scrape RNZ every INTERVAL seconds for DURATION minutes, committing and
# pushing docs/data/electorates.json whenever the results change.
#
# Env vars:
#   INTERVAL_SECONDS  seconds between scrapes            (default 120)
#   DURATION_MINUTES  how long to keep looping           (default 58)
#   IDLE_MINUTES      stop early if nothing changed for this long (default 0 = never)
#   PUSH              set to 0 to skip git commit/push (local testing)
set -uo pipefail

INTERVAL_SECONDS="${INTERVAL_SECONDS:-120}"
DURATION_MINUTES="${DURATION_MINUTES:-58}"
IDLE_MINUTES="${IDLE_MINUTES:-0}"
PUSH="${PUSH:-1}"
OUT="docs/data/electorates.json"

cd "$(git rev-parse --show-toplevel)"
end=$(( $(date +%s) + DURATION_MINUTES * 60 ))
last_change=$(date +%s)
failures=0

while :; do
  started=$(date +%s)
  python3 scraper/scrape.py --out "$OUT"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    failures=0
    last_change=$started
    if [ "$PUSH" = "1" ]; then
      git add docs/data/
      git commit -q -m "Update election results ($(date -u +%H:%MZ))" || true
      for attempt in 1 2 3 4; do
        git pull -q --rebase -X theirs origin "$(git branch --show-current)" && git push -q && break
        sleep $(( 2 ** attempt ))
      done
    fi
  elif [ "$rc" -eq 3 ]; then
    failures=0
  else
    failures=$(( failures + 1 ))
    echo "::warning::scrape failed (${failures} in a row)"
    if [ "$failures" -ge 5 ]; then
      echo "::error::5 consecutive scrape failures; stopping"
      exit 1
    fi
  fi

  now=$(date +%s)
  if [ "$IDLE_MINUTES" -gt 0 ] && [ $(( now - last_change )) -ge $(( IDLE_MINUTES * 60 )) ]; then
    echo "No changes for ${IDLE_MINUTES} min; stopping early to save Actions minutes."
    exit 0
  fi
  next=$(( started + INTERVAL_SECONDS ))
  if [ "$next" -ge "$end" ]; then
    echo "Reached ${DURATION_MINUTES} min run duration."
    exit 0
  fi
  sleep $(( next - now > 0 ? next - now : 0 ))
done
