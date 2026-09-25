// The deploy's KV upload used to report only wrangler's last four stderr lines — its generic footer —
// so three failed chunk puts on 2026-09-25 left no cause in the build logs. wranglerFailure keeps the
// error line and what follows it.

import { describe, expect, test } from "bun:test";
import { wranglerFailure } from "../../scripts/wrangler-cmd";

describe("wranglerFailure", () => {
	test("keeps the [ERROR] line and drops the footer", () => {
		const stderr = [
			"",
			"✘ [ERROR] A request to the Cloudflare API (/accounts/x/storage/kv/namespaces/y/values/z) failed.",
			"",
			"  Service Unavailable [code: 10013]",
			"",
			"If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose",
			'🪵  Logs were written to "/opt/buildhome/.config/.wrangler/logs/wrangler.log"',
		].join("\n");
		const why = wranglerFailure(stderr);
		expect(why).toContain("[ERROR] A request to the Cloudflare API");
		expect(why).toContain("Service Unavailable [code: 10013]");
		expect(why).not.toContain("If you think this is a bug");
		expect(why).not.toContain("Logs were written");
	});

	test("without an [ERROR] line, the last lines that are not the footer", () => {
		expect(wranglerFailure("a\nb\nc\nIf you think this is a bug, please open an issue")).toBe("a | b | c");
	});

	test("says so when there is nothing to say", () => {
		expect(wranglerFailure("\n\n")).toBe("no output");
	});
});
