/**
 * POST /api/attendance/device/approve  { deviceId, action: 'approve' | 'revoke' }
 *
 * R-606 threat: a colleague who knows someone's password checks them in from his own laptop. Even
 * if he registers a passkey on HIS laptop under that login, it stays 'pending' until the OWNER
 * approves it here — and the owner sees which device and when. Owner only (Pardeep, 9 Oct 2026:
 * not managers). Max 2 approved devices per employee; the database trigger enforces it too.
 * Passkeys keep the private key on the device; a synced one follows only the employee's own
 * Google/Apple account (shown to the owner as "synced passkey").
 */
import { NextResponse, type NextRequest } from "next/server";
import { decideOwnerAction, deviceError, type DeviceStatus } from "@/lib/attendance/webauthn";
import { getCaller } from "../_server";

export async function POST(request: NextRequest) {
  const c = await getCaller();
  if (!c) return NextResponse.json({ error: "Not signed in. Sign in again, then retry." }, { status: 401 });
  if (c.role !== "owner") return NextResponse.json(deviceError("OWNER_ONLY"), { status: 403 });

  const body = await request.json().catch(() => null);
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
  const action = body?.action === "approve" || body?.action === "revoke" ? (body.action as "approve" | "revoke") : null;
  if (!deviceId || !action) {
    return NextResponse.json({ error: "Pick a device and Approve or Remove. Refresh the page if the list looks old." }, { status: 400 });
  }

  const { data: device } = await c.admin
    .from("attendance_devices")
    .select("id, employee_id, status")
    .eq("tenant_id", c.tenantId)
    .eq("id", deviceId)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: "This device is not in your workspace any more. Refresh the Devices list." }, { status: 404 });
  }

  const { data: siblings } = await c.admin
    .from("attendance_devices")
    .select("id, status")
    .eq("tenant_id", c.tenantId)
    .eq("employee_id", device.employee_id);

  const decision = decideOwnerAction({ id: device.id, status: device.status as DeviceStatus }, siblings ?? [], action);
  if (!decision.ok) return NextResponse.json(deviceError(decision.code), { status: 409 });

  const now = new Date().toISOString();
  const patch =
    decision.status === "approved"
      ? { status: "approved", approved_by: c.userId, approved_at: now }
      : { status: "revoked", revoked_at: now };
  const { error } = await c.admin
    .from("attendance_devices")
    .update(patch)
    .eq("tenant_id", c.tenantId)
    .eq("id", device.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });

  return NextResponse.json({ id: device.id, status: decision.status });
}
