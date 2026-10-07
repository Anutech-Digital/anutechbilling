/**
 * Customer Aging — outstanding receivables bucketed by days overdue.
 *
 * Buckets (from invoice date):
 *   • Current      0–30 days
 *   • 31–60 days
 *   • 61–90 days
 *   • 90+ days     (worst)
 *
 * Per customer: shows outstanding in each bucket + total + days of oldest
 * invoice. Sorted by total outstanding descending so the biggest exposure
 * is at the top.
 *
 * Inline WhatsApp / Email actions per customer for quick follow-up.
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { AGING_BUCKETS } from "@/lib/navigation/drilldown";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { primaryContactsFor } from "@/lib/contacts/primary";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { MsmePayablesCard } from "@/components/features/accounting/msme-payables-card";
import { useCreditSummary } from "@/lib/credit/queries";

// ────────────────────────────────────────────────────────────────
// Aggregation hook
// ────────────────────────────────────────────────────────────────

interface CustomerAgingRow {
  customerId:      string | null;
  customerName:    string;
  contactEmail:    string | null;
  contactPhone:    string | null;
  buckets:         { current: number; b30: number; b60: number; b90: number; over90: number };
  total:           number;
  oldestDays:      number;
  oldestInvoiceId: string | null;
}

interface AgingTotals {
  current: number;
  b30:     number;
  b60:     number;
  b90:     number;
  over90:  number;
  total:   number;
}

function daysBetween(from: string, to: Date): number {
  const f = new Date(from + "T00:00:00Z");
  return Math.floor((to.getTime() - f.getTime()) / (24 * 60 * 60 * 1000));
}

function useAging() {
  return useQuery({
    queryKey: ["accounting", "aging"],
    queryFn: async (): Promise<{ rows: CustomerAgingRow[]; totals: AgingTotals }> => {
      const supabase = createClient();

      // Unpaid / partially-paid invoices = the outstanding pool.
      // We use `net_payable` when present (= amount − adjusted advances)
      // otherwise fall back to `amount`. Invoices already 'paid' or 'void'
      // are excluded.
      const { data: invoices, error: invErr } = await supabase
        .from("invoices")
        .select("id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date")
        .in("status", ["pending", "overdue"]);
      if (invErr) throw invErr;

      // Pull customer contact info so the row can offer WhatsApp / email.
      const customerIds = Array.from(
        new Set((invoices ?? []).map((i) => i.customer_id).filter((x): x is string => !!x)),
      );
      /* The PRIMARY CONTACT, not customers.contact_*. Those columns stopped being the
         truth on 10 Sep 2026 — a customer's people live in `contacts`, one marked
         primary. One batched lookup, so a report over 200 customers stays one query. */
      const contactsByCustomerId = new Map<string, { email: string | null; phone: string | null }>();
      if (customerIds.length > 0) {
        const primaries = await primaryContactsFor(supabase, customerIds);
        for (const [id, p] of primaries) {
          contactsByCustomerId.set(id, { email: p.email, phone: p.phone });
        }
      }

      const today = new Date();
      const grouped = new Map<string, CustomerAgingRow>();

      for (const inv of invoices ?? []) {
        /* What is still owed — net of advances AND of receipts since. Until 2 Oct 2026 this
           was net_payable ?? amount, so a half-paid invoice aged at its full value here
           while /invoices showed the balance (lib/invoices/kpis.ts#invoiceBalance). */
        const owed = invoiceBalance({ ...inv, amount: inv.amount ?? 0 });
        if (owed <= 0) continue;

        const days     = daysBetween(inv.invoice_date, today);
        const key      = inv.customer_id ?? inv.customer_name ?? "unknown";
        const contact  = inv.customer_id ? contactsByCustomerId.get(inv.customer_id) : null;

        let row = grouped.get(key);
        if (!row) {
          row = {
            customerId:      inv.customer_id ?? null,
            customerName:    inv.customer_name ?? "—",
            contactEmail:    contact?.email ?? null,
            contactPhone:    contact?.phone ?? null,
            buckets:         { current: 0, b30: 0, b60: 0, b90: 0, over90: 0 },
            total:           0,
            oldestDays:      0,
            oldestInvoiceId: null,
          };
          grouped.set(key, row);
        }

        // Bucket assignment by days since invoice date
        if      (days <=  30) row.buckets.current += owed;
        else if (days <=  60) row.buckets.b30     += owed;
        else if (days <=  90) row.buckets.b60     += owed;
        else                  row.buckets.over90  += owed;

        row.total += owed;
        if (days > row.oldestDays) {
          row.oldestDays      = days;
          row.oldestInvoiceId = inv.id;
        }
      }

      const rows = Array.from(grouped.values()).sort((a, b) => b.total - a.total);

      const totals: AgingTotals = {
        current: 0, b30: 0, b60: 0, b90: 0, over90: 0, total: 0,
      };
      for (const r of rows) {
        totals.current += r.buckets.current;
        totals.b30     += r.buckets.b30;
        totals.b60     += r.buckets.b60;
        totals.b90     += r.buckets.b90;
        totals.over90  += r.buckets.over90;
        totals.total   += r.total;
      }

      return { rows, totals };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

