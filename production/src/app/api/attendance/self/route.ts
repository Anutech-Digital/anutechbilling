/**
 * POST /api/attendance/self  { photo?, code?, lat?, lng?, accuracy? }
 *
 * Self check-in for a logged-in app user. Defense-in-depth:
 *   • Identity  — the login (auth.uid()) proves WHO.
 *   • Presence  — when require_presence is on, the rotating office code proves
 *                 the person is physically at the office (can only be read off
 *                 the office tablet). R-440: checked INSIDE the database by
 *                 validate_presence_code() — this route never sees the seed.
 *   • Proof     — when require_selfie is on, a live selfie is captured; GPS is
 *                 always stored (soft audit signal) if the phone shares it.
 *   • Location  — R-438: when the owner set the office location, mark_self_attendance()
 *                 measures the distance IN THE DATABASE: block refuses (403, "You are about
 *                 500 m from the office"), flag marks + flag outside_office. The office code
 *                 is checked there again, so calling the RPC directly skips nothing.
 *
 *   • Device    — R-606: when require_device is on, the check-in must carry a passkey
 *                 signature (`deviceAssertion`) from an OWNER-APPROVED device of THIS
 *                 employee. Threat: a colleague who knows the password checks someone in
 *                 from his own laptop. The passkey's private key never leaves the employee's
 *                 device (a synced passkey follows only their own Google/Apple account), so
 *                 another laptop cannot sign. When off: the old soft token + new_device flag.
 *
 * Flow: validate presence → device passkey (if required) → mark_self_attendance(lat, lng,
 * accuracy, code) → attach
 * selfie + geo to the day's row (best-effort; never blocks the mark once recorded).
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { compareFaces } from "@/lib/attendance/face";
import { officeNetworkDecision } from "@/lib/attendance/office-network";
import { requestIp } from "@/lib/attendance/request-ip";
import { accuracyM, coord, markErrorReply } from "@/lib/attendance/geofence";
import { deviceError } from "@/lib/attendance/webauthn";
import { getCaller, verifyDeviceAssertion } from "../device/_server";
import { presenceGateReply } from "./presence-gate";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const photo = body?.photo as string | undefined; // data:image/jpeg;base64,...
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  // R-438: out-of-range or non-numeric coordinates count as "no location".
  const lat = coord(body?.lat, 90);
  const lng = coord(body?.lng, 180);
  const accuracy = accuracyM(body?.accuracy);
  const deviceRaw = typeof body?.device === "string" ? body.device.trim() : "";
  const deviceHash = deviceRaw ? crypto.createHash("sha256").update(deviceRaw).digest("hex").slice(0, 32) : null;

  // Caller's tenant + linked employee — needed for the selfie storage path.
  const { data: me } = await supabase
    .from("users").select("tenant_id, employee_id").eq("id", authData.user.id).single();
  if (!me?.employee_id) {
    return NextResponse.json(
      { error: "Pehle apna employee record link karo, phir attendance mark hogi." },
      { status: 400 },
    );
  }

  /* R-601: employees cannot write attendance rows themselves any more. The mark itself is
     the SECURITY DEFINER RPC below; the settings read and the selfie / geo / flags patch
     after it go through the server client, and every one of those calls is scoped to THIS
     caller's tenant + linked employee in code. R-440: the office-code seed is not read here
     at all — validate_presence_code() checks the code inside the database. */
  const admin = createAdminClientFor(authData.user.id);
  const { data: settings } = me.tenant_id
    ? await admin
      .from("attendance_settings")
      .select("require_selfie, require_presence, require_face_match, require_device, allowed_ips")
      .eq("tenant_id", me.tenant_id)
      .maybeSingle()
    : { data: null };
  const requireSelfie = settings?.require_selfie ?? true;
  const requirePresence = settings?.require_presence ?? false;
  const requireFaceMatch = settings?.require_face_match ?? false;
  const requireDevice = settings?.require_device ?? false;

  /* R-605 — office Wi-Fi. Until 10 Oct only the kiosk checked allowed_ips, so My Attendance
     worked from home even with the office network locked. Checked before anything is
     recorded; "Can mark from outside office" staff pass and the day is flagged. */
  const { data: empNet } = await admin
    .from("employees").select("attendance_anywhere")
    .eq("id", me.employee_id).eq("tenant_id", me.tenant_id ?? "").maybeSingle();
  const net = officeNetworkDecision({
    purpose: "self",
    allowedIps: settings?.allowed_ips ?? [],
    ip: requestIp(request),
    anywhere: empNet?.attendance_anywhere ?? false,
  });
  if (!net.ok) return NextResponse.json({ error: net.error, code: net.code }, { status: net.status });

  // Presence gate — must know the current rotating office code (R-440: checked in the
  // database, for the caller's own company, with a wrong-code limit).
  if (requirePresence) {
    const gate = presenceGateReply(await supabase.rpc("validate_presence_code", { p_code: code }));
    if (gate) return NextResponse.json(gate.body, { status: gate.status });
  }

  if (requireSelfie && !photo) {
    return NextResponse.json(
      { error: "Selfie zaroori hai — camera allow karke dobara try karo." },
      { status: 400 },
    );
  }

  // DPDP shield — never store a face selfie without recorded consent.
  if (requireSelfie) {
    const { data: emp } = await supabase
      .from("employees").select("attendance_consent_at").eq("id", me.employee_id).maybeSingle();
    if (!emp?.attendance_consent_at) {
      return NextResponse.json(
        { error: "NEEDS_CONSENT", needsConsent: true },
        { status: 428 },
      );
    }
  }

  /* R-606 device gate — the last check before the mark, so the passkey's one-time challenge is
     only spent once every other check has passed. */
  let approvedDeviceId: string | null = null;
  if (requireDevice) {
    if (!body?.deviceAssertion) return NextResponse.json(deviceError("DEVICE_REQUIRED"), { status: 403 });
    const caller = await getCaller();
    if (!caller || caller.employeeId !== me.employee_id) {
      return NextResponse.json(deviceError("DEVICE_NOT_REGISTERED"), { status: 403 });
    }
    const check = await verifyDeviceAssertion(caller, request, body.deviceAssertion);
    if (!check.ok) return NextResponse.json({ error: check.error, code: check.code }, { status: 403 });
    approvedDeviceId = check.deviceId;
  }

  /* R-438: the office-location check (and the office code again) run INSIDE the function, so a
     direct RPC call cannot skip them. The no-argument version is service-role only now.
     Generated types say number for the coordinates; the function takes NULL = no location. */
  const markArgs = { p_lat: lat, p_lng: lng, p_accuracy: accuracy, p_code: code || undefined };
  const { data, error } = await supabase.rpc(
    "mark_self_attendance",
    markArgs as unknown as { p_lat: number; p_lng: number; p_accuracy: number; p_code?: string },
  );
  if (error) {
    const reply = markErrorReply(error);
    return NextResponse.json(reply.body, { status: reply.status });
  }
  const action = data as unknown as string;

  // Attach selfie + geo (best-effort — attendance is already recorded).
  if (action === "checked_in" || action === "checked_out") {
    try {
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const workDate = istNow.toISOString().slice(0, 10);
      const slot = action === "checked_in" ? "in" : "out";
      const patch: {
        selfie_in?: string; selfie_out?: string; geo_in?: string; geo_out?: string;
        check_in_device?: string; check_out_device?: string; flags?: string[];
      } = {};

      if (photo) {
        const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
        const buf = Buffer.from(base64, "base64");
        if (me.tenant_id && buf.length > 0 && buf.length < 3_000_000) {
          const path = `${me.tenant_id}/${workDate}/${me.employee_id}_${slot}.jpg`;
          const up = await supabase.storage.from("attendance-selfies").upload(path, buf, { contentType: "image/jpeg", upsert: true });
          if (!up.error) patch[slot === "in" ? "selfie_in" : "selfie_out"] = path;
        }
      }
      if (lat !== null && lng !== null) {
        patch[slot === "in" ? "geo_in" : "geo_out"] = `${lat.toFixed(6)},${lng.toFixed(6)}${accuracy !== null ? `,${Math.round(accuracy)}` : ""}`;
      }
      // R-606: with a required device, the approved device's id is the record; else the soft hash.
      const deviceMark = approvedDeviceId ?? deviceHash;
      if (deviceMark) patch[slot === "in" ? "check_in_device" : "check_out_device"] = deviceMark;

      // ── Anomaly flags (honest deterrence — surfaced to the owner, not blocking) ──
      const flags = new Set<string>();
      if (net.flag) flags.add(net.flag);
      const hour = istNow.getUTCHours(); // istNow already shifted to IST wall-clock
      if (hour < 5 || hour >= 23) flags.add("odd_hours");
      if (lat === null || lng === null) flags.add("no_location");
      if (deviceHash && !approvedDeviceId) {
        // "new device" = this soft token never used by this employee before.
        const { data: seen } = await supabase
          .from("attendance")
          .select("id")
          .eq("tenant_id", me.tenant_id)
          .eq("employee_id", me.employee_id)
          .or(`check_in_device.eq.${deviceHash},check_out_device.eq.${deviceHash}`)
          .limit(1);
        if (!seen || seen.length === 0) flags.add("new_device");
      }
      // ── Face verification (Phase 4 seam — opt-in; stub → owner review) ──────
      if (requireFaceMatch && photo) {
        const { data: emp } = await supabase
          .from("employees").select("face_ref_path").eq("id", me.employee_id).maybeSingle();
        if (!emp?.face_ref_path) {
          flags.add("face_not_enrolled");
        } else {
          const dl = await supabase.storage.from("attendance-selfies").download(emp.face_ref_path);
          if (dl.data) {
            const refB64 = Buffer.from(await dl.data.arrayBuffer()).toString("base64");
            const probeB64 = photo.includes(",") ? photo.split(",")[1] : photo;
            const cmp = await compareFaces(refB64, probeB64);
            if (cmp.match === false) flags.add("face_mismatch");
            else if (cmp.match === null) flags.add("face_review"); // stub / undecided → owner eyeballs it
            // cmp.match === true → verified, no flag
          } else {
            flags.add("face_review");
          }
        }
      }

      if (flags.size) {
        // Merge with any flags already on today's row (from the earlier punch).
        const { data: cur } = await supabase.from("attendance")
          .select("flags").eq("employee_id", me.employee_id).eq("work_date", workDate).maybeSingle();
        const merged = new Set([...(cur?.flags ?? []), ...flags]);
        patch.flags = [...merged];
      }

      if (Object.keys(patch).length && me.tenant_id) {
        await admin.from("attendance").update(patch)
          .eq("tenant_id", me.tenant_id).eq("employee_id", me.employee_id).eq("work_date", workDate);
      }
    } catch { /* selfie/geo is best-effort; never block attendance */ }
  }

  return NextResponse.json({ action });
}
