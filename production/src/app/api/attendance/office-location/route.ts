/**
 * GET  /api/attendance/office-location → { lat, lng, radiusM, mode, canEdit }
 * POST /api/attendance/office-location   { lat, lng, radiusM, mode }   (owner only)
 *
 * R-438: where the office is, how big the circle is, and what self check-in does outside it
 * (off / flag / block). The check itself runs inside mark_self_attendance(). Saving goes
 * through set_office_location() — owner only, enforced in the database (members have no
 * write grant on these columns), so this route's role check is only for a friendly reply.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { officeLocationSchema, parseOfficeLocation } from "@/lib/attendance/geofence";

export const dynamic = "force-dynamic";

async function me(supabase: ReturnType<typeof createClient>) {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).maybeSingle();
  return data?.tenant_id ? { tenantId: data.tenant_id as string, role: String(data.role ?? "") } : null;
}

export async function GET() {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Please sign in to a company account." }, { status: 401 });
  const { data, error } = await supabase
    .from("attendance_settings")
    .select("office_lat, office_lng, office_radius_m, geofence_mode")
    .eq("tenant_id", u.tenantId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not read the office location. Refresh the page and try again." }, { status: 500 });
  }
  return NextResponse.json({ ...parseOfficeLocation(data), canEdit: u.role === "owner" });
}

export async function POST(request: Request) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Please sign in to a company account." }, { status: 401 });
  if (u.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change where attendance may be marked from." }, { status: 403 });
  }
  const parsed = officeLocationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the office location and try again." }, { status: 400 });
  }
  const v = parsed.data;
  /* Generated types say number; the function takes NULL lat/lng when the check is off. */
  const args = { p_lat: v.lat, p_lng: v.lng, p_radius_m: v.radiusM, p_mode: v.mode };
  const { error } = await supabase.rpc(
    "set_office_location",
    args as unknown as { p_lat: number; p_lng: number; p_radius_m: number; p_mode: string },
  );
  if (error) {
    const status = error.code === "42501" || error.code === "28000" ? 403 : error.code === "22023" ? 400 : 500;
    return NextResponse.json({
      error: status === 500 ? "Could not save the office location. Try again in a minute." : error.message,
    }, { status });
  }
  return NextResponse.json({ ok: true, ...v });
}
