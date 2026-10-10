/**
 * GET  /api/attendance/network  → { allowedIps, currentIp, onAllowedNetwork }
 * POST /api/attendance/network  { action: 'lock' | 'clear' | 'remove', ip? }
 *
 * Owner/manager manages the office-network allowlist for attendance. "lock"
 * captures the CURRENT public IP (read server-side) as an allowed office
 * network; "remove" drops one; "clear" turns the gate off.
 *
 * R-606: action "require_device" { value } — self check-in only from an owner-approved passkey
 * device (threat: a colleague with someone's password checking them in from his own laptop;
 * a passkey's private key never leaves the employee's device). GET returns requireDevice and,
 * for the owner, employeesWithoutDevice — the people who would be blocked.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { newPresenceSecret } from "@/lib/attendance/presence";
import { parseShiftRules, validateShiftInput } from "@/lib/attendance/shift";
import { officeNetworkDecision } from "@/lib/attendance/office-network";
import { clientIp as trustedClientIp } from "@/lib/security/rate-limit";
import { countEmployeesWithoutDevice } from "../device/_server";

/* S20: /mark jaisa hi IP — dono ek hi niyam se padhein, warna "lock" kiya IP "mark" par
   kabhi mel na khaye. "" = IP nahi mili (purana matlab). */
function clientIp(req: NextRequest): string {
  const ip = trustedClientIp(req.headers);
  return ip === "unknown" ? "" : ip;
}

async function me(supabase: ReturnType<typeof createClient>) {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  return data ? { userId: authData.user.id, ...data } : null;
}

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data } = await supabase.from("attendance_settings").select("allowed_ips, require_selfie, require_presence, selfie_retention_days, require_face_match, require_device, shift_start, shift_end, late_grace_minutes, half_day_under_hours").maybeSingle();
  const allowedIps: string[] = data?.allowed_ips ?? [];
  const currentIp = clientIp(request);
  /* R-605: can THIS person self check-in from here? Same rule /api/attendance/self enforces —
     sent so My Attendance can say so before the press, not after. */
  const { data: myUser } = await supabase.from("users").select("employee_id").eq("id", u.userId).maybeSingle();
  const { data: myEmp } = myUser?.employee_id
    ? await supabase.from("employees").select("attendance_anywhere").eq("id", myUser.employee_id).maybeSingle()
    : { data: null };
  const selfHere = officeNetworkDecision({
    purpose: "self", allowedIps, ip: currentIp, anywhere: myEmp?.attendance_anywhere ?? false,
  });
  return NextResponse.json({
    selfCheckIn: selfHere.ok
      ? { ok: true as const, outsideOffice: selfHere.flag === "outside_office" }
      : { ok: false as const, error: selfHere.error },
    allowedIps,
    currentIp,
    onAllowedNetwork: allowedIps.length === 0 || allowedIps.includes(currentIp),
    requireSelfie: data?.require_selfie ?? true,
    requirePresence: data?.require_presence ?? false,
    retentionDays: data?.selfie_retention_days ?? 180,
    requireFaceMatch: data?.require_face_match ?? false,
    // R-604: office hours (late / half-day). Defaults when the workspace has no row.
    shift: parseShiftRules(data),
    // R-606: passkey device required for self check-in; the owner also sees who has none yet.
    requireDevice: data?.require_device ?? false,
    employeesWithoutDevice: u.role === "owner" && u.tenant_id
      ? await countEmployeesWithoutDevice(createAdminClientFor(u.userId), u.tenant_id)
      : null,
  });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const u = await me(supabase);
  if (!u) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (u.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change attendance security" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action as string | undefined;
  const currentIp = clientIp(request);

  /* R-601: presence_secret is not selectable by `authenticated` any more (it is the seed of
     the office code), so the owner's settings write goes through the server client, scoped
     to the owner's tenant here — the owner check above is the gate. */
  const admin = createAdminClientFor(u.userId);
  const { data: existing } = await admin.from("attendance_settings").select("allowed_ips, require_selfie, require_presence, presence_secret, selfie_retention_days, require_face_match, require_device, shift_start, shift_end, late_grace_minutes, half_day_under_hours").eq("tenant_id", u.tenant_id).maybeSingle();
  let allowed: string[] = existing?.allowed_ips ?? [];
  let requireSelfie: boolean = existing?.require_selfie ?? true;
  let requirePresence: boolean = existing?.require_presence ?? false;
  let presenceSecret: string | null = existing?.presence_secret ?? null;
  let retentionDays: number = existing?.selfie_retention_days ?? 180;
  let requireFaceMatch: boolean = existing?.require_face_match ?? false;
  let shift = parseShiftRules(existing);
  let requireDevice: boolean = existing?.require_device ?? false;

  if (action === "lock") {
    if (!currentIp) return NextResponse.json({ error: "Couldn't read this network's IP" }, { status: 400 });
    if (!allowed.includes(currentIp)) allowed = [...allowed, currentIp];
  } else if (action === "remove") {
    const ip = body?.ip as string | undefined;
    allowed = allowed.filter((a) => a !== ip);
  } else if (action === "clear") {
    allowed = [];
  } else if (action === "require_selfie") {
    requireSelfie = Boolean(body?.value);
  } else if (action === "require_presence") {
    requirePresence = Boolean(body?.value);
    // Enabling for the first time → mint the rotating-code seed.
    if (requirePresence && !presenceSecret) presenceSecret = newPresenceSecret();
  } else if (action === "set_retention") {
    const v = Number(body?.value);
    if (!Number.isFinite(v) || v < 30 || v > 3650) {
      return NextResponse.json({ error: "Retention 30–3650 din ke beech hona chahiye" }, { status: 400 });
    }
    retentionDays = Math.round(v);
  } else if (action === "require_face_match") {
    requireFaceMatch = Boolean(body?.value);
  } else if (action === "require_device") {
    // Allowed even while some people have no approved device — the response says how many.
    requireDevice = Boolean(body?.value);
  } else if (action === "set_shift") {
    const v = validateShiftInput(body?.value ?? {});
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    shift = v.rules;
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { error } = await admin
    .from("attendance_settings")
    .upsert({ tenant_id: u.tenant_id, allowed_ips: allowed, require_selfie: requireSelfie, require_presence: requirePresence, presence_secret: presenceSecret, selfie_retention_days: retentionDays, require_face_match: requireFaceMatch, shift_start: shift.shiftStart, shift_end: shift.shiftEnd, late_grace_minutes: shift.lateGraceMinutes, half_day_under_hours: shift.halfDayUnderHours, require_device: requireDevice, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const employeesWithoutDevice = u.tenant_id ? await countEmployeesWithoutDevice(admin, u.tenant_id) : 0;
  return NextResponse.json({ allowedIps: allowed, currentIp, requireSelfie, requirePresence, retentionDays, requireFaceMatch, shift, requireDevice, employeesWithoutDevice });
}
