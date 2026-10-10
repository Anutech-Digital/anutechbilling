/**
 * Customers — TanStack Query hooks.
 */
"use client";

import * as React from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { attachPrimaryContact } from "@/lib/contacts/attach";
import { requireTenantId } from "@/lib/queries/require-tenant";
import type { Customer, Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { missingInvoiceState, withStateCode } from "@/lib/gst/gstin-state";
import { flattenPages } from "@/lib/queries/keyset";

type CustomerInsert = Database["public"]["Tables"]["customers"]["Insert"];
type CustomerUpdate = Database["public"]["Tables"]["customers"]["Update"];

// ============================================================
// List
// ============================================================
type Client = ReturnType<typeof createClient>;

/** Every customer, A–Z — the full list. Also the Customers page's CSV export (R-210). */
export async function fetchAllCustomers(supabase: Client): Promise<Customer[]> {
  // Removed 2026-08-13 — same dead hardcoded-tenant fallback as leads.ts.
  // RLS (verified on prod: enabled on `customers`, 5 policies) filters the
  // retry identically, so it could never return a row the first query didn't.
  /* R-046: PostgREST answers at most 1000 rows (supabase/config.toml max_rows) and says
     NOTHING when it cut the answer short. At 1001 customers this list silently lost the
     rest — no error, no warning, just a page that looks complete and is not. That is
     the worst shape a data bug takes (AGENTS.md §2).

     fetchAllRows pages until a short page comes back. The order ENDS ON id because an
     offset page over an order with ties can repeat or skip a row across a page
     boundary — see the helper header; name alone is not a total order. */
  return await fetchAllRows<Customer>((from, to) =>
    supabase
      .from("customers")
      .select("*")
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to));
}

export function useCustomers(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["customers"],
    /* R-210: the Customers page turns this off while its paged read is showing. Every
       other caller passes nothing and gets the whole list, as before. */
    enabled: opts.enabled ?? true,
    queryFn: async (): Promise<Customer[]> => fetchAllCustomers(createClient()),
  });
}

// ============================================================
// Customers page — server pages (R-210, part of R-064)
// ============================================================
/* The page's default screen (view All, newest first) reads 50 rows at a time with the
   search and the archived switch in the query and an exact total, instead of every
   customer. Which screens use it: app/(app)/customers/server-list.ts#customerListMode. */

export const CUSTOMERS_PAGE_SIZE = 50;

/** The columns the page's search box reads on the customer row itself (R-467: + contact_phone — the box says "phone"). */
export const CUSTOMER_SEARCH_COLUMNS = ["name", "display_name", "domain", "contact_name", "contact_email", "contact_phone"] as const;

export interface CustomerPageFilters {
  /** Free text, as typed. Trimmed and lower-cased here. */
  search: string;
  /** true = only archived (is_active false); false = everything else. */
  archived: boolean;
  /** Customers whose PEOPLE match the search (contact link table) — they match too. */
  contactIds?: readonly string[] | null;
}

/**
 * The PostgREST `or=(…)` for the search box, or null when there is no search.
 *
 * Same test as the page's in-browser search: any of CUSTOMER_SEARCH_COLUMNS contains the
 * text (case-insensitive), or the customer is one a matching person is on. The value is
 * double-quoted so a comma or bracket the user typed cannot split the filter; the LIKE
 * wildcards `%` `*` and the quoting characters `"` `\` are dropped from it rather than
 * escaped (an escape inside a quoted or-value is itself unescaped by PostgREST, so it is
 * not dependable). `_` stays — it can only widen a match, never hide a row.
 */
