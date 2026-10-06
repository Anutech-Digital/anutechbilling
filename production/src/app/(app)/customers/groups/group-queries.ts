/**
 * R-222 — Parent accounts pages read only what they show (tester, 6 Oct: ~29 s to open).
 *
 * WHY: both pages called useCustomers() — `select *` of EVERY customer, paged past 1000 —
 * and the detail page also useSubscriptions(), `select *` of every subscription. The list
 * page needs one number per group (how many companies); the detail page needs one group's
 * companies and their active MRR. Reading the whole book to show a handful of cards is what
 * made the page slow, and it grows with the business, not with the number of groups.
 *
 * Now (no per-group query — the request count does not grow with the number of groups):
 *   - list:   ONE slim read of `customers.group_id` for grouped customers only, counted here;
 *   - detail: the group's own customers (`group_id = id`), and `customer_id, mrr` of their
 *             ACTIVE subscriptions only (`in` chunks of IN_CHUNK ids).
 * Keys sit under ["customers"] / ["subscriptions"] so the existing mutations' invalidations
 * (assign a group, edit a customer, change a subscription) still refresh them.
 * Receivables keep useOutstandingReceivables() — that is money logic with one home.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Customer } from "@/lib/supabase/database.types";
import { fetchAllRows, fetchAllRowsIn, idsKey } from "@/lib/ops/fetch-all";

type Client = ReturnType<typeof createClient>;

/** group id → how many customers sit in it. Customers with no group are not read at all. */
export async function fetchGroupMemberCounts(supabase: Client): Promise<Map<string, number>> {
  const rows = await fetchAllRows<{ group_id: string | null }>((from, to) =>
    supabase
      .from("customers")
      .select("group_id")
      .not("group_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to));
  const map = new Map<string, number>();
  for (const r of rows) if (r.group_id) map.set(r.group_id, (map.get(r.group_id) ?? 0) + 1);
  return map;
}

export function useGroupMemberCounts() {
  return useQuery({
    queryKey: ["customers", "group-member-counts"],
    queryFn: () => fetchGroupMemberCounts(createClient()),
  });
}

/** One group's companies, A–Z (the order the page showed when it filtered the full list). */
export async function fetchGroupMembers(supabase: Client, groupId: string): Promise<Customer[]> {
  return fetchAllRows<Customer>((from, to) =>
    supabase
      .from("customers")
      .select("*")
      .eq("group_id", groupId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to));
}

export function useGroupMembers(groupId: string | undefined) {
  return useQuery({
    queryKey: ["customers", "group-members", groupId],
    enabled: !!groupId,
    queryFn: () => fetchGroupMembers(createClient(), groupId!),
  });
}

/** customer id → summed MRR (₹) of that customer's ACTIVE subscriptions — members only. */
export async function fetchMembersMrr(supabase: Client, customerIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await fetchAllRowsIn<{ customer_id: string | null; mrr: number | null }, string>(
    customerIds,
    (ids, from, to) =>
      supabase
        .from("subscriptions")
        .select("customer_id, mrr")
        .eq("status", "active")
        .in("customer_id", ids)
        .order("id", { ascending: true })
        .range(from, to),
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.customer_id) continue;
    map.set(r.customer_id, (map.get(r.customer_id) ?? 0) + (r.mrr ?? 0));
  }
  return map;
}

export function useMembersMrr(customerIds: readonly string[] | undefined) {
  const ids = idsKey(customerIds ?? []);
  return useQuery({
    queryKey: ["subscriptions", "group-members-mrr", ids],
    enabled: customerIds !== undefined,
    queryFn: () => fetchMembersMrr(createClient(), ids),
  });
}