function whatsappLink(phone: string, message: string): string {
  // Strip +, spaces, dashes
  const clean = phone.replace(/[^0-9]/g, "");
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
}

export default function AgingPage() {
  const { data, isLoading, isError, refetch } = useAging();
  /* R-346: subscriptions switched on before payment ("Activate now, pay later"). */
  const { data: credit } = useCreditSummary();
  /* R-270: on a failed load the tiles used to read ₹0 and the table "No outstanding
     receivables. Nice." — the opposite of the truth when money is owed. */
  const failed = isError && !data;
  const { data: me } = useCurrentUser();
  // Reminder messages are sent FROM this reseller — use their own business name,
  // never a hardcoded one (this is multi-tenant; another reseller must not send
  // messages branded with someone else's company).
  const bizName = me?.tenantName ?? "us";
  const allRows = data?.rows  ?? [];
  /* R-118: a bucket tile opens the customers with money in that bucket. */
  const [bucket, setBucket] = useUrlChoice<"" | "current" | "b30" | "b60" | "over90">("bucket", AGING_BUCKETS, "");
  const rows   = bucket ? allRows.filter((r) => r.buckets[bucket] > 0) : allRows;
  const totals = data?.totals ?? { current: 0, b30: 0, b60: 0, b90: 0, over90: 0, total: 0 };

  const overdueRupees = totals.b30 + totals.b60 + totals.b90 + totals.over90;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Customer Aging</h1>
          <p className="text-sm text-ink-3 mt-1">
            Who owes you money, and for how long. Sorted by largest exposure.
          </p>
        </div>
      </div>

      {/* KPI strip */}
      {!failed && (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-6">
        <KPI label="Total outstanding" value={rupee(totals.total)} tone={totals.total > 0 ? "rose" : undefined} big onClick={() => setBucket("")} active={bucket === ""} />
        <KPI label="Current (0–30 days)" value={rupee(totals.current)} onClick={() => setBucket("current")} active={bucket === "current"} />
        <KPI label="31–60 days"          value={rupee(totals.b30)}     tone={totals.b30 > 0 ? "amber" : undefined} onClick={() => setBucket("b30")} active={bucket === "b30"} />
        <KPI label="61–90 days"          value={rupee(totals.b60)}     tone={totals.b60 > 0 ? "amber" : undefined} onClick={() => setBucket("b60")} active={bucket === "b60"} />
        <KPI label="90+ days"            value={rupee(totals.over90)}  tone={totals.over90 > 0 ? "rose" : undefined} onClick={() => setBucket("over90")} active={bucket === "over90"} />
      </div>
      )}

      {totals.total > 0 && overdueRupees > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <div className="text-sm text-ink-2 leading-relaxed">
            <Icon name="alert" size={16} className="text-rose inline mr-1.5 align-text-bottom" />
            <b>{rupee(overdueRupees)}</b> is overdue (31+ days). Healthy SME accounts
            receivable should be {totals.total > 0 ? Math.round((totals.current / totals.total) * 100) : 0}%+ in
            the &quot;Current&quot; bucket — chase the 31+ day rows below.
          </div>
        </Card>
      )}

      {/* R-346: what is live on credit and not yet paid. Hidden when there is none (or before
          the database update), so it never reads as a zero that means "unknown". */}
      {credit && credit.subscriptions > 0 && (
        <Card className="p-4 mb-6 border-amber/50 bg-amber-soft/40">
          <p className="text-sm text-ink-2">
            <Icon name="clock" size={16} className="text-amber-ink inline mr-1.5 align-text-bottom" />
            Subscriptions running on credit: <b>{credit.subscriptions}</b> · <b>{rupee(credit.amountDue)}</b> due.
            {" "}Their reminders are tasks for the owner; nothing is suspended automatically.
          </p>
        </Card>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : failed ? (
        <LoadError what="Customer aging" onRetry={() => { void refetch(); }} />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="check_circle"
            title="No outstanding receivables"
            body="Every invoice is either paid in full or hasn't been issued. Nice."
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Customer</th>
                  <th className="text-right px-4 py-3">Current</th>
                  <th className="text-right px-4 py-3">31–60</th>
                  <th className="text-right px-4 py-3">61–90</th>
                  <th className="text-right px-4 py-3">90+</th>
                  <th className="text-right px-4 py-3">Total</th>
                  <th className="text-left  px-4 py-3">Oldest</th>
                  <th className="text-right px-4 py-3">Follow up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr key={r.customerId ?? r.customerName} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{r.customerName}</div>
                      {(r.contactEmail || r.contactPhone) && (
                        <div className="text-xs text-ink-3 mt-0.5">
                          {r.contactEmail ?? r.contactPhone}
                        </div>
                      )}
                    </td>
                    <Cell value={r.buckets.current} />
                    <Cell value={r.buckets.b30}     tone={r.buckets.b30    > 0 ? "amber" : undefined} />
                    <Cell value={r.buckets.b60}     tone={r.buckets.b60    > 0 ? "amber" : undefined} />
                    <Cell value={r.buckets.over90}  tone={r.buckets.over90 > 0 ? "rose"  : undefined} />
                    <td className="px-4 py-3 text-right">
                      <div className="font-semibold text-ink font-mono">{rupee(r.total)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge color={r.oldestDays > 90 ? "rose" : r.oldestDays > 30 ? "amber" : "slate"}>
                        {r.oldestDays} days
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {r.contactPhone && (
                        <a
                          href={whatsappLink(r.contactPhone,
                            `Hi from ${bizName} — just a reminder that ${rupee(r.total)} is pending on your account. Could you let me know when payment will reach us?`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald hover:underline mr-2"
                        >
                          <Icon name="whatsapp" size={12} /> WA
                        </a>
                      )}
                      {r.contactEmail && (
                        <a
                          href={`mailto:${r.contactEmail}?subject=${encodeURIComponent(`Payment reminder — ${rupee(r.total)} outstanding`)}`}
                          className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
                        >
                          <Icon name="mail" size={12} /> Email
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{rupee(totals.current)}</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-ink">{rupee(totals.b30)}</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-ink">{rupee(totals.b60)}</td>
                  <td className="px-4 py-3 text-right font-mono text-rose">{rupee(totals.over90)}</td>
                  <td className="px-4 py-3 text-right font-serif text-lg text-ink">{rupee(totals.total)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </Card>

          {/* Mobile card list */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((r) => (
              <li key={r.customerId ?? r.customerName}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="font-medium text-ink leading-tight">{r.customerName}</div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(r.total)}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-xs mb-3">
                    <Mini label="Current" value={r.buckets.current} />
                    <Mini label="31–60"   value={r.buckets.b30}    tone={r.buckets.b30   > 0 ? "amber" : undefined} />
                    <Mini label="61–90"   value={r.buckets.b60}    tone={r.buckets.b60   > 0 ? "amber" : undefined} />
                    <Mini label="90+"     value={r.buckets.over90} tone={r.buckets.over90 > 0 ? "rose" : undefined} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge color={r.oldestDays > 90 ? "rose" : r.oldestDays > 30 ? "amber" : "slate"}>
                      {r.oldestDays} days old
                    </Badge>
                    <div className="flex gap-2">
                      {r.contactPhone && (
                        <a
                          href={whatsappLink(r.contactPhone,
                            `Hi from ${bizName} — ${rupee(r.total)} is pending on your account. When can we expect the payment?`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-paper"
                          style={{ background: "#25D366" }}
                        >
                          <Icon name="whatsapp" size={12} /> WhatsApp
                        </a>
                      )}
                      {r.contactEmail && (
                        <a
                          href={`mailto:${r.contactEmail}?subject=${encodeURIComponent(`Payment reminder — ${rupee(r.total)} outstanding`)}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-hairline text-ink-2"
                        >
                          <Icon name="mail" size={12} /> Email
                        </a>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Payables side: MSME vendors ka 45-din (s.43B(h)) flag — S33. */}
      <MsmePayablesCard />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Cell + Mini primitives
// ────────────────────────────────────────────────────────────────

function Cell({ value, tone }: { value: number; tone?: "amber" | "rose" }) {
  const colorClass = tone === "rose" ? "text-rose"
                   : tone === "amber" ? "text-amber-ink"
                   : "text-ink-2";
  return (
    <td className={`px-4 py-3 text-right font-mono ${colorClass}`}>
      {value > 0 ? rupee(value) : "—"}
    </td>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone?: "amber" | "rose" }) {
  const colorClass = tone === "rose" ? "text-rose"
                   : tone === "amber" ? "text-amber-ink"
                   : "text-ink-3";
  return (
    <div className="rounded-md border border-hairline p-1.5 text-center bg-paper">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold leading-none mb-0.5">{label}</div>
      <div className={`font-mono leading-none ${colorClass}`}>{value > 0 ? rupee(value) : "—"}</div>
    </div>
  );
}

function KPI({
  label, value, tone, big, onClick, active,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
  big?: boolean;
  /** R-118: show only the customers with money in this bucket. */
  onClick?: () => void;
  active?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  const body = (<>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-2xl md:text-3xl" : "text-xl md:text-2xl"} ${colorClass} leading-tight`}>
        {value}
      </div>
</>);
  if (!onClick) return <Card className="p-3 md:p-4">{body}</Card>;
  return (
    <button type="button" onClick={onClick} aria-pressed={active ?? undefined}
      className={`text-left rounded-lg border bg-paper p-3 md:p-4 transition-colors hover:border-amber/60 ${active ? "border-amber" : "border-hairline"}`}>
      {body}
    </button>
  );
}
