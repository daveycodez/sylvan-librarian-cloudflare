#!/usr/bin/env bash
# Benchmark: our Worker vs upstream sylvan-librarian.com vs Scryfall API.
# Per service, per query: 1 cold hit + 2 warm hits, sequential. Scryfall
# requests are spaced >=600ms (their etiquette floor is 500ms). Captures
# HTTP status, total time, TTFB, payload bytes as TSV for analysis.
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

OUT="$1"
: > "$OUT"

measure() { # service query run url
  local line
  line=$(curl -sG -o /dev/null \
    -H "User-Agent: sylvan-librarian-cloudflare-bench/1.0" \
    -w "%{http_code}\t%{time_total}\t%{time_starttransfer}\t%{size_download}" \
    --data-urlencode "q=$2" "$4")
  printf "%s\t%s\t%s\t%s\n" "$1" "$2" "$3" "$line" >> "$OUT"
}

for q in "${QUERIES[@]}"; do
  for run in cold warm1 warm2; do
    measure ours "$q" "$run" "https://sylvan-librarian.deckgen.workers.dev/search"
  done
done
echo "ours done" >&2

for q in "${QUERIES[@]}"; do
  for run in cold warm1 warm2; do
    measure upstream "$q" "$run" "https://sylvan-librarian.com/search"
  done
done
echo "upstream done" >&2

for q in "${QUERIES[@]}"; do
  for run in cold warm1 warm2; do
    sleep 0.6
    measure scryfall "$q" "$run" "https://api.scryfall.com/cards/search"
  done
done
echo "scryfall done" >&2
