/**
 * The signed-in person's own Claude connections (cookie session, same-origin only).
 *   GET  → list them (no tokens, no hashes)
 *   POST {"id": "<grant id>"} or {"all": true} → disconnect; the next MCP call fails at once.
 * RLS limits both to the caller's own rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { trustedOrigin } from "@/lib/app-url";
import { mcpEnabled } from "@/lib/mcp/config";
import { mcpDbFromClient, type McpDb } from "@/lib/mcp/db";
import { revokeGrant } from "@/lib/mcp/oauth/grants";
import { istDateTime } from "@/lib/mcp/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function me(): Promise<{ db: McpDb; userId: string } | Response> {
  if (!mcpEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in to ResellerOS first." }, { status: 401 });
  const { data: row } = await supabase.from("users").select("tenant_id").eq("id", auth.user.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Your login is not linked to a company." }, { status: 403 });
  return { db: mcpDbFromClient(supabase as unknown as SupabaseClient, row.tenant_id), userId: auth.user.id };
}

export async function GET(): Promise<Response> {
  const m = await me();
  if (m instanceof Response) return m;
  const r = await m.db.select("mcp_oauth_grants", ["id", "client_name", "scope", "status", "created_at", "last_used_at", "revoked_at"])
    .eq("user_id", m.userId).neq("status", "pending").order("created_at", { ascending: false }).page(0, 100);
  if (r.error) return NextResponse.json({ error: `Could not read your connections: ${r.error.message}` }, { status: 503 });
  return NextResponse.json({
    connections: (r.data ?? []).map((g) => ({
      id: g.id, client: g.client_name, can_change: String(g.scope).includes("mcp:write"), status: g.status,
      connected: istDateTime(g.created_at), last_used: istDateTime(g.last_used_at), disconnected: istDateTime(g.revoked_at),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

const BODY = z.union([z.object({ id: z.string().uuid() }).strict(), z.object({ all: z.literal(true) }).strict()]);

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("origin") !== new URL(trustedOrigin(req.headers)).origin) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const m = await me();
  if (m instanceof Response) return m;
  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Send {"id": "<connection id>"} or {"all": true}.' }, { status: 400 });
  let ids: string[];
  if ("id" in parsed.data) ids = [parsed.data.id];
  else {
    const r = await m.db.select<{ id: string }>("mcp_oauth_grants", ["id"]).eq("user_id", m.userId).in("status", ["pending", "active"]).page(0, 200);
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 503 });
    ids = (r.data ?? []).map((g) => g.id);
  }
  let revoked = 0;
  for (const id of ids) if (await revokeGrant(m.db, id)) revoked++;
  return NextResponse.json({ revoked });
}
