/**
 * POST /api/public/expense-claim/manage  { action, tid, sig, exp?, employeeId, pin, claimId, ... }
 *
 * Lets an employee fix a mistake they just made — edit or delete one of their
 * own PENDING claims — from the same session (PIN re-sent, verified server-side
 * by edit_claim_public / delete_claim_public). Approved claims can't be touched.
 * Returns the fresh claimable balance so the form can update.
 *
 * R-725: the PIN goes through checkClaimPin (per-employee limit + DB lockout) FIRST.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { claimTokenError, claimTokenStatus, verifyClaimToken } from "@/lib/claim-token";
import { checkClaimPin, claimPinFailure, isUuid } from "@/lib/security/claim-pin-guard";
import { publicDbError } from "@/app/api/public/_lib/db-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const action     = String(body.action ?? "");
  const tid        = String(body.tid ?? "");
  const sig        = String(body.sig ?? "");
  const exp        = body.exp == null ? "" : String(body.exp);
  const employeeId = String(body.employeeId ?? "");
  const pin        = String(body.pin ?? "");
  const claimId    = String(body.claimId ?? "");

  if (!verifyClaimToken(tid, sig, exp)) {
    return NextResponse.json({ error: claimTokenError(claimTokenStatus(tid, sig, exp)) }, { status: 403 });
  }
  if (!employeeId || !pin || !isUuid(claimId)) return NextResponse.json({ error: "Missing details" }, { status: 400 });
  if (action !== "delete" && action !== "edit") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const admin = createAdminClient();
  const gate = await checkClaimPin(admin, tid, employeeId, pin);
  if (!gate.ok) {
    const f = claimPinFailure(gate);
    return NextResponse.json(f.body, f.init);
  }

  if (action === "delete") {
    const { error } = await admin.rpc("delete_claim_public", {
      p_tenant_id: tid, p_employee_id: employeeId, p_pin: pin, p_claim_id: claimId,
    });
    if (error) {
      const e = publicDbError("expense-claim/manage", error, "We could not delete the claim just now. Please try again in a minute.", { passCodes: { P0001: 400 } });
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
  } else {
    const amount   = Math.round(Number(body.amount));
    const category = String(body.category ?? "").trim();
    const purpose  = body.purpose ? String(body.purpose).trim() : null;
    const spentOn  = String(body.spentOn ?? "").slice(0, 10);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter a valid amount" }, { status: 400 });
    if (!category) return NextResponse.json({ error: "Choose a category" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return NextResponse.json({ error: "Pick a valid date" }, { status: 400 });
    const { error } = await admin.rpc("edit_claim_public", {
      p_tenant_id: tid, p_employee_id: employeeId, p_pin: pin, p_claim_id: claimId,
      p_amount: amount, p_category: category, p_purpose: purpose, p_spent_on: spentOn,
    });
    if (error) {
      const e = publicDbError("expense-claim/manage", error, "We could not save the claim just now. Please try again in a minute.", { passCodes: { P0001: 400 } });
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
  }

  const { data: remaining } = await admin.rpc("verify_claim_access", {
    p_tenant_id: tid, p_employee_id: employeeId, p_pin: pin,
  });
  return NextResponse.json({ ok: true, remaining: Number(remaining ?? 0) });
}
