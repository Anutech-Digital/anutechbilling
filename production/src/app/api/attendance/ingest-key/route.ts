/**
 * GET    /api/attendance/ingest-key           → { tenantId, key, hasKey }   (owner only)
 * GET    /api/attendance/ingest-key?status=1  → { hasKey }                  (any member — never the key)
 * POST   /api/attendance/ingest-key           → { tenantId, key }           (owner only — makes a new key)
 * DELETE /api/attendance/ingest-key           → { ok, hasKey: false }       (owner only — turns the key off)
 *
 * R-607. The biometric bridge's shared secret. Whoever holds it can post punches for any
 * employee on any date (/api/attendance/punch has no login — it is a machine door), so only
 * the owner may see or rotate it. It lives in attendance_settings.ingest_key, a column
 * `authenticated` has no grant on; this route reads and writes it with the server client,
 * scoped to the owner's own tenant. It used to sit on tenants.attendance_ingest_key, which
 * every member reads.
 *
 * R-609 (10 Oct 2026). Pardeep has no machine yet, so a left-over key is an open door with
 * nothing behind it. DELETE sets it to null — with no key, /punch matches no tenant and
 * refuses every batch. An activity_log row records who turned it off and when (never the
 * key itself), written BEFORE the change so an un-audited change cannot happen.
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

interface Caller { userId: string; tenantId: string; role: string | null }
type Gate = { ok: true; who: Caller } | { ok: false; fail: NextResponse };

async function signedIn(): Promise<Gate> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return { ok: false, fail: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id) {
    return { ok: false, fail: NextResponse.json({ error: "No workspace found for this login." }, { status: 403 }) };
  }
  return { ok: true, who: { userId: authData.user.id, tenantId: me.tenant_id as string, role: (me.role as string | null) ?? null } };
}

async function ownerOnly(): Promise<Gate> {
  const gate = await signedIn();
  if (!gate.ok) return gate;
  if (gate.who.role !== "owner") {
    return {
      ok: false,
      fail: NextResponse.json(
        { error: "Only the owner can see or change the biometric device key. Ask the owner to open this page." },
        { status: 403 },
      ),
    };
  }
  return gate;
}

export async function GET(req: NextRequest) {
  const statusOnly = new URL(req.url).searchParams.get("status") === "1";
  const gate = statusOnly ? await signedIn() : await ownerOnly();
  if (!gate.ok) return gate.fail;
  const { who } = gate;
  const { data } = await createAdminClientFor(who.userId)
    .from("attendance_settings").select("ingest_key").eq("tenant_id", who.tenantId).maybeSingle();
  const key = (data?.ingest_key as string | null | undefined) ?? null;
  if (statusOnly) return NextResponse.json({ hasKey: Boolean(key) });
  return NextResponse.json({ tenantId: who.tenantId, key, hasKey: Boolean(key) });
}

export async function POST() {
  const gate = await ownerOnly();
  if (!gate.ok) return gate.fail;
  const { who } = gate;
  const fresh = crypto.randomBytes(24).toString("hex");
  const { error } = await createAdminClientFor(who.userId)
    .from("attendance_settings")
    .upsert({ tenant_id: who.tenantId, ingest_key: fresh, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ error: "Could not make a new key. Nothing was changed — try again." }, { status: 500 });
  }
  return NextResponse.json({ tenantId: who.tenantId, key: fresh });
}

export async function DELETE() {
  const gate = await ownerOnly();
  if (!gate.ok) return gate.fail;
  const { who } = gate;
  const admin = createAdminClientFor(who.userId);

  const { data: current, error: readErr } = await admin
    .from("attendance_settings").select("ingest_key").eq("tenant_id", who.tenantId).maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: "Could not check the machine key. Nothing was changed — try again." }, { status: 500 });
  }
  if (!current?.ingest_key) {
    // Already off — nothing to change, nothing to audit.
    return NextResponse.json({ ok: true, hasKey: false, alreadyOff: true });
  }

  const { data: audit, error: auditErr } = await admin
    .from("activity_log")
    .insert({
      tenant_id: who.tenantId,
      user_id:   who.userId,
      action:    "attendance_ingest_key_off",
      entity:    "attendance_settings",
      entity_id: who.tenantId,
      label:     "Biometric machine key turned off — machine punches are refused until a new key is made",
    })
    .select("id")
    .single();
  if (auditErr || !audit) {
    return NextResponse.json(
      { error: "Could not write the audit record, so the key was not turned off. Try again." },
      { status: 500 },
    );
  }

  const { error } = await admin
    .from("attendance_settings")
    .update({ ingest_key: null, updated_at: new Date().toISOString() })
    .eq("tenant_id", who.tenantId);
  if (error) {
    await admin
      .from("activity_log")
      .update({ action: "attendance_ingest_key_off_failed", label: "Biometric machine key NOT turned off — the save failed" })
      .eq("id", audit.id);
    return NextResponse.json({ error: "Could not turn the key off. The old key still works — try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, hasKey: false });
}
