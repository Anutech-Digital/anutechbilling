"use client";
/**
 * R-2838 (Renewals history H3 — Pardeep 15 Nov: "quote/invoice/payment history ka pop-up"; audit
 * RENEWALS-AUDIT/audit-2026-11-15-history.md §5): the drawer's ONE History section, right under the header.
 * It replaced "Quotes & invoices" + "Payments" (two long lists, payments far below, a quote's receipt
 * listed again under its second invoice). Rules: ./drawer-history.ts historyTabs (R-2836).
 *
 *   strip     Last quote · Last invoice · Last paid (the card asks for it — the one-line answer on top)
 *   tabs      All · Quotes · Invoices · Payments (counts) — the shared Radix tabs (components/ui/tabs):
 *             arrows / Home / End move and select, one tab in the Tab order
 *   All       documents newest first, each invoice with the payments that went to it; money not
 *             against an invoice yet in one group at the top
 *   Payments  each receipt once at its full amount, "for <invoice> · <period it covers>" (ids linked)
 *   Timeline  (R-2844, H9) everything on one list, newest first: quotes, invoices
 *             raised, payments, follow-ups logged (calls, promises) and reminders sent — drawer-history.ts
 *             historyTimeline; the other tabs are its filters
 *   R-2857    the five tabs stay on one line in the drawer (compact padding / count)
 *   footer    "All history for <customer> →" = the customer page's Transactions → Payments (R-2837)
 */
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatDate } from "@/lib/utils";
import { PaymentTdsLine } from "@/components/features/customers/payment-tds-line";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { drawerPage } from "./drawer";
import type { DrawerFollowupRow } from "./drawer";
import type { HistoryPaymentLine, HistoryRow, HistoryTab, HistoryTabs, TimelineItem } from "./drawer-history";
import type { DocTone } from "./last-docs";
import type { DrawerReminderRow } from "./reminder-log";

type SectionTab = HistoryTab | "timeline";

const TABS: readonly { key: SectionTab; label: string; empty: string }[] = [
  { key: "all", label: "All", empty: "No quotes, invoices or payments yet." },
  { key: "quotes", label: "Quotes", empty: "No quotes yet." },
  { key: "invoices", label: "Invoices", empty: "No invoices yet." },
  { key: "payments", label: "Payments", empty: "No payment recorded in the app for this subscription." },
  { key: "timeline", label: "Timeline", empty: "Nothing has happened on this renewal yet." },
];

const TONE: Record<DocTone, string> = {
  ok: "text-emerald",
  warn: "font-medium text-ink",
  danger: "font-medium text-rose-600",
  muted: "text-ink-3",
};

/** The customer page's Transactions → Payments (R-2837 reads ?tab= / ?show=). */
export function customerHistoryHref(customerId: string): string {
  return `/customers/${encodeURIComponent(customerId)}?tab=transactions&show=payments`;
}

/**
 * The strip's three facts; null = "None yet". Last paid = the newest receipt; only when there is none,
 * money on an invoice with no receipt (R-2818 — those lines carry no date, so they cannot be ordered).
 */
export function historyLastFacts(t: HistoryTabs): { quote: string | null; invoice: string | null; paid: string } {
  const q = t.quotes[0];
  const i = t.invoices[0];
  const receipt = t.payments.find((p) => !p.noReceipt);
  const onInvoice = t.payments.find((p) => p.noReceipt);
  return {
    quote: q ? `${q.id} · ${q.status}` : null,
    invoice: i ? `${i.id} · ${i.status}` : null,
    paid: receipt ? `${receipt.amount} · ${receipt.date}` : onInvoice ? `${onInvoice.amount} · on the invoice, no receipt` : "No payment yet",
  };
}

type Hrefs = ReadonlyMap<string, string | null>;
const ID_LINK = "font-mono underline underline-offset-2 hover:text-ink";

function DocId({ id, hrefs }: { id: string; hrefs: Hrefs }) {
  const href = hrefs.get(id);
  return href ? <Link href={href as never} className={ID_LINK}>{id}</Link> : <span className="font-mono">{id}</span>;
}

