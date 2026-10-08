/**
 * R-051 part 3 (7 Oct 2026) — tell the audit log WHO a service-role write was made for.
 *
 * A route that proves the caller (withRoute / mayDo) and then writes with the admin client
 * reaches Postgres with a service_role JWT and no `sub`, so log_row_change() saw no user and
 * wrote nothing. createAdminClientFor(userId) (server.ts) sends this header; PostgREST exposes
 * it as the GUC `request.headers`, and public.audit_service_actor()
 * (20261007240000_audit_actor_admin_writes.sql) reads it — ONLY when the JWT is service_role
 * and there is no user session, so a browser cannot claim to be someone else with it.
 *
 * Only ever pass the id of the user the route has ALREADY verified (withRoute's `user.id`,
 * or `auth.getUser()`), never an id from the request body.
 */
export const ACTOR_HEADER = "x-actor-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The header that names the acting user — empty when the id is not a uuid (DB would ignore it). */
export function actorHeaders(actorUserId: string | null | undefined): Record<string, string> {
  const id = (actorUserId ?? "").trim();
  return UUID_RE.test(id) ? { [ACTOR_HEADER]: id.toLowerCase() } : {};
}
