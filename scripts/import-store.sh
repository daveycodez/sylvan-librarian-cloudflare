#!/usr/bin/env bash
# Build the card store and publish it to remote KV. The one implementation
# behind every path that needs an index: `bun run deploy`, and the automatic
# postinstall that Workers Builds triggers.
#
# Ordering is import-THEN-deploy everywhere, which is why this provisions the
# KV namespace itself rather than relying on `wrangler deploy` autoconfig to
# have done it. The payoff is that a Worker is never live without an index:
# by the time the deploy runs, the store is already published.
#
# Failure is always fatal to the caller (set -e, no swallowed errors) — that is
# the entire point. A deploy that cannot build an index must not happen.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Create the KV namespace if absent and pin the binding to it, by id,
#    before `wrangler deploy` reads the config. Must come before any early exit
#    below: a skipped import still has to deploy against a binding that
#    resolves, which is what a deleted-and-recreated namespace breaks.
bun scripts/align-kv-binding.ts

if [[ "${SKIP_IMPORT:-}" == "1" ]]; then
    echo "==> SKIP_IMPORT=1 — leaving the card store as it is."
    exit 0
fi

# 2. Decide whether to import at all.
#
#    Skip when a recent store is already live: without that, every routine code
#    push re-downloads ~450MB to republish an identical store, and the nightly
#    in-Worker refresh is what keeps it current between deploys.
#
#    Skip on a PREVIEW build for the same reason but more urgently. Workers
#    Builds runs non-production branches through `wrangler versions upload`, but
#    it runs this script on EVERY branch and every branch shares one namespace — so a
#    pull request would otherwise republish the production card index from
#    unreviewed code. The exception is a deployment with no store at all: a
#    fresh fork whose default branch is not `main` still has to get an index,
#    and shipping nothing is worse than shipping a preview-built one. Override
#    the branch name with PRODUCTION_BRANCH.
#    Whatever it decides, SAY WHY. This check used to run under `2>/dev/null`,
#    which threw away the one line explaining itself — so a store-age query that
#    could not reach KV at all was indistinguishable, in the build log, from a
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
# Say why the import is running. store-age has already printed the SPECIFIC
# finding on stderr just above — nothing published, a manifest whose chunks are
# gone, a store Scryfall has superseded, or a read that failed — so this line
# must not invent a different one. It used to say "No current store published"
# for every one of those, which reported a stale-but-present store as an absent
# one: the same class of lie the store-age reason text exists to prevent.
if [[ -n "$STORE_AGE" ]]; then
    # Only reachable with FORCE_IMPORT=1; every other path with a live store
    # returned above.
    echo "==> FORCE_IMPORT=1 — rebuilding even though a store built $STORE_AGE is live."
elif [[ "$STORE_AGE_STATUS" -ge 2 ]]; then
    echo "==> Could not read the live store's state — running the full bulk import to be safe."
else
    echo "==> The live store is missing or superseded (reason above) — running the full bulk import."
fi

# 3. Full native import. 8GB and 20 minutes in Workers Builds, versus a 128MB
#    isolate and 30s alarms in the Worker runtime — which is why this lives in
#    the build and the in-Worker pipeline only handles nightly changes.
echo "==> Building the card store from Scryfall bulk data (~450MB, a few minutes)..."
"$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
./target/fast-native/sylvan-store-builder --out store-build

# 4. Regenerate the parser's alias map from the SAME build.
#
#    This port resolves tag aliases at query time instead of stamping them into the store (see
#    TagData::oracle_aliases), which makes these two artifacts halves of one thing: the store holds
#    only canonical slugs, and this map is what still lets `art:flames` reach `fire`. Regenerating
#    here — between the build and the publish, from that build's own tag-aliases.json — is what
#    keeps them describing the same dumps. Deploy order does the rest: import-then-deploy means
#    wrangler bundles this file after it is written.
#
#    Nothing regenerates it when the import is skipped, which is correct — a skipped import means
#    the live store did not change either.
echo "==> Regenerating the parser's tag alias map..."
bun scripts/generate-tag-aliases.ts store-build

echo "==> Publishing the store to KV..."
bun scripts/seed-remote-kv.ts store-build

echo "==> Card index published."
