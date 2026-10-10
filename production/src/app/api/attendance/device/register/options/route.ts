/**
 * POST /api/attendance/device/register/options → WebAuthn creation options for "Register this device".
 *
 * R-606 threat: a colleague who knows someone's password checks them in from his own laptop.
 * A passkey's private key is created inside THIS device (fingerprint / face / Windows Hello) and
 * never leaves it, so only this device can sign that employee's check-ins later. Synced passkeys
 * follow the employee's own Google/Apple account, never another person's laptop.
 *
 * Refused when the employee already has 2 live (pending + approved) devices.
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateRegistrationOptions, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { canRegisterAnother, deviceError, employeeIdBytes, liveDevices } from "@/lib/attendance/webauthn";
import { employeeDevices, getCaller, rpFor, saveChallenge, registerNetworkRefusal } from "../../_server";

export async function POST(request: NextRequest) {
  const c = await getCaller();
  if (!c) return NextResponse.json({ error: "Not signed in. Sign in again, then register this device." }, { status: 401 });
  if (!c.employeeId) return NextResponse.json(deviceError("NOT_LINKED"), { status: 400 });
  const offSite = await registerNetworkRefusal(c, request);
  if (offSite) return NextResponse.json({ error: offSite.error, code: offSite.code }, { status: offSite.status });

  const devices = await employeeDevices(c, c.employeeId);
  if (!canRegisterAnother(devices)) return NextResponse.json(deviceError("DEVICE_LIMIT"), { status: 409 });

  const { rpID } = rpFor(request);
  const options = await generateRegistrationOptions({
    rpName: "ResellerOS",
    rpID,
    userName: c.email ?? c.userId,
    userDisplayName: c.email ?? undefined,
    userID: employeeIdBytes(c.employeeId),
    attestationType: "none",
    excludeCredentials: liveDevices(devices).map((d) => ({
      id: d.credential_id,
      transports: d.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
  });

  const err = await saveChallenge(c, options.challenge, "register");
  if (err) return NextResponse.json({ error: "Could not start device registration. Try again in a minute." }, { status: 500 });
  return NextResponse.json(options);
}
