/**
 * R-2013: the 6-digit code that proves the person asking owns the email.
 *
 * Reuses the app's OTP pieces (R-1903, lib/sms/otp.ts): the same code generator and the same
 * HMAC key, so the database only ever stores a hash. The hash is bound to the request id, so a
 * code for one request never opens another.
 *
 * The mail goes through sendInternalEmail on purpose: it is a sign-in-style code the person
 * asked for one second ago (like email verification), not a message to a customer — it must not
 * wait on the company's "Customer messages" switch, or a person could never use their rights.
 */
import "server-only";
import { generateOtp, hashOtp, otpHashSecret } from "@/lib/sms/otp";
import { sendInternalEmail } from "@/lib/messaging";
import { kindLabel, PRIVACY_CODE_TTL_MIN } from "./requests";

export { generateOtp as newPrivacyCode, otpHashSecret as privacyCodeSecret };

/** The hash stored on the request (and sent to privacy_request_verify). */
export function privacyCodeHash(secret: string, requestId: string, code: string): string {
  return hashOtp(secret, requestId, "privacy-request", code);
}

export function privacyCodeEmail(input: { name: string; code: string; kind: string; company: string }): { subject: string; text: string } {
  const first = input.name.trim().split(/\s+/)[0] || "there";
  return {
    subject: `${input.code} is your code for your privacy request`,
    text:
      `Hi ${first},\n\n` +
      `Your code is ${input.code}\n\n` +
      `Enter it on the page where you asked ${input.company} to: ${kindLabel(input.kind)}. ` +
      `It works for ${PRIVACY_CODE_TTL_MIN} minutes.\n\n` +
      `If you did not ask for this, ignore this email — nothing happens without the code.\n`,
  };
}

export async function sendPrivacyCode(input: { to: string; name: string; code: string; kind: string; company: string; tenantId: string; from: string }): Promise<boolean> {
  const mail = privacyCodeEmail(input);
  const res = await sendInternalEmail({
    to: input.to, from: input.from, ...mail,
    kind: "privacy_request_code",
    route: { tenantId: input.tenantId },
  });
  return res.status === "sent" || res.status === "stubbed";
}
