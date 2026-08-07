// Port of api/utils/timer.py Timer: hierarchical span timing whose
// get_timings() tree feeds the search envelope's inner_timings/outer_timings.
// Note that Workers freeze the clock during synchronous execution, so spans
// routinely measure 0 ms; frequency (count/duration) is reported as 0 in that
// case rather than dividing by zero (Python never hits this because
// time.monotonic() always advances there).

interface TimingNode {
	_children?: Record<string, TimingNode>;
	_meta?: Record<string, number>;
}

function roundPy(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export class Timer {
	private timingsDict: TimingNode = {};
	private ptrs: TimingNode[] = [this.timingsDict];

	/** Equivalent of `with timer(name):` around a synchronous block. */
	time<T>(name: string, fn: () => T): T {
		const parent = this.ptrs[this.ptrs.length - 1] as TimingNode;
		if (!parent._children) {
			parent._children = {};
		}
		const children = parent._children;
		if (!children[name]) {
			children[name] = {};
		}
		const node = children[name];
		this.ptrs.push(node);
		const start = performance.now();
		try {
			return fn();
		} finally {
			const duration = (performance.now() - start) / 1000; // seconds, like time.monotonic() deltas
			if (!node._meta) {
				node._meta = {};
			}
			const meta = node._meta;
			const count = (meta.count ?? 0) + 1;
			const total = duration + (meta.duration ?? 0);
			meta.count = count;
			meta.duration = total;
			meta.duration_ms = total * 1000;
			meta.frequency = total > 0 ? count / total : 0;
			this.ptrs.pop();
		}
	}

	/** Nested timing tree with rounded _meta values, keyed like upstream get_timings(). */
	getTimings(): Record<string, TimingNode> {
		const clone = structuredClone(this.timingsDict);
		const recurseRound = (node: TimingNode): void => {
			if (node._meta) {
				for (const [k, v] of Object.entries(node._meta)) {
					node._meta[k] = roundPy(v, 3);
				}
			}
			for (const child of Object.values(node._children ?? {})) {
				recurseRound(child);
			}
		};
		recurseRound(clone);
		return clone._children ?? {};
	}
}
