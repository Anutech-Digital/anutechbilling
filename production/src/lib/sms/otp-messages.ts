/**
 * R-1903: what the person reads when a mobile OTP step stops (§24 — what happened, why, what
 * next). Keyed by the `reason` request_phone_otp / verify_phone_otp return. Client-safe.
 */

export type OtpReason =
  | "invalid_phone" | "cooldown" | "rate_limited" | "locked"
  | "wrong_code" | "expired" | "no_code" | "taken";

export interface OtpRefusal {
  reason: string;
  retry_after_seconds?: number;
  tries_left?: number;
}

const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

export function otpMessage(r: OtpRefusal): string {
  const wait = r.retry_after_seconds ?? 0;
  switch (r.reason) {
    case "invalid_phone":
      return "Enter a 10-digit Indian mobile number (it starts with 6, 7, 8 or 9).";
    case "cooldown":
      return `A code was sent just now. Wait ${Math.max(1, wait)} seconds, then press Resend code.`;
    case "rate_limited":
      return `Too many codes in the last hour. Try again in ${minutes(wait)} min.`;
    case "locked":
      return `Too many wrong codes, so this number is locked. Wait ${minutes(wait || 900)} min, then ask for a new code.`;
    case "wrong_code": {
      const n = r.tries_left ?? 0;
      return `That code is not right — ${n} ${n === 1 ? "try" : "tries"} left. Check the latest SMS and type it again.`;
    }
    case "expired":
      return "That code has expired (codes last 5 minutes). Press Resend code to get a new one.";
    case "no_code":
      return "There is no active code for this number. Press Verify to get a new code.";
    case "taken":
      return "This number is already verified on another login. Use a different number, or ask your owner to remove it from that login on the Team page.";
    default:
      return "The code could not be checked. Try again; if it keeps happening, ask your owner.";
  }
}

/** HTTP status for a refusal: limits are 429, the rest are the person's input (400/409). */
export function otpStatus(reason: string): number {
  if (reason === "cooldown" || reason === "rate_limited" || reason === "locked") return 429;
  if (reason === "taken") return 409;
  return 400;
}
