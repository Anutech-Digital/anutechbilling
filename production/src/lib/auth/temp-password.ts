/**
 * R-391 — an owner sets a TEMPORARY password for a teammate (/team → "Set temporary password").
 *
 * Client-safe on purpose (same split as password-rules.ts): no `node:crypto`, no server-only
 * import. The generator uses Web Crypto (`globalThis.crypto.getRandomValues`), which Node 18+
 * and every browser have, so the Team page can import the length constant without dragging a
 * Node module into the client bundle.
 *
 * ─── WHAT THIS GRANTS, SAID PLAINLY ─────────────────────────────────────────
 * send-reset-link-button.tsx explains why the app used to refuse this: an owner who knows a
 * teammate's password can sign in as them. The agreed design (card R-391, 7 Oct 2026) accepts
 * that for ONE purpose — getting somebody signed in today without an email round trip — and
 * narrows it:
 *   - only an owner, re-read from the database, never from the client;
 *   - only a teammate in the SAME workspace, never another owner, never yourself;
 *   - the password is shown ONCE in the response and never stored, logged or put in a URL;
 *   - the teammate must choose their own password on the next sign-in (app_metadata flag,
 *     see must-change-password.ts), after which the owner no longer knows it;
 *   - every use is written to activity_log (who, whom, when — no password);
 *   - rate-limited per owner.
 */
import { checkNewPassword, type PasswordProblem } from "./password-rules";

/** An owner-typed temporary password must be at least this long. */
export const TEMP_PASSWORD_MIN_LENGTH = 12;
/** Length of a generated one. 16 chars over a 55-symbol alphabet ≈ 92 bits. */
export const TEMP_PASSWORD_GENERATED_LENGTH = 16;

/* No 0/O, 1/l/I — the owner may read this out over the phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

type RandomFill = (buf: Uint8Array) => Uint8Array;
const webCrypto: RandomFill = (buf) => globalThis.crypto.getRandomValues(buf);

/**
 * A strong random temporary password: upper + lower + digit, unambiguous characters,
 * uniform (rejection sampling — `byte % 55` would favour the first symbols).
 */
export function generateTempPassword(
  length: number = TEMP_PASSWORD_GENERATED_LENGTH,
  fill: RandomFill = webCrypto,
): string {
  if (length < TEMP_PASSWORD_MIN_LENGTH) throw new Error("temporary password too short");
  const limit = 256 - (256 % ALPHABET.length);
  for (;;) {
    let out = "";
    while (out.length < length) {
      const bytes = fill(new Uint8Array(length * 2));
      for (const b of bytes) {
        if (b >= limit) continue;
        out += ALPHABET[b % ALPHABET.length];
        if (out.length === length) break;
      }
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out) && checkNewPassword(out) === null) {
      return out;
    }
  }
}

/** An owner-typed temporary password: the normal rules, plus the longer floor. */
export function checkTypedTempPassword(password: string): PasswordProblem | null {
  if (password.length < TEMP_PASSWORD_MIN_LENGTH) {
    return { message: `A temporary password needs at least ${TEMP_PASSWORD_MIN_LENGTH} characters. Leave it empty and one will be made for you.` };
  }
  return checkNewPassword(password);
}

export interface TeamRow {
  id: string;
  role: string | null;
  tenant_id: string | null;
}

export type TempPasswordDecision =
  | { ok: true }
  | { ok: false; status: 403; error: string };

/**
 * Who may set whose temporary password. Pure, so every refusal is pinned by a test.
 * `caller` and `target` are rows read by the SERVER from public.users — never client input.
 * A target in another workspace is looked up with the caller's tenant_id, so it arrives here
 * as null and gets the same answer as a non-existent id (no hint that it exists elsewhere).
 */
export function decideTempPassword(caller: TeamRow | null, target: TeamRow | null): TempPasswordDecision {
  if (!caller?.tenant_id) {
    return { ok: false, status: 403, error: "You are not in a workspace." };
  }
  if (caller.role !== "owner") {
    return { ok: false, status: 403, error: "Only the workspace owner can set a temporary password. Ask an owner, or use Send reset link." };
  }
  if (!target || target.tenant_id !== caller.tenant_id) {
    return { ok: false, status: 403, error: "That person is not in your workspace." };
  }
  if (target.id === caller.id) {
    return { ok: false, status: 403, error: "Change your own password in Settings → Security, not here." };
  }
  if (target.role === "owner") {
    return { ok: false, status: 403, error: "An owner's password can only be changed by that owner. Use Send reset link instead." };
  }
  return { ok: true };
}

/** UI mirror of the target rules — whether the Team page shows the button at all. */
export function canSetTempPassword(member: { id: string; role: string | null }, myId: string | null | undefined): boolean {
  return Boolean(myId) && member.id !== myId && member.role !== "owner";
}

/** Per owner: enough for a morning of onboarding, not enough to cycle through a team. */
export const TEMP_PASSWORD_RATE = { limit: 10, windowMs: 60 * 60_000 } as const;
