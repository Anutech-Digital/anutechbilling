/**
 * Two blanks the desk Record payment sheet fills once the payment is saved (9 Oct 2026).
 * Both are best-effort: the money is already recorded, so a failure only logs.
 *
 * R-447 — fillCustomerStateFromQuote: generate_invoice takes the place of supply from the
 *   CUSTOMER row. A lead with no state on a quote whose Place of supply is set produced a
 *   customer with no state, so "Issue GST invoice now" was refused although the quote said
 *   where the supply goes. Fill the customer's BLANK state from the quote — never overwrite.
 *
 * R-407 — saveDomainAfterPayment: the domain typed on the sheet was stamped only onto a
 *   subscription, so on a quote that made none (a one-time line) it was saved nowhere. It is
 *   now also written to the customer (when its domain is blank) and to the quote's
 *   provisioning task (when its domain is blank). Never overwrites.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { quoteStateToFill } from "@/lib/payments/record-payment-invoice";
import { pickDomainStampTarget } from "@/lib/quotes/payment-domain";

type Client = SupabaseClient<Database>;

/** The quote's customer after record_payment (it may have just been created). */
async function quoteCustomerId(sb: Client, quoteId: string): Promise<string | null> {
  const { data } = await sb.from("quotes").select("customer_id").eq("id", quoteId).maybeSingle();
  return (data?.customer_id as string | null | undefined) ?? null;
}

export async function fillCustomerStateFromQuote(
  sb: Client,
  quoteId: string,
): Promise<"filled" | "nothing_to_fill"> {
  try {
    const { data: q } = await sb
      .from("quotes").select("customer_id, prospect_state_code, prospect_state").eq("id", quoteId).maybeSingle();
    const customerId = (q?.customer_id as string | null | undefined) ?? null;
    if (!q || !customerId) return "nothing_to_fill";
    const { data: c } = await sb
      .from("customers").select("state_code, state, gstin").eq("id", customerId).maybeSingle();
    const code = quoteStateToFill(c, q);
    if (!code) return "nothing_to_fill";
    const { data: updated, error } = await sb
      .from("customers")
      .update({ state_code: code, state: (c?.state ?? "").trim() ? c?.state ?? null : q.prospect_state ?? null })
      .eq("id", customerId)
      .or("state_code.is.null,state_code.eq.")
      .select("id");
    if (error || !updated?.length) return "nothing_to_fill";
    return "filled";
  } catch (e) {
    console.error("[record-payment] could not copy the quote's place of supply to the customer:", e);
    return "nothing_to_fill";
  }
}

export async function saveDomainAfterPayment(
  sb: Client,
  args: { quoteId: string; domain: string | null | undefined },
): Promise<{ customer: boolean; task: boolean }> {
  const domain = (args.domain ?? "").trim().toLowerCase();
  const out = { customer: false, task: false };
  if (!domain) return out;
  try {
    const customerId = await quoteCustomerId(sb, args.quoteId);
    if (customerId) {
      const { data, error } = await sb
        .from("customers")
        .update({ domain })
        .eq("id", customerId)
        .or("domain.is.null,domain.eq.")
        .select("id");
      if (error) console.error("[record-payment] customer domain not saved (payment still recorded):", error);
      out.customer = Boolean(data?.length);
    }
    const { data: t, error: tErr } = await sb
      .from("provisioning_tasks")
      .update({ domain })
      .eq("quote_id", args.quoteId)
      .is("domain", null)
      .select("id");
    if (tErr) console.error("[record-payment] provisioning task domain not saved (payment still recorded):", tErr);
    out.task = Boolean(t?.length);
  } catch (e) {
    console.error("[record-payment] domain not saved (payment still recorded):", e);
  }
  return out;
}

/**
 * R-1730 — the whole "save this quote's domain" step, one place for its two callers:
 *   · Record payment (record-payment-dialog), after the money is saved, with the domain the page
 *     already knew (the sheet no longer has a domain field — setup, not money);
 *   · the quote's "Setting up" card (provisioning-card), where a domain nobody knew yet is typed.
 * Same writes as before (R-389 / R-407): ONE subscription of the quote (pickDomainStampTarget —
 * the unique (tenant, quote, lower(domain)) index refuses a second), then the customer and the
 * provisioning task. Blanks only, never overwrites; best-effort — a failure only logs.
 */
export async function stampPaymentDomain(
  sb: Client,
  args: { quoteId: string; domain: string | null | undefined },
): Promise<{ subscription: boolean; customer: boolean; task: boolean }> {
  const domain = (args.domain ?? "").trim();
  if (!domain) return { subscription: false, customer: false, task: false };
  let subscription = false;
  const { data: quoteSubs, error: subsErr } = await sb
    .from("subscriptions")
    .select("id, vendor, domain")
    .eq("quote_id", args.quoteId)
    .order("created_at", { ascending: true });
  if (subsErr) console.error("[record-payment] could not read the quote's subscriptions for the domain:", subsErr);
  const targetId = subsErr ? null : pickDomainStampTarget(quoteSubs ?? [], domain);
  if (targetId) {
    const { data: stamped, error: domErr } = await sb
      .from("subscriptions")
      .update({ domain })
      .eq("id", targetId)
      .is("domain", null)
      .select("id");
    if (domErr) console.error("[record-payment] domain stamp failed (payment still recorded):", domErr);
    subscription = Boolean(stamped?.length);
  }
  const rest = await saveDomainAfterPayment(sb, { quoteId: args.quoteId, domain });
  return { subscription, ...rest };
}

/**
 * R-1730 — the "Set up" pointer in the Record payment result toast when the quote makes a
 * subscription and no domain is known yet (the sheet no longer asks for it). A fully paid quote
 * has its "Setting up" card (raised by trg_quotes_raise_provisioning); before that, the
 * subscription's own "Add domain" on Subscriptions. null = nothing to set up.
 */
export function domainSetupLine(r: { domainToSetUp: boolean; isFullyPaid: boolean }): string | null {
  if (!r.domainToSetUp) return null;
  return r.isFullyPaid
    ? "Next: add the customer's domain on the quote's Setting up card."
    : "Next: add the customer's domain in Subscriptions → Add domain.";
}
