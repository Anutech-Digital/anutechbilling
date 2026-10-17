/**
 * R-1496: name the real reason when the database refuses a signed-in user because their
 * second sign-in step is pending.
 *
 * R-731 makes current_tenant_id() NULL for an MFA-enrolled user whose session is not aal2, so
 * every write fails with 42501 — which the browser showed as "belongs to another workspace, or
 * your role doesn't allow it". Only on that error path (no cost for a working request) we ask
 * the database the same question R-731 asks — public.session_mfa_ok() for this identity — and,
 * if the second step is what is missing, answer with MFA_PENDING_DATA_REFUSAL instead.
 * Status and code stay 403 / 42501: nothing is allowed that was refused before.
 */
import "server-only";
import { MFA_PENDING_DATA_REFUSAL } from "@/lib/auth/mfa-gate";
import { withIdentity, type Identity } from "@/server/db/gateway";
import { PgrstError } from "./parse";

/** true / false from session_mfa_ok(); null when it cannot be told (function missing, DB error). */
export type MfaCheck = (identity: Identity) => Promise<boolean | null>;

export const sessionMfaOk: MfaCheck = async (identity) => {
  try {
    const rows = await withIdentity(identity, (tx) =>
      tx.$queryRawUnsafe<{ ok: boolean | null }[]>("select public.session_mfa_ok() as ok"));
    const ok = rows[0]?.ok;
    return typeof ok === "boolean" ? ok : null;
  } catch {
    return null;
  }
};

export async function explainMfaPending(err: PgrstError, identity: Identity, check: MfaCheck = sessionMfaOk): Promise<PgrstError> {
  if (err.code !== "42501" || identity.mode !== "user" || identity.aal === "aal2") return err;
  if ((await check(identity)) !== false) return err;
  return new PgrstError(err.status, err.code, MFA_PENDING_DATA_REFUSAL, null,
    "Sign out, sign in again and type the 6-digit code from your authenticator app.");
}
