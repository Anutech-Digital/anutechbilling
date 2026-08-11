/**
 * POST /api/attendance/consent  { action }
 *
 * DPDP consent management for attendance selfies.
 *   • record    — caller consents for their OWN linked employee (self flow).
 *   • withdraw  — caller withdraws; we clear consent AND delete their stored
 *                 selfies (right to erasure). Attendance rows stay; only the
 *                 face images go.
 *   • owner_set — owner records/clears consent for an employee (enrollment);
 *                 clearing also deletes that employee's selfies.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Delete every stored selfie for one employee + null the row columns. */
async function eraseSelfies(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  employeeId: string,
) {
  const { data: rows } = await supabase
    .from("attendance")
    .select("id, selfie_in, selfie_out")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId);
  const paths = (rows ?? []).flatMap((r) => [r.selfie_in, r.selfie_out].filter(Boolean) as string[]);
  if (paths.length) {
    await supabase.storage.from("attendance-selfies").remove(paths);
    await supabase.from("attendance")
      .update({ selfie_in: null, selfie_out: null })
      .eq("tenant_id", tenantId).eq("employee_id", employeeId);
  }
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, role, employee_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const action = body?.action as string | undefined;

  if (action === "record") {
    const { error } = await supabase.rpc("record_attendance_consent");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "withdraw") {
    if (!me.employee_id) return NextResponse.json({ error: "Not linked to an employee" }, { status: 400 });
    await supabase.from("employees")
      .update({ attendance_consent_at: null, attendance_consent_source: null })
      .eq("id", me.employee_id).eq("tenant_id", me.tenant_id);
    await eraseSelfies(supabase, me.tenant_id, me.employee_id);
    return NextResponse.json({ ok: true });
  }

  if (action === "owner_set") {
    if (me.role !== "owner") return NextResponse.json({ error: "Only the owner can set consent" }, { status: 403 });
    const employeeId = body?.employeeId as string | undefined;
    const value = Boolean(body?.value);
    if (!employeeId) return NextResponse.json({ error: "Missing employee" }, { status: 400 });
    await supabase.from("employees")
      .update(value
        ? { attendance_consent_at: new Date().toISOString(), attendance_consent_source: "owner" }
        : { attendance_consent_at: null, attendance_consent_source: null })
      .eq("id", employeeId).eq("tenant_id", me.tenant_id);
    if (!value) await eraseSelfies(supabase, me.tenant_id, employeeId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
