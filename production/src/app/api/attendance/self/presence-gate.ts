/**
 * R-440 — the office-code gate for self check-in.
 *
 * The code is checked INSIDE the database by `validate_presence_code(p_code)` (SECURITY
 * DEFINER, caller's own company, 5 wrong codes → 15-minute lock). The app never reads
 * attendance_settings.presence_secret for this any more. This helper only turns the RPC's
 * answer into the HTTP reply, so the mapping is testable without a database.
 */

export type PresenceRpcResult = {
  data: boolean | null;
  error: { message?: string; code?: string; hint?: string | null } | null;
};

export type PresenceGateReply = { status: number; body: { error: string; code: string } };

export const WRONG_CODE_MESSAGE =
  "Office code galat ya expire ho gaya — office tablet pe abhi jo code hai wahi daalo.";

/** null = the code is right, carry on with the check-in. */
export function presenceGateReply(result: PresenceRpcResult): PresenceGateReply | null {
  if (!result.error) {
    return result.data === true
      ? null
      : { status: 400, body: { error: WRONG_CODE_MESSAGE, code: "PRESENCE_CODE_WRONG" } };
  }
  if (result.error.message === "PRESENCE_CODE_LOCKED") {
    return {
      status: 429,
      body: {
        error: result.error.hint || "Bahut baar galat office code daala — 15 minute baad dobara try karo.",
        code: "PRESENCE_CODE_LOCKED",
      },
    };
  }
  // No company on this login (28000) or any database error: fail closed.
  return {
    status: result.error.code === "28000" ? 403 : 400,
    body: { error: WRONG_CODE_MESSAGE, code: "PRESENCE_CODE_UNCHECKED" },
  };
}
