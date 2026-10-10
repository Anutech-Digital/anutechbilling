/**
 * Who is signed in, as the database layer needs it: { userId, tenantId }.
 *
 * Today the login is still Supabase (GoTrue): getUser() verifies the token with the auth
 * server, so the user id is trustworthy. The tenant comes from public.users — never from
 * the request. When login moves to Auth.js only this file changes; every withTenant() call
 * stays as it is.
 *
 * Even if this returned a wrong tenant for a user, the database would not follow it:
 * current_tenant_id() accepts app.tenant_id only when public.users says this user belongs
 * to that tenant (prisma/migrations/20261005120000_tenant_context).
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { TenantSession } from "@/server/db";

export async function getTenantSession(): Promise<TenantSession | null> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;

  const { data: row } = await supabase.from("users").select("tenant_id").eq("id", auth.user.id).maybeSingle();
  if (!row?.tenant_id) return null;

  return { userId: auth.user.id, tenantId: row.tenant_id };
}

/** For route handlers / server actions that must not run without a signed-in tenant user. */
export async function requireTenantSession(): Promise<TenantSession> {
  const s = await getTenantSession();
  if (!s) throw new UnauthorizedError();
  return s;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Sign in again — your session has ended.");
    this.name = "UnauthorizedError";
  }
}
