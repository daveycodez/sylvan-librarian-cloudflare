/**
 * The `/_admin` mount (upstream #963 + #966), mirrored as the one thing it can be here.
 *
 * Upstream moved every data-management route — `import_data`, `setup_schema`, the backfills, the
 * tag imports, `ingest_cubecobra`, `prefer_score_tuner` — off the public resource onto an
 * AdminResource mounted at `/_admin`, gated by HTTP Basic Auth against ADMIN_PASSWORD
 * (api/middlewares/admin_auth_middleware.py). With no password configured upstream rejects every
 * request under the mount; this deployment has no password and no Postgres for the routes to reach
 * — the Cloudflare import pipeline replaced them — so "no password configured" is its permanent
 * state and the 401 is the whole mirror. The old public paths (`/import_data` ...) are plain 404s
 * now, exactly as upstream answers them.
 *
 * Every response under the mount is `no-store`, pass or reject, so nothing here is ever eligible
 * for a cache — upstream stamps that before the auth check for the same reason.
 */

import { securityHeaders } from "./http";

export const ADMIN_MOUNT_PREFIX = "_admin";
const ADMIN_REALM = "admin";

/** Whether a normalized path (no leading/trailing slashes) is the admin mount or anything under it. */
export function isAdminPath(path: string): boolean {
	return path === ADMIN_MOUNT_PREFIX || path.startsWith(`${ADMIN_MOUNT_PREFIX}/`);
}

/** Upstream's rejection, verbatim: 401, a Basic challenge, `{"error": "Unauthorized"}`, no-store. */
export function adminUnauthorized(): Response {
	return securityHeaders(
		new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: {
				"content-type": "application/json",
				"WWW-Authenticate": `Basic realm="${ADMIN_REALM}"`,
				"Cache-Control": "no-store",
			},
		}),
	);
}
