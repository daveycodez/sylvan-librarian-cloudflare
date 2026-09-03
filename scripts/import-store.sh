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
#
# ── A RECORDED ONE-TIME COST, ALREADY ACCEPTED — NOT A WARNING TO ACT ON ──────
#
# The deploy that first ships the partitioned store publishes a PARTITIONED
# manifest to `store:manifest` while the previously-deployed Worker is still
# live and still serving. That Worker cannot parse a partitioned manifest, so
# from the moment this script's publish lands until the new code finishes
# deploying — a few minutes — its requests fail.
#
# That is deliberate. There is no dual window BY DESIGN: the partitioned store
# is the setup, not a migration target, so there is no second manifest key to
# stage the new shape behind and no legacy serving path to keep alive while the
# swap happens. The alternative was a rollout flag, two manifest pointers, two
# nightly pipelines and two serving paths — machinery whose whole purpose was
# to avoid these few minutes, and which was deleted for exactly that trade.
#
# It happens ONCE, on the transition deploy. Every deploy after it publishes the
# shape the live Worker already reads, so this paragraph is history, not a
# runbook step. Nothing here needs doing about it.
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

# 1b. The KV data that is NOT in the store: rulings, and the /sets, /catalog/*
#     and /symbology mirrors. Neither comes out of the bulk store build —
#     rulings hang off oracle_id rather than a printing, and the reference data
#     is fetched from api.scryfall.com rather than derived from the corpus — so
#     without this step a deploy leaves those routes answering 503 until the
#     first nightly cron.
#
#     BEFORE the store-age gate below, deliberately: the common deploy skips the
#     store import entirely because a recent store is already live, and "the
#     store is current" says nothing about whether these were ever published.
#
#     `--if-missing` makes each a single KV read when the data is already there,
#     which is the same trade the store gate makes: the deploy guarantees the
#     data EXISTS, the nightly import keeps it CURRENT. FORCE_IMPORT=1
#     republishes them along with the store.
#
#     Never fatal. The store is the index; these back three routes that fail
#     honestly (503) when absent, and losing a deploy because api.scryfall.com
#     was briefly unhappy would be the worse trade — the same call the in-Worker
#     pipeline makes for both of these phases.
IF_MISSING="--if-missing"
if [[ "${FORCE_IMPORT:-}" == "1" ]]; then
    IF_MISSING=""
fi
echo "==> Publishing rulings to KV..."
bun scripts/seed-rulings.ts --remote $IF_MISSING || echo "!!! Rulings publish failed — /cards/*/rulings answers 503 until the nightly import."
echo "==> Publishing sets, catalogs and symbology to KV..."
bun scripts/seed-reference.ts --remote $IF_MISSING || echo "!!! Reference publish failed — /sets, /catalog/* and /symbology answer 503 until the nightly import."

#     And retire superseded store builds, whether or not this deploy publishes one. Cleanup is not
#     part of publishing: the sweep used to live inside the store publisher, so the common deploy —
#     which skips the import because a recent store is already live — skipped the cleanup too, and
#     KV reached 15 builds (~510MB of a 1GB namespace) against a policy of 2.
echo "==> Retiring superseded store builds..."
bun scripts/prune-kv.ts --remote || echo "!!! Store retention failed — superseded builds stay in KV until the next import."

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
    # Exit 2 is "could not tell", not "no store" — the state that silently
    # costs a full rebuild on every deploy. Exit 3 is "nothing published", which
    # store-age has already said on stderr. Either way, print the reason.
    if [[ "$STORE_AGE_STATUS" -eq 2 ]]; then
        echo "!!! Could not determine whether a store is live — importing to be safe."
    fi
    sed 's/^/    /' "$STORE_AGE_ERR"
fi
BRANCH="${WORKERS_CI_BRANCH:-}"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-main}"

# INSIDE WORKERS BUILDS, AN UNKNOWN BRANCH IS TREATED AS A PREVIEW, NOT AS PRODUCTION.
#
# The guard below used to require `-n "$BRANCH"` before it would refuse anything, which made it
# FAIL OPEN: if WORKERS_CI_BRANCH were ever missing — a build image change, an older trigger, a
# manual re-run — every branch silently became "production" and could republish the shared index.
# On 2026-08-27 the guard printed nothing at all and a branch build ran the full import, which is
# what that failure looks like from the log.
#
# WORKERS_CI is set by Workers Builds and nothing else (ci-postinstall.sh gates on the same
# variable), so it is the reliable half of the pair: knowing we are in a build is enough to demand
# a positive match on the branch before touching the shared store. A human running this script
# locally has neither variable and keeps the old behaviour.
if [[ "${WORKERS_CI:-}" == "1" && -z "$BRANCH" ]]; then
    echo "==> Workers Builds did not tell us the branch (WORKERS_CI_BRANCH is unset)."
    echo "    Treating this as a PREVIEW build, which is the safe direction: the cost of being"
    echo "    wrong here is a preview without a fresh store, and the cost of the other guess is"
    echo "    production reading an index this build was not entitled to replace."
    BRANCH="<unknown>"
fi

