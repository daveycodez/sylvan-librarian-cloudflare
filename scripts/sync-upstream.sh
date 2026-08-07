#!/usr/bin/env bash
# Sync the vendored sylvan_librarian tree with upstream.
#
# Three-way merge: for every file, base = the pinned commit in UPSTREAM.lock,
# ours = vendor/sylvan_librarian (which carries our Cloudflare patches),
# theirs = upstream at the requested ref (default: origin/HEAD).
#
#   scripts/sync-upstream.sh          # sync to upstream HEAD
#   scripts/sync-upstream.sh <sha>    # sync to a specific upstream commit
#
# After merging, the script updates UPSTREAM.lock and prints:
#   - every vendored file that changed upstream
#   - conflicts (left as standard conflict markers — resolve by hand)
#   - changed files that have TypeScript/Rust PORTS in this repo, which must be
#     re-reviewed so the ports keep mirroring upstream behavior.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor/sylvan_librarian"
LOCK="$REPO_ROOT/UPSTREAM.lock"
UPSTREAM_URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['repo'])")
BASE_SHA=$(python3 -c "import json;print(json.load(open('$LOCK'))['commit'])")
TARGET_REF="${1:-HEAD}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "Fetching upstream ($UPSTREAM_URL)..."
git clone --quiet --filter=blob:none "$UPSTREAM_URL" "$WORK/upstream"
git -C "$WORK/upstream" checkout --quiet "$TARGET_REF"
TARGET_SHA=$(git -C "$WORK/upstream" rev-parse HEAD)

if [[ "$TARGET_SHA" == "$BASE_SHA" ]]; then
    echo "Already at upstream $BASE_SHA — nothing to sync."
    exit 0
fi

echo "Syncing $BASE_SHA -> $TARGET_SHA"
git -C "$WORK/upstream" worktree add --quiet "$WORK/base" "$BASE_SHA"

# Files whose behavior is re-implemented in this repo. When one of these changes
# upstream, the corresponding port must be re-reviewed (and parity fixtures
# regenerated where applicable).
declare -A PORTS=(
    ["api/parsing/hand_parser.py"]="src/parser/ (TS port; regenerate fixtures: tests/parser/)"
    ["api/parsing/rewrite.py"]="src/parser/rewrite.ts (TS port)"
    ["api/parsing/nodes.py"]="src/parser/nodes.ts (TS port)"
    ["api/card_processing.py"]="engine/builder/src/transform.rs (Rust port)"
    ["api/tag_import.py"]="engine/builder/src/tags.rs (Rust port)"
    ["api/scryfall_bulk_data_fetcher.py"]="engine/builder/src/bulk.rs (Rust port)"
    ["api/api_resource.py"]="src/routes/ (TS port of user-facing routes)"
    ["api/noscript_helpers.py"]="src/routes/root.ts (TS port)"
)

changed=()
conflicts=()
port_hits=()

while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    base_f="$WORK/base/$rel"
    theirs_f="$WORK/upstream/$rel"
    ours_f="$VENDOR/$rel"

    if ! cmp -s "$base_f" "$theirs_f" 2>/dev/null; then
        changed+=("$rel")
        mkdir -p "$(dirname "$ours_f")"
        if [[ ! -f "$ours_f" ]]; then
            cp "$theirs_f" "$ours_f" # new upstream file
        elif [[ ! -f "$base_f" ]]; then
            : # existed only locally at base? leave ours
        elif ! git merge-file -L ours -L base -L upstream "$ours_f" "$base_f" "$theirs_f"; then
            conflicts+=("$rel")
        fi
        if [[ -n "${PORTS[$rel]:-}" ]]; then
            port_hits+=("$rel -> ${PORTS[$rel]}")
        fi
    fi
done < <(cd "$WORK/upstream" && find . -type f -not -path "./.git/*" -print0)

# Files deleted upstream since base: report, do not auto-delete (our patches may depend on them).
while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    if [[ ! -f "$WORK/upstream/$rel" && -f "$VENDOR/$rel" ]]; then
        echo "DELETED upstream (kept locally, review): $rel"
    fi
done < <(cd "$WORK/base" && find . -type f -not -path "./.git/*" -print0)

python3 - "$LOCK" "$TARGET_SHA" <<'EOF'
import json, sys, datetime
lock_path, sha = sys.argv[1], sys.argv[2]
lock = json.load(open(lock_path))
lock["commit"] = sha
lock["vendored_at"] = datetime.date.today().isoformat()
json.dump(lock, open(lock_path, "w"), indent=2)
open(lock_path, "a").write("\n")
EOF

echo
echo "=== ${#changed[@]} upstream file(s) changed ==="
printf '%s\n' "${changed[@]}"
if ((${#conflicts[@]})); then
    echo
    echo "=== CONFLICTS (fix conflict markers by hand) ==="
    printf '%s\n' "${conflicts[@]}"
fi
if ((${#port_hits[@]})); then
    echo
    echo "=== PORTS TO RE-REVIEW (behavior mirrored in this repo) ==="
    printf '%s\n' "${port_hits[@]}"
fi
echo
echo "UPSTREAM.lock now pins $TARGET_SHA"
echo "Next: cargo test && bun test (parser parity) && rebuild + republish the store."
