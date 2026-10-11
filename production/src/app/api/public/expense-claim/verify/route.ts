/**
 * POST /api/public/expense-claim/verify  { tid, sig, exp?, employeeId, pin }
 *
 * Step 1 of the claim flow: check the employee's PIN once and return how much
 * of their advance is still claimable. The form then lets them log several
 * expenses in a row without re-entering the PIN (it's kept in memory for the
 * session and sent with each submit — never stored).
 *
 * R-725: the PIN check is the shared checkClaimPin (per-employee limit + DB lockout),
 * the same one submit and manage run.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { claimTokenError, claimTokenStatus, verifyClaimToken } from "@/lib/claim-token";
import { checkClaimPin, claimPinFailure } from "@/lib/security/claim-pin-guard";
import { publicDbError } from "@/app/api/public/_lib/db-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const tid        = String(body.tid ?? "");
  const sig        = String(body.sig ?? "");
  const exp        = body.exp == null ? "" : String(body.exp);
  const employeeId = String(body.employeeId ?? "");
  const pin        = String(body.pin ?? "");

  if (!verifyClaimToken(tid, sig, exp)) {
    return NextResponse.json({ error: claimTokenError(claimTokenStatus(tid, sig, exp)) }, { status: 403 });
  }

  const admin = createAdminClient();
  const gate = await checkClaimPin(admin, tid, employeeId, pin);
  if (!gate.ok) {
    const f = claimPinFailure(gate);
    return NextResponse.json(f.body, f.init);
  }

  const { data, error } = await admin.rpc("verify_claim_access", {
    p_tenant_id:   tid,
    p_employee_id: employeeId,
    p_pin:         pin,
  });
  if (error) {
    const e = publicDbError("expense-claim/verify", error, "We could not check your PIN just now. Please try again in a minute.", { passCodes: { P0001: 400 } });
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  return NextResponse.json({ ok: true, remaining: Number(data ?? 0) });
}
