/**
 * GET  /api/attendance/ingest-key → { tenantId, key }   (owner only)
 * POST /api/attendance/ingest-key → { tenantId, key }   (owner only — makes a new key)
 *
 * R-607. The biometric bridge's shared secret. Whoever holds it can post punches for any
 * employee on any date (/api/attendance/punch has no login — it is a machine door), so only
 * the owner may see or rotate it. It lives in attendance_settings.ingest_key, a column
 * `authenticated` has no grant on; this route reads and writes it with the server client,
 * scoped to the owner's own tenant. It used to sit on tenants.attendance_ingest_key, which
 * every member reads.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

async function ownerOnly() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return { fail: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) } as const;
  }
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id || me.role !== "owner") {
    return {
      fail: NextResponse.json(
        { error: "Only the owner can see or change the biometric device key. Ask the owner to open this page." },
        { status: 403 },
      ),
    } as const;
  }
  return { userId: authData.user.id, tenantId: me.tenant_id as string } as const;
}

export async function GET() {
  const who = await ownerOnly();
  if ("fail" in who) return who.fail;
  const { data } = await createAdminClientFor(who.userId)
    .from("attendance_settings").select("ingest_key").eq("tenant_id", who.tenantId).maybeSingle();
  return NextResponse.json({ tenantId: who.tenantId, key: data?.ingest_key ?? null });
}

export async function POST() {
  const who = await ownerOnly();
  if ("fail" in who) return who.fail;
  const fresh = crypto.randomBytes(24).toString("hex");
  const { error } = await createAdminClientFor(who.userId)
    .from("attendance_settings")
    .upsert({ tenant_id: who.tenantId, ingest_key: fresh, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ error: "Could not make a new key. Nothing was changed — try again." }, { status: 500 });
  }
  return NextResponse.json({ tenantId: who.tenantId, key: fresh });
}
