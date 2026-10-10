/**
 * POST /api/attendance/device/register/verify  { response, label }
 *
 * R-606 threat: a colleague who knows someone's password checks them in from his own laptop.
 * Here the browser's passkey registration is verified and the device saved as 'pending' — the
 * OWNER approves it (Payroll → Attendance → Devices). The owner registering their own device is
 * approved at once. Only the public key is stored; the private key never leaves the device, and a
 * synced passkey follows the employee's own Google/Apple account, never someone else's laptop.
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { canRegisterAnother, cleanLabel, deviceError, initialStatus } from "@/lib/attendance/webauthn";
import { employeeDevices, getCaller, rpFor, takeChallenge, registerNetworkRefusal } from "../../_server";

function isRegistration(v: unknown): v is RegistrationResponseJSON {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.rawId === "string" && typeof o.response === "object" && o.response !== null;
}

export async function POST(request: NextRequest) {
  const c = await getCaller();
  if (!c) return NextResponse.json({ error: "Not signed in. Sign in again, then register this device." }, { status: 401 });
  if (!c.employeeId) return NextResponse.json(deviceError("NOT_LINKED"), { status: 400 });
  const offSite = await registerNetworkRefusal(c, request);
  if (offSite) return NextResponse.json({ error: offSite.error, code: offSite.code }, { status: offSite.status });

  const body = await request.json().catch(() => null);
  if (!isRegistration(body?.response)) {
    return NextResponse.json({ error: "The device did not send a registration. Press Register this device again." }, { status: 400 });
  }
  const label = cleanLabel(body?.label, "My device");

  const challenge = await takeChallenge(c, "register");
  if (!challenge) return NextResponse.json(deviceError("CHALLENGE_EXPIRED"), { status: 400 });

  const devices = await employeeDevices(c, c.employeeId);
  if (!canRegisterAnother(devices)) return NextResponse.json(deviceError("DEVICE_LIMIT"), { status: 409 });

  const { rpID, origin } = rpFor(request);
  let info;
  try {
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified) return NextResponse.json(deviceError("DEVICE_CHECK_FAILED"), { status: 400 });
    info = result.registrationInfo;
  } catch {
    return NextResponse.json(deviceError("DEVICE_CHECK_FAILED"), { status: 400 });
  }

  const status = initialStatus(c.role);
  const now = new Date().toISOString();
  const { data, error } = await c.admin
    .from("attendance_devices")
    .insert({
      tenant_id: c.tenantId,
      employee_id: c.employeeId,
      user_id: c.userId,
      credential_id: info.credential.id,
      public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      label,
      backed_up: info.credentialBackedUp,
      status,
      approved_by: status === "approved" ? c.userId : null,
      approved_at: status === "approved" ? now : null,
    })
    .select("id, label, status, backed_up, created_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "This device is already registered. Check the list under This device." }, { status: 409 });
    }
    // The trigger's limit messages already say what to do next.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return NextResponse.json({ device: data, credentialId: info.credential.id });
}
