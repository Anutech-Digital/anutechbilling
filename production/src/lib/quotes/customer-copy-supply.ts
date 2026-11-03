/**
 * R-2448 — read the buyer and the seller that customerCopyBlock's place-of-supply rule needs,
 * for a route that has only the quote (Mark as sent, the PDF link). The same rows the send
 * route reads: the customer, else the lead the quote was raised on, and the company's own
 * state. Every read is scoped to the caller's workspace.
 */
import type { CustomerCopyParties } from "./customer-copy-gate";

// The supabase-js call chains this needs, from either the admin or a user client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: "customers" | "leads" | "tenants") => any };

export async function loadCustomerCopyParties(
  db: Db,
  quote: { tenant_id: string; customer_id?: string | null; lead_id?: string | null },
  role: string | null | undefined,
): Promise<CustomerCopyParties> {
  const [{ data: customer }, { data: lead }, { data: seller }] = await Promise.all([
    quote.customer_id
      ? db.from("customers").select("name, state_code, gstin, country, gst_treatment")
          .eq("id", quote.customer_id).eq("tenant_id", quote.tenant_id).maybeSingle()
      : Promise.resolve({ data: null }),
    !quote.customer_id && quote.lead_id
      ? db.from("leads").select("state_code, gstin, country")
          .eq("id", quote.lead_id).eq("tenant_id", quote.tenant_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from("tenants").select("state_code, gstin").eq("id", quote.tenant_id).maybeSingle(),
  ]);
  return {
    customer: customer ?? null,
    lead: lead ?? null,
    seller: { state_code: seller?.state_code ?? null, gstin: seller?.gstin ?? null },
    role: role ?? null,
  };
}