# A preview build NEVER writes the shared card index. The one exception is a
# namespace nothing has ever been published to (store-age exit 3) — a fresh
# fork whose default branch is not `main` still has to get a first index, and
# shipping nothing is worse than shipping a preview-built one.
#
# The guard used to fire only when the live store was ALSO current for this
# branch's code ([[ -n "$STORE_AGE" ]]), which is exactly never in the case
# that matters: on 2026-08-23 a preview branch carrying a STORE_CONTENT_GENERATION
# bump saw the generation-39 store as "unusable", fell through this check,
# republished the shared index at generation 40, and retention then dropped the
# generation-39 chunks — production, still deployed at 39, lost every /search
# until the branch merged. A preview whose code cannot read the live store gets
# a broken PREVIEW, which is the correct trade: preview versions take no
# traffic, and the fix ships by merging, not by letting the preview redefine
# what production reads.
if [[ -n "$BRANCH" && "$BRANCH" != "$PRODUCTION_BRANCH" ]]; then  # fail-closed: see the WORKERS_CI block above
    if [[ -n "$STORE_AGE" ]]; then
        echo "==> Preview build on '$BRANCH' (production is '$PRODUCTION_BRANCH') and a store"
        echo "    built $STORE_AGE is already live — leaving the shared card index alone."
        exit 0
    elif [[ "$STORE_AGE_STATUS" -eq 3 ]]; then
        echo "==> Preview build on '$BRANCH', but nothing has ever been published to this"
        echo "    namespace — seeding the first card index so the deploy is not empty."
    else
        echo "==> Preview build on '$BRANCH' (production is '$PRODUCTION_BRANCH'): the live store"
        echo "    is not usable by THIS branch's code (reason above), but production still reads"
        echo "    it — REFUSING to overwrite the shared card index from a preview build."
        echo "    This preview's /search may not work until the branch merges and production"
        echo "    rebuilds the store to match. (FORCE_IMPORT=1 overrides, and overwrites it.)"
        if [[ "${FORCE_IMPORT:-}" != "1" ]]; then
            exit 0
        fi
    fi
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
elif [[ "$STORE_AGE_STATUS" -eq 2 ]]; then
    echo "==> Could not read the live store's state — running the full bulk import to be safe."
else
    echo "==> The live store is missing or superseded (reason above) — running the full bulk import."
fi

# 3. Full native import. 20 minutes and 2 vCPU in Workers Builds, versus a 128MB
#    isolate and 30s alarms in the Worker runtime — which is why this lives in
#    the build and the in-Worker pipeline only handles nightly changes. The
#    reason is WALL CLOCK, not memory: the builder streams the corpus to a spill
#    file under store-build/ and builds one partition at a time, so the real
#    517,746-row multilingual corpus measures 451MiB peak RSS in 52s (it held
#    every draft in one Vec until 2026-08-16 and peaked at 7.41GiB, a 1-2 year
#    runway against this environment's 8GB — see engine/builder/src/spill.rs).
#    Memory moved onto scratch disk: ~1.5GB of spill, briefly ~3GB while the
#    demux holds the single spill and its per-partition cut at once, then
#    deleted partition by partition as the loop consumes them (and on every
#    error path). store-build/ still holds rows.jsonl (~1.7GB) as it always has.
#
#    `--partitions auto` makes the builder cut the store into N archives
#    (N = clamp(ceil(staged_draft_bytes * 0.24 / 43MB), 2, 32), plan Decision 3b
#    — the projection and both constants twinned with src/import-publish.ts, so
#    the deploy build and the nightly pick the same N for the same corpus) and emit
#    a v2 manifest skeleton with partition_count/partition_hash/partitions[] —
#    which is the only store shape a generation-20 deployment can serve. The
#    builder REJECTS argv it does not recognise (its parser matches exactly), so
#    if this checkout's builder predates the flag the build FAILS LOUDLY here
#    rather than silently publishing an unpartitioned store that ships the site
#    dark; seed-remote-kv.ts refuses an unpartitioned build dir for the same
#    reason, as the second line of defense.
echo "==> Building the card store from Scryfall bulk data (~450MB, a few minutes)..."
"$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
./target/fast-native/sylvan-store-builder --out store-build --partitions auto

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

# 4b. ...and the set release dates behind `date>=<set code>`, for the same reason and at the same
#     moment. Scryfall resolves a set code written where a date goes to that set's released_at, and
#     the parser is synchronous — so the table is a committed module rather than a KV read on the
#     parse path of every search. Sourced from api.scryfall.com/sets, which is the same endpoint
#     the reference import mirrors, so a set released since the last run is an unknown code until
#     this runs again. Not fatal if the fetch fails: a stale table still answers every set that
#     existed when it was written, and failing the whole import over it would trade a working
#     publish for a handful of week-old set codes.
echo "==> Regenerating the parser's set release dates..."
bun scripts/generate-set-dates.ts || echo "    (set-dates refresh failed; keeping the committed table)"

echo "==> Publishing the store to KV..."
bun scripts/seed-remote-kv.ts store-build

echo "==> Card index published."
