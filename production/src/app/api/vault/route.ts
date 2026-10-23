/**
 * /api/vault — list and create customer console credentials.
 *
 * ─── WHY THIS IS A ROUTE AND NOT A SUPABASE QUERY FROM THE PAGE ──────────────
 * Everything else in this app reads its own table straight from the browser and
 * lets RLS do the work. This cannot, for one reason: decryption needs
 * SECRETS_MASTER_KEY, and that key must never reach a browser. The moment the
 * page could decrypt, the key would be in the bundle and the encryption would be
 * decoration.
 *
 * ─── GET NEVER RETURNS A SECRET ──────────────────────────────────────────────
 * Not the plaintext, and not the ciphertext either. Shipping ciphertext to the
 * client "because it's encrypted" hands an attacker an offline copy to work on
 * at leisure, and it would sit in the browser cache and in every HAR file
 * support ever asks a customer for. The list is metadata and health only. A
 * single secret comes back exactly one at a time, from /reveal, and that call
 * is logged.
 *
 * ─── RLS STILL DOES THE TENANT SCOPING ───────────────────────────────────────
 * These handlers use the request-scoped client, not the admin client, even
 * though the admin client would be simpler. With the user's own client a bug in
 * my WHERE clause cannot leak another tenant's credentials, because the database
 * refuses. With the admin client, that one bug is the whole breach.
 *
 * ─── EXCEPT THE CIPHERTEXT COLUMNS (R-840) ───────────────────────────────────
 * username/password/notes_ciphertext are server-only: browser roles hold no SELECT, INSERT or
 * UPDATE on them (20261011081000_r840_vault_ciphertext_columns.sql). POST therefore writes the
 * new row with the admin client, only after vaultGate() (owner / manager), with tenant_id set
 * from the gate — never from the body. GET reads non-secret columns only, with the user client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClientFor, createClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/security/rate-limit";
import { encryptSecret, isVaultConfigured, fingerprintPassword } from "@/lib/crypto/vault";
import { assessStrength, vaultHealth, type VaultEntryHealth } from "@/lib/vault/passwords";
import { vaultDb, UNDEFINED_TABLE, type VaultCategory } from "@/lib/vault/db";
import { istToday } from "@/lib/dates/ist";
import { vaultGate } from "./vault-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export async function GET() {
  const supabase = createClient();
  const db = vaultDb(supabase);
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  // R-716: owner / manager only — the same roles that see the /vault menu.
  const gate = await vaultGate(supabase, authData.user.id);
  if (!gate.ok) return gate.res;

  const { data, error } = await db
    .from("vault_passwords")
    .select("id, customer_id, title, category, url, password_fingerprint, last_rotated_at, created_at, updated_at")
    .order("title");

  if (error) {
    // Told apart from a real failure on purpose: "you have not applied the
    // migration" is a fixable setup step, and showing it as a generic error is
    // how somebody spends an afternoon debugging the wrong thing.
    if (error.code === UNDEFINED_TABLE) {
      return NextResponse.json(
        {
          ok: false,
          setupRequired: true,
          error: "The vault tables do not exist yet. Apply migration 0234_vault_passwords.sql, then reload.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  const today = istToday();   // R-1653: IST day, not the UTC one

  // Health is computed from fingerprints and dates — none of which are secrets.
  const health = vaultHealth(
    rows.map((r): VaultEntryHealth => ({
      id: r.id,
      title: r.title,
      category: r.category,
      customerId: r.customer_id,
      fingerprint: r.password_fingerprint ?? null,
      // No `password` field: judging strength needs the plaintext, and this
      // handler deliberately never decrypts. So vaultHealth reports reuse and
      // rotation age here, and simply cannot report weakness — which is the
      // honest trade for not holding every secret in memory to build a list.
      lastRotatedAt: r.last_rotated_at ? String(r.last_rotated_at).slice(0, 10) : null,
    })),
    today,
  );

  return NextResponse.json({
    ok: true,
    configured: isVaultConfigured(),
    entries: rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      title: r.title,
      category: r.category,
      url: r.url,
      hasPassword: Boolean(r.password_fingerprint),
      lastRotatedAt: r.last_rotated_at,
      createdAt: r.created_at,
    })),
    health,
  });
}

interface CreateBody {
  title?: unknown;
  category?: unknown;
  url?: unknown;
  customerId?: unknown;
  username?: unknown;
  password?: unknown;
  notes?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const CATEGORIES: VaultCategory[] = [
  "google_admin", "m365_admin", "dns_registrar", "cpanel", "distributor", "other",
];

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const db = vaultDb(supabase);
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  // R-716: owner / manager only — the same roles that see the /vault menu.
  const gate = await vaultGate(supabase, authData.user.id);
  if (!gate.ok) return gate.res;

  // Refuse rather than store an admin console password in the clear. A vault
  // that silently degrades to plaintext is the worst of both worlds: it carries
  // the trust of a vault and the safety of a spreadsheet.
  if (!isVaultConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "SECRETS_MASTER_KEY is not set on this deployment, so passwords cannot be encrypted. "
          + "Nothing was saved.",
      },
      { status: 503 },
    );
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const title = str(body.title);
  const password = typeof body.password === "string" ? body.password : "";
  if (!title) {
    return NextResponse.json({ ok: false, error: "Title is required." }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ ok: false, error: "Password is required." }, { status: 400 });
  }

  const me = { tenant_id: gate.tenantId };

  const username = str(body.username);
  const notes    = str(body.notes);

  // R-840: ciphertext columns are server-only — written with the admin client, after the gate.
  const admin = vaultDb(createAdminClientFor(authData.user.id));
  const { data: created, error } = await admin
    .from("vault_passwords")
    .insert({
      tenant_id: me.tenant_id,
      customer_id: str(body.customerId) || null,
      title,
      // Narrowed against the enum rather than trusted: an unknown string would
      // be rejected by the DB check constraint as a 500 the user cannot act on.
      category: CATEGORIES.includes(str(body.category) as VaultCategory)
        ? (str(body.category) as VaultCategory)
        : "other",
      url: str(body.url) || null,
      username_ciphertext: username ? encryptSecret(username) : null,
      password_ciphertext: encryptSecret(password),
      notes_ciphertext: notes ? encryptSecret(notes) : null,
      password_fingerprint: fingerprintPassword(password),
      // Set at creation so "never rotated" and "created today" are not confused:
      // a credential entered today genuinely is current.
      last_rotated_at: new Date().toISOString(),
      created_by: authData.user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === UNDEFINED_TABLE) {
      return NextResponse.json(
        { ok: false, setupRequired: true, error: "Apply migration 0234_vault_passwords.sql first." },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // .single() is typed as nullable; without this guard a failed insert would
  // read created.id and throw a 500 that hides the real cause.
  if (!created) {
    return NextResponse.json({ ok: false, error: "Saved but no id returned." }, { status: 500 });
  }

  await db.from("vault_access_log").insert({
    tenant_id: me.tenant_id,
    credential_id: created.id,
    customer_id: str(body.customerId) || null,
    user_id: authData.user.id,
    action: "create",
    /* S20: XFF ki pehli entry client khud likhta hai — audit me wahi IP jo humari infra ne dekhi. */
    ip_address: ((ip) => (ip === "unknown" ? null : ip))(clientIp(req.headers)),
    user_agent: req.headers.get("user-agent"),
  });

  // The strength assessment is returned but NOT stored — it is advice about the
  // value, and keeping it next to the row would tell a reader of the table which
  // credentials are the weak ones to attack first.
  return NextResponse.json({
    ok: true,
    id: created.id,
    strength: assessStrength(password),
  });
}
