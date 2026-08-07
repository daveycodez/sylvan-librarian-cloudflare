// LOCAL PATCH (Cloudflare port): monotonic-clock shim.
//
// Upstream reads `std::time::Instant` at ~30 sites on the query path (phase
// stats, prepare timing, explain/explain_analyze). On wasm32-unknown-unknown
// `Instant::now()` COMPILES but ABORTS at runtime ("time not implemented on
// this platform"), which would take down every query inside a Worker isolate.
//
// Native builds re-export the real Instant unchanged. The wasm build gets a
// zero-sized stub whose durations are always zero: the router chooses plans
// from the cost model's predicted features, never from these measurements, so
// the only observable difference on wasm is that the diagnostic ns counters
// (PhaseStats, acquire_ns, explain_analyze trials) all read 0.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) use std::time::Instant;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Instant;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Instant {
    pub(crate) fn now() -> Self {
        Instant
    }

    pub(crate) fn elapsed(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl std::ops::Sub for Instant {
    type Output = std::time::Duration;

    fn sub(self, _rhs: Instant) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}
