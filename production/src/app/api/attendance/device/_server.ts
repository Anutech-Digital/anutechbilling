/**
 * R-606 — server half of attendance passkeys, shared by the /device routes and /self.
 *
 * Why this exists: a password proves someone KNOWS the login, not which machine they are on,
 * so a colleague could check a friend in from his own laptop. A passkey's private key is made
 * inside the employee's own device (fingerprint / face / Windows Hello) and never leaves it;
 * we keep only the public key. Synced passkeys follow the employee's own Google/Apple account,
 * never another person's laptop. See src/lib/attendance/webauthn.ts for the pure rules.
 *
 * Every write here uses the service-role client (authenticated has SELECT only on
 * attendance_devices and nothing on the challenges table) and is scoped in code to the
 * caller's tenant + linked employee.
 */
import type { NextRequest } from "next/server";
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { CHALLENGE_TTL_MS, deviceError, relyingParty, type DeviceErrorCode } from "@/lib/attendance/webauthn";

export type AdminClient = ReturnType<typeof createAdminClientFor>;

export type Caller = {
  userId: string;
  email: string | null;
  tenantId: string;
  employeeId: string | null;
  role: string;
  admin: AdminClient;
};

/** The signed-in caller's tenant, role and linked employee — or null when signed out. */
export async function getCaller(): Promise<Caller | null> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, employee_id, role, is_active")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id || me.is_active === false) return null;
  return {
    userId: authData.user.id,
    email: authData.user.email ?? null,
    tenantId: me.tenant_id,
    employeeId: me.employee_id ?? null,
    role: String(me.role ?? ""),
    admin: createAdminClientFor(authData.user.id),
  };
}

export function rpFor(request: NextRequest): { rpID: string; origin: string } {
  return relyingParty({
    url: request.url,
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    host: request.headers.get("host"),
  });
}

/** Store (replace) the caller's one live challenge. */
export async function saveChallenge(c: Caller, challenge: string, purpose: "register" | "auth"): Promise<string | null> {
  const { error } = await c.admin.from("attendance_webauthn_challenges").upsert(
    {
      user_id: c.userId,
      tenant_id: c.tenantId,
      challenge,
      purpose,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    },
    { onConflict: "user_id" },
  );
  return error ? error.message : null;
}

/** Take the caller's challenge for this purpose (one use only). null = none / expired. */
export async function takeChallenge(c: Caller, purpose: "register" | "auth"): Promise<string | null> {
  const { data } = await c.admin
    .from("attendance_webauthn_challenges")
    .select("challenge, purpose, expires_at")
    .eq("user_id", c.userId)
    .eq("tenant_id", c.tenantId)
    .maybeSingle();
  await c.admin.from("attendance_webauthn_challenges").delete().eq("user_id", c.userId);
  if (!data || data.purpose !== purpose) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.challenge;
}

export type DeviceRow = {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[];
  status: string;
};

/** The caller's devices (their linked employee only, this tenant only). */
export async function employeeDevices(c: Caller, employeeId: string): Promise<DeviceRow[]> {
  const { data } = await c.admin
    .from("attendance_devices")
    .select("id, credential_id, public_key, counter, transports, status")
    .eq("tenant_id", c.tenantId)
    .eq("employee_id", employeeId);
  return (data ?? []).map((d) => ({ ...d, counter: Number(d.counter ?? 0), transports: d.transports ?? [] }));
}

function isAssertion(v: unknown): v is AuthenticationResponseJSON {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.rawId === "string" && typeof o.response === "object" && o.response !== null;
}

/**
 * Verify a check-in's passkey signature against an APPROVED device of THIS caller's employee.
 * On success bumps the counter + last_used_at and returns the device id.
 */
export async function verifyDeviceAssertion(
  c: Caller,
  request: NextRequest,
  assertion: unknown,
): Promise<{ ok: true; deviceId: string } | { ok: false; code: DeviceErrorCode; error: string }> {
  const fail = (code: DeviceErrorCode) => ({ ok: false as const, ...deviceError(code) });
  if (!c.employeeId) return fail("NOT_LINKED");
  if (!isAssertion(assertion)) return fail("DEVICE_REQUIRED");

  const { data: dev } = await c.admin
    .from("attendance_devices")
    .select("id, credential_id, public_key, counter, transports, status")
    .eq("tenant_id", c.tenantId)
    .eq("employee_id", c.employeeId)
    .eq("credential_id", assertion.id)
    .eq("status", "approved")
    .maybeSingle();
  if (!dev) {
    await takeChallenge(c, "auth"); // burn it either way
    return fail("DEVICE_NOT_REGISTERED");
  }

  const challenge = await takeChallenge(c, "auth");
  if (!challenge) return fail("CHALLENGE_EXPIRED");

  const { rpID, origin } = rpFor(request);
  try {
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: dev.credential_id,
        publicKey: new Uint8Array(Buffer.from(dev.public_key, "base64url")),
        counter: Number(dev.counter ?? 0),
        transports: (dev.transports ?? []) as AuthenticatorTransportFuture[],
      },
    });
    if (!result.verified) return fail("DEVICE_CHECK_FAILED");
    await c.admin
      .from("attendance_devices")
      .update({ counter: result.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
      .eq("id", dev.id)
      .eq("tenant_id", c.tenantId);
    return { ok: true, deviceId: dev.id };
  } catch {
    // Wrong origin, replayed counter, bad signature — all "this device check did not pass".
    return fail("DEVICE_CHECK_FAILED");
  }
}

/**
 * How many people would be blocked if "Require registered device" were on: active logins linked
 * to an active employee who has no APPROVED device yet. Owner screens only.
 */
export async function countEmployeesWithoutDevice(admin: AdminClient, tenantId: string): Promise<number> {
  const [{ data: users }, { data: employees }, { data: devices }] = await Promise.all([
    admin.from("users").select("employee_id").eq("tenant_id", tenantId).eq("is_active", true).not("employee_id", "is", null),
    admin.from("employees").select("id").eq("tenant_id", tenantId).eq("is_active", true),
    admin.from("attendance_devices").select("employee_id").eq("tenant_id", tenantId).eq("status", "approved"),
  ]);
  const active = new Set((employees ?? []).map((e) => e.id));
  const withDevice = new Set((devices ?? []).map((d) => d.employee_id));
  const linked = new Set((users ?? []).map((u) => u.employee_id).filter((id): id is string => !!id && active.has(id)));
  return [...linked].filter((id) => !withDevice.has(id)).length;
}
