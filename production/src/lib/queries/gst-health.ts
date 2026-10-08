/**
 * Run the GST audit over the invoices that have actually been issued.
 *
 * ─── GROUPED BY CUSTOMER, NOT BY INVOICE ────────────────────────────────────
 * The findings that matter are almost always properties of a CUSTOMER — no state on
 * record, a GSTIN that is not a GSTIN — and one such customer had three invoices. Listing
 * them per invoice shows the same problem three times and the same fix three times, which
 * makes a nine-customer problem look like a thirteen-item chore and buries how few actions
 * are really needed. Fix the customer once and every one of their findings clears.
 *
 * ─── AND THE RUPEES ARE COUNTED ONCE ────────────────────────────────────────
 * Per invoice, at its worst finding. An invoice with a bad GSTIN AND an unknown place of
 * supply does not put its tax at risk twice. A total that overstates itself is one nobody
 * believes the second time they read it.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { auditInvoiceGst, type GstIssue } from "@/lib/gst/mismatch";
import { fetchAllRows } from "@/lib/ops/fetch-all";

export interface CustomerGstFindings {
  customerId: string | null;
  customerName: string;
  invoiceCount: number;
  /** Deduplicated across this customer's invoices — the same finding repeated is one fix. */
  issues: GstIssue[];
  /** Sum over this customer's invoices of each invoice's single worst exposure. */
  atRisk: number;
}

export interface GstHealth {
  customers: CustomerGstFindings[];
  invoicesChecked: number;
  invoicesWithIssues: number;
  totalAtRisk: number;
}

export function useGstHealth() {
  return useQuery({
    queryKey: ["gst-health"],
    queryFn: async (): Promise<GstHealth> => {
      const supabase = createClient();

      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", auth.user.id).single();
      if (meErr) throw meErr;

      /* The seller side comes from the tenant, not from a constant: the place of supply is
         decided by comparing two states, and hard-coding ours would make this silently
         wrong for every other tenant on the platform. */
      const { data: tenant } = await supabase
        .from("tenants").select("state_code, gstin").eq("id", me!.tenant_id).single();

      /* R-265: every invoice and customer, paged on `id` — a bare select stops at
         PostgREST's 1000-row cap, so the audit checked only the first 1000 invoices and a
         customer past row 1000 looked like "no state on record". A failed page throws
         instead of reading as an empty customer list. */
      const [invoices, customers] = await Promise.all([
        fetchAllRows((a, b) => supabase.from("invoices")
          .select("id, customer_id, taxable_value, tax_amount, tax_rate, inter_state")
          .order("id").range(a, b)),
        fetchAllRows((a, b) => supabase.from("customers")
          .select("id, name, state_code, gstin, country")
          .order("id").range(a, b)),
      ]);

      const byId = new Map(customers.map((c) => [c.id, c]));
      const seller = { stateCode: tenant?.state_code, gstin: tenant?.gstin, country: "India" };

      const grouped = new Map<string, CustomerGstFindings>();
      let invoicesWithIssues = 0;
      let totalAtRisk = 0;

      for (const inv of invoices) {
        const customer = inv.customer_id ? byId.get(inv.customer_id) : undefined;
        const issues = auditInvoiceGst(
          {
            taxableValue: inv.taxable_value ?? 0,
            taxAmount: inv.tax_amount ?? 0,
            taxRate: inv.tax_rate ?? 0,
            interState: Boolean(inv.inter_state),
          },
          {
            stateCode: customer?.state_code,
            gstin: customer?.gstin,
            country: customer?.country,
          },
          seller,
        );
        if (issues.length === 0) continue;

        invoicesWithIssues += 1;
        const worst = issues.reduce((m, i) => Math.max(m, i.amountAtRisk ?? 0), 0);
        totalAtRisk += worst;

        const key = inv.customer_id ?? `__none__${inv.id}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.invoiceCount += 1;
          existing.atRisk += worst;
          /* Same code = same fix. Keep one copy so the list reads as work, not as volume. */
          for (const i of issues) {
            if (!existing.issues.some((e) => e.code === i.code)) existing.issues.push(i);
          }
        } else {
          grouped.set(key, {
            customerId: inv.customer_id ?? null,
            customerName: customer?.name ?? "(no customer on the invoice)",
            invoiceCount: 1,
            issues: [...issues],
            atRisk: worst,
          });
        }
      }

      return {
        customers: [...grouped.values()].sort((a, b) => b.atRisk - a.atRisk),
        invoicesChecked: invoices.length,
        invoicesWithIssues,
        totalAtRisk,
      };
    },
    /* Invoices and customer records change by the hour, not the minute. */
    staleTime: 60_000,
  });
}
