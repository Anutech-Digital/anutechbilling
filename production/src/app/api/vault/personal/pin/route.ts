/**
 * GET  /api/vault/personal/pin   → is a PIN set, and is it currently locked out?
 * POST /api/vault/personal/pin   → { action: "set" | "verify" | "remove", … }
 *
 * ─── WHY THE PIN IS SERVER-SIDE AT ALL ──────────────────────────────────────
 * The PIN is a screen lock, not encryption — `lib/vault/personal/pin.ts` says so at
 * length and the UI repeats it. But a screen lock checked in the browser is not even a
 * screen lock: the hash would have to be shipped to the client, where 10,000 candidates
 * is a fraction of a second of work, and the attempt counter would be a variable the
 * person being locked out controls.
 *
 * So: comparison is timing-safe here, and the lockout lives in a row the owner can READ
 * but never write (GP-02b, R-2112).
 *
 * ─── GP-02b: EVERY WRITE GOES THROUGH A SERVICE-ROLE SQL FUNCTION ───────────
 * Before 30 Oct 2026 the row was writable by its owner's session (devtools could PATCH
 * failed_attempts = 0) and the counter was read here, then written back +1 — five parallel
 * wrong guesses all read 0, all wrote 1, and the lock never closed. Now:
 *   · vault_pin_begin_attempt() COUNTS the attempt in one UPDATE … RETURNING, before the
 *     PIN is checked, and only while the lock is open — so at most MAX_ATTEMPTS guesses
 *     are ever checked per lock window, however many requests arrive at once;
 *   · a correct PIN then clears it (vault_pin_clear_attempts);
 *   · set / remove use vault_pin_save / vault_pin_remove.
 * Those functions are EXECUTE-able by service_role only, so they are called with the
 * admin client — always for `who.userId`, which requireOwner() proved from the session.
 * Migration: 20261030042132_gp02b_vault_pin_hardening.sql.
 *
 * ─── WHAT THE CALLER IS TOLD, AND WHAT IT IS NOT ────────────────────────────
 * A wrong PIN returns 401 with how many attempts remain. It does NOT say whether a PIN
 * is even configured on a verify — that is what GET is for, and the owner is the only
 * one who can call either. There is no user id parameter anywhere in this route: every
 * operation is on `auth.uid()`'s own row, so there is nothing to enumerate.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import {
  validateNewPin,
  newSalt,
  hashPin,
  verifyPin,
  lockState,
  MAX_ATTEMPTS,
} from "@/lib/vault/personal/pin";

const bodySchema = z.object({
  action: z.enum(["set", "verify", "remove"]),
  pin: z.string().optional(),
  currentPin: z.string().optional(),
});

/** One reply of vault_pin_begin_attempt (it returns a single-row table). */
interface AttemptRow {
  status: "ok" | "locked" | "none";
  pin_hash: string | null;
  pin_salt: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

/** The PIN functions are not in the generated types yet; this is the slice the route uses. */
interface PinRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

function pinDb(userId: string): PinRpcClient {
  return createAdminClientFor(userId) as unknown as PinRpcClient;
}

const SERVER_FAIL = "The vault lock could not be updated. Try again in a minute.";

function serverFail() {
  return NextResponse.json({ error: SERVER_FAIL }, { status: 500 });
}

/**
 * Take one attempt from the lock, atomically, and check `supplied` against the PIN.
 * Returns the reply to send on failure, or `{ ok: true }` when the PIN was right (the
 * counter is already cleared then).
 */
async function attempt(
  db: PinRpcClient,
  userId: string,
  supplied: string,
  wrongMessage: (left: number, locked: boolean) => string,
): Promise<{ ok: true } | { ok: false; reply: NextResponse }> {
  const { data, error } = await db.rpc("vault_pin_begin_attempt", { p_user_id: userId });
  if (error) return { ok: false, reply: serverFail() };
  const r = (Array.isArray(data) ? data[0] : data) as AttemptRow | undefined;
  if (!r) return { ok: false, reply: serverFail() };

  if (r.status === "none") {
    return { ok: false, reply: NextResponse.json({ error: "No PIN is set." }, { status: 400 }) };
  }
  if (r.status === "locked") {
    const { retryAfterSec } = lockState(r.failed_attempts, r.locked_until, new Date());
    return {
      ok: false,
      reply: NextResponse.json(
        { error: `Too many wrong attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`, retryAfterSec },
        { status: 429 },
      ),
    };
  }

  if (verifyPin(supplied, r.pin_salt ?? "", r.pin_hash ?? "")) {
    // Correct PIN — the only event that proves it is the owner, so the slate is wiped.
    const clear = await db.rpc("vault_pin_clear_attempts", { p_user_id: userId });
    if (clear.error) return { ok: false, reply: serverFail() };
    return { ok: true };
  }

  const locked = r.failed_attempts >= MAX_ATTEMPTS;
  const left = Math.max(0, MAX_ATTEMPTS - r.failed_attempts);
  return {
    ok: false,
    reply: NextResponse.json(
      { error: wrongMessage(left, locked), attemptsLeft: left, locked },
      { status: locked ? 429 : 401 },
    ),
  };
}

/** GP-07a (R-2115): the business owner's Private Vault, and a personal login's Money pages. */
const VAULT_ROLES: readonly string[] = ["owner", "personal"];

/** The vault is an owner (or personal-login) feature. Anyone else gets 403 and no hint about
 *  what is behind it. Either way every operation is on the caller's OWN row (auth.uid()). */
async function requireOwner(supabase: ReturnType<typeof createClient>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "You are not signed in." }, { status: 401 }) } as const;

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return { error: NextResponse.json({ error: "Workspace not found." }, { status: 403 }) } as const;
  }
  if (!VAULT_ROLES.includes(me.role)) {
    return { error: NextResponse.json({ error: "This is for the owner only." }, { status: 403 }) } as const;
  }
  return { userId: user.id, tenantId: me.tenant_id } as const;
}

