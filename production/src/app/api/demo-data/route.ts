/**
 * POST   /api/demo-data — add demo customers and deals to the signed-in person's workspace.
 * DELETE /api/demo-data — remove them again (only rows named "DEMO · …").
 *
 * R-201 (6 Oct 2026). Staging and local only: a production build has NEXT_PUBLIC_APP_ENV ""
 * and gets 403 before anything is read. Owner or manager only. Everything goes through the
 * person's own client, so RLS keeps it inside their workspace — no service role here.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { demoDataAllowed, demoRows, DEMO_PREFIX } from "@/lib/demo/demo-data";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function who() {
  if (!demoDataAllowed(process.env.NEXT_PUBLIC_APP_ENV)) {
    return { error: NextResponse.json({ error: "Demo data is only for staging and local." }, { status: 403 }) };
  }
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id || !["owner", "manager"].includes(me.role ?? "")) {
    return { error: NextResponse.json({ error: "Only an owner or manager can add or clear demo data." }, { status: 403 }) };
  }
  return { supabase, tenantId: me.tenant_id as string, userId: user.id };
}

export async function POST() {
  const w = await who();
  if ("error" in w) return w.error;
  const { customers, leads } = demoRows(istToday(), Date.now());
  const { error: cErr } = await w.supabase.from("customers").insert(customers.map((c) => ({ ...c, tenant_id: w.tenantId })));
  if (cErr) return NextResponse.json({ error: `Could not add demo customers: ${cErr.message}` }, { status: 500 });
  const { error: lErr } = await w.supabase.from("leads").insert(leads.map((l) => ({ ...l, tenant_id: w.tenantId, owner_id: w.userId })));
  if (lErr) return NextResponse.json({ error: `Demo customers added, but deals failed: ${lErr.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, customers: customers.length, leads: leads.length });
}

export async function DELETE() {
  const w = await who();
  if ("error" in w) return w.error;
  const pattern = `${DEMO_PREFIX}%`;
  const { data: l, error: lErr } = await w.supabase.from("leads").delete().like("company", pattern).select("id");
  if (lErr) return NextResponse.json({ error: `Could not clear demo deals: ${lErr.message}` }, { status: 500 });
  const { data: c, error: cErr } = await w.supabase.from("customers").delete().like("name", pattern).select("id");
  if (cErr) return NextResponse.json({ error: `Demo deals cleared, but customers failed: ${cErr.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, customers: c?.length ?? 0, leads: l?.length ?? 0 });
}