/** "for INV-1 · Oct 2025 – Sep 2026" with each known document id linked (as the old Payments list did). */
function LinkedWords({ text, hrefs }: { text: string; hrefs: Hrefs }) {
  const ids = [...hrefs.keys()].filter((id) => text.includes(id)).sort((a, b) => b.length - a.length);
  if (!ids.length) return <>{text}</>;
  const re = new RegExp(`(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return <>{text.split(re).map((part, n) => (n % 2 ? <DocId key={n} id={part} hrefs={hrefs} /> : part))}</>;
}

/** R-2844: the Timeline's small kind word in front of a line ("Payment", "Reminder", "Follow-up") — as Quote / Invoice. */
function KindTag({ children }: { children: React.ReactNode }) {
  return <span className="mr-1.5 text-2xs uppercase text-ink-3">{children}</span>;
}

/** One payment line. Under an invoice it does not repeat "for <invoice>" (the invoice line above says it). */
function PaymentLine({ p, showFor, hrefs, tag = false }: { p: HistoryPaymentLine; showFor: boolean; hrefs: Hrefs; tag?: boolean }) {
  const ids = [p.receiptNo ? `Receipt ${p.receiptNo}` : null, p.reference ? `Ref ${p.reference}` : null].filter(Boolean).join(" · ");
  const rest = [p.partOf ? `part of ${p.partOf}` : null, p.shared].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-2 py-1 text-sm" data-testid="renewal-drawer-payment" data-no-receipt={p.noReceipt || undefined}>
      <span className="min-w-0 break-words text-ink-2">
        {tag ? <KindTag>Payment</KindTag> : null}
        {p.date ? <><span className="tabular-nums">{p.date}</span> · </> : null}{p.method}
        {showFor && p.forWords ? <> · <LinkedWords text={p.forWords} hrefs={hrefs} /></> : null}
        {rest ? ` · ${rest}` : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="font-medium tabular-nums text-ink">{p.amount}</span>
        <PaymentTdsLine amount={p.gross} tds={p.tds} />
      </span>
      {ids ? <span className="basis-full text-xs text-ink-3" data-testid="renewal-drawer-payment-ids">{ids}</span> : null}
    </li>
  );
}

function NestedPayments({ payments, showFor, hrefs }: { payments: readonly HistoryPaymentLine[]; showFor: boolean; hrefs: Hrefs }) {
  if (!payments.length) return null;
  return (
    <ul className="mt-1 border-l-2 border-hairline pl-3" aria-label="Payments">
      {payments.map((p, n) => <PaymentLine key={`${p.id}-${n}`} p={p} showFor={showFor} hrefs={hrefs} />)}
    </ul>
  );
}

function HistoryLine({ row, hrefs }: { row: HistoryRow; hrefs: Hrefs }) {
  if (row.kind === "unlinked") {
    return (
      <li className="py-2 text-sm" data-testid="renewal-drawer-history-unlinked">
        <p className="text-xs font-medium text-ink-2">{row.title}</p>
        <NestedPayments payments={row.payments} showFor hrefs={hrefs} />
      </li>
    );
  }
  return (
    <li className="py-2 text-sm" data-testid="renewal-drawer-doc" data-kind={row.kind} data-doc={row.id}>
      <div className={cn(row.tone === "muted" && row.kind === "invoice" && "opacity-70")}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate">
            <KindTag>{row.kind === "invoice" ? "Invoice" : "Quote"}</KindTag>
            <DocId id={row.id} hrefs={hrefs} />
          </p>
          <span className="shrink-0 tabular-nums text-ink">{row.amount ?? "—"}</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs">
          <span className="min-w-0 break-words text-ink-3 tabular-nums">
            {row.date ? formatDate(row.date) : "No date"}{row.period ? ` · for ${row.period}` : ""}
          </span>
          <span className={cn("shrink-0 text-right", TONE[row.tone])} data-testid="renewal-drawer-doc-status">{row.status}</span>
        </div>
      </div>
      {row.kind === "invoice" && <NestedPayments payments={row.payments} showFor={false} hrefs={hrefs} />}
    </li>
  );
}

/** R-2762: one renewal reminder (email / WhatsApp) — the Follow-ups list and the Timeline (`tag`) share it. */
export function ReminderLine({ r, tag = false }: { r: DrawerReminderRow; tag?: boolean }) {
  return (
    <li className="py-1.5 text-sm" data-testid="renewal-drawer-reminder" data-channel={r.channel}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-ink-2">{tag ? <KindTag>Reminder</KindTag> : null}<span className="tabular-nums">{r.when}</span> · {r.channel} · {r.what}</span>
        <span className={cn("shrink-0 text-right text-xs", r.reached ? "text-ink-2" : "font-medium text-rose-600")}>{r.status}</span>
      </div>
      {r.to && <p className="truncate text-xs text-ink-3" title={r.to}>to {r.to}</p>}
    </li>
  );
}

/** One logged follow-up (call / email / note, promise, next date) — the Follow-ups list and the Timeline (`tag`) share it. */
export function FollowupLine({ f, tag = false }: { f: DrawerFollowupRow; tag?: boolean }) {
  return (
    <li className="py-1.5 text-sm" data-testid="renewal-drawer-followup">
      <p className="text-xs text-ink-3">{tag ? <KindTag>Follow-up</KindTag> : null}{[f.when, f.kind, f.who].filter(Boolean).join(" · ")}</p>
      {f.note && <p className="break-words text-ink">{f.note}</p>}
      {[f.outcome, f.promise, f.next].filter(Boolean).length > 0 && (
        <p className="text-xs text-ink-2">{[f.outcome, f.promise, f.next].filter(Boolean).join(" · ")}</p>
      )}
    </li>
  );
}

/** R-2844: one Timeline line — each kind drawn by the row its own tab / section already uses. */
function TimelineLine({ item, hrefs }: { item: TimelineItem; hrefs: Hrefs }) {
  switch (item.kind) {
    case "doc": return <HistoryLine row={item.row} hrefs={hrefs} />;
    case "payment": return <PaymentLine p={item.line} showFor hrefs={hrefs} tag />;
    case "reminder": return <ReminderLine r={item.row} tag />;
    case "followup": return <FollowupLine f={item.row} tag />;
  }
}

function LastFact({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={cn("break-words text-xs tabular-nums", value ? "text-ink" : "text-ink-3")} data-testid={testId}>{value ?? "None yet"}</dd>
    </div>
  );
}

/** The drawer's History. Give it `key={subscription id}` so another renewal starts again on All, first page. */
export function DrawerHistory({ initialTab = "all", tabs, timeline, loading, failed, customer, canQuotes, canInvoices }: {
  /** R-2842: the tab the drawer opens on — Payments when the row's History button came from a payment. */
  initialTab?: SectionTab;
  tabs: HistoryTabs;
  /** R-2844: drawer-history.ts historyTimeline (documents + payments + follow-ups + reminders). */
  timeline: readonly TimelineItem[];
  loading: boolean;
  failed: boolean;
  customer: { id: string; name: string } | null;
  canQuotes: boolean;
  canInvoices: boolean;
}) {
  const [tab, setTab] = React.useState<SectionTab>(initialTab);
  const [showAll, setShowAll] = React.useState(false);
  /* every document id on this list → its page (null = this role may not open it) */
  const hrefs = React.useMemo<Hrefs>(() => new Map<string, string | null>([
    ...tabs.quotes.map((r) => [r.id, canQuotes ? `/quotes/${encodeURIComponent(r.id)}` : null] as const),
    ...tabs.invoices.map((r) => [r.id, canInvoices ? invoiceHref(r.id) : null] as const),
  ]), [tabs, canQuotes, canInvoices]);
  const last = historyLastFacts(tabs);
  const ready = !loading && !failed;
  const counts: Record<SectionTab, number> = { ...tabs.counts, timeline: timeline.length };

  const panel = (t: (typeof TABS)[number]) => {
    const list: readonly (HistoryRow | HistoryPaymentLine | TimelineItem)[] =
      t.key === "all" ? tabs.all : t.key === "quotes" ? tabs.quotes : t.key === "invoices" ? tabs.invoices : t.key === "payments" ? tabs.payments : timeline;
    const page = drawerPage(list, showAll);
    if (loading) return <Skeleton className="mt-2 h-16 w-full" aria-label="Loading history" />;
    if (failed) return <p className="pt-2 text-sm text-ink-3">Couldn&apos;t load the history — close and open again.</p>;
    if (!list.length) return <p className="pt-2 text-sm text-ink-3">{t.empty}</p>;
    return (
      <>
        <ul className="divide-y divide-hairline/70">
          {t.key === "timeline"
            ? (page.shown as TimelineItem[]).map((i) => <TimelineLine key={i.key} item={i} hrefs={hrefs} />)
            : t.key === "payments"
            ? (page.shown as HistoryPaymentLine[]).map((p) => <PaymentLine key={p.id} p={p} showFor hrefs={hrefs} />)
            : (page.shown as HistoryRow[]).map((r) => <HistoryLine key={`${r.kind}-${r.id}`} row={r} hrefs={hrefs} />)}
        </ul>
        {page.hidden > 0 && (
          /* the tab's own count, so the button and the tab never say two totals (All = documents + payments) */
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>Show all {counts[t.key]}</Button>
        )}
      </>
    );
  };

  return (
    <section className="border-t border-hairline pt-4" data-testid="renewal-drawer-history" aria-label="History">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">History</h3>
      {ready && (
        <dl className="mb-3 grid grid-cols-3 gap-3" data-testid="renewal-drawer-history-last">
          <LastFact label="Last quote" value={last.quote} testId="history-last-quote" />
          <LastFact label="Last invoice" value={last.invoice} testId="history-last-invoice" />
          <LastFact label="Last paid" value={last.paid} testId="history-last-paid" />
        </dl>
      )}
      <Tabs value={tab} onValueChange={(v) => { setTab(v as SectionTab); setShowAll(false); }}>
        {/* R-2857: all five tabs on ONE line in the 480px drawer (they wrapped, Timeline alone on line two) —
            no gap between tabs, tighter padding in each tab and its count. flex-wrap stays only as the
            fallback for a narrow phone / very large counts: every tab stays in sight, nothing is clipped
            (a sideways scroll would hide Timeline and cut the focus ring) */}
        <TabsList aria-label="History" className="flex-wrap gap-0" data-testid="renewal-drawer-history-tabs">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-1 whitespace-nowrap px-1">
              {t.label}
              {ready && <span className={cn("rounded-full px-1 text-2xs leading-4 tabular-nums", t.key === tab ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-3")}>{counts[t.key]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="pt-1 focus-visible:outline-none">{panel(t)}</TabsContent>
        ))}
      </Tabs>
      {customer && (
        <p className="mt-2 text-sm">
          <Link href={customerHistoryHref(customer.id) as never} className="break-words text-ink-2 underline underline-offset-2 hover:text-ink">
            All history for {customer.name} →
          </Link>
        </p>
      )}
    </section>
  );
}
