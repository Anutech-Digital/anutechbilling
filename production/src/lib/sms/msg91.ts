/**
 * R-1903 slice 3 placeholder — MSG91 SMS adapter. NOT WIRED: ./gateway.ts never returns it.
 *
 * Waits for (Pardeep, 25 Oct 2026): TRAI DLT registration (entity ID, 6-letter sender ID, the
 * approved OTP template) and the MSG91 auth key. Pardeep puts the values into the server env
 * himself; only the NAMES live in code. Slice 3: call MSG91's OTP/flow API here, map its errors
 * to SmsSendResult, wire it in smsGateway() for deployments when msg91Configured() is true,
 * and test it with a mocked fetch — never a real send from a test.
 */
import "server-only";
import type { SmsGateway } from "./gateway";

type Env = Record<string, string | undefined>;

export const MSG91_ENV = {
  authKey:    "MSG91_AUTH_KEY",
  templateId: "MSG91_OTP_TEMPLATE_ID",
  senderId:   "MSG91_SENDER_ID",
} as const;

/** All three names have a value (values are never read out or logged). */
export function msg91Configured(env: Env = process.env): boolean {
  return Object.values(MSG91_ENV).every((k) => (env[k] ?? "").trim() !== "");
}

/** Stub: refuses every send until slice 3 builds the real call. */
export function createMsg91Gateway(): SmsGateway {
  return {
    name: "msg91",
    ready: false,
    async send() {
      return {
        ok: false,
        reason: "not_configured",
        message: "The MSG91 connection is not built yet (R-1903 slice 3), so no SMS was sent.",
      };
    },
  };
}
