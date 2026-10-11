/**
 * POST /api/public/expense-claim
 *
 * Public (no session) endpoint the shareable expense-claim link posts to. The
 * link carries the tenant id + expiry + HMAC signature; the employee proves themselves
 * with their attendance PIN. We verify the token, check the PIN (shared checkClaimPin:
 * per-employee limit + DB lockout), THEN stash the optional receipt photo in the private
 * expense-receipts bucket, then call submit_expense_claim (SECURITY DEFINER — verifies
 * PIN + advance server-side). The claim lands 'pending'; the owner approves it in-app.
 *
 * R-725: the photo used to be uploaded BEFORE the PIN was checked, under an unchecked
 * employeeId, with a guessable name and upsert:true — anyone with the link could overwrite
 * another person's receipt. Now: PIN first, employeeId a uuid of this tenant (claim_pin_check),
 * random file name, upsert:false.
 *
 * Body: { tid, sig, exp?, employeeId, pin, amount, category, purpose?, spentOn, photo? }
 */
import { randomUUID } from "crypto";
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

  const tid       = String(body.tid ?? "");
  const sig       = String(body.sig ?? "");
  const exp       = body.exp == null ? "" : String(body.exp);
  const employeeId = String(body.employeeId ?? "");
  const pin       = String(body.pin ?? "");
  const amount    = Math.round(Number(body.amount));
  const category  = String(body.category ?? "").trim();
  const purpose   = body.purpose ? String(body.purpose).trim() : null;
  const spentOn   = String(body.spentOn ?? "").slice(0, 10);
  const photo     = typeof body.photo === "string" ? body.photo : null;

  if (!verifyClaimToken(tid, sig, exp)) {
    return NextResponse.json({ error: claimTokenError(claimTokenStatus(tid, sig, exp)) }, { status: 403 });
  }
  if (!employeeId || !pin) return NextResponse.json({ error: "Pick your name and enter your PIN" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter a valid amount" }, { status: 400 });
  if (!category) return NextResponse.json({ error: "Choose a category" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return NextResponse.json({ error: "Pick the date you spent on" }, { status: 400 });

  const admin = createAdminClient();

  // PIN first — nothing is written (not even the photo) for a wrong or locked PIN.
  const gate = await checkClaimPin(admin, tid, employeeId, pin);
  if (!gate.ok) {
    const f = claimPinFailure(gate);
    return NextResponse.json(f.body, f.init);
  }

  // Optional receipt photo → private bucket. Best-effort: never block the claim.
  let receiptPath: string | null = null;
  if (photo) {
    try {
      const base64 = photo.includes(",") ? photo.split(",")[1] : photo;
      const buf = Buffer.from(base64, "base64");
      if (buf.length > 0 && buf.length < 4_000_000) {
        const stamp = spentOn.replace(/-/g, "");
        const path = `${tid}/${employeeId}/${stamp}_${randomUUID()}.jpg`;
        const up = await admin.storage.from("expense-receipts").upload(path, buf, { contentType: "image/jpeg", upsert: false });
        if (!up.error) receiptPath = path;
      }
    } catch { /* receipt is optional */ }
  }

  const { data, error } = await admin.rpc("submit_expense_claim", {
    p_tenant_id:    tid,
    p_employee_id:  employeeId,
    p_pin:          pin,
    p_amount:       amount,
    p_category:     category,
    p_purpose:      purpose,
    p_spent_on:     spentOn,
    p_receipt_path: receiptPath,
  });

  if (error) {
    // The claim did not land — don't leave its receipt behind.
    if (receiptPath) {
      try { await admin.storage.from("expense-receipts").remove([receiptPath]); } catch { /* best-effort */ }
    }
    // The RPC raises friendly messages (no open advance, over-limit) as P0001;
    // anything else is a fault, and its raw text stays in the server log (R-026).
    const e = publicDbError("expense-claim", error, "We could not submit the claim just now. Please try again in a minute.", { passCodes: { P0001: 400 } });
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  // Fresh claimable balance so the form can update without a reload.
  const { data: remaining } = await admin.rpc("verify_claim_access", {
    p_tenant_id:   tid,
    p_employee_id: employeeId,
    p_pin:         pin,
  });

  return NextResponse.json({ ok: true, claimId: data as string, remaining: Number(remaining ?? 0) });
}
