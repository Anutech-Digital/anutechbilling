/**
 * Reads the order the thanks page may show, or null. See page.tsx for the security posture:
 * the quote's secret token (S11), ANUTECH's tenant, and a paid status must all hold.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import type { ThanksOrder } from "./thanks-client";
import { websiteTenantId } from "@/lib/website-tenant";
import { orderPaymentState } from "@/lib/checkout/order-payment-state";
import { PLAN_COPY, type PlanId } from "../_parts/plans";

/* R-1499: tenant read per call (websiteTenantId) — outside production an unset BUY_PAGE_TENANT_ID
   shows nothing (and logs why), never the live tenant's data. */

/** Pull only the customer-safe slice of the quote row. Never expose cost,
 *  margin, internal notes, or other tenant data. */
export async function fetchOrder(quoteId: string, token: string | null | undefined): Promise<ThanksOrder | null> {
  // Both shapes of quote number: today's Q-<tenant code>-2026-27-0042 (next_document_number with
  // the tenant's doc_code) and the older Q-2026-27-0042. Until 29 Sep 2026 only the older one was
  // accepted, so every customer since tenant codes arrived got the "no order found" page.
  // And since 30 Sep 2026 (20260930172000, CGST Rule 46(b) 16 characters) the short shape
  // Q-<code>-27-0005: FY as two digits. Found 2 Oct when a test purchase landed on "not found".
  if (!/^Q-(?:[A-Z0-9]{2,8}-)?(?:[0-9]{4}-)?[0-9]{2}-[0-9]{4,}$/.test(quoteId)) return null;
  // No token, no lookup: a guessed number never reaches the database.
  if (!token) return null;
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("quotes")
    .select("id, tenant_id, public_token, customer_name, plan, seats, amount, subtotal, payment_status, payment_received_at, line_items, created_date")
    .eq("id", quoteId)
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    /* "invoiced" too (R-120): the GST invoice is issued straight after record_payment (webhook
       and simulated checkout alike) and moves the quote to payment_status 'invoiced' — so a
       paid order was answered "no order found" the moment its invoice existed. */
    .in("payment_status", ["received", "partial", "invoiced"])
    .maybeSingle();
  if (error || !data) return null;
  if (!quoteTokenMatches(token, data.public_token)) return null;

  // Extract tier name + domain from line_items / notes if present.
  const firstLine = Array.isArray(data.line_items) && data.line_items.length > 0
    ? (data.line_items[0] as { name?: string })
    : null;
  const lineTier = firstLine?.name?.replace(/^Google Workspace\s*[·\-]?\s*/i, "").replace(/\s*\(annual\)\s*$/i, "")
                ?? data.plan
                ?? "Google Workspace";
  /* R-1986: an order from the buy page (plan google-workspace-<tier>) is named as the page names
     it — Google's full plan name (PLAN_COPY); a monthly one keeps saying so. Other quotes: the line. */
  const slug = /^google-workspace-(starter|standard|plus|enterprise)$/.exec(String(data.plan ?? ""))?.[1] as PlanId | undefined;
  const tierName = slug ? `${PLAN_COPY[slug].name}${/monthly/i.test(firstLine?.name ?? "") ? " — monthly" : ""}` : lineTier;

  /* R-1624: what came in against this quote. 'invoiced' (set the moment the GST invoice is
     issued) does not by itself say whether the order is paid in full, so the page's state comes
     from orderPaymentState with the received sum — payments.amount, what each payment settles. */
  const { data: payRows, error: payError } = await admin
    .from("payments")
    .select("amount")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("quote_id", data.id)
    .eq("status", "received");
  const amountReceived = payError
    ? null
    : ((payRows ?? []) as { amount: number | null }[]).reduce((s, p) => s + Number(p.amount ?? 0), 0);

  /* R-1968 / R-1971: the GST invoice number issued for this order (generate_invoice links it by
     quote_id), so the buyer sees it on the thanks page. None yet / unreadable → not shown. */
  const { data: inv } = await admin
    .from("invoices")
    .select("id")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("quote_id", data.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  /* R-1977: a new domain bought with this order — its line carries the registrant. */
  const newDomain = Array.isArray(data.line_items)
    ? ((data.line_items as { domain?: unknown; registrant?: unknown }[]).find((l) => typeof l?.domain === "string" && l.registrant && typeof l.registrant === "object")?.domain as string | undefined) ?? null
    : null;

  return {
    quoteId:        data.id,
    newDomain,
    invoiceNumber:  (inv as { id?: string } | null)?.id ?? null,
    customerName:   data.customer_name ?? "",
    tierName,
    seats:          data.seats ?? 0,
    amount:         data.amount ?? 0,
    subtotal:       data.subtotal ?? null,
    paymentStatus:  data.payment_status ?? "awaiting",
    paymentState:   orderPaymentState({ paymentStatus: data.payment_status, amount: data.amount, received: amountReceived }),
    amountReceived,
    paymentDate:    data.payment_received_at ?? data.created_date ?? null,
  };
}
