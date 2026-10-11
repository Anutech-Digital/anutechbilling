/**
 * R-722 (P1, security audit 10 Oct): a deactivated member (users.is_active = false) kept full
 * access for as long as their login lived — current_tenant_id() never looked at is_active, and
 * neither did the middleware or the owner checks of the team routes.
 *
 * Three layers now, each enough on its own:
 *   1. Database — current_tenant_id() is NULL for an inactive user (migration
 *      20261011131500_r722_inactive_user_tenant.sql), so every tenant RLS policy gives them 0 rows.
 *   2. Middleware — every request of a deactivated user ends their session: the login cookies are
 *      cleared, pages go to /login?error=deactivated, API calls get 401. Reactivating the member
 *      (is_active = true) lets them sign in again; nothing else has to be undone.
 *   3. Owner-only routes (invite, claim, join-requests, temp-password) require an ACTIVE owner.
 *
 * Only an explicit `false` counts: a missing row (new signup on /welcome, an apprentice) or a
 * lookup that failed is not "deactivated" — those have their own gates.
 */
import type { NextResponse } from "next/server";

export const DEACTIVATED_ERROR = "deactivated";

export const DEACTIVATED_MESSAGE =
  "Your account has been deactivated by the workspace owner. Ask them to turn it back on.";

/** True only when the users row says is_active = false. */
export function isDeactivated(row: { is_active?: boolean | null } | null | undefined): boolean {
  return row?.is_active === false;
}

/** An active owner — the only role that may invite, claim, approve joins or set temp passwords. */
export function isActiveOwner(row: { role?: string | null; is_active?: boolean | null } | null | undefined): boolean {
  return row?.role === "owner" && row.is_active !== false;
}

/** Auth.js (authjs.*, __Secure-authjs.*, chunked .0/.1) and GoTrue (sb-*) login cookies. */
export function isLoginCookie(name: string): boolean {
  return /^(__Secure-|__Host-)?(authjs|next-auth)\./.test(name) || name.startsWith("sb-");
}

/** Signs the browser out: every login cookie on the request is expired on this response. */
export function clearLoginCookies(res: NextResponse, cookieNames: string[]): NextResponse {
  for (const name of cookieNames) {
    if (!isLoginCookie(name)) continue;
    const secure = name.startsWith("__Secure-") || name.startsWith("__Host-");
    res.cookies.set(name, "", { path: "/", maxAge: 0, ...(secure ? { secure: true } : {}) });
  }
  return res;
}