export async function GET() {
  const supabase = createClient();
  const who = await requireOwner(supabase);
  if ("error" in who) return who.error;

  const { data, error } = await supabase
    .from("personal_vault_pin")
    .select("failed_attempts, locked_until")
    .eq("user_id", who.userId)
    .maybeSingle();

  // GP-02b: a failed read is NOT "no PIN" — answering configured:false here would open
  // the vault. The gate treats any non-200 as locked.
  if (error) return NextResponse.json({ error: "Could not check the vault lock." }, { status: 500 });

  if (!data) {
    return NextResponse.json({ configured: false, locked: false, retryAfterSec: 0, attemptsLeft: MAX_ATTEMPTS });
  }

  const state = lockState(data.failed_attempts, data.locked_until, new Date());
  return NextResponse.json({ configured: true, ...state });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const who = await requireOwner(supabase);
  if ("error" in who) return who.error;

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const db = pinDb(who.userId);

  // ─── set ──────────────────────────────────────────────────────────────────
  if (body.action === "set") {
    const pin = body.pin ?? "";
    const check = validateNewPin(pin);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    const { data: existing, error: readError } = await supabase
      .from("personal_vault_pin")
      .select("user_id")
      .eq("user_id", who.userId)
      .maybeSingle();
    if (readError) return serverFail();

    // Changing an existing PIN requires the old one. Without this, anybody who reaches
    // an unlocked session can silently replace the lock and keep the vault open. The
    // check takes an attempt from the same lock as unlocking does.
    if (existing) {
      const res = await attempt(db, who.userId, body.currentPin ?? "", () => "Current PIN is wrong.");
      if (!res.ok) return res.reply;
    }

    const salt = newSalt();
    const { data: saved, error } = await db.rpc("vault_pin_save", {
      p_user_id: who.userId,
      p_tenant_id: who.tenantId,
      p_hash: hashPin(pin, salt),
      p_salt: salt,
      p_replace: Boolean(existing),
    });
    if (error) return serverFail();
    if (saved === false) {
      // A PIN appeared between the read and the save (another tab set one first). It is
      // never replaced without the current PIN.
      return NextResponse.json(
        { error: "A PIN was just set from another tab. Reload the page, then change it with the current PIN." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  // ─── verify / remove: both take an attempt from the lock ───────────────────
  const supplied = body.action === "verify" ? (body.pin ?? "") : (body.currentPin ?? "");
  const res = await attempt(db, who.userId, supplied, (left, locked) =>
    locked ? "Wrong PIN. Too many attempts — try again in 15 minutes." : `Wrong PIN. ${left} attempt(s) left.`,
  );
  if (!res.ok) return res.reply;

  if (body.action === "remove") {
    const { error } = await db.rpc("vault_pin_remove", { p_user_id: who.userId });
    if (error) return serverFail();
    return NextResponse.json({ ok: true, configured: false });
  }

  return NextResponse.json({ ok: true });
}
