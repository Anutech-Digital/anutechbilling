/**
 * POST /api/attendance/device/auth/options → WebAuthn request options for a check-in / check-out.
 *
 * R-606 threat: a colleague who knows someone's password checks them in from his own laptop.
 * When the workspace requires a registered device, the check-in must be signed by the passkey of
 * one of THIS employee's approved devices. The private key never leaves that device (a synced
 * passkey follows only the employee's own Google/Apple account), so another laptop cannot sign.
 */
import { NextResponse } from "next/server";
import { generateAuthenticationOptions, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { deviceError } from "@/lib/attendance/webauthn";
import { employeeDevices, getCaller, rpFor, saveChallenge } from "../../_server";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const c = await getCaller();
  if (!c) return NextResponse.json({ error: "Not signed in. Sign in again, then check in." }, { status: 401 });
  if (!c.employeeId) return NextResponse.json(deviceError("NOT_LINKED"), { status: 400 });

  const approved = (await employeeDevices(c, c.employeeId)).filter((d) => d.status === "approved");
  if (approved.length === 0) return NextResponse.json(deviceError("DEVICE_NOT_REGISTERED"), { status: 403 });

  const { rpID } = rpFor(request);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: approved.map((d) => ({
      id: d.credential_id,
      transports: d.transports as AuthenticatorTransportFuture[],
    })),
  });

  const err = await saveChallenge(c, options.challenge, "auth");
  if (err) return NextResponse.json({ error: "Could not start the device check. Try again in a minute." }, { status: 500 });
  return NextResponse.json(options);
}