export function customerSearchOr(search: string, contactIds?: readonly string[] | null): string | null {
  const s = search.trim().toLowerCase().replace(/[%*"\\]/g, "");
  if (!s) return null;
  const pat = `"%${s}%"`;
  const parts: string[] = CUSTOMER_SEARCH_COLUMNS.map((c) => `${c}.ilike.${pat}`);
  const ids = [...new Set(contactIds ?? [])];
  if (ids.length > 0) parts.push(`id.in.(${ids.join(",")})`);
  return parts.join(",");
}

export interface CustomerPage { rows: Customer[]; total: number }

/**
 * One page of the Customers list: `limit` rows from `from`, plus the exact total for the
 * same filters. Newest first with nulls last, then A–Z, then id — the order the page's
 * newestFirst() gave the full list (stable sort over an A–Z read), ending on a unique
 * column so an offset page never repeats or skips a row.
 */
export async function fetchCustomersPage(
  supabase: Client, f: CustomerPageFilters, from: number, limit = CUSTOMERS_PAGE_SIZE,
): Promise<CustomerPage> {
  let q = supabase.from("customers").select("*", { count: "exact" });
  q = f.archived ? q.eq("is_active", false) : q.not("is_active", "is", false);
  const or = customerSearchOr(f.search, f.contactIds);
  if (or) q = q.or(or);
  const { data, error, count } = await q
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + limit - 1);
  if (error) throw error;
  const rows = (data ?? []) as Customer[];
  return { rows, total: count ?? from + rows.length };
}

/** Where the next page starts, or undefined when the list is complete. */
export function nextCustomerPageFrom(
  last: CustomerPage, pages: readonly CustomerPage[], limit = CUSTOMERS_PAGE_SIZE,
): number | undefined {
  const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
  if (last.rows.length < limit || loaded >= last.total) return undefined;
  return loaded;
}

export function useCustomersPaged(f: CustomerPageFilters, opts: { enabled?: boolean } = {}) {
  const key: CustomerPageFilters = {
    search: f.search.trim().toLowerCase(),
    archived: f.archived,
    contactIds: [...new Set(f.contactIds ?? [])].sort(),
  };
  const q = useInfiniteQuery({
    /* Under ["customers"], so every customer mutation's invalidation reaches it. */
    queryKey: ["customers", "paged", key],
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchCustomersPage(createClient(), key, pageParam),
    getNextPageParam: (last, pages) => nextCustomerPageFrom(last, pages),
  });
  const rows = React.useMemo(
    () => (q.data ? flattenPages(q.data.pages, (c) => c.id) : undefined),
    [q.data],
  );
  const pages = q.data?.pages;
  const total = pages && pages.length > 0 ? pages[pages.length - 1].total : undefined;
  return { ...q, rows, total };
}

export interface CustomerListCounts {
  /** Every customer, active + archived — the "All" chip. */
  all: number;
  /** Archived only (is_active false). */
  archived: number;
  /** Customers a tax invoice would refuse for having no state (missingInvoiceState). */
  noStateIds: string[];
}

/**
 * The numbers the page used to count over every customer row: two exact server counts,
 * and the few customers with no state code (read slim, then tested with the same
 * missingInvoiceState the invoice uses — so a country spelled "India " is judged exactly
 * as generate_invoice judges it).
 */
export async function fetchCustomerListCounts(supabase: Client): Promise<CustomerListCounts> {
  const [allRes, archRes, blank] = await Promise.all([
    supabase.from("customers").select("id", { count: "exact", head: true }),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("is_active", false),
    fetchAllRows<{ id: string; state_code: string | null; country: string | null }>((from, to) =>
      supabase
        .from("customers")
        .select("id, state_code, country")
        .or("state_code.is.null,state_code.eq.")
        .order("id", { ascending: true })
        .range(from, to)),
  ]);
  if (allRes.error) throw allRes.error;
  if (archRes.error) throw archRes.error;
  return {
    all: allRes.count ?? 0,
    archived: archRes.count ?? 0,
    noStateIds: blank.filter((c) => missingInvoiceState(c)).map((c) => c.id),
  };
}

export function useCustomerListCounts() {
  return useQuery({
    queryKey: ["customers", "list-counts"],
    queryFn: () => fetchCustomerListCounts(createClient()),
  });
}

// ============================================================
// Single
// ============================================================
export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: ["customers", id],
    enabled: !!id,
    queryFn: async (): Promise<Customer | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) {
        console.warn("Supabase customer query warning:", error.message);
        return null;
      }
      return data;
    },
  });
}

