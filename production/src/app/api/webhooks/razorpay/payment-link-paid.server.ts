/**
 * R-2415 — a Send-reminder pay link (invoice / statement) was paid at Razorpay.
 *
 * Called by webhook.server.ts AFTER the signature check (the same HMAC as every other event),
 * for `payment_link.paid` AND for the `payment.captured` / `order.paid` of the same money — a
 * tenant whose Razorpay webhook does not send payment_link.paid is still booked.
 *   1. Our row (invoice_payment_links): by Razorpay link id, else by the `link_row` our notes
 *      carry, the order's receipt (= our row id) or the order id stored on an earlier event.
 *      Its tenant must pass the S24 tenant gate.
 *   2. settle_invoice_payment_link books it ONCE: the link row is locked, an already-paid link
 *      answers already_recorded (so the second of the two events writes nothing), and anything
 *      that no longer matches the frozen link goes to review (the owner is told; nothing is
 *      booked — never another bill's money, never a quiet credit).
 *   3. Razorpay's fee + who bore it on the payment rows (fee once per payment), owner notified,
 *      and the customer's OTHER live links that now ask for paid money are cancelled.
 * No email to the customer from here — the reminder already went from us, and Razorpay's own
 * notifications are off on the link.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { rupee } from "@/lib/utils";
import { logDbError, safeDbMessage } from "@/lib/errors/db-error";
import { recordFeeBearer } from "@/lib/payments/online-fee.server";
import { INVOICE_LINK_PURPOSE, parsePaymentLinkPaid } from "@/lib/payments/payment-link";
import { sweepStaleInvoicePayLinks } from "@/lib/payments/payment-link.server";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { flagPaymentForReview } from "./review.server";
import type { RazorpayPayment } from "./webhook.server";

type Admin = ReturnType<typeof createAdminClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentLinkPaidDeps {
  mayActOn: (tenantId: string) => Promise<boolean>;
  eventId: string | null;
  /** webhook.server's recordGatewayFee — passed in so this file does not import its caller. */
  recordGatewayFee: (admin: Admin, tenantId: string, quoteId: string, reference: string, payment: RazorpayPayment) => Promise<void>;
}

interface SettleResult {
  found?: boolean;
  recorded?: boolean;
  already_recorded?: boolean;
  review?: boolean;
  why?: string | null;
  tenant_id?: string;
  customer_id?: string;
  lines?: { invoice_id: string; quote_id: string; amount: number; payment_id: string | null; invoice_paid: boolean }[];
}

interface LinkRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  razorpay_link_id: string | null;
  razorpay_order_id: string | null;
}

const ROW_COLS = "id, tenant_id, customer_id, razorpay_link_id, razorpay_order_id";

type Notes = Record<string, unknown> | unknown[] | null | undefined;
const noteOf = (n: Notes, k: string): string | null => {
  if (!n || Array.isArray(n)) return null;
  const v = (n as Record<string, unknown>)[k];
  return typeof v === "string" ? v.trim() : null;
};

/** Our row for a Razorpay event — by link id, our notes' link_row, the order receipt, or the order id. */
async function findLinkRow(
  db: SupabaseClient,
  by: { linkId?: string | null; notes?: Notes[]; receipt?: string | null; orderId?: string | null },
): Promise<LinkRow | null> {
  if (by.linkId) {
    const { data } = await db.from("invoice_payment_links").select(ROW_COLS).eq("razorpay_link_id", by.linkId).maybeSingle();
    if (data) return data as LinkRow;
  }
  const rowIds = new Set<string>();
  for (const n of by.notes ?? []) {
    if (noteOf(n, "purpose") === INVOICE_LINK_PURPOSE) {
      const r = noteOf(n, "link_row");
      if (r && UUID.test(r)) rowIds.add(r);
    }
  }
  const receipt = by.receipt?.trim() ?? "";
  if (UUID.test(receipt)) rowIds.add(receipt);
  for (const id of rowIds) {
    const { data } = await db.from("invoice_payment_links").select(ROW_COLS).eq("id", id).maybeSingle();
    if (data) return data as LinkRow;
  }
  const orderId = by.orderId?.trim() ?? "";
  if (orderId.startsWith("order_")) {
    const { data } = await db.from("invoice_payment_links").select(ROW_COLS).eq("razorpay_order_id", orderId).limit(1).maybeSingle();
    if (data) return data as LinkRow;
  }
  return null;
}

