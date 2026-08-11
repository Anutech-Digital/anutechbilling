/**
 * POST /api/attendance/self  { photo?, code?, lat?, lng?, accuracy? }
 *
 * Self check-in for a logged-in app user. Defense-in-depth:
 *   • Identity  — the login (auth.uid()) proves WHO.
 *   • Presence  — when require_presence is on, the rotating office code proves
 *                 the person is physically at the office (can only be read off
 *                 the office tablet). Validated server-side against the secret.
 *   • Proof     — when require_selfie is on, a live selfie is captured; GPS is
 *                 always stored (soft audit signal) if the phone shares it.
 *
 * Flow: validate presence → mark_self_attendance() → attach selfie + geo to the
 * day's row (best-effort; never blocks the mark once recorded).
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { validateCode } from "@/lib/attendance/presence";
import { compareFaces } from "@/lib/attendance/face";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const photo = body?.photo as string | undefined; // data:image/jpeg;base64,...
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const lat = typeof body?.lat === "number" ? body.lat : null;
  const lng = typeof body?.lng === "number" ? body.lng : null;
  const accuracy = typeof body?.accuracy === "number" ? body.accuracy : null;
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

  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("require_selfie, require_presence, presence_secret, require_face_match")
    .maybeSingle();
  const requireSelfie = settings?.require_selfie ?? true;
  const requirePresence = settings?.require_presence ?? false;
  const requireFaceMatch = settings?.require_face_match ?? false;

  // Presence gate — must know the current rotating office code.
  if (requirePresence) {
    if (!settings?.presence_secret || !validateCode(settings.presence_secret, code, Date.now())) {
      return NextResponse.json(
        { error: "Office code galat ya expire ho gaya — office tablet pe abhi jo code hai wahi daalo." },
        { status: 400 },
      );
    }
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

  const { data, error } = await supabase.rpc("mark_self_attendance");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
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
      if (deviceHash) patch[slot === "in" ? "check_in_device" : "check_out_device"] = deviceHash;

      // ── Anomaly flags (honest deterrence — surfaced to the owner, not blocking) ──
      const flags = new Set<string>();
      const hour = istNow.getUTCHours(); // istNow already shifted to IST wall-clock
      if (hour < 5 || hour >= 23) flags.add("odd_hours");
      if (lat === null || lng === null) flags.add("no_location");
      if (deviceHash) {
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

      if (Object.keys(patch).length) {
        await supabase.from("attendance").update(patch)
          .eq("employee_id", me.employee_id).eq("work_date", workDate);
      }
    } catch { /* selfie/geo is best-effort; never block attendance */ }
  }

  return NextResponse.json({ action });
}
