/**
 * R-2448 — read the buyer and the seller that customerCopyBlock's place-of-supply rule needs,
 * for a route that has only the quote (Mark as sent, the PDF link). The same rows the send
 * route reads, with the same (admin) client: a sales user whose access rules hide the customer
 * row must not get a false "has no state on record". Every read is scoped to the quote's
 * workspace. A failed read throws — "could not read" is never reported as "no state".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CustomerCopyParties } from "./customer-copy-gate";

type ReadResult = { data: unknown; error: { message?: string } | null };

function rowOrThrow<T>(what: string, r: ReadResult): T | null {
  if (r.error) throw new Error(`Could not read the ${what} to check the place of supply: ${r.error.message ?? "unknown error"}`);
  return (r.data as T | null) ?? null;
}

export async function loadCustomerCopyParties(
  db: SupabaseClient<Database>,
  quote: { tenant_id: string; customer_id?: string | null; lead_id?: string | null },
  role: string | null | undefined,
): Promise<CustomerCopyParties> {
  const none: ReadResult = { data: null, error: null };
  const [customerRes, leadRes, sellerRes] = await Promise.all([
    quote.customer_id
      ? db.from("customers").select("name, state_code, gstin, country, gst_treatment")
          .eq("id", quote.customer_id).eq("tenant_id", quote.tenant_id).maybeSingle()
      : Promise.resolve(none),
    !quote.customer_id && quote.lead_id
      ? db.from("leads").select("state_code, gstin, country")
          .eq("id", quote.lead_id).eq("tenant_id", quote.tenant_id).maybeSingle()
      : Promise.resolve(none),
    db.from("tenants").select("state_code, gstin").eq("id", quote.tenant_id).maybeSingle(),
  ]);
  const customer = rowOrThrow<NonNullable<CustomerCopyParties["customer"]>>("customer", customerRes as ReadResult);
  const lead = rowOrThrow<NonNullable<CustomerCopyParties["lead"]>>("lead", leadRes as ReadResult);
  const seller = rowOrThrow<{ state_code: string | null; gstin: string | null }>("company", sellerRes as ReadResult);
  return {
    customer,
    lead,
    seller: { state_code: seller?.state_code ?? null, gstin: seller?.gstin ?? null },
    role: role ?? null,
  };
}
