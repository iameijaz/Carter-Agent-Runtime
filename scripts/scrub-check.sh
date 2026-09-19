#!/usr/bin/env bash
# Publish gate: fails if a personal or institutional identifier is tracked in git.
#
# This is the check that must pass before this repo goes public. It scans what
# git tracks, not the working tree, because .env and friends are gitignored and
# are allowed to hold real values.
#
# Run: bash scripts/scrub-check.sh
set -uo pipefail
cd "$(dirname "$0")/.."

# Identifiers that must never appear in tracked source. Extend, never shorten.
PATTERN='freiberg|tubaf|DE-105|TUF_|@gmail\.com|C:\\Users\\|/home/[a-z]'

# Excluded, deliberately and narrowly:
#   package-lock.json  — npm writes resolved registry URLs there.
#   STATUS.md / DECISIONS.md — the project record. They must be able to name what
#     was renamed and why, or the history of this scrub becomes unreadable. They
#     hold no credentials; anything secret belongs in .env regardless.
#   this script — it contains the patterns by definition.
# Source code has no such exemption.
hits=$(git grep -lIiE "$PATTERN" -- . \
  ':!package-lock.json' ':!STATUS.md' ':!DECISIONS.md' ':!scripts/scrub-check.sh' || true)

if [ -n "$hits" ]; then
  echo "FAIL — identifiers found in tracked files:"
  echo "$hits" | sed 's/^/  /'
  echo
  echo "Move the value into .env and read it through src/config.ts."
  exit 1
fi
echo "ok — no personal or institutional identifiers in tracked files"
