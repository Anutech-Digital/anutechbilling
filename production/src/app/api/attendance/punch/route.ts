/**
 * POST /api/attendance/punch
 *
 * Ingest biometric attendance punches from the office bridge (which reads the
 * LAN fingerprint terminal, e.g. Hikvision). Auth = per-tenant ingest key in the
 * `x-ingest-key` header (no user session — the bridge is a machine). Each punch
 * maps to an employee via employees.biometric_id; the earliest punch of the day
 * becomes check-in, the latest check-out. source='biometric'. Idempotent —
 * re-sending the same punches only widens the in/out window, never duplicates.
 *
 * Body: { punches: [{ biometric_id: string, timestamp: ISO string }] }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  punches: z.array(z.object({
    biometric_id: z.string().min(1).max(64),
    timestamp:    z.string().min(1),
  })).min(1).max(2000),
});

/** Calendar date (YYYY-MM-DD) of a timestamp in IST — the attendance work_date. */
function istDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export async function POST(req: NextRequest) {
  const key = req.headers.get("x-ingest-key");
  if (!key) return NextResponse.json({ error: "Missing x-ingest-key" }, { status: 401 });

  let body;
  try { body = bodySchema.parse(await req.json()); }
  catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }

  const admin = createAdminClient();

  const { data: tenant } = await admin
    .from("tenants").select("id").eq("attendance_ingest_key", key).maybeSingle();
  if (!tenant) return NextResponse.json({ error: "Invalid ingest key" }, { status: 401 });
  const tenantId = tenant.id as string;

  // Map this tenant's biometric IDs → employee id.
  const { data: emps } = await admin
    .from("employees").select("id, biometric_id")
    .eq("tenant_id", tenantId).not("biometric_id", "is", null);
  const empByBio = new Map<string, string>();
  for (const e of (emps ?? []) as { id: string; biometric_id: string | null }[]) {
    if (e.biometric_id) empByBio.set(String(e.biometric_id).trim(), e.id);
  }

  // Collapse the batch into per (employee, work_date) earliest + latest punch.
  type Win = { min: string; max: string };
  const windows = new Map<string, Win>();     // key = employeeId|workDate
  const unmatched = new Set<string>();
  for (const p of body.punches) {
    const empId = empByBio.get(p.biometric_id.trim());
    if (!empId) { unmatched.add(p.biometric_id.trim()); continue; }
    const d = istDate(p.timestamp);
    if (Number.isNaN(new Date(p.timestamp).getTime())) continue;
    const k = `${empId}|${d}`;
    const w = windows.get(k);
    if (!w) windows.set(k, { min: p.timestamp, max: p.timestamp });
    else {
      if (new Date(p.timestamp) < new Date(w.min)) w.min = p.timestamp;
      if (new Date(p.timestamp) > new Date(w.max)) w.max = p.timestamp;
    }
  }

  let upserted = 0;
  for (const [k, w] of windows) {
    const [empId, workDate] = k.split("|");
    const { data: existing } = await admin
      .from("attendance").select("id, check_in, check_out")
      .eq("tenant_id", tenantId).eq("employee_id", empId).eq("work_date", workDate)
      .maybeSingle();

    const earliest = (a: string | null, b: string) => (!a || new Date(b) < new Date(a) ? b : a);
    const latest   = (a: string | null, b: string) => (!a || new Date(b) > new Date(a) ? b : a);

    if (!existing) {
      const checkOut = w.max !== w.min ? w.max : null;
      const { error } = await admin.from("attendance").insert({
        tenant_id: tenantId, employee_id: empId, work_date: workDate,
        check_in: w.min, check_out: checkOut, source: "biometric",
      });
      if (!error) upserted++;
    } else {
      const newIn  = earliest(existing.check_in as string | null, w.min);
      const newOut = latest(existing.check_out as string | null, w.max);
      // Don't let check_out equal check_in (single punch day → out stays null).
      const finalOut = newOut && newIn && new Date(newOut) > new Date(newIn) ? newOut : (existing.check_out ?? null);
      const { error } = await admin.from("attendance")
        .update({ check_in: newIn, check_out: finalOut, source: "biometric" })
        .eq("id", existing.id);
      if (!error) upserted++;
    }
  }

  return NextResponse.json({
    ok: true,
    received: body.punches.length,
    days_updated: upserted,
    matched_employees: windows.size,
    unmatched_biometric_ids: Array.from(unmatched),
  });
}
