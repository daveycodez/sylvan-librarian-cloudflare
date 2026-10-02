// A reset under a running alarm is not the alarm losing its state (x49).
//
// DeckGen, 2026-09-28 → 10-01: each nightly's coordinator was reset once, 3–4 s into a publish
// slice, with no deploy. The slice failed with the runtime's reset message, the retry bookkeeping
// then threw because the instance's storage was gone, and that second throw was logged as the
// ERROR "Import alarm could not manage its own state (storage unavailable?)" — an error line a
// night for a reset the platform absorbed by firing the alarm again 7–22 s later.

import { describe, expect, test } from "bun:test";
import { ResetUnderAlarmError, resetUnderAlarm } from "../../src/import-budget";

const RESET = new Error("Durable Object reset because its code was updated.");
// What sqlRun threw on those nights: an error from the dead instance's storage.
const STORAGE_GONE = new Error("Durable Object reset because its code was updated.");

describe("resetUnderAlarm", () => {
	test("a slice that died of a reset, whose retry could not be recorded, is absorbed", () => {
		const line = resetUnderAlarm("publish", RESET, STORAGE_GONE);
		expect(line).toContain("Import phase publish");
		expect(line).toContain("reset because its code was updated");
		expect(line).toContain("absorbed");
		// The second throw's text is not what decides it: the log rendered it with no message at all.
		expect(resetUnderAlarm("publish", RESET, new Error(""))).not.toBeNull();
	});

	test("the runtime's other reset messages count too", () => {
		for (const message of [
			"Internal error in Durable Object storage caused object to be reset; reference = abc",
			"Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
		]) {
			expect(resetUnderAlarm("build", new Error(message), STORAGE_GONE)).not.toBeNull();
		}
	});

	test("an ordinary slice failure whose bookkeeping then fails is still the real thing", () => {
		expect(resetUnderAlarm("publish", new Error("KV PUT failed: 500"), STORAGE_GONE)).toBeNull();
		expect(resetUnderAlarm("publish", new Error("Network connection lost."), new Error("boom"))).toBeNull();
	});

	test("a spent storage quota is never read as a reset", () => {
		// An engine object a deploy reset can hand a notify slice the reset message while this
		// object's own storage refuses writes for the day: that must stay an error.
		for (const quota of ["Exceeded allowed rows written: daily limit", "you have exceeded your quota"]) {
			expect(resetUnderAlarm("notify", RESET, new Error(quota))).toBeNull();
		}
	});

	test("the error alarm() recognises carries the line", () => {
		const err = new ResetUnderAlarmError(resetUnderAlarm("publish", RESET, STORAGE_GONE) as string);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ResetUnderAlarmError");
		expect(err.message).toContain("the watchdog kicks the run if it does not");
	});
});