/**
 * Is this payment.captured / order.paid the capture of one of OUR invoice links? Then it is
 * settled here (once — whichever of the events comes first), never by the quote path.
 */
export async function invoiceLinkRowForCapture(
  admin: Admin,
  payment: { order_id?: string | null; notes?: Notes } | undefined,
  order: { id?: string; receipt?: string | null; notes?: Notes } | undefined,
): Promise<LinkRow | null> {
  return findLinkRow(admin as unknown as SupabaseClient, {
    notes: [payment?.notes, order?.notes],
    receipt: order?.receipt ?? null,
    orderId: payment?.order_id ?? order?.id ?? null,
  });
}

interface Paid {
  linkId: string | null;
  paymentId: string;
  paidPaise: number;
  currency: string;
  method: string | null;
  orderId: string | null;
  event: string;
  entity: RazorpayPayment;
}

async function settle(admin: Admin, link: LinkRow, paid: Paid, deps: PaymentLinkPaidDeps): Promise<NextResponse> {
  const db = admin as unknown as SupabaseClient;
  if (!(await deps.mayActOn(link.tenant_id))) {
    console.error("[webhooks/razorpay] pay-link tenant mismatch", { event: paid.event, linkTenant: link.tenant_id });
    return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
  }

  /* Stamp what this event knows: the order (so a later payment.captured without our notes is
     recognised) and, for a row whose link id was never saved, the link id. */
  const stamp: Record<string, string> = {};
  if (paid.orderId && !link.razorpay_order_id) stamp.razorpay_order_id = paid.orderId;
  if (paid.linkId && !link.razorpay_link_id) stamp.razorpay_link_id = paid.linkId;
  if (Object.keys(stamp).length) {
    const { error } = await db.from("invoice_payment_links").update(stamp).eq("tenant_id", link.tenant_id).eq("id", link.id);
    if (error) logDbError("webhooks/razorpay:payment_link.stamp", error);
  }

  const reviewPayment = { id: paid.paymentId, amount: paid.paidPaise, currency: paid.currency, email: paid.entity.email, contact: paid.entity.contact };
  const review = (why: string) =>
    flagPaymentForReview(admin, {
      tenantId: link.tenant_id, quoteId: null, leadId: null, payment: reviewPayment, orderId: paid.orderId,
      event: paid.event,
      title: "Razorpay pay-link payment needs a check",
      why: `it came through the reminder pay link but ${why}`,
      nextStep: `Open Payment Follow-up → this customer. If the bill is still open, use Record payment with reference ${paid.paymentId}; if it was already paid, refund the customer from the Razorpay dashboard.`,
    });

  const linkId = link.razorpay_link_id ?? paid.linkId;
  if (!linkId) return review("the app never saved this link's Razorpay id");
  if (paid.currency.toUpperCase() !== "INR") return review(`it was paid in ${paid.currency}, not INR`);

  const { data, error } = await admin.rpc("settle_invoice_payment_link" as never, {
    p_link_id: linkId,
    p_payment_id: paid.paymentId,
    p_paid_paise: paid.paidPaise,
    p_event_id: deps.eventId,
  } as never);
  if (error) {
    logDbError("webhooks/razorpay:settle_invoice_payment_link", error);
    return NextResponse.json({ error: safeDbMessage(error, "Payment processing failed") }, { status: 500 });
  }
  const r = (data ?? {}) as SettleResult;
  if (!r.found) return NextResponse.json({ received: true, ignored: `${paid.event} (pay link not found)` });
  if (r.already_recorded) return NextResponse.json({ received: true, alreadyProcessed: true });
  if (r.review) return review(r.why ?? "it no longer matches the bill");

  const lines = r.lines ?? [];
  /* Razorpay's fee belongs to the ONE payment — on the first bill's row only; every row gets
     who bore the fee (business, today — R-2417 charges it). */
  for (const [i, l] of lines.entries()) {
    if (i === 0) await deps.recordGatewayFee(admin, link.tenant_id, l.quote_id, paid.paymentId, paid.entity);
    else await recordFeeBearer(admin, link.tenant_id, l.quote_id, paid.paymentId);
  }

  /* The customer's other live links (the statement that also held this bill, say) now ask for
     money that is paid — cancel them before anyone pays twice. Best-effort. */
  await sweepStaleInvoicePayLinks({ admin, tenantId: link.tenant_id, customerId: link.customer_id })
    .catch((e: unknown) => console.error("[webhooks/razorpay] pay-link sweep failed:", e instanceof Error ? e.message : e));

  const total = lines.reduce((s, l) => s + l.amount, 0);
  const which = lines.map((l) => l.invoice_id).join(", ");
  await notifyTenantOwners({
    tenantId: link.tenant_id,
    kind: "payment.received",
    title: `Paid by reminder pay link — ${rupee(total)} · ${which}`,
    body: `Razorpay payment ${paid.paymentId}${paid.method ? ` (${paid.method})` : ""} booked on ${which}.`,
    href: lines.length === 1 ? invoiceHref(lines[0].invoice_id) : "/collections",
    entityId: paid.paymentId,
  });

  return NextResponse.json({ received: true, recorded: true, invoices: lines.map((l) => l.invoice_id) });
}

