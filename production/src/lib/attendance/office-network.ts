/**
 * Is this attendance action allowed from this network? — one rule for every door (R-605).
 *
 * Pardeep, 9–10 Oct 2026:
 *   • "sab apne mobile ya laptop" — people mark on their own device (My Attendance);
 *   • "kuch log bahar se laga sakte hai" — some employees may mark from outside the office;
 *   • "kiosk sirf office wifi par" — the shared kiosk works on the office Wi-Fi only.
 *
 * "Office Wi-Fi" = the public IPs the owner locked in Attendance → "Lock to this network"
 * (attendance_settings.allowed_ips). The IP comes from lib/security/rate-limit `clientIp`
 * (right-most hop our own infra added), never a header the browser can set.
 *
 * Why a registered device (R-606) is not enough on its own: a passkey proves WHO is
 * marking, not WHERE. The employee's own phone works just as well from home.
 */

export type NetworkPurpose = "self" | "register_device" | "kiosk";

export interface NetworkInput {
  purpose: NetworkPurpose;
  /** attendance_settings.allowed_ips — empty means the owner has not locked an office network. */
  allowedIps: readonly string[];
  /** Trusted client IP; "" when it could not be read. */
  ip: string;
  /** employees.attendance_anywhere — owner allowed this person to mark from outside. */
  anywhere?: boolean;
  /** The caller is the workspace owner. */
  isOwner?: boolean;
}

export type NetworkDecision =
  | { ok: true; flag: "outside_office" | null }
  | { ok: false; code: "KIOSK_NOT_LOCKED" | "OFF_NETWORK" | "REGISTER_OFF_NETWORK"; status: 403; error: string };

export function officeNetworkDecision(input: NetworkInput): NetworkDecision {
  const locked = input.allowedIps.length > 0;
  const onOffice = locked && input.ip !== "" && input.allowedIps.includes(input.ip);

  if (input.purpose === "kiosk") {
    if (!locked) {
      return {
        ok: false, code: "KIOSK_NOT_LOCKED", status: 403,
        error: "The kiosk works only on the office Wi-Fi, and no office network is set yet. Owner: open Attendance on the office Wi-Fi and press \"Lock to this network\".",
      };
    }
    if (!onOffice) {
      return {
        ok: false, code: "OFF_NETWORK", status: 403,
        error: "You're not on the office Wi-Fi — the kiosk only works inside the office.",
      };
    }
    return { ok: true, flag: null };
  }

  // Self check-in and device registration: nothing to check until the owner locks a network.
  if (!locked || onOffice) return { ok: true, flag: null };

  if (input.purpose === "register_device") {
    if (input.isOwner || input.anywhere) return { ok: true, flag: null };
    return {
      ok: false, code: "REGISTER_OFF_NETWORK", status: 403,
      error: "Register this device on the office Wi-Fi. If you work outside the office, ask the owner to turn on \"Can mark from outside office\" for you.",
    };
  }

  // purpose === "self"
  if (input.anywhere) return { ok: true, flag: "outside_office" };
  return {
    ok: false, code: "OFF_NETWORK", status: 403,
    error: "You're not on the office Wi-Fi, so attendance can't be marked from here. Connect to the office Wi-Fi, or ask the owner to turn on \"Can mark from outside office\" for you.",
  };
}
