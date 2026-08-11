#!/usr/bin/env bash
# The Rust lint gate, pinned to the SAME toolchain upstream's CI pins.
#
# Why this exists at all: the gate this project had been running was `cargo test` plus
# `cargo check`, and neither runs clippy. jbylund/sylvan_librarian's `rust-test` job runs
#
#     cargo clippy --manifest-path card_engine/Cargo.toml --all-targets -- -D warnings
#
# so every change to the vendored engine here could be locally green and red the moment it reached
# a PR — which it was, on #912 and #913, for as long as nobody looked at the checks.
#
# Two traps this script exists to close, both hit on 2026-08-11:
#
#   1. TOOLCHAIN DRIFT. Upstream pins 1.97.1 (dtolnay/rust-toolchain@1.97.1) precisely because
#      every Rust release adds lints. A local `stable` was 1.90, and `useless_vec` exists in 1.97
#      and not 1.90 — so a fix verified locally shipped and CI stayed red. Upstream's own workflow
#      comment records the same drift biting their PR #760. Pinned here to match; bump both
#      together, deliberately, so the new lints get reviewed on purpose.
#
#   2. CACHED NON-OUTPUT. `cargo clippy` re-run over an unchanged crate prints nothing and exits 0,
#      which is indistinguishable from a clean pass. Verifying a lint fix by re-running the same
#      command is not a verification. CLIPPY_FORCE=1 cleans the workspace crates first.
#
# --workspace --all-targets, not per-crate --lib: `engine/builder/tests/roundtrip.rs` and
# `engine/builder/examples/memprobe.rs` both stopped COMPILING when the card-object archive split
# added a parameter, and the prescribed `cargo test -p sylvan-store-builder --lib` never built
# either of them. A gate that does not compile every target is not watching every target.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Keep in step with .github/workflows/rust-tests.yml in the upstream repo.
TOOLCHAIN="${CLIPPY_TOOLCHAIN:-1.97.1}"

if [[ -x "$HOME/.cargo/bin/rustup" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! command -v rustup >/dev/null 2>&1; then
    echo "clippy.sh: no rustup on PATH — run scripts/with-rust.sh once to install it." >&2
    exit 1
fi

if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
    echo "clippy.sh: installing Rust ${TOOLCHAIN} to match upstream CI (a minute or two)..." >&2
    rustup toolchain install "$TOOLCHAIN" --component clippy --profile minimal >&2
fi

if [[ "${CLIPPY_FORCE:-}" == "1" ]]; then
    # See trap 2 above. Only the workspace's own crates; dependencies are untouched, so this
    # costs seconds rather than a full rebuild.
    for crate in card_engine sylvan-store-builder sylvan-engine-wasm sylvan-wasm-import \
        sylvan-wasm-builder-probe; do
        cargo clean -p "$crate" >/dev/null 2>&1 || true
    done
fi

exec rustup run "$TOOLCHAIN" cargo clippy --workspace --all-targets -- -D warnings
