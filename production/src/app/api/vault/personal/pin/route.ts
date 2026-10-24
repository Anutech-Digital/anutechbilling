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
 * So: the hash and salt never leave this file, comparison is timing-safe, and the
 * lockout is written to a row nobody but the owner can reach.
 *
 * ─── WHAT THE CALLER IS TOLD, AND WHAT IT IS NOT ────────────────────────────
 * A wrong PIN returns 401 with how many attempts remain. It does NOT say whether a PIN
 * is even configured on a verify — that is what GET is for, and the owner is the only
 * one who can call either. There is no user id parameter anywhere in this route: every
 * operation is on `auth.uid()`'s own row, so there is nothing to enumerate.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  validateNewPin,
  newSalt,
  hashPin,
  verifyPin,
  lockState,
  nextFailureState,
  successState,
  MAX_ATTEMPTS,
} from "@/lib/vault/personal/pin";

const bodySchema = z.object({
  action: z.enum(["set", "verify", "remove"]),
  pin: z.string().optional(),
  currentPin: z.string().optional(),
});

/** The vault is an owner feature. Non-owners get 403 and no hint about what is behind it. */
async function requireOwner(supabase: ReturnType<typeof createClient>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "You are not signed in." }, { status: 401 }) } as const;

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return { error: NextResponse.json({ error: "Workspace not found." }, { status: 403 }) } as const;
  }
  if (me.role !== "owner") {
    return { error: NextResponse.json({ error: "This is for the owner only." }, { status: 403 }) } as const;
  }
  return { userId: user.id, tenantId: me.tenant_id } as const;
}

export async function GET() {
  const supabase = createClient();
  const who = await requireOwner(supabase);
  if ("error" in who) return who.error;

  const { data } = await supabase
    .from("personal_vault_pin")
    .select("failed_attempts, locked_until")
    .eq("user_id", who.userId)
    .maybeSingle();

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

  const { data: existing } = await supabase
    .from("personal_vault_pin")
    .select("pin_hash, pin_salt, failed_attempts, locked_until")
    .eq("user_id", who.userId)
    .maybeSingle();

  const now = new Date();

  // ─── set ──────────────────────────────────────────────────────────────────
  if (body.action === "set") {
    const pin = body.pin ?? "";
    const check = validateNewPin(pin);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    // Changing an existing PIN requires the old one. Without this, anybody who reaches
    // an unlocked session can silently replace the lock and keep the vault open.
    if (existing) {
      const state = lockState(existing.failed_attempts, existing.locked_until, now);
      if (state.locked) {
        return NextResponse.json(
          { error: `Too many wrong attempts. Try again in ${Math.ceil(state.retryAfterSec / 60)} minute(s).` },
          { status: 429 },
        );
      }
      if (!verifyPin(body.currentPin ?? "", existing.pin_salt, existing.pin_hash)) {
        const fail = nextFailureState(existing.failed_attempts, now);
        await supabase
          .from("personal_vault_pin")
          .update({ failed_attempts: fail.failedAttempts, locked_until: fail.lockedUntil, updated_at: now.toISOString() })
          .eq("user_id", who.userId);
        return NextResponse.json({ error: "Current PIN is wrong." }, { status: 401 });
      }
    }

    const salt = newSalt();
    const { error } = await supabase.from("personal_vault_pin").upsert(
      {
        user_id: who.userId,
        tenant_id: who.tenantId,
        pin_hash: hashPin(pin, salt),
        pin_salt: salt,
        failed_attempts: 0,
        locked_until: null,
        updated_at: now.toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // ─── verify / remove both need an existing PIN ────────────────────────────
  if (!existing) {
    return NextResponse.json({ error: "No PIN is set." }, { status: 400 });
  }

  const state = lockState(existing.failed_attempts, existing.locked_until, now);
  if (state.locked) {
    return NextResponse.json(
      { error: `Too many wrong attempts. Try again in ${Math.ceil(state.retryAfterSec / 60)} minute(s).`, retryAfterSec: state.retryAfterSec },
      { status: 429 },
    );
  }

  const supplied = body.action === "verify" ? (body.pin ?? "") : (body.currentPin ?? "");
  const ok = verifyPin(supplied, existing.pin_salt, existing.pin_hash);

  if (!ok) {
    const fail = nextFailureState(existing.failed_attempts, now);
    await supabase
      .from("personal_vault_pin")
      .update({ failed_attempts: fail.failedAttempts, locked_until: fail.lockedUntil, updated_at: now.toISOString() })
      .eq("user_id", who.userId);

    const left = Math.max(0, MAX_ATTEMPTS - fail.failedAttempts);
    return NextResponse.json(
      {
        error: fail.locked
          ? "Wrong PIN. Too many attempts — try again in 15 minutes."
          : `Wrong PIN. ${left} attempt(s) left.`,
        attemptsLeft: left,
        locked: fail.locked,
      },
      { status: fail.locked ? 429 : 401 },
    );
  }

  // Correct PIN — the only event that proves it is the owner, so the slate is wiped.
  const clean = successState();

  if (body.action === "remove") {
    const { error } = await supabase.from("personal_vault_pin").delete().eq("user_id", who.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, configured: false });
  }

  await supabase
    .from("personal_vault_pin")
    .update({ failed_attempts: clean.failedAttempts, locked_until: clean.lockedUntil, updated_at: now.toISOString() })
    .eq("user_id", who.userId);

  return NextResponse.json({ ok: true });
}
