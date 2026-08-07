#!/usr/bin/env bash
# Benchmark: this port vs upstream sylvan-librarian.com vs Scryfall API.
#
# Per service, ONE curl invocation issues all requests over a reused
# connection (matching how browsers behave; a fresh TLS handshake per request
# would penalize distant origins hardest). Per query: 1 cold hit + 2 warm
# hits, sequential. Scryfall requests are rate-limited to 1/s via --rate
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

urlencode() { python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

bench_service() { # service base_url extra_curl_args...
  local service="$1" base="$2"; shift 2
  local args=()
  for q in "${QUERIES[@]}"; do
    local enc; enc=$(urlencode "$q")
    for _run in "${RUNS[@]}"; do
      args+=(--url "$base?q=$enc" --output /dev/null)
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

bench_service ours     "https://sylvan-librarian.deckgen.workers.dev/search"
bench_service upstream "https://sylvan-librarian.com/search"
bench_service scryfall "https://api.scryfall.com/cards/search" --rate 1/s
