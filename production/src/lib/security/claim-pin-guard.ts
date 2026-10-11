/**
 * R-725 (11 Oct 2026): the ONE expense-claim PIN check, used by all three public routes
 * (verify / submit / manage) BEFORE they do anything else — before a receipt is uploaded,
 * before any claim RPC runs.
 *
 * Two layers:
 *   1. rateLimitShared per tenant+employee — every PIN attempt counts (right or wrong), shared
 *      across instances when RATE_LIMIT_STORE=postgres. Bounds hammering cheaply.
 *   2. public.claim_pin_check (migration 20261011154500) — the durable wrong-PIN counter in the
 *      DB: every 5th wrong PIN in a row locks the employee (15 min, doubling, max 24 h). This is
 *      what survives restarts and multiple instances regardless of the limiter's store.
 *
 * Before R-725 only /verify had a limit (in one instance's memory); submit and manage checked
 * the PIN with none, so a 4–6 digit PIN fell to a loop through them.
 *
 * Fails CLOSED: if the DB check errors, the PIN is not accepted.
 */
import { rateLimitShared } from "@/lib/security/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** All PIN attempts for one employee, per hour (verify + several submits/edits fit easily). */
export const CLAIM_PIN_RATE = { limit: 20, windowMs: 60 * 60_000 } as const;

export const CLAIM_PIN_MESSAGES = {
  pick: "Pick your name and enter your PIN",
  wrong: "Wrong PIN",
  locked: "Too many wrong PINs. Please try again later, or ask the office to reset your PIN.",
  slow: "Too many tries. Please wait a while and try again.",
  inactive: "This employee is inactive",
  noPin: "No PIN set for you — ask the office to set one",
  down: "We could not check your PIN just now. Please try again in a minute.",
} as const;

export type ClaimPinResult =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function checkClaimPin(
  admin: object,
  tid: string,
  employeeId: string,
  pin: string,
): Promise<ClaimPinResult> {
  if (!isUuid(tid) || !isUuid(employeeId) || !pin) {
    return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.pick };
  }
  if (pin.length > 12) return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.wrong };

  const gate = await rateLimitShared(`claim-pin:${tid.toLowerCase()}:${employeeId.toLowerCase()}`, CLAIM_PIN_RATE);
  if (!gate.ok) {
    return { ok: false, status: 429, error: CLAIM_PIN_MESSAGES.slow, retryAfterSec: gate.retryAfterSec };
  }

  // claim_pin_check is newer than database.generated.ts — hence the narrow cast.
  const { data, error } = await (admin as RpcClient).rpc("claim_pin_check", {
    p_tenant_id: tid,
    p_employee_id: employeeId,
    p_pin: pin,
  });
  if (error) {
    console.error("[expense-claim] claim_pin_check failed", (error as { message?: string })?.message ?? error);
    return { ok: false, status: 503, error: CLAIM_PIN_MESSAGES.down };
  }
  switch (data) {
    case "ok":         return { ok: true };
    case "wrong_pin":  return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.wrong };
    case "pin_locked": return { ok: false, status: 429, error: CLAIM_PIN_MESSAGES.locked };
    case "inactive":   return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.inactive };
    case "no_pin":     return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.noPin };
    case "not_found":  return { ok: false, status: 400, error: CLAIM_PIN_MESSAGES.pick };
    default:           return { ok: false, status: 503, error: CLAIM_PIN_MESSAGES.down };
  }
}

/** JSON body + headers for a failed check (routes wrap it in NextResponse.json). */
export function claimPinFailure(r: Extract<ClaimPinResult, { ok: false }>) {
  return {
    body: { error: r.error },
    init: {
      status: r.status,
      ...(r.retryAfterSec ? { headers: { "Retry-After": String(r.retryAfterSec) } } : {}),
    },
  };
}
