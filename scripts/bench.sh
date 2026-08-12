#!/usr/bin/env bash
# Benchmark: this port vs upstream sylvan-librarian.com vs Scryfall API.
#
# Per service, ONE curl invocation issues all requests over a reused
# connection (matching how browsers behave; a fresh TLS handshake per request
# would penalize distant origins hardest). Per query: 1 cold hit + 2 warm
# hits, sequential.
#
# COLD MEANS COLD. Every URL carries a nonce that changes each time this script
# runs, because the query set is fixed and /search sends
# stale-while-revalidate=86400 — so without it, a second run within 24 hours
# measured edge cache hits and reported them as "cold". That is not a
# hypothetical: consecutive runs produced 145ms and then 24ms for the same
# column, and the 24ms was cache all the way down. The three runs of a given
# query share one nonce, so cold misses and the two warm runs hit. Scryfall requests are rate-limited to 1/s via --rate
# (their etiquette floor is 500ms between requests). Output TSV:
# service, query, run, HTTP status, total seconds, TTFB seconds, bytes.
set -euo pipefail

QUERIES=(
  't:goblin cmc<3 c:r'
  'o:"draw a card" t:creature f:modern'
  'kw:flying pow>=4 -c:w'
  't:instant cmc=1 c:u'
  't:legendary t:elf f:commander'
  'o:"enters tapped" t:land'
  'c:wu t:bird'
  'r:mythic t:dragon cmc<=4'
  't:planeswalker c:b f:pioneer'
  't:instant o:damage cmc=1'
)
RUNS=(cold warm1 warm2)

OUT="$1"
: > "$OUT"

# One nonce for the whole invocation, so every service is compared on URLs
# none of their caches have seen, and the two warm runs still hit the entry
# their cold run populated.
NONCE="$(date +%s)-$RANDOM"

urlencode() { python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

bench_service() { # service base_url extra_curl_args...
  local service="$1" base="$2"; shift 2
  local args=()
  for q in "${QUERIES[@]}"; do
    local enc; enc=$(urlencode "$q")
    local url="$base?q=$enc&_bench=$NONCE"
    for _run in "${RUNS[@]}"; do
      args+=(--url "$url" --output /dev/null)
    done
  done
  # One invocation = one reused connection; -w emits one line per transfer.
  local i=0
  while IFS=$'\t' read -r code total ttfb size; do
    [[ "$code" == "200" ]] || echo "WARN: $service non-200 ($code)" >&2
    local q="${QUERIES[$((i / 3))]}"
    local run="${RUNS[$((i % 3))]}"
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$service" "$q" "$run" "$code" "$total" "$ttfb" "$size" >> "$OUT"
    i=$((i + 1))
  done < <(curl -s -o /dev/null \
    -H "User-Agent: sylvan-librarian-cloudflare-bench/1.0" \
    -w "%{http_code}\t%{time_total}\t%{time_starttransfer}\t%{size_download}\n" \
    "$@" "${args[@]}")
  echo "$service done" >&2
}

# The deployment under test. Overridable because this port runs in two places
# and they answer different questions: the paid custom domain is the headline
# the README quotes, and the free workers.dev host is where the free-plan
# ceilings (30s DO CPU, 128MB isolate) actually bite — so a change justified by
# those ceilings has to be measured there.
#
#   BENCH_OURS=https://sylvan-librarian.daveycodez.workers.dev/search scripts/bench.sh out.tsv
BENCH_OURS="${BENCH_OURS:-https://sylvan.mtgseeker.com/search}"

bench_service ours     "$BENCH_OURS"
bench_service upstream "https://sylvan-librarian.com/search"
bench_service scryfall "https://api.scryfall.com/cards/search" --rate 1/s
