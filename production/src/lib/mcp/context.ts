/**
 * Who is calling: access token → user → tenant → role, every request (nothing cached).
 *
 * Fails closed at each step with a reason the client can show. The role comes from the users
 * row read under the caller's own RLS — never from the token — so a role change or a
 * deactivation applies on the next call.
 */
import "server-only";
import { isUserRole, type UserRole } from "@/lib/auth/roles";
import { istToday } from "@/lib/dates/ist";
import { SCOPE_WRITE } from "@/lib/mcp/config";
import { mcpDbFromClient, readSelf, type McpDb } from "@/lib/mcp/db";
import { accessClaims } from "@/lib/mcp/oauth/grants";

export interface McpContext {
  userId: string;
  email: string;
  tenantId: string;
  role: UserRole;
  fullName: string | null;
  grantId: string;
  clientName: string;
  canWrite: boolean;
  db: McpDb;
  now: Date;
}

export type ContextResult =
  | { ok: true; ctx: McpContext }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function resolveContext(token: string, secret: string, now: Date = new Date()): Promise<ContextResult> {
  const c = accessClaims(token, secret, now.getTime());
  if (!c) return { ok: false, status: 401, error: "The access token is invalid or expired." };
  const self = await readSelf(c.u, c.e, c.a);
  if (self.error) return { ok: false, status: 503, error: "Could not read your account right now. Try again in a minute." };
  const row = self.row;
  if (!row || row.is_active === false) {
    return { ok: false, status: 401, error: "Your ResellerOS login is deactivated. Ask the owner to reactivate it, then connect again." };
  }
  if (row.access_ends_on && row.access_ends_on < istToday(now)) {
    return { ok: false, status: 401, error: "Your access to ResellerOS has ended (last working day passed)." };
  }
  if (row.tenant_id !== c.t) {
    return { ok: false, status: 401, error: "You switched to another company since connecting. Connect Claude again from that company." };
  }
  if (!isUserRole(row.role) || row.role === "personal") {
    return { ok: false, status: 403, error: "This ResellerOS account type cannot use the Claude connector." };
  }
  const db = mcpDbFromClient(self.client, c.t);
  const g = await db.select<{ id: string; status: string; client_name: string | null }>("mcp_oauth_grants", ["id", "status", "client_name"]).eq("id", c.g);
  if (g.error) return { ok: false, status: 503, error: "Could not check this connection right now. Try again in a minute." };
  const grant = g.data?.[0];
  if (!grant || grant.status !== "active") {
    return { ok: false, status: 401, error: "This connection was disconnected. Add the connector again in Claude." };
  }
  return {
    ok: true,
    ctx: {
      userId: c.u, email: c.e, tenantId: c.t, role: row.role, fullName: row.full_name,
      grantId: c.g, clientName: grant.client_name ?? "MCP client",
      canWrite: c.s.split(" ").includes(SCOPE_WRITE), db, now,
    },
  };
}
