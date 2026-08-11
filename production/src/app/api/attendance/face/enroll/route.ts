/**
 * POST /api/attendance/face/enroll  { photo, employeeId? }
 *
 * Enrol an employee's reference face (Phase 4 seam). Self-enrols the caller's
 * own employee, or — for owners — any employee (employeeId). Consent is required
 * first (same DPDP shield as selfies). Stores a private reference image and
 * stamps face_enrolled_at. No external call — enrollment is just a stored photo.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, role, employee_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const photo = body?.photo as string | undefined;
  const targetId = (body?.employeeId as string | undefined) ?? me.employee_id ?? undefined;

  if (!photo) return NextResponse.json({ error: "Photo zaroori hai" }, { status: 400 });
  if (!targetId) return NextResponse.json({ error: "Pehle apna employee link karo" }, { status: 400 });
  // Only the owner may enrol someone else's face.
  if (targetId !== me.employee_id && me.role !== "owner") {
    return NextResponse.json({ error: "Sirf owner doosre employee ko enrol kar sakta hai" }, { status: 403 });
  }

  const { data: emp } = await supabase
    .from("employees").select("id, tenant_id, attendance_consent_at").eq("id", targetId).maybeSingle();
  if (!emp || emp.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "Employee not in your workspace" }, { status: 400 });
  }
  if (!emp.attendance_consent_at) {
    return NextResponse.json({ error: "Pehle attendance consent zaroori hai", needsConsent: true }, { status: 428 });
  }

  const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0 || buf.length > 3_000_000) {
    return NextResponse.json({ error: "Photo galat ya bahut badi hai" }, { status: 400 });
  }

  const path = `${me.tenant_id}/_enroll/${targetId}.jpg`;
  const up = await supabase.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  const { error } = await supabase.from("employees")
    .update({ face_enrolled_at: new Date().toISOString(), face_ref_path: path })
    .eq("id", targetId).eq("tenant_id", me.tenant_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
