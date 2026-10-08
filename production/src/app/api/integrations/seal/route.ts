/**
 * POST /api/integrations/seal
 *
 * Re-encrypt every credential in `tenant_secrets` that is still stored in
 * plaintext, in place, without anyone retyping anything.
 *
 * ─── WHY THIS ROUTE HAD TO EXIST ─────────────────────────────────────────────
 * The plan for switching on envelope encryption was "open each integration dialog
 * and press Save", because saving re-runs `sealTenantSecrets`. That stopped
 * working the moment the Razorpay wipe bug was fixed — and correctly so.
 *
 * The dialogs never prefill a secret (a server that hands a live key secret back
 * to the browser has already lost). Before the fix, a blank box was written
 * through as NULL, which is what made "just press Save" appear to work while
 * actually destroying the webhook secret. After the fix a blank box means "leave
 * it alone" — safe, and it also means pressing Save changes nothing, so nothing
 * gets sealed.
 *
 * Retyping every secret from each vendor dashboard would work but is exactly the
 * copy-paste ceremony that has already cost this project two secrets. The server
 * already holds both halves: the plaintext in the database and the master key in
 * its environment. So it can do the job itself.
 *
 * ─── WHAT IT IS CAREFUL ABOUT ────────────────────────────────────────────────
 * • Refuses outright when SECRETS_MASTER_KEY is absent, rather than "succeeding"
 *   and leaving everything in the clear.
 * • Only touches values that are NOT already envelopes, so it is safe to run
 *   twice — running it again is a no-op, not a double-encryption.
 * • Owner-only.
 * • Never returns or logs a secret value; only names and counts.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { SECRET_COLUMNS, trySealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { isVaultConfigured, isEncrypted } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me) {
    return NextResponse.json({ ok: false, error: "User not linked to a tenant" }, { status: 403 });
  }
  if (me.role !== "owner") {
    return NextResponse.json({ ok: false, error: "Only the workspace owner can seal credentials" }, { status: 403 });
  }

  // Fail loudly. Reporting success here while leaving credentials in the clear is
  // the precise failure this whole exercise exists to remove.
  if (!isVaultConfigured()) {
    return NextResponse.json({
      ok: false,
      error: "SECRETS_MASTER_KEY is not set on this server, so nothing can be encrypted. "
           + "Set it on the deployment first, then run this again.",
    }, { status: 503 });
  }

  const admin = createAdminClientFor(authData.user.id);
  const { data: row, error: readErr } = await admin
    .from("tenant_secrets")
    .select("*")
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (readErr) return NextResponse.json({ ok: false, error: readErr.message }, { status: 500 });
  if (!row) {
    return NextResponse.json({ ok: true, sealed: [], alreadySealed: [], empty: true });
  }

  // Typed as the secret columns rather than a loose record, so a typo in a column
  // name is a compile error instead of a silently skipped credential.
  type SecretColumn = (typeof SECRET_COLUMNS)[number];
  const plain: Partial<Record<SecretColumn, string>> = {};
  const alreadySealed: string[] = [];

  for (const col of SECRET_COLUMNS) {
    const value = (row as Record<string, unknown>)[col];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (isEncrypted(value)) { alreadySealed.push(col); continue; }
    plain[col] = value;
  }

  const toSeal = Object.keys(plain);
  if (toSeal.length === 0) {
    return NextResponse.json({ ok: true, sealed: [], alreadySealed, nothingToDo: true });
  }

  // Should be impossible — isVaultConfigured() was checked above — but if the key
  // vanished between the two calls, sealing refuses (R-051) and nothing is written.
  const sealed = trySealTenantSecrets(plain);
  if (!sealed.ok) return NextResponse.json({ ok: false, error: sealed.error }, { status: sealed.status });
  const sealedRow = sealed.row;

  // The cast covers ONE ordering problem, not a type hole: SECRET_COLUMNS now
  // lists `resend_api_key`, but `types.ts` is generated from the live database
  // and migration 0237 has not been applied, so that column does not exist to
  // TypeScript yet. Every key in `sealedRow` still comes from SECRET_COLUMNS, so
  // a typo cannot sneak through here — it would have to be typo'd in the
  // constant, where it is one list of seven strings.
  //
  // Remove the cast once 0237 is applied and types are regenerated.
  const secretsTable = admin.from("tenant_secrets") as unknown as {
    update(patch: Partial<Record<SecretColumn, string>>): {
      eq(column: string, value: string): Promise<{ error: { message: string } | null }>;
    };
  };
  const { error: writeErr } = await secretsTable
    .update(sealedRow)
    .eq("tenant_id", me.tenant_id);

  if (writeErr) return NextResponse.json({ ok: false, error: writeErr.message }, { status: 500 });

  // Column names only. A count and a list of field names is everything an
  // operator needs, and nothing an attacker does.
  return NextResponse.json({ ok: true, sealed: toSeal, alreadySealed });
}
