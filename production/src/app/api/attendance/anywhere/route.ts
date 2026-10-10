/**
 * POST /api/attendance/anywhere  { employeeId, value }   (owner only)
 *
 * R-605. Pardeep: "kuch log bahar se laga sakte hai attendance". Turns "Can mark from outside
 * office" on or off for one employee. With it on, My Attendance works off the office Wi-Fi
 * (the day is flagged outside_office for review) and a device can be registered off-site;
 * without it, both need the office Wi-Fi once the owner has locked one.
 *
 * Owner only, like device approval (Pardeep, 9 Oct: "sirf owner approve kare"): this switch
 * decides who may skip the office rule, so it is the same decision.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not signed in. Sign in again and retry." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id || me.role !== "owner") {
    return NextResponse.json(
      { error: "Only the owner can choose who may mark attendance from outside the office." },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  const employeeId = typeof body?.employeeId === "string" ? body.employeeId : "";
  const value = body?.value === true;
  if (!employeeId) return NextResponse.json({ error: "Pick an employee first." }, { status: 400 });

  const { data, error } = await createAdminClientFor(authData.user.id)
    .from("employees")
    .update({ attendance_anywhere: value })
    .eq("id", employeeId).eq("tenant_id", me.tenant_id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not save. Nothing was changed — try again." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "That employee is not in this workspace. Refresh the page." }, { status: 404 });
  return NextResponse.json({ ok: true, value });
}
