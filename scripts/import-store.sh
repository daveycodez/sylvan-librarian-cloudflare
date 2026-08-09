#!/usr/bin/env bash
# Build the card store and publish it to remote D1. The one implementation
# behind every path that needs an index: `bun run deploy`, and the automatic
# postinstall that Workers Builds triggers.
#
# Ordering is import-THEN-deploy everywhere, which is why this provisions the
# D1 database itself rather than relying on `wrangler deploy` autoconfig to
# have done it. The payoff is that a Worker is never live without an index:
# by the time the deploy runs, the store is already published.
#
# Failure is always fatal to the caller (set -e, no swallowed errors) — that is
# the entire point. A deploy that cannot build an index must not happen.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
# Derived from the Worker name wrangler will actually deploy as — the CI
# override included — so two Workers on one account each own their own
# database, from an unedited fork. Never hardcoded.
DB_NAME="$(bun scripts/project-config.ts d1)"

# 1. The database must exist before anything can reference or fill it. `d1
#    create` fails when it already does, which is the common case and not an
#    error — so ask first, and only create when genuinely absent.
if bunx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
    echo "==> D1 database '$DB_NAME' exists."
else
    echo "==> Creating D1 database '$DB_NAME'..."
    bunx wrangler d1 create "$DB_NAME"
fi

# 2. Pin the binding to THAT database, by id, before `wrangler deploy` reads
#    the config. Must come after the create above (the id has to exist) and
#    before any early exit below: a skipped import still has to deploy against
#    a binding that resolves, which is exactly what a deleted-and-recreated
#    database breaks.
bun scripts/align-d1-binding.ts

if [[ "${SKIP_IMPORT:-}" == "1" ]]; then
    echo "==> SKIP_IMPORT=1 — leaving the card store as it is."
    exit 0
fi

# 3. Decide whether to import at all.
#
#    Skip when a recent store is already live: without that, every routine code
#    push re-downloads ~450MB to republish an identical store, and the nightly
#    in-Worker refresh is what keeps it current between deploys.
#
#    Skip on a PREVIEW build for the same reason but more urgently. Workers
#    Builds runs non-production branches through `wrangler versions upload`, but
#    it runs this script on EVERY branch and every branch shares one D1 — so a
#    pull request would otherwise republish the production card index from
#    unreviewed code. The exception is a deployment with no store at all: a
#    fresh fork whose default branch is not `main` still has to get an index,
#    and shipping nothing is worse than shipping a preview-built one. Override
#    the branch name with PRODUCTION_BRANCH.
#    Whatever it decides, SAY WHY. This check used to run under `2>/dev/null`,
#    which threw away the one line explaining itself — so a store-age query that
#    could not reach D1 at all was indistinguishable, in the build log, from a
#    database with nothing published in it, and every deploy re-ran a 450MB
#    import announcing "no current store" while a two-minute-old store sat live.
#    A skipped import is an optimisation; a wrong reason is a lie in the log.
STORE_AGE=""
STORE_AGE_ERR="$(mktemp)"
trap 'rm -f "$STORE_AGE_ERR"' EXIT
STORE_AGE_STATUS=0
age="$(bun scripts/store-age.ts 2>"$STORE_AGE_ERR")" || STORE_AGE_STATUS=$?
if [[ "$STORE_AGE_STATUS" -eq 0 && -n "$age" ]]; then
    STORE_AGE="$age"
    # Says which upstream dump the live store already covers — the reason a
    # skip is a skip, not just the fact of one.
    sed 's/^/    /' "$STORE_AGE_ERR"
else
    # Exit 2+ is "could not tell", not "no store" — the state that silently
    # costs a full rebuild on every deploy. Either way, print the reason.
    if [[ "$STORE_AGE_STATUS" -ge 2 ]]; then
        echo "!!! Could not determine whether a store is live — importing to be safe."
    fi
    sed 's/^/    /' "$STORE_AGE_ERR"
fi
BRANCH="${WORKERS_CI_BRANCH:-}"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-main}"

if [[ -n "$STORE_AGE" && -n "$BRANCH" && "$BRANCH" != "$PRODUCTION_BRANCH" ]]; then
    echo "==> Preview build on '$BRANCH' (production is '$PRODUCTION_BRANCH') and a store"
    echo "    built $STORE_AGE is already live — leaving the shared card index alone."
    exit 0
fi

if [[ "${FORCE_IMPORT:-}" != "1" && -n "$STORE_AGE" ]]; then
    echo "==> A store built $STORE_AGE is already live — skipping the import."
    echo "    (FORCE_IMPORT=1 rebuilds it anyway.)"
    exit 0
fi
[[ -n "$STORE_AGE" ]] || echo "==> No current store published — running the full bulk import."

# 4. Full native import. 8GB and 20 minutes in Workers Builds, versus a 128MB
#    isolate and 30s alarms in the Worker runtime — which is why this lives in
#    the build and the in-Worker pipeline only handles nightly changes.
echo "==> Building the card store from Scryfall bulk data (~450MB, a few minutes)..."
"$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
./target/fast-native/sylvan-store-builder --out store-build

echo "==> Publishing the store to D1..."
bun scripts/seed-remote-d1.ts store-build

echo "==> Card index published."
