/**
 * POST   /api/demo-data — fill the signed-in person's workspace with demo data in every module.
 * DELETE /api/demo-data — remove it again (only rows tagged "DEMO · …").
 *
 * R-201 (6 Oct 2026) customers + deals; R-361 (7 Oct 2026) every module — catalogue, vendors,
 * quotes, subscriptions, invoices, payments, tasks, vendor bills, expenses
 * (lib/demo/demo-data.ts says what and why).
 *
 * SAFETY
 *  - Staging and local only: a production build has NEXT_PUBLIC_APP_ENV "" and gets 403
 *    before anything is read. The invoice RPCs also refuse unless the DATABASE has
 *    public.demo_data_switch turned on, which live never has.
 *  - Owner or manager only.
 *  - Everything goes through the person's own client, so RLS keeps it inside their
 *    workspace — no service role here.
 *  - Nobody can be contacted: emails are on example.invalid (sendEmail refuses them) and no
 *    phone numbers are set.
 *  - A second click adds nothing (200 with `already: true`).
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { demoDataAllowed } from "@/lib/demo/demo-data";
import { addDemoData, clearDemoData, describeCounts, type DemoDb } from "@/lib/demo/demo-data.server";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function who() {
  if (!demoDataAllowed(process.env.NEXT_PUBLIC_APP_ENV)) {
    return { error: NextResponse.json({ error: "Demo data is only for staging and local — this is the live app, nothing was changed." }, { status: 403 }) };
  }
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id || !["owner", "manager"].includes(me.role ?? "")) {
    return { error: NextResponse.json({ error: "Only an owner or manager can add or clear demo data." }, { status: 403 }) };
  }
  const { data: tenant } = await supabase.from("tenants").select("state_code").eq("id", me.tenant_id).maybeSingle();
  return {
    db: supabase as unknown as DemoDb,
    tenantId: me.tenant_id as string,
    userId: user.id,
    tenantStateCode: (tenant?.state_code as string | null | undefined) ?? null,
  };
}

export async function POST() {
  const w = await who();
  if (w.error) return w.error;
  const r = await addDemoData(w.db, {
    tenantId: w.tenantId, userId: w.userId, tenantStateCode: w.tenantStateCode,
    today: istToday(), stamp: Date.now(), newId: randomUUID,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
  if (r.already) {
    return NextResponse.json({ ok: true, already: true, summary: "Demo data is already here — clear it first to start again." });
  }
  return NextResponse.json({
    ok: true, already: false, counts: r.counts, invoicesSkipped: r.invoicesSkipped,
    summary: describeCounts(r.counts),
  });
}

export async function DELETE() {
  const w = await who();
  if (w.error) return w.error;
  const r = await clearDemoData(w.db);
  if (!r.ok) return NextResponse.json({ error: r.error, counts: r.counts }, { status: 500 });
  return NextResponse.json({ ok: true, counts: r.counts, invoicesSkipped: r.invoicesSkipped, summary: describeCounts(r.counts) });
}
