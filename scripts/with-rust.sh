#!/usr/bin/env bash
# Run a command under a Rust toolchain that can build this repo, so no build
# script ever requires thinking about Rust setup:
#   - prefers the rustup-managed toolchain (~/.cargo/bin) over Homebrew's
#     rustc, whose std does not ship the wasm32-unknown-unknown target
#   - installs the wasm32-unknown-unknown target on first use
# wasm-pack itself is a devDependency (prebuilt binary via bun install), so
# `bun run` resolves it from node_modules/.bin without any cargo install.
# Everything is idempotent; on a warm machine this adds ~50ms.
set -euo pipefail

if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1; then
    # No toolchain at all. Install one rather than failing: this path is hit by
    # Workers Builds (Ubuntu image ships Node/Bun/Go/Python but no Rust) and by
    # a fresh clone, and in both cases the right answer is "get on with it".
    echo "with-rust.sh: no Rust toolchain found — installing rustup (a minute or two)..." >&2
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable >&2
    export PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null 2>&1 || {
        echo "with-rust.sh: rustup install did not produce a working cargo." >&2
        exit 1
    }
fi

if command -v rustup >/dev/null 2>&1; then
    rustup target list --installed | grep -qx wasm32-unknown-unknown \
        || rustup target add wasm32-unknown-unknown
else
    case "$*" in
        *wasm*)
            echo "with-rust.sh: warning: no rustup on PATH — if this wasm build fails" >&2
            echo "with 'can't find crate for core', install rustup: https://rustup.rs" >&2
            ;;
    esac
fi

if [[ "${1:-}" == "wasm-pack" ]] && ! command -v wasm-pack >/dev/null 2>&1; then
    echo "with-rust.sh: wasm-pack not found — run 'bun install' (it is a devDependency)" >&2
    exit 1
fi

exec "$@"
