/**
 * R-391 — "this account must choose its own password before using the app".
 *
 * ─── WHY app_metadata AND NOT A COLUMN ──────────────────────────────────────
 * The flag lives on the AUTH user (`app_metadata.must_change_password`), not on public.users:
 *   - app_metadata is writable only with the service role. A member cannot clear it through
 *     PostgREST the way they could edit a column on their own users row (users_self_update).
 *   - Both login paths carry it with no schema change: GoTrue (live) returns it from
 *     `auth.getUser()`, and R-161's Auth.js store (staging, src/server/auth/accounts.ts) reads
 *     the same auth.users.raw_app_meta_data and merges `app_metadata` on updateUserById.
 *   - No migration, so nothing to apply before the code can ship.
 *
 * Edge-safe and client-safe: plain object reads only. Takes `unknown` because the middleware's
 * user is a supabase-js User on GoTrue and `{ id, email }` on R-161's Auth.js session.
 */
import { isAppPath } from "@/lib/safe-path";

export const MUST_CHANGE_PASSWORD_KEY = "must_change_password";
export const CHANGE_PASSWORD_PATH = "/change-password";

export function mustChangePassword(user: unknown): boolean {
  if (!user || typeof user !== "object") return false;
  const meta = (user as { app_metadata?: unknown }).app_metadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as Record<string, unknown>)[MUST_CHANGE_PASSWORD_KEY] === true;
}

/**
 * Where to go after the password is changed. `next` comes from the query string, so it goes
 * through lib/safe-path (no `https://…`, `//host`, `/\host`), and never back to this screen.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!isAppPath(next) || next!.startsWith(CHANGE_PASSWORD_PATH)) return fallback;
  return next!;
}

/** The forced-change URL for a request to `target` (path + query). */
export function changePasswordUrl(target: string | null): string {
  const next = safeNextPath(target, "");
  return next ? `${CHANGE_PASSWORD_PATH}?next=${encodeURIComponent(next)}` : CHANGE_PASSWORD_PATH;
}
