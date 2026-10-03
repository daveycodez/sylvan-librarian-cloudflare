/**
 * Waiting on a load ANOTHER REQUEST began, in a Worker isolate — for a bounded time.
 *
 * A promise kept in module state so concurrent first requests share one read (the tag alias map,
 * the catalog tables) belongs to the request that started it: its reads run on that request's I/O.
 * When that request is CANCELLED — the client hung up, which the Workers runtime answers by
 * dropping everything the request had in flight — the read never settles, the promise never
 * settles, its `finally` never runs, and the slot it sits in is never cleared. Every later request
 * in the isolate that awaits it then waits for as long as its own client does.
 *
 * Measured in workerd 2026-10-03 (a throwaway Worker holding one module-level load, and a caller
 * that dropped its call 500ms in): the load was still unsettled afterwards, the next request
 * awaiting it got no answer in 15s — the runtime does NOT detect this as a hung request, since the
 * promise is still reachable from module state — and a request that raced the same promise against
 * its OWN timer answered when the timer fired. On DeckGen the same day two `/cards/search` requests
 * ran 100.002s and 99.998s on 7.7ms and 2.8ms of CPU with no subrequest at all, until the edge gave
 * up (524); the first had logged its routing filter and never its alias map. Client disconnects
 * are ordinary there: 22,281 cancelled invocations that day, at least 46 of them before any
 * subrequest — four of those, 0.4–39.5ms in, two minutes before the first hung request.
 *
 * So a joiner brings its own clock. The timer below is created by the WAITING request, on its own
 * I/O, so it fires whatever became of the request that owns `shared`.
 */

/**
 * `shared`'s value once it settles, or null when `ms` pass first. A rejection of `shared` inside the
 * window is the caller's rejection too, exactly as awaiting it would be.
 */
export async function settledWithin<T>(shared: Promise<T>, ms: number): Promise<{ value: T } | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	// A rejection after the window has no one waiting on it here; the owner still hears it.
	shared.catch(() => {});
	try {
		return await Promise.race([shared.then((value) => ({ value })), late]);
	} finally {
		clearTimeout(timer);
	}
}
