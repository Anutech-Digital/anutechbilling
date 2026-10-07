/**
 * R-295 — what is ALREADY on file, read in full before an import flags duplicates.
 *
 * The four import dialogs (customers, customer domains, Google subscriptions, subscriptions)
 * used to read existing rows with one bare `select()`. PostgREST answers at most 1000 rows
 * and says nothing when it cut the answer short, so a workspace with 1,200 customers had
 * its customers #1001–#1200 missing from the duplicate check — re-importing the same CSV
 * created them a second time. Every lookup here pages with fetchAllRows, ordered on `id`
 * (a unique column — offset pages over an order with ties can skip a row).
 *
 * The client type is structural (from → select → order → range) so a test can hand in a
 * fake that enforces the 1000-row cap, the way the real server does.
 */
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";

export interface PagedClient {
  from(table: string): {
    select(columns: string): {
      order(column: string): { range(from: number, to: number): PageQuery<unknown> };
    };
  };
}

/** Every row of `table` (this tenant, via RLS), `columns` only, paged past the 1000-row cap. */
export async function readAllRows<Row>(client: PagedClient, table: string, columns: string): Promise<Row[]> {
  const rows = await fetchAllRows<unknown>((from, to) => client.from(table).select(columns).order("id").range(from, to));
  return rows as Row[];
}

export type ExistingCustomerRow = { id: string; name: string; customer_number: string | null; domain?: string | null; contact_email?: string | null };

/** Lower-cased, trimmed customer numbers and emails already on file — the customer import's duplicate keys. */
export function existingCustomerKeys(rows: readonly Pick<ExistingCustomerRow, "customer_number" | "contact_email">[]): { nums: Set<string>; emails: Set<string> } {
  const nums = new Set<string>();
  const emails = new Set<string>();
  for (const c of rows) {
    if (c.customer_number) nums.add(c.customer_number.trim().toLowerCase());
    if (c.contact_email) emails.add(c.contact_email.trim().toLowerCase());
  }
  return { nums, emails };
}
