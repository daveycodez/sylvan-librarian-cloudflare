/**
 * The first of several attempts to SUCCEED; rejects only if every one fails.
 *
 * Not `Promise.race`, which settles on the first REJECTION. The engine uses
 * this to ask a cold colo's own store load and the region's warm one at the
 * same time, and there a regional DO that is unreachable must not take down a
 * request this colo could have answered itself.
 *
 * Every attempt is given a handler, so a loser that rejects after someone else
 * has won can never surface as an unhandled rejection.
 */
export async function firstToSucceed<T>(...attempts: Promise<T>[]): Promise<T> {
	if (attempts.length === 0) throw new Error("firstToSucceed needs at least one attempt");
	return new Promise<T>((resolve, reject) => {
		let outstanding = attempts.length;
		let firstError: unknown;
		let failed = false;
		for (const attempt of attempts) {
			attempt.then(resolve, (err) => {
				if (!failed) {
					failed = true;
					firstError = err;
				}
				outstanding -= 1;
				if (outstanding === 0) reject(firstError);
			});
		}
	});
}
