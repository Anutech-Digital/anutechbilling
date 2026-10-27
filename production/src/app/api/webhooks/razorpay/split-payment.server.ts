/**
 * R-1985 — one captured Razorpay payment that pays TWO quotes of one website order: a monthly
 * (flex) Workspace quote and the new domain's own quote (lib/checkout/split-order.ts says how
 * the order ties them together).
 *
 * The money is recorded as TWO payments rows with the SAME Razorpay payment id — the Workspace
 * share on the Workspace quote, the domain share on the domain quote — by running the normal
 * settlement (settleCapturedPayment) once per quote, with that quote's share as the amount.
 * Each quote then invoices itself on its own path (instalment / generate_invoice), so nothing is
 * counted twice (supabase/tests/r1985_monthly_domain_split.test.sql).
 *
 * Idempotent: each share is checked against THIS quote's payments (and record_payment answers
 * already_recorded under its row lock), so a repeat delivery — or one that arrives after only the
 * first share was recorded — records only what is missing. A part that fails answers its error,
 * and Razorpay's retry records the rest.
 *
 * Refused, nothing recorded, owner told once: a payment that is not exactly the sum of the shares.
 */
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/server";
import { rupee } from "@/lib/utils";
import type { SplitPart } from "@/lib/checkout/split-order";
import { flagPaymentForReview } from "./review.server";
import type { CaptureInput, RazorpayPayment } from "./webhook.server";

type Admin = ReturnType<typeof createAdminClient>;

/** What one part of a split settlement is told (CaptureInput.splitPart). */
export interface SplitRole {
  /** primary = the Workspace quote (gateway fee, confirmation emails); secondary = the domain. */
  role: "primary" | "secondary";
  /** The whole payment in rupees — what the confirmation email says was paid. */
  orderTotal: number;
}

type Settle = (admin: Admin, input: CaptureInput) => Promise<NextResponse>;

export async function settleSplitPayment(
  admin: Admin,
  input: CaptureInput & { payment: RazorpayPayment },
  ctx: { tenantId: string; quoteId: string; leadId: string | null; orderId: string; parts: SplitPart[] },
  settle: Settle,
): Promise<NextResponse> {
  const { payment, event } = input;
  const total = ctx.parts.reduce((s, p) => s + p.amount, 0);
  if (Number(payment.amount) !== total * 100 || (payment.currency ?? "INR") !== "INR") {
    return flagPaymentForReview(admin, {
      tenantId: ctx.tenantId, quoteId: ctx.quoteId, leadId: ctx.leadId, orderId: ctx.orderId, event,
      payment: { id: payment.id, amount: payment.amount, currency: payment.currency, email: payment.email, contact: payment.contact },
      why: `it pays ${ctx.parts.map((p) => `${p.quoteId} (${rupee(p.amount)})`).join(" + ")} = ${rupee(total)} together, and the amount captured does not match`,
      nextStep: `Check payment ${payment.id} in the Razorpay dashboard; if it is correct, record each quote's share by hand with Record payment (reference ${payment.id}); otherwise refund it.`,
    });
  }

  const results: Record<string, unknown>[] = [];
  for (const [i, part] of ctx.parts.entries()) {
    const primary = i === 0;
    const res = await settle(admin, {
      ...input,
      /* This quote's share. Razorpay's fee belongs to the one payment — kept on the first share
         only, so it is booked once. */
      payment: { ...payment, amount: part.amount * 100, fee: primary ? payment.fee : null, tax: primary ? payment.tax : null },
      order: { id: ctx.orderId, receipt: part.quoteId, amount: part.amount * 100, notes: input.order?.notes },
      splitPart: { role: primary ? "primary" : "secondary", orderTotal: total },
    });
    if (res.status >= 300) {
      console.error(`[webhooks/razorpay] split payment ${payment.id}: share on ${part.quoteId} failed (${res.status}) — Razorpay will retry; recorded shares are not repeated`);
      return res;
    }
    results.push({ quoteId: part.quoteId, ...((await res.json().catch(() => ({}))) as Record<string, unknown>) });
  }
  const all = results.every((r) => r.alreadyProcessed === true);
  return NextResponse.json({
    received: true,
    split: true,
    ...(all ? { alreadyProcessed: true } : {}),
    quoteId: ctx.parts[0].quoteId,
    invoiceId: (results[0]?.invoiceId as string | null | undefined) ?? null,
    parts: results.map((r) => ({ quoteId: r.quoteId, paid: r.paid ?? null, invoiceId: r.invoiceId ?? null, alreadyProcessed: r.alreadyProcessed === true })),
  });
}
