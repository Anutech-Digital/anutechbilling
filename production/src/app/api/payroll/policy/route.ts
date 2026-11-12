/**
 * GET  /api/payroll/policy → { policy }   — the company payroll policy (R-2700); defaults when
 *                                            the workspace never saved one. Any signed-in member.
 * POST /api/payroll/policy { policy }     — owner only. Saves the six payroll_* columns of the
 *                                            workspace's attendance_settings row.
 *
 * Same pattern as /api/attendance/network: the owner check here is the gate, then the server
 * client writes the owner's OWN tenant row (attendance_settings is column-granted, a login has
 * no INSERT/UPDATE on these columns). The upsert sends ONLY the policy columns, so the row's
 * attendance settings (IPs, selfie, office hours, secrets) are never touched.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { PAYROLL_POLICY_COLUMNS, parsePayrollPolicy, policyToRow, validatePayrollPolicyInput, type PayrollPolicyRow } from "@/lib/payroll/policy";

async function me(supabase: ReturnType<typeof createClient>) {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  return data?.tenant_id ? { userId: authData.user.id, tenantId: data.tenant_id as string, role: data.role as string } : null;
}

export async function GET() {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // RLS keeps the read to the caller's own tenant row.
  const { data, error } = await supabase.from("attendance_settings").select(PAYROLL_POLICY_COLUMNS).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read the payroll policy" }, { status: 500 });
  return NextResponse.json({ policy: parsePayrollPolicy(data as PayrollPolicyRow | null) });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (u.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change the payroll policy" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const v = validatePayrollPolicyInput(body?.policy);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const admin = createAdminClientFor(u.userId);
  const { error } = await admin
    .from("attendance_settings")
    .upsert({ tenant_id: u.tenantId, ...policyToRow(v.policy), updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ error: "Could not save the payroll policy — nothing was changed." }, { status: 500 });
  return NextResponse.json({ policy: v.policy });
}
