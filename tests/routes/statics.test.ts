// Static assets: content types, cache headers, and bodies matching the
// vendored files (app.min.js is the terser build).

import { describe, expect, test } from "bun:test";
import { makeCtx, testDispatch } from "./harness";

const ctx = makeCtx();

describe("static assets", () => {
	const cases: [path: string, contentType: string, cacheControl: string | null][] = [
		["/favicon.ico", "image/vnd.microsoft.icon", "public, max-age=604800"],
		["/static/favicon.ico", "image/vnd.microsoft.icon", "public, max-age=604800"],
		["/static/social-preview.webp", "image/webp", "public, max-age=2592000"],
		["/static/styles.css", "text/css", "public, max-age=2592000"],
		["/static/app.js", "application/javascript", "public, max-age=3600"],
		["/static/app.min.js", "application/javascript", "public, max-age=2592000"],
		["/static/card.js", "application/javascript", "public, max-age=3600"],
		["/robots.txt", "text/plain", null],
	];

	for (const [path, contentType, cacheControl] of cases) {
		test(`${path} → ${contentType}, Cache-Control ${cacheControl ?? "(none)"}`, async () => {
			const res = await testDispatch(ctx, path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe(contentType);
			expect(res.headers.get("Cache-Control")).toBe(cacheControl);
		});
	}

	test("robots.txt body matches the vendored file", async () => {
		const res = await testDispatch(ctx, "/robots.txt");
		expect(await res.text()).toBe("User-agent: *\nDisallow: \nCrawl-delay: 5\n");
	});

	test("binary assets carry an explicit content-length", async () => {
		const res = await testDispatch(ctx, "/favicon.ico");
		expect(res.headers.get("content-length")).toBe("15406");
		const webp = await testDispatch(ctx, "/static/social-preview.webp");
		expect(webp.headers.get("content-length")).toBe("105128");
	});

	test("app.min.js is a real minification of app.js, not a copy", async () => {
		const min = await (await testDispatch(ctx, "/static/app.min.js")).text();
		const full = await (await testDispatch(ctx, "/static/app.js")).text();
		expect(min.length).toBeGreaterThan(0);
		expect(min.length).toBeLessThan(full.length);
		expect(min).not.toBe(full);
	});

	test("prefer_score_tuner serves HTML with no cache header", async () => {
		const res = await testDispatch(ctx, "/prefer_score_tuner");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("Cache-Control")).toBeNull();
	});

	test("security headers ride on every response", async () => {
		const res = await testDispatch(ctx, "/robots.txt");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});
});
