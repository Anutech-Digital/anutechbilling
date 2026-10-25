/**
 * R-1903: the ONE way the app sends an SMS — `smsGateway().send(phone, text)`.
 *
 * Which gateway answers:
 *   - a developer's laptop / tests (not a deployment): the DEV gateway. Nothing leaves the
 *     machine — the message is printed on the server console, and the OTP routes may hand the
 *     code back to the screen so the person testing can type it.
 *   - staging / live (any deployment, see isProductionDeployment): NO gateway yet. send()
 *     answers "SMS is not set up yet" and never pretends a message went out.
 *
 * MSG91 (Pardeep's choice, 25 Oct 2026) needs TRAI DLT first. Its adapter is a stub in
 * ./msg91.ts and is deliberately NOT wired here — slice 3 of R-1903 wires it after DLT.
 */
import "server-only";
import { isProductionDeployment } from "@/lib/checkout/live-guards";
import { maskPhone } from "./phone";

type Env = Record<string, string | undefined>;

export type SmsSendResult =
  | { ok: true; provider: "dev" | "msg91" }
  | { ok: false; reason: "not_configured" | "failed"; message: string };

export interface SmsGateway {
  readonly name: "dev" | "none" | "msg91";
  /** False → send() would refuse; callers check this BEFORE creating a code. */
  readonly ready: boolean;
  send(phone: string, text: string): Promise<SmsSendResult>;
}

/** §24: what happened, why, what to do next. */
export const SMS_NOT_SET_UP =
  "SMS is not set up yet, so no code was sent. Mobile verification starts working once the SMS provider (MSG91) is connected — ask your owner.";

/** The dev gateway (and any on-screen code) only off a deployment: never NODE_ENV=production, never staging/live. */
export function devSmsAllowed(env: Env = process.env): boolean {
  return !isProductionDeployment(env);
}

export const devGateway: SmsGateway = {
  name: "dev",
  ready: true,
  async send(phone, text) {
    // Local only (devSmsAllowed): the console is where the developer reads the code.
    console.info(`[sms:dev] not sent — to ${maskPhone(phone)}: ${text}`);
    return { ok: true, provider: "dev" };
  },
};

export const notSetUpGateway: SmsGateway = {
  name: "none",
  ready: false,
  async send() {
    return { ok: false, reason: "not_configured", message: SMS_NOT_SET_UP };
  },
};

export function smsGateway(env: Env = process.env): SmsGateway {
  if (devSmsAllowed(env)) return devGateway;
  return notSetUpGateway;
}