/** `payment_link.paid`. */
export async function handlePaymentLinkPaid(admin: Admin, body: unknown, deps: PaymentLinkPaidDeps): Promise<NextResponse> {
  const paid = parsePaymentLinkPaid(body);
  if (!paid) {
    console.warn("[webhooks/razorpay] payment_link.paid without a captured payment — ignored");
    return NextResponse.json({ received: true, ignored: "payment_link.paid (no captured payment)" });
  }
  const payload = (body as { payload: { payment: { entity: RazorpayPayment }; order?: { entity?: { receipt?: string | null; notes?: Notes } } } }).payload;
  const link = await findLinkRow(admin as unknown as SupabaseClient, {
    linkId: paid.linkId,
    notes: [paid.notes, payload.order?.entity?.notes],
    receipt: payload.order?.entity?.receipt ?? null,
    orderId: paid.orderId,
  });
  if (!link) {
    /* Not an invoice link of ours (a link made by hand in the Razorpay dashboard, say). */
    console.warn("[webhooks/razorpay] payment_link.paid for a link the app did not make:", paid.linkId);
    return NextResponse.json({ received: true, ignored: "payment_link.paid (not an app invoice link)" });
  }
  return settle(admin, link, {
    linkId: paid.linkId, paymentId: paid.paymentId, paidPaise: paid.paidPaise, currency: paid.currency,
    method: paid.method, orderId: paid.orderId, event: "payment_link.paid", entity: payload.payment.entity,
  }, deps);
}

/** payment.captured / order.paid of a pay-link payment — settled the same way, once. */
export async function settleInvoiceLinkCapture(
  admin: Admin,
  link: LinkRow,
  event: string,
  payment: RazorpayPayment | undefined,
  deps: PaymentLinkPaidDeps,
): Promise<NextResponse> {
  if (!payment?.id || payment.status !== "captured" || !(typeof payment.amount === "number" && payment.amount > 0)) {
    /* An order-only event names no captured amount; the payment's own event settles it. */
    return NextResponse.json({ received: true, ignored: `${event} (reminder pay link — no captured payment in it)` });
  }
  return settle(admin, link, {
    linkId: null, paymentId: payment.id, paidPaise: payment.amount, currency: payment.currency ?? "INR",
    method: payment.method ?? null, orderId: payment.order_id ?? null, event, entity: payment,
  }, deps);
}
