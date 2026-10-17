/**
 * What the Google bill is checked against: every Google subscription and every customer with a
 * domain (R-164).
 *
 * R-1519: both reads are paged. `.limit(5000)` / `.limit(10000)` came back as 1000 rows (the
 * gateway caps every answer at 1000 and says nothing), so domain no. 1001 showed as
 * "No customer" / "No subscription" — and "Add all missing" offered to create a customer that
 * already exists. Each order ends on `id` so no page repeats or skips a row.
 */
import type { createClient } from "@/lib/supabase/client";
import { errorMessage, fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import type { CustomerLite, SubLite } from "@/lib/reconcile/google-bill";

type Client = ReturnType<typeof createClient>;

export async function fetchGoogleBillBooks(supabase: Client): Promise<{ subs: SubLite[]; customers: CustomerLite[] }> {
  try {
    const [subs, customers] = await Promise.all([
      fetchAllRows<SubLite>((from, to) => supabase.from("subscriptions")
        .select("id, customer_id, customer_name, domain, vendor, status, seats, vendor_seats, mrr, plan")
        .eq("vendor", "google").order("id", { ascending: true }).range(from, to) as unknown as PageQuery<SubLite>),
      fetchAllRows<CustomerLite>((from, to) => supabase.from("customers")
        .select("id, name, domain").not("domain", "is", null).order("id", { ascending: true }).range(from, to) as unknown as PageQuery<CustomerLite>),
    ]);
    return { subs, customers };
  } catch (e) {
    throw new Error(errorMessage(e));
  }
}
