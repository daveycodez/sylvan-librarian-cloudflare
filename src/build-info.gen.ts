// GENERATED at build time by scripts/ci-postinstall.sh — do not edit by hand.
//
// The commit a deployed Worker was built from, sent back as `x-sylvan-build` on every response
// (src/index.ts). Workers Builds rewrites this from WORKERS_CI_COMMIT_SHA before `wrangler deploy`
// bundles the script; the committed value is what every other build reports. It exists so the
// post-push smoke test (.github/workflows/ci.yml) can tell "the new code is live" apart from "the
// previous version is still answering", which a fixed URL against a 90s edge cache could not.
export const BUILD_COMMIT = "unknown";
