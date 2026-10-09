/**
 * R-606 — attendance device binding with passkeys (WebAuthn). Pure rules only: no network,
 * no database, no @simplewebauthn import — safe for the browser and for unit tests.
 *
 * THE THREAT (Pardeep, 9 Oct 2026): "doosre ke email id ko apne computer par login karke uski
 * attendance laga denge". A colleague who knows someone's password checks them in from his own
 * laptop. A password proves knowledge, not the machine.
 *
 * WHY PASSKEYS: registering a device creates a key pair inside the device's own secure hardware
 * (fingerprint, face or Windows Hello PIN unlocks it). The private key never leaves that device;
 * the server keeps only the public key. Every check-in is signed by that key, so a check-in from
 * another laptop fails even with the right password. A "synced" passkey (Google Password Manager,
 * iCloud Keychain) follows the employee's OWN Google/Apple account to their other devices — never
 * to another person's laptop — and the owner sees it marked as synced before approving.
 */

/** Pardeep, 9 Oct 2026: at most two devices per employee (pending + approved). */
export const MAX_DEVICES_PER_EMPLOYEE = 2;
/** A registration / sign-in challenge is good for five minutes. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type DeviceStatus = "pending" | "approved" | "revoked";

/** Machine-readable reasons the API returns next to the human message, so the UI can offer the fix. */
export type DeviceErrorCode =
  | "DEVICE_LIMIT"
  | "APPROVED_LIMIT"
  | "DEVICE_REQUIRED"
  | "DEVICE_NOT_REGISTERED"
  | "DEVICE_CHECK_FAILED"
  | "CHALLENGE_EXPIRED"
  | "OWNER_ONLY"
  | "NOT_LINKED"
  | "BAD_TRANSITION";

export const DEVICE_MESSAGES: Record<DeviceErrorCode, string> = {
  DEVICE_LIMIT: "You already have 2 devices. Ask the owner to remove one.",
  APPROVED_LIMIT:
    "This employee already has 2 approved devices. Remove one of them first, then approve this one.",
  DEVICE_REQUIRED:
    "Check-in needs a registered device in this workspace. Register this device on My Attendance and ask the owner to approve it.",
  DEVICE_NOT_REGISTERED:
    "This device is not registered for you. Register it on My Attendance and ask the owner to approve.",
  DEVICE_CHECK_FAILED:
    "The device check did not pass. Press the button again and confirm with your fingerprint, face or Windows Hello PIN.",
  CHALLENGE_EXPIRED: "The device check took too long. Press the button again.",
  OWNER_ONLY:
    "Only the owner can approve or remove attendance devices. Ask the owner to open Payroll → Attendance → Devices.",
  NOT_LINKED:
    "Your login is not linked to an employee yet. Pick your name on My Attendance first, then register this device.",
  BAD_TRANSITION: "This device has already been removed. Ask the employee to register it again.",
};

export function deviceError(code: DeviceErrorCode): { error: string; code: DeviceErrorCode } {
  return { error: DEVICE_MESSAGES[code], code };
}

type HasStatus = { status: string };

/** Devices that still count toward the limit: pending + approved. */
export function liveDevices<T extends HasStatus>(devices: readonly T[]): T[] {
  return devices.filter((d) => d.status === "pending" || d.status === "approved");
}

/** May this employee register one more device? */
export function canRegisterAnother(devices: readonly HasStatus[]): boolean {
  return liveDevices(devices).length < MAX_DEVICES_PER_EMPLOYEE;
}

/** Status moves the owner may make. Revoked is final — re-register instead. */
export function canTransition(from: DeviceStatus, to: DeviceStatus): boolean {
  if (from === to) return false;
  if (from === "pending") return to === "approved" || to === "revoked";
  if (from === "approved") return to === "revoked";
  return false;
}

/**
 * Decide an owner's approve/revoke on one device, given every device of that employee.
 * Returns the new status or the reason it is refused.
 */
export function decideOwnerAction(
  device: { id: string; status: DeviceStatus },
  employeeDevices: readonly { id: string; status: string }[],
  action: "approve" | "revoke",
): { ok: true; status: DeviceStatus } | { ok: false; code: DeviceErrorCode } {
  const to: DeviceStatus = action === "approve" ? "approved" : "revoked";
  if (!canTransition(device.status, to)) return { ok: false, code: "BAD_TRANSITION" };
  if (to === "approved") {
    const otherApproved = employeeDevices.filter((d) => d.id !== device.id && d.status === "approved").length;
    if (otherApproved >= MAX_DEVICES_PER_EMPLOYEE) return { ok: false, code: "APPROVED_LIMIT" };
  }
  return { ok: true, status: to };
}

/** The owner registering their own device is approved straight away; everyone else waits. */
export function initialStatus(callerRole: string | null | undefined): DeviceStatus {
  return callerRole === "owner" ? "approved" : "pending";
}

/** WebAuthn user handle: the employee id's 16 bytes (stable across that employee's devices). */
export function employeeIdBytes(employeeId: string): Uint8Array<ArrayBuffer> {
  const hex = employeeId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("employee id is not a uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Relying-party id + origin for this request. The rpID is the bare hostname (no port), the
 * origin is scheme://host[:port] as the browser saw it — behind Cloud Run that is the
 * forwarded host/proto, not the container's own address.
 */
export function relyingParty(input: {
  url: string;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  host?: string | null;
}): { rpID: string; origin: string } {
  const u = new URL(input.url);
  const host = (input.forwardedHost?.split(",")[0].trim() || input.host?.trim() || u.host).toLowerCase();
  const proto = (input.forwardedProto?.split(",")[0].trim() || u.protocol.replace(":", "")).toLowerCase();
  const rpID = host.replace(/:\d+$/, "");
  return { rpID, origin: `${proto}://${host}` };
}

/** A friendly default name for "this device", from the browser's own hints. */
export function defaultDeviceLabel(hints: { platform?: string | null; mobile?: boolean | null; userAgent?: string | null }): string {
  const p = (hints.platform || "").toLowerCase();
  const ua = (hints.userAgent || "").toLowerCase();
  const mobile = hints.mobile ?? /mobi|android|iphone/.test(ua);
  if (p.includes("android") || ua.includes("android")) return "Android phone";
  if (p.includes("ios") || /iphone/.test(ua)) return "iPhone";
  if (/ipad/.test(ua)) return "iPad";
  if (p.includes("mac") || ua.includes("mac os")) return mobile ? "iPhone" : "Mac";
  if (p.includes("win") || ua.includes("windows")) return "Windows laptop";
  if (p.includes("linux") || ua.includes("linux")) return "Linux computer";
  if (p.includes("chrome") || ua.includes("cros")) return "Chromebook";
  return mobile ? "Phone" : "Computer";
}

/** Clean a user-typed label: trimmed, single-spaced, 1–40 characters. */
export function cleanLabel(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return (s || fallback).slice(0, 40);
}

/** What the employee's "This device" card should say, given their devices' statuses. */
export function myDeviceSummary(devices: readonly HasStatus[]): "none" | "pending" | "approved" {
  const live = liveDevices(devices);
  if (live.some((d) => d.status === "approved")) return "approved";
  if (live.length) return "pending";
  return "none";
}
