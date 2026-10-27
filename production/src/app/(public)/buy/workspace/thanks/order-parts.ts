/**
 * R-1985: the extra reads the thanks page needs for a MONTHLY order with a new domain — one
 * payment over two quotes (lib/checkout/split-order.ts):
 *   - the domain's own quote (same lead, plan domain-registration) with its GST invoice and the
 *     money received on it, so the page shows the whole order and BOTH invoices;
 *   - the Workspace quote's month-1 invoice, which is a subscription instalment (quote_id NULL —
 *     R-1974) and so is not found by quote_id.
 * Read-only, scoped to the website tenant; anything unreadable → null (not shown), never a guess.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { DOMAIN_QUOTE_PLAN } from "@/lib/checkout/split-order";

type Admin = ReturnType<typeof createAdminClient>;

export interface DomainPart {
  quoteId: string;
  amount: number;
  subtotal: number;
  domain: string | null;
  invoiceNumber: string | null;
  received: number | null;
}

/** The domain quote paid with this order, or null (every order except monthly + new domain). */
export async function domainPartOf(admin: Admin, tenantId: string, quote: { id: string; lead_id: string | null }): Promise<DomainPart | null> {
  if (!quote.lead_id) return null;
  try {
    const { data, error } = await admin
      .from("quotes")
      .select("id, amount, subtotal, line_items")
      .eq("tenant_id", tenantId)
      .eq("lead_id", quote.lead_id)
      .eq("plan", DOMAIN_QUOTE_PLAN)
      .limit(2);
    if (error) return null;
    const row = ((data ?? []) as { id: string; amount: number | null; subtotal: number | null; line_items: unknown }[])
      .find((r) => r.id !== quote.id);
    if (!row) return null;
    const lines = Array.isArray(row.line_items) ? (row.line_items as { domain?: unknown }[]) : [];
    const { data: pays, error: payErr } = await admin
      .from("payments").select("amount").eq("tenant_id", tenantId).eq("quote_id", row.id).eq("status", "received");
    const { data: inv } = await admin
      .from("invoices").select("id").eq("tenant_id", tenantId).eq("quote_id", row.id)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    return {
      quoteId: row.id,
      amount: Number(row.amount ?? 0),
      subtotal: Number(row.subtotal ?? 0),
      domain: (lines.find((l) => typeof l?.domain === "string")?.domain as string | undefined) ?? null,
      invoiceNumber: (inv as { id?: string } | null)?.id ?? null,
      received: payErr ? null : ((pays ?? []) as { amount: number | null }[]).reduce((s, p) => s + Number(p.amount ?? 0), 0),
    };
  } catch {
    return null;
  }
}

/** A monthly (flex) quote's month-1 GST invoice — the instalment raised for its subscription. */
export async function instalmentInvoiceOf(admin: Admin, tenantId: string, quoteId: string): Promise<string | null> {
  try {
    const { data: subs, error } = await admin
      .from("subscriptions").select("id").eq("tenant_id", tenantId).eq("quote_id", quoteId);
    if (error || !subs?.length) return null;
    const { data: billed } = await admin
      .from("subscription_billings")
      .select("invoice_id")
      .eq("tenant_id", tenantId)
      .in("subscription_id", (subs as { id: string }[]).map((s) => s.id))
      .not("invoice_id", "is", null)
      .order("term_start", { ascending: true })
      .order("period_index", { ascending: true })
      .limit(1);
    const id = (billed as { invoice_id?: string | null }[] | null)?.[0]?.invoice_id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}
