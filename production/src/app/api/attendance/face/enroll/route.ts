/**
 * POST /api/attendance/face/enroll  { photo, employeeId? }
 *
 * Enrol an employee's reference face (Phase 4 seam). Self-enrols the caller's
 * own employee, or — for owners — any employee (employeeId). Consent is required
 * first (same DPDP shield as selfies). Stores a private reference image and
 * stamps face_enrolled_at. No external call — enrollment is just a stored photo.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { apiFailure } from "@/lib/errors/api-error";

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

  if (!photo) return NextResponse.json({ error: "A photo is required" }, { status: 400 });
  if (!targetId) return NextResponse.json({ error: "Link your employee record first" }, { status: 400 });
  // Only the owner may enrol someone else's face.
  if (targetId !== me.employee_id && me.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can enrol another employee" }, { status: 403 });
  }

  /* R-1001: read through the server client, scoped to the caller's tenant (employees SELECT
     is owner / manager / accountant only, so a sales login enrolling its OWN face read
     nothing). targetId is already limited above to the caller's own employee, or anyone for
     the owner. */
  const admin = createAdminClientFor(authData.user.id);
  const { data: emp } = await admin
    .from("employees").select("id, tenant_id, attendance_consent_at")
    .eq("id", targetId).eq("tenant_id", me.tenant_id).maybeSingle();
  if (!emp || emp.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "Employee not in your workspace" }, { status: 400 });
  }
  if (!emp.attendance_consent_at) {
    return NextResponse.json({ error: "Attendance consent is required first", needsConsent: true }, { status: 428 });
  }

  const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0 || buf.length > 3_000_000) {
    return NextResponse.json({ error: "The photo is invalid or too large" }, { status: 400 });
  }

  /* R-724: _enroll is server-only in storage (20261011133000_r724_storage_roles) — with the
     browser token anyone in the workspace could overwrite a colleague's reference face and
     clock in as them. targetId passed the owner/self + same-tenant + consent checks above. */
  const path = `${me.tenant_id}/_enroll/${targetId}.jpg`;
  const up = await admin.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
  // R-1137: storage / DB text is logged, the screen gets a fixed sentence + code.
  if (up.error) {
    return NextResponse.json(
      apiFailure("FACE_UPLOAD_FAILED", "Could not save the face photo — nothing was changed. Take the photo again and retry.", up.error, "attendance/face/enroll"),
      { status: 500 },
    );
  }

  /* R-601: on the server client. employees writes are owner/manager/accountant only
     (20260930175000_role_hardening.sql), and an RLS-blocked update is silent, so an
     employee enrolling their OWN face got "ok" with nothing saved. targetId is already
     limited above to the caller's own employee, or anyone for the owner. */
  const { error } = await admin.from("employees")
    .update({ face_enrolled_at: new Date().toISOString(), face_ref_path: path })
    .eq("id", targetId).eq("tenant_id", me.tenant_id);
  if (error) {
    return NextResponse.json(
      apiFailure("FACE_SAVE_FAILED", "The photo was uploaded but the employee record was not updated. Save the photo again; if it keeps failing, tell the owner.", error, "attendance/face/enroll"),
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
