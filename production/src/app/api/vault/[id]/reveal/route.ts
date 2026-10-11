/**
 * POST /api/vault/[id]/reveal — hand back exactly one secret, and record it.
 *
 * ─── WHY REVEALING IS A WRITE ────────────────────────────────────────────────
 * This is a POST, not a GET, and that is not pedantry about verbs. A GET is
 * something the browser, a prefetcher, or a link preview may perform on its own
 * — and every one of those would silently decrypt a customer's admin password
 * and write a row into the audit log saying a person looked at it. Reads that
 * cause an irreversible side effect must be requested deliberately.
 *
 * ─── THE LOG IS WRITTEN BEFORE THE SECRET GOES OUT ───────────────────────────
 * If the log insert fails, the reveal fails. An access trail that is best-effort
 * is not a trail: the one view anybody would ever want to hide is exactly the
 * one worth dropping. Slower and honest beats fast and deniable.
 *
 * This is also why `log_activity` is not used here. It returns silently without
 * writing when there is no JWT, which was discovered the hard way on this
 * project (638 rows in, 638 rows out). A security log needs its own table with
 * its own insert that can actually fail.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/security/rate-limit";
import { decryptSecret, isVaultConfigured } from "@/lib/crypto/vault";
import { assessStrength } from "@/lib/vault/passwords";
import { vaultDb } from "@/lib/vault/db";
import { vaultGate } from "../../vault-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const db = vaultDb(supabase);
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  // R-716: only owner / manager may decrypt a stored credential (roles.ts can_reveal_vault).
  // Checked before anything is read or logged; RLS enforces the same rule underneath.
  const gate = await vaultGate(supabase, authData.user.id);
  if (!gate.ok) return gate.res;

  if (!isVaultConfigured()) {
    return NextResponse.json(
      { ok: false, error: "SECRETS_MASTER_KEY is not set, so stored secrets cannot be decrypted." },
      { status: 503 },
    );
  }

  // RLS scopes this to the caller's tenant; a wrong id returns nothing rather
  // than another tenant's credential.
  const { data: row, error } = await db
    .from("vault_passwords")
    .select("id, tenant_id, customer_id, title, username_ciphertext, password_ciphertext, notes_ciphertext")
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Log FIRST. If this insert fails, nothing is revealed.
  const { error: logError } = await db.from("vault_access_log").insert({
    tenant_id: row.tenant_id,
    credential_id: row.id,
    customer_id: row.customer_id,
    user_id: authData.user.id,
    action: "view",
    /* S20: XFF ki pehli entry client khud likhta hai — audit me wahi IP jo humari infra ne dekhi. */
    ip_address: ((ip) => (ip === "unknown" ? null : ip))(clientIp(req.headers)),
    user_agent: req.headers.get("user-agent"),
  });

  if (logError) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Could not record this access, so the password was not shown. "
          + "Viewing a stored credential is always logged.",
      },
      { status: 500 },
    );
  }

  const password = decryptSecret(row.password_ciphertext);

  return NextResponse.json({
    ok: true,
    title: row.title,
    username: decryptSecret(row.username_ciphertext),
    password,
    notes: decryptSecret(row.notes_ciphertext),
    strength: assessStrength(password),
  });
}