// ============================================================
// Create — fetches current tenant_id automatically
// ============================================================
export function useCreateCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: Omit<CustomerInsert, "tenant_id">) => {
      const supabase = createClient();

      /* R-001, Pardeep 2026-09-25. This used to default to the seed tenant
         "11111111-..." and only replace it if BOTH the auth call and the users read
         succeeded — so a signed-out session, an expired one, or a blip on that one
         query put a real customer into the demo company and said "Customer added".
         Banking -> Reconcile invoices whatever this returns, so that customer became a
         bank receipt nobody could ever match. It refuses now. */
      const tenantId = await requireTenantId(supabase);

      /* ── A NEW CUSTOMER MUST HAVE A PERSON ON IT ──────────────────────────
         Abhishek's rule, 18 Sep 2026: "without contact customer not created". Checked
         before the insert, so the refusal costs nothing to undo. The form asks for this
         too, but the form is one caller and this is the door every caller goes through. */
      const personName = (input.contact_name ?? "").trim();
      if (!personName) {
        throw new Error(
          "A contact person is required before a customer can be created. Fill in the contact's name, email and phone on the Contact Person section, then save again.",
        );
      }

      const { data, error } = await supabase
        .from("customers")
        // withStateCode: a hand-picked state must reach state_code, or generate_invoice refuses.
        .insert(withStateCode({ ...input, tenant_id: tenantId }))
        .select()
        .single();

      /* R-001 again, the other half. This used to swallow the error, build a
         `CUST-<timestamp>` customer out of the form values, push it into the list cache
         and return it as a success. The screen then showed a customer that was never
         saved; anything done with that id — invoice, reconcile, subscription — failed
         later with an error naming a row that does not exist.

         AGENTS.md §2: never turn a failure into a plausible value. The insert's own
         reason is what the operator needs, so it travels straight to the toast. */
      if (error) throw new Error(error.message);
      if (!data) {
        throw new Error(
          "The customer was not saved and the database gave no reason. Check your connection and try again — nothing was created.",
        );
      }

      /* ── The new customer's mandatory PRIMARY CONTACT ─────────────────────
         Since 10 Sep 2026 a customer's people live in `contacts`; since 18 Sep the
         relationship lives in `customer_contacts`, and that is the ONLY table the
         invoice and dunning recipient lookup reads. This used to write a `contacts` row
         with `customer_id` set and no link — which looked right on the customer page and
         was invisible to every path that sends money-related email.

         `attachPrimaryContact` is the same writer the Add Subscription dialog uses, so
         the two doors into "a customer exists" cannot drift apart again.

         NOT best-effort any more. It used to warn and keep the customer, which is exactly
         how a customer reaches the books with nobody to invoice. If the contact cannot be
         written the customer is DELETED — it was created milliseconds ago by this same
         call, nothing references it yet, so removing it leaves the books untouched. */
      {
        const outcome = await attachPrimaryContact(supabase, {
          tenantId,
          customerId: data.id,
          name: personName,
          email: input.contact_email ?? null,
          phone: input.contact_phone ?? null,
          role: "poc",
          company: input.name ?? null,
        });
        if (outcome.kind === "failed") {
          const { error: undoErr } = await supabase
            .from("customers").delete().eq("id", data.id);
          throw new Error(
            undoErr
              ? `${outcome.reason} The customer was created but could not be removed — open "${input.name ?? personName}" and add a contact to it.`
              : `${outcome.reason} The customer was not created. Fix the contact details and save again.`,
          );
        }
      }

      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Customer added");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Update
// ============================================================
export function useUpdateCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: CustomerUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers")
        .update(withStateCode(patch))
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", data.id] });
      toast.success("Customer updated");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Delete — guarded via the delete_customer RPC. The RPC refuses to delete a
// customer that still has subscriptions / payments / invoices (money history);
// only "empty" customers can be removed. See src/lib/customers/deletable.ts
// for the client-side twin used to disable the delete control.
// ============================================================
export { customerDeleteBlockReason } from "@/lib/customers/deletable";

export function useDeleteCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_customer", { p_customer_id: id });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer deleted");
    },
    onError: (err) => toastError(err),
  });
}

/** Archive / reactivate a customer (Zoho-style "Mark as Inactive"). Flips the
 *  is_active flag only — never touches invoices/payments/GST records. Reversible.
 *  This is the right action for a customer that can't be deleted (has money
 *  history) but is no longer doing business with us. */
export function useSetCustomerActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const supabase = createClient();
      const { error } = await supabase.from("customers").update({ is_active: isActive }).eq("id", id);
      if (error) throw error;
      return { id, isActive };
    },
    onSuccess: ({ id, isActive }) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", id] });
      toast.success(isActive ? "Customer reactivated" : "Customer archived — hidden from the active list");
    },
    onError: (err) => toastError(err),
  });
}

/** Total OPEN advance credit (₹) this customer holds — from earlier overpayments.
 *  Adjust it against their next bill in the record-payment sheet. */
export function useCustomerOpenCredit(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customer_credits", "open-total", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_credits").select("amount").eq("customer_id", customerId!).eq("status", "open");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
    },
    staleTime: 30_000,
  });
}

/** Total OPEN advance credit (₹) per customer, across the whole tenant — for the
 *  customers list "Unused credits" column. RLS scopes the read to this tenant. */
export function useOpenCreditsByCustomer() {
  return useQuery({
    queryKey: ["customer_credits", "open-by-customer"],
    queryFn: async (): Promise<Record<string, number>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_credits").select("customer_id, amount").eq("status", "open");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of data ?? []) {
        if (!r.customer_id) continue;
        map[r.customer_id] = (map[r.customer_id] ?? 0) + (r.amount ?? 0);
      }
      return map;
    },
    staleTime: 30_000,
  });
}
