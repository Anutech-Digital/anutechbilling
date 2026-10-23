/**
 * Payments — money in, reconciled and ready for GST invoice.
 * Queries the `payments` table directly (supports multiple per quote = installments).
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { PAYMENT_FOCI, paymentInFocus, projectReceivedInMonth, type PaymentFocus } from "@/lib/payments/focus";
import { FocusBanner } from "@/components/shared/focus-banner";
import { PAYMENT_TABS } from "@/lib/navigation/drilldown";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { downloadCSV } from "@/lib/csv";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { getDocumentSignedUrl } from "@/lib/queries/documents";

/** Open a payment's attached receipt (private bucket → short-lived signed URL). */
async function openReceipt(path: string) {
  try {
    const url = await getDocumentSignedUrl(path);
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    toast.error("Could not open the receipt", { description: "The file may have been removed. Refresh the page and try again." });
  }
}

import {
  usePayments,
  useDeletePayment,
  useOutstandingReceivables,
  useMarkReminderSent,
  useResumeSubscription,
  useWriteOffSubscription,
  usePaymentInvoiceCustomers,
  type Payment,
} from "@/lib/queries/payments";
import { useQuotes } from "@/lib/queries/quotes";
import { useOpenSeatQuotes } from "@/lib/queries/seat-quotes";
import { seatQuotePendingText } from "@/lib/subscriptions/seat-quotes-pending";
import { useAllProjectPayments } from "@/lib/queries/projects";
import { collectedInMonth } from "@/lib/company/summary";
import { paymentDocHref, paymentDocId } from "@/lib/payments/payment-source";
import { paymentCustomerLookup, paymentInvoiceLookup, quotelessInvoiceIds, type PaymentCustomer, type PaymentInvoice } from "@/lib/payments/payment-customer";
import { OpeningInvoiceDuesCard } from "@/components/features/invoices/opening-invoice-dues-card";
import { useCustomers } from "@/lib/queries/customers";
import { useBankAccounts } from "@/lib/queries/bank";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { duesReminderMailto, duesReminderTo } from "./dues-reminder";
import { canWriteSales } from "@/lib/nav";
import { canDeleteMoney, canRecordMoney } from "@/lib/auth/roles";
import { ViewOnlyNote } from "@/components/shared/view-only-note";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { EditPaymentDialog } from "@/components/features/quotes/edit-payment-dialog";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError, LoadErrorBanner } from "@/components/shared/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { canOpenQuotes } from "@/lib/quotes/access";
import { RecordQuotePaymentDialog } from "./record-quote-payment";
import { DuesPayButton, duesPaymentRoute, useDuesQuoteLinks } from "./dues-pay";
import { SubscriptionDuesList, SubscriptionDuesHeading } from "./dues-list";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { paymentsKpiPlan } from "./kpi-plan";
import { PaymentRefundButton, usePaymentRefundFlow } from "@/components/features/payments/payment-refund";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate, bankLabel, cleanDisplayName, cn } from "@/lib/utils";
import { istMonth, toIstDate } from "@/lib/dates/ist";
import { useConfirm, useAskText } from "@/components/providers/confirm-provider";
import { PAYMENTS_PAGE_SIZE } from "./load-more";
import { paymentMethodLabel } from "./method-label";
import { paymentMatchesSearch } from "./payment-search";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { paymentSortValues, PAY_ROW_ATTR } from "./payment-table";
import { useRowOrder } from "./use-row-order";
import { scopeToCustomer, paymentTotals, paymentsSummaryLine } from "./customer-scope";
import { BookGatewayFeesButton, FeeNetLine } from "./gateway-fee";
import { paymentFeeView } from "@/lib/razorpay/fee-expense";
import { SuspendSubscriptionDialog } from "@/components/features/subscriptions/suspend-subscription-dialog";

const STATUS_TABS: TabBarItem[] = [
  { id: "all",       label: "All" },
  { id: "received",  label: "Received",  dot: "emerald" },
  { id: "refunded",  label: "Refunded",  dot: "rose" },
];

const METHOD_META: Record<string, { label: string; icon: string }> = {
  upi:           { label: "UPI",        icon: "rupee" },
  razorpay:      { label: "Razorpay",   icon: "zap" },
  bank_transfer: { label: "Bank transfer", icon: "receipt" },
  cheque:        { label: "Cheque",     icon: "file" },
  cash:          { label: "Cash",       icon: "rupee" },
  other:         { label: "Other",      icon: "info" },
};

// Table column widths (fluid percentages, DataTable colgroup). A dedicated LINKED DOCS
// column keeps the source quote / invoice / receipt out of the Status badge.
const PAY_COL_WIDTHS: Record<string, string> = {
  date: "10%", customer: "19%", amount: "12%", method: "13%", reference: "12%", linked: "16%", status: "10%", action: "8%",
};

function PaymentsPageInner() {
  /* window.prompt returns null in the desktop app — Write off did nothing (R-052). */
  const askText = useAskText();
  /* R-1698: Remind asks "did it go out?" before it writes Last reminder. */
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab]       = useUrlChoice<"all" | "received" | "refunded">("tab", PAYMENT_TABS, "all"); // R-118
  /* R-118: "Collected MTD"'s own set (lib/payments/focus.ts) — "" = none. */
  const [focus, setFocus]   = useUrlChoice<PaymentFocus>("focus", PAYMENT_FOCI, "");
  const [view, setView]     = React.useState<"all" | "subscription" | "project">("all");
  const [search, setSearch] = React.useState("");
  const [helpOpen, setHelpOpen] = React.useState(false);

  /* ── One customer's receipts ───────────────────────────────────────────────
     `?customer=<id>` — how the "Lifetime paid" tile on a customer answers "which
     payments is that number made of?".

     By ID, not by the search box, and that is the whole point. The search matches customer
     NAME as a substring, and this book already contains "AB corprotion", "abc corporaton"
     and more near-identical names, so ?q=<name> would show one customer somebody else's
     receipts — on a money screen, under a heading claiming they are theirs. */
  const customerFilter = useSearchParams().get("customer");
  // Payment currently open in the "edit details" sheet (null = closed).
  const [editPayment, setEditPayment] = React.useState<Payment | null>(null);

  const { data: payments, isLoading, error, refetch } = usePayments();
  /* ?edit=<payment id> — Payments Made opens a refund straight into its edit form (2 Oct 2026).
     Once, when the list has loaded; the whole list is in memory here. */
  const editOpened = React.useRef(false);
  React.useEffect(() => {
    if (editOpened.current || !payments || typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("edit");
    if (!id) return;
    editOpened.current = true;
    const p = payments.find((x) => x.id === id);
    if (p) setEditPayment(p);
  }, [payments]);
  const projectPaymentsQ = useAllProjectPayments();
  const quotesQ = useQuotes();
  const outstandingQ = useOutstandingReceivables();
  const { data: projectPayments } = projectPaymentsQ;
  const { data: quotes } = quotesQ;
  const { data: outstanding } = outstandingQ;
  const sideFailed = [projectPaymentsQ, quotesQ, outstandingQ].filter((q) => q.isError);
  /* R-1697: each dues row's own quote / renewal quote, so a row with no customer quote still
     gets "Record payment" through the same record_payment path. */
  const { data: duesQuoteLinks } = useDuesQuoteLinks((outstanding ?? []).map((o) => o.subscription_id));
  /* R-1705: added seats whose pro-rata quote is unpaid — not in subscriptions.outstanding_amount,
     so listed beside the dues (additive; the dues rows and their total are unchanged). */
  const { data: seatQuotes } = useOpenSeatQuotes();
  const { data: customers } = useCustomers();
  const { data: bankAccounts } = useBankAccounts();
  const { data: me } = useCurrentUser();
  /* R-237: billing cannot open /quotes (middleware sends it to /invoices) — no quote links
     for it, and Record payment opens the dialog here for everyone. */
  const canQuotes = canOpenQuotes(me?.role);
  /* R-255: the accountant reads payments; recording, reminders, refunds stay with the team. */
  const canWrite = canWriteSales(me?.role);
  const [payQuoteId, setPayQuoteId] = React.useState<string | null>(null);
  /* R-1525: one payment across several invoices of a customer. */
  const [multiPayOpen, setMultiPayOpen] = React.useState(false);
  const [kpiOpen, setKpiOpen] = React.useState(true);

  // Lookup: bankAccountId → short label (for the "received in" hint on a row)
  const bankNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of bankAccounts ?? []) m.set(a.id, bankLabel(a.bank_name || a.name, a.account_number_last4));
    return m;
  }, [bankAccounts]);
  const markReminderSent  = useMarkReminderSent();
  /* R-1681: the row being paused — the dialog asks why and links the unpaid invoice. */
  const [suspendRow, setSuspendRow] = React.useState<{ id: string; customer_name: string; plan: string; outstanding_amount: number } | null>(null);
  const resumeSub         = useResumeSubscription();
  const writeOffSub       = useWriteOffSubscription();

  // Build a lookup: quoteId → quote (status context + its GST invoice)
  const quoteById = React.useMemo(() => {
    const m = new Map<string, { paymentStatus: string; invoiceId: string | null }>();
    for (const q of quotes ?? []) {
      m.set(q.id, {
        paymentStatus: q.payment_status,
        invoiceId:     q.invoice_id,
      });
    }
    return m;
  }, [quotes]);

  // Lookup: customerId → full customer record (for GSTIN, address, email on receipt voucher)
  const customerById = React.useMemo(() => {
    const m = new Map<string, NonNullable<typeof customers>[number]>();
    for (const c of customers ?? []) m.set(c.id, c);
    return m;
  }, [customers]);

  /* R-1745: whose payment is it — the quote's customer, else (a payment on an imported Zoho
     invoice, R-1739: no quote) the invoice's, else the payment's own customer_id. One lookup for
     the rows, phone cards, search, sort, Export CSV and the receipt voucher / its PDF. */
  const { data: invoiceCustomers } = usePaymentInvoiceCustomers(
    React.useMemo(() => quotelessInvoiceIds(payments ?? []), [payments]),
  );
  const customerOf = React.useMemo(
    () => paymentCustomerLookup({ quotes: quotes ?? [], invoices: invoiceCustomers ?? [], customers: customers ?? [] }),
    [quotes, invoiceCustomers, customers],
  );
  /* R-1747: which invoice a payment is on — the quote's GST invoice, else (imported Zoho invoice)
     payments.invoice_id. The refund flow and the receipt voucher read it from here, so such a
     payment never goes down the credit-note route or prints "Advance received against service". */
  const invoiceOf = React.useMemo(
    () => paymentInvoiceLookup({ quotes: quotes ?? [], invoices: invoiceCustomers ?? [] }),
    [quotes, invoiceCustomers],
  );

  /* R-533: with ?customer= every number on the page is that customer's — the list, the tab
     counts, the summary line, the analytics strip, the dues card and the view counts. One
     slice, computed once; without the filter it is the whole company, as before. */
  const scoped = React.useMemo(
    () => scopeToCustomer(
      { payments: payments ?? [], projectPayments: projectPayments ?? [], quotes: quotes ?? [], outstanding: outstanding ?? [] },
      customerFilter,
    ),
    [payments, projectPayments, quotes, outstanding, customerFilter],
  );
  const scopedPayments = scoped.payments;
  const customerName = customerFilter
    ? cleanDisplayName(customerById.get(customerFilter)?.name ?? "this customer")
    : null;

  // Filter. Memoised: DataTable starts again at one page whenever `rows` is a new array
  // (R-024), so a fresh array on every render would undo "Load more" (R-215).
  /* The customer filter is already applied in `scoped` (customer-scope.ts: by the payment's
     own customer_id, falling back to the customer on its quote for pre-conversion receipts). */
  const filtered = React.useMemo(() => scopedPayments.filter((p) => {
    if (tab !== "all" && p.status !== tab) return false;
    if (focus && !paymentInFocus(p, focus)) return false;   // the tile's own predicate
    /* R-1639: also the receipt voucher no. and the invoice number (payment-search.ts). */
    return paymentMatchesSearch(p, search, { customerName: customerOf(p).customerName, invoiceNumber: invoiceOf(p).invoiceNumber });
  }), [scopedPayments, tab, focus, customerOf, invoiceOf, search]);

  /* R-215: the list is on the shared DataTable — header sort, and R-104's "paint 50 at a
     time" now comes from its pageSize. Tab counts, KPIs, "collected" and the CSV export
     still use every payment in `filtered` / `payments`; only the painting is paged. */
  const paySort = React.useMemo(
    () => paymentSortValues<Payment>((p) => customerOf(p).customerName),
    [customerOf],
  );
  const payColumns: DataTableColumn<Payment>[] = [
    { id: "date", header: "Date", width: PAY_COL_WIDTHS.date, sortValue: paySort.date },
    { id: "customer", header: "Customer", width: PAY_COL_WIDTHS.customer, sortValue: paySort.customer },
    { id: "amount", header: "Amount", width: PAY_COL_WIDTHS.amount, align: "right", sortValue: paySort.amount },
    { id: "method", header: "Method", width: PAY_COL_WIDTHS.method, sortValue: paySort.method },
    { id: "reference", header: "Reference", width: PAY_COL_WIDTHS.reference, sortValue: paySort.reference },
    { id: "linked", header: "Linked docs", width: PAY_COL_WIDTHS.linked },
    { id: "status", header: "Status", width: PAY_COL_WIDTHS.status, sortValue: paySort.status },
    { id: "action", header: <span className="sr-only">Actions</span>, width: PAY_COL_WIDTHS.action, align: "right" },
  ];

  /* j / k / Enter / o over the sales-payments table — opens the payment's quote,
     the same target a click uses. Enabled only while that table is on screen
     (it lives inside the subscription/all block, not the project view), so the
     keys never open a row from a list the user isn't looking at. The order is read
     from the painted rows (after a header sort / Load more), so the highlighted row
     is the one Enter opens. */
  const payTableRef = React.useRef<HTMLDivElement | null>(null);
  const shownIds = useRowOrder(payTableRef, view !== "project" && !isLoading && !error && filtered.length > 0);
  const payKeys = useListKeys({
    count: shownIds.length,   // only the rows on screen (R-104)
    enabled: view !== "project",
    onOpen: (i) => {
      const p = filtered.find((x) => x.id === shownIds[i]);
      if (p && canQuotes) router.push(paymentDocHref(p) as never);
    },
  });
  const selectedRowRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [payKeys.index]);
  const payKbSelectedId = payKeys.index >= 0 ? shownIds[payKeys.index] ?? null : null;

  // KPIs — include project-sale payments so "collected" is ALL money in (R-533: the scoped slice).
  const projPays = scoped.projectPayments;
  const { counts, projectCollected: projCollected, totalCollected } = paymentTotals(scopedPayments, projPays);
  const tabsWithCounts = STATUS_TABS.map((t) => ({ ...t, count: counts[t.id] ?? 0 }));
  const allReceived = scopedPayments.filter((p) => p.status === "received");
  const scopedOutstanding = scoped.outstanding;
  const scopedSeatQuotes = (seatQuotes ?? []).filter((q) => !customerFilter || q.customerId === customerFilter);
  const seatQuotesTotal = scopedSeatQuotes.reduce((s, q) => s + q.pending, 0);

  // Awaiting-invoice: quotes with payment_status = 'received' (fully paid, no invoice yet)
  const awaitingInvoiceQuotes = scoped.quotes.filter((q) => q.payment_status === "received");
  const awaitingInvoiceTotal = awaitingInvoiceQuotes.reduce((s, q) => s + (q.amount ?? 0), 0);

  // Partial payments (quotes with status=partial)
  const partialQuotes = scoped.quotes.filter((q) => q.payment_status === "partial");
  /* R-1730: one figure, one place — the strip shows figures only while collapsed, and the two
     quote counts live in "Action needed" whenever it is shown (kpi-plan.ts). */
  const actionCardShown = canWrite && !isLoading && (partialQuotes.length > 0 || awaitingInvoiceQuotes.length > 0);
  const kpi = paymentsKpiPlan({ expanded: kpiOpen, actionCardShown });

  /* Collected this IST month — one helper (lib/company/summary.ts), shared with the dashboard
     Company section (R-062: it used to start at "the 1st at this time of day", browser clock).
     TDS the customer withheld settles the invoice but never reaches the bank — said separately. */
  const mtdCollected = collectedInMonth(scopedPayments, projPays);
  /* The part of Collected MTD that is project receipts — those rows live on /projects, so
     the tile and the banner say how much of the total this list cannot show. */
  const mtdProject = projectReceivedInMonth(projPays);
  const mtdMonth = istMonth();
  const mtdTds = [...allReceived, ...projPays]
    .filter((p) => p.method === "tds" && !!p.received_at && toIstDate(p.received_at).slice(0, 7) === mtdMonth)
    .reduce((s, p) => s + p.amount, 0);

  // Method breakdown
  const methodBreakdown: Record<string, number> = {};
  for (const p of allReceived) {
    methodBreakdown[p.method] = (methodBreakdown[p.method] ?? 0) + 1;
  }
  const topMethod = Object.entries(methodBreakdown).sort((a, b) => b[1] - a[1])[0];

  // Real CSV export of the currently-filtered payments (hand this file to your
  // CA / accountant). Data is already in memory, so it's a plain downloadCSV —
  // no fake "coming soon".
  const handleExportCsv = () => {
    if (filtered.length === 0) { toast.info("No payments to export"); return; }
    /* R-045: gateway fee + net received, blank when not known (never a guessed zero). */
    const header = ["Date", "Customer", "Quote", "Amount", "Gateway fee", "Net received", "Method", "Reference", "Status", "Receipt Voucher"];
    const lines = filtered.map((p) => {
      const fee = paymentFeeView(p);
      return [
        formatDate(p.received_at), customerOf(p).customerName ?? "", paymentDocId(p), String(p.amount),
        fee ? String(fee.fee) : "", fee ? String(fee.net) : "",
        p.method ? paymentMethodLabel(p.method) : "", p.reference ?? "", p.status, p.receipt_voucher_no ?? "",
      ];
    });
    /* R-1795: the shared downloadCSV — csvEscape on every cell (R-734) and an export_log row (R-1006). */
    downloadCSV(`payments-${new Date().toISOString().slice(0, 10)}.csv`, header, lines);
    toast.success(`Exported ${filtered.length} payment${filtered.length === 1 ? "" : "s"} to CSV`);
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Payments Received</h1>
          <p className="text-sm text-ink-3 mt-1">
            All payments received · partial / installments supported · ready for GST invoice
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <BookGatewayFeesButton payments={payments} role={me?.role} />
          {canRecordMoney(me?.role) && (
            <Button icon="rupee" onClick={() => setMultiPayOpen(true)}>
              Record payment — multiple invoices
            </Button>
          )}
          <Button icon="download" onClick={handleExportCsv}>
            Export CSV
          </Button>
          <Button asChild variant="primary" icon="receipt">
            <Link href="/invoices">View Invoices →</Link>
          </Button>
        </div>
      </div>

      {!canWrite && <ViewOnlyNote what="record, edit or refund payments" />}

      {/* All / Subscription / Project payments toggle (mirrors the Invoices page) */}
      <TabBar
        className="overflow-y-hidden"
        value={view}
        onChange={(v) => setView(v as "all" | "subscription" | "project")}
        items={[
          { id: "all",          label: "All payments", count: (scopedPayments.length + projPays.length) || undefined },
          { id: "subscription", label: "Subscription", count: scopedPayments.length || undefined },
          { id: "project",      label: "Project",      count: projPays.length || undefined },
        ]}
      />

      {/* ── Arrived here from one customer ──────────────────────────────────
          Names whose payments these are, and offers the way out. A filter applied from
          another screen and then never mentioned is how an operator concludes the payments
          page has lost their money. R-533: it sits above the analytics, because every
          number below it — view counts, tiles, dues, tabs, totals — is this customer's. */}
      {customerFilter && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-paper-2/60 px-3.5 py-2.5">
          <Icon name="filter" size={15} className="shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">
            Showing only <b className="text-ink">{customerName}</b>. All counts and totals below are theirs.
          </p>
          {/* A Link, not a click handler: this is navigation, so it should behave like a
              link — focusable, middle-clickable, and it drops the query string by going to
              the bare route. */}
          <Button size="sm" variant="ghost" icon="x" asChild>
            <Link href="/payments">Show all payments</Link>
          </Button>
        </div>
      )}

      {(view === "subscription" || view === "all") && (<>
      {/* Collapsible Payments Analytics Banner */}
      {!isLoading && payments && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            aria-expanded={kpiOpen}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Payments &amp; Collections Analytics</span>
              {/* R-1730: figures here only while collapsed — expanded, the boxes below carry them. */}
              {kpi.strip.includes("collected") && (<>
                <span className="text-ink-3">·</span>
                <span className="text-ink-2 font-mono font-medium">Collected MTD: <b className="text-emerald">{rupee(mtdCollected, { compact: true })}</b></span>
              </>)}
              {kpi.strip.includes("partial") && (<>
                <span className="text-ink-3 font-mono">·</span>
                <span className="text-ink-2 font-mono font-medium">Partial Quotes: <b className="text-amber-ink">{partialQuotes.length}</b></span>
              </>)}
              {kpi.strip.includes("awaiting") && (<>
                <span className="text-ink-3 font-mono">·</span>
                <span className="text-ink-2 font-mono font-medium">Awaiting GST Invoice: <b className="text-amber-ink">{rupee(awaitingInvoiceTotal, { compact: true })}</b> ({awaitingInvoiceQuotes.length})</span>
              </>)}
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline bg-paper">
              <div className={kpi.tiles.length > 2 ? "grid grid-cols-2 sm:grid-cols-4 gap-2.5" : "grid grid-cols-2 gap-2.5"}>
                <button type="button" onClick={() => { setTab("all"); setFocus("received-month"); }} aria-pressed={focus === "received-month"} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Collected MTD</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(mtdCollected, { compact: true })}</p>
                  {mtdTds > 0 && <p className="text-3xs text-ink-3 mt-0.5">incl. {rupee(mtdTds)} TDS</p>}
                  {mtdProject > 0 && <p className="text-3xs text-ink-3 mt-0.5">incl. {rupee(mtdProject)} project receipts</p>}
                </button>
                {/* These two count QUOTES — they open the quotes they counted (lib/quotes/focus.ts). */}
                {/* R-237: billing cannot open /quotes — the tile stays a number, not a dead link. */}
                {/* R-1730: shown here only when "Action needed" (below) is not carrying them. */}
                {kpi.tiles.includes("partial") && (
                <button type="button" disabled={!canQuotes} onClick={() => router.push("/quotes?focus=partial" as never)} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left enabled:hover:border-amber/60 transition-all enabled:cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Partial Quotes</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{partialQuotes.length}</p>
                </button>
                )}
                {kpi.tiles.includes("awaiting") && (
                <button type="button" onClick={() => router.push((canQuotes ? "/quotes?focus=to-invoice" : "/invoices") as never)} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Awaiting GST Invoice</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(awaitingInvoiceTotal, { compact: true })} <span className="text-xs text-ink-3 font-normal">({awaitingInvoiceQuotes.length})</span></p>
                </button>
                )}
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Top Payment Method</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{topMethod ? paymentMethodLabel(topMethod[0]) : "—"}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Outstanding Receivables — actionable card ── */}
      {(scopedOutstanding.length > 0 || scopedSeatQuotes.length > 0) && (() => {
        const outstanding = scopedOutstanding;
        return (
          <Card className="border-rose/30 bg-rose-soft/20">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-2.5">
                <Icon name="alert" size={18} className="text-rose" />
                {/* R-1806: a failed dues read shows no total (the banner above explains it). */}
                <SubscriptionDuesHeading rows={outstanding} failed={outstandingQ.isError}>
                  {seatQuotesTotal > 0 && (
                    <p className="text-xs text-amber-ink">
                      + {rupee(seatQuotesTotal)} in {scopedSeatQuotes.length} unpaid seat quote{scopedSeatQuotes.length === 1 ? "" : "s"} (seats already added, listed below)
                    </p>
                  )}
                </SubscriptionDuesHeading>
              </div>
            </div>

            {/* R-1698: one list for every width — cards below 1280px, the table from 1280px
                (before, 768–1279px showed no rows at all). One filled button per row (Record
                payment, R-1697); Remind / Suspend / Resume / Write off behind "⋯". */}
            {outstanding.length > 0 && (
              <SubscriptionDuesList
                rows={outstanding}
                readOnly={!canWrite}
                actions={{
                  payButton: (o) => <DuesPayButton route={duesPaymentRoute(o, duesQuoteLinks?.get(o.subscription_id))} onRecord={setPayQuoteId} />,
                  onRemind: async (o) => {
                    /* R-1638: To = the customer's billing contact, signed with this business's name. */
                    const to = await duesReminderTo(o.customer_id);
                    window.location.href = duesReminderMailto(o, { to, sellerName: me?.tenantName });
                    /* R-1698: "Last reminder" is written only once the mail app opened and the
                       user says it went (it was written before the mail app even opened). */
                    const sent = await confirm({
                      title: `Did the reminder to ${o.customer_name} go out?`,
                      body: to
                        ? `Your mail app opened with the reminder to ${to}. Mark it as sent once you have sent it.`
                        : `${o.customer_name} has no email on file, so the "To" line is empty — type the address in your mail app (or add a contact to the customer). Mark it as sent once you have sent it.`,
                      confirmLabel: "Yes, mark as sent",
                      cancelLabel: "Not sent",
                      icon: "mail",
                    });
                    if (sent) await markReminderSent.mutateAsync(o.subscription_id);
                  },
                  onSuspend: (o) => setSuspendRow({ id: o.subscription_id, customer_name: o.customer_name, plan: o.plan, outstanding_amount: o.outstanding_amount }),
                  onResume: (o) => resumeSub.mutate(o.subscription_id),
                  onWriteOff: async (o) => {
                    const reason = await askText({
                      title: `Write off ${rupee(o.outstanding_amount)} from ${o.customer_name}?`,
                      /* R-1635: the invoices leave the chase too (write_off_subscription). */
                      body: "This cancels the subscription and marks the balance as uncollectable. Its unpaid invoices leave Payment Follow-up and Overdue, and no more reminders go out. The invoices stay issued as they are (GST unchanged).",
                      label: "Reason (for audit)",
                      confirmLabel: "Write off",
                      danger: true,
                    });
                    if (reason) {
                      writeOffSub.mutate({ id: o.subscription_id, reason });
                    }
                  },
                }}
              />
            )}

            {/* R-1705: open add-seats quotes — the seats are live, the money is not in. */}
            {scopedSeatQuotes.length > 0 && (
              <div className="mt-3 rounded-md border border-amber/40 bg-paper p-3">
                <h3 className="text-xs font-semibold text-ink mb-2">Seat quotes pending · {rupee(seatQuotesTotal)}</h3>
                <ul className="space-y-2">
                  {scopedSeatQuotes.map((q) => (
                    <li key={q.quoteId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{q.customerName}</span>
                        <span className="text-ink-3"> · {q.plan} · </span>
                        <span className="text-amber-ink">{seatQuotePendingText(q)}</span>
                        {" "}
                        {canQuotes ? (
                          <Link href={`/quotes/${q.quoteId}` as never} className="font-mono text-xs text-amber-ink hover:underline">{q.quoteId}</Link>
                        ) : (
                          <span className="font-mono text-xs text-ink-3">{q.quoteId}</span>
                        )}
                      </span>
                      {canWrite && (
                        <Button size="sm" variant="default" icon="rupee" onClick={() => setPayQuoteId(q.quoteId)}>
                          Record payment
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-2xs text-ink-3">Not paid for? Reject the quote — that takes the seats and MRR back off the subscription.</p>
              </div>
            )}
          </Card>
        );
      })()}

      {/* R-1739: balances on invoices imported from Zoho Books (no subscription, so not above). */}
      <OpeningInvoiceDuesCard customerId={customerFilter} canRecord={canWrite && canRecordMoney(me?.role)} />

      {/* Action needed — the two "close the loop" worklists (collect balance +
          generate the paid-but-uninvoiced GST invoices) merged into ONE compact
          card so they don't push the payment table down as two stacked bands. */}
      {actionCardShown && (
        <GeminiCard title="Action needed to close the loop" compact>
          <ul className="space-y-2">
            {partialQuotes.length > 0 && (
              <li className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <b>{partialQuotes.length} partial payment{partialQuotes.length === 1 ? "" : "s"}</b> — collect the remaining balance from the customer.
                </span>
                {canQuotes ? (
                  <Button asChild size="sm" variant="default" icon="external" className="shrink-0">
                    {/* R-1730: the analytics no longer repeat this count — so with several, open them all. */}
                    <Link href={(partialQuotes.length > 1 ? "/quotes?focus=partial" : `/quotes/${partialQuotes[0].id}`) as any}>Open</Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="default" icon="rupee" className="shrink-0" onClick={() => setPayQuoteId(partialQuotes[0].id)}>
                    Record payment
                  </Button>
                )}
              </li>
            )}
            {awaitingInvoiceQuotes.length > 0 && (
              <li className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <b>{awaitingInvoiceQuotes.length} fully paid</b>, GST invoice not generated yet (₹{awaitingInvoiceTotal.toLocaleString("en-IN")} worth).
                </span>
                {/* Billing generates GST invoices on /invoices (the quote page is closed to it). */}
                <Button asChild size="sm" variant="default" icon="receipt" className="shrink-0">
                  <Link href={(!canQuotes ? "/invoices" : awaitingInvoiceQuotes.length > 1 ? "/quotes?focus=to-invoice" : `/quotes/${awaitingInvoiceQuotes[0].id}`) as any}>Generate</Link>
                </Button>
              </li>
            )}
          </ul>
        </GeminiCard>
      )}

      {/* TabBar + Search — sticky on phone/tablet (cards). From xl the table shows and its
          own column header sticks under the top bar (R-1741), so this scrolls away there —
          two sticky bars at 56px stacked and covered the first rows. */}
      {!isLoading && payments && (
        <div className="sticky top-[56px] z-20 xl:static xl:z-auto bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
          {focus && (
            <FocusBanner
              label={mtdProject > 0
                ? `Received this month — sales receipts (+ ${rupee(mtdProject)} project receipts on Projects)`
                : "Received this month"}
              count={filtered.length}
              onClear={() => setFocus("")}
            />
          )}
          <TabBar className="overflow-y-hidden" value={tab} onChange={(v) => { setFocus(""); setTab(v as typeof tab); }} items={tabsWithCounts} />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="text-xs text-ink-3">
              {/* How many are painted is the table's own "Showing x of y" (R-215). */}
              {paymentsSummaryLine({ shown: filtered.length, total: scopedPayments.length, collected: rupee(totalCollected), customerName })}
            </div>
            <div className="w-full sm:w-72">
              <Input
                prefix={<Icon name="search" size={14} />}
                aria-label="Search payments"
                placeholder="Receipt / invoice no., customer, amount…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <LoadError what="Payments" error={error} onRetry={() => refetch()} />}
      {/* R-1655: the side lists (awaiting invoice, part-paid, dues, project payments) come from
          other reads — a failed one used to leave its list silently empty. */}
      {!error && sideFailed.length > 0 && (
        <LoadErrorBanner onRetry={() => sideFailed.forEach((q) => void q.refetch())} />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && payments && payments.length === 0 && projPays.length === 0 && (
        <EmptyState
          icon="rupee"
          title="No payments yet"
          body="Once you record a payment on any quote, it shows up here for reconciliation and invoicing."
          action={
            <Button asChild icon="external">
              {canQuotes ? <Link href="/quotes">Go to Quotes</Link> : <Link href="/invoices">Go to Invoices</Link>}
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && payments && payments.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="No payments match"
          body={search ? `No results for "${search}".`
            : customerName && scopedPayments.length === 0 ? `No subscription payments from ${customerName} yet.`
            : `No payments with status "${tab}".`}
          action={<Button icon="x" onClick={() => { setTab("all"); setSearch(""); }}>Clear filters</Button>}
          compact
        />
      )}

      {/* R-215: one shared DataTable — cards below 1280px, the table at xl; header sort;
          "Load 50 more" (R-104) from its pageSize. Rows carry data-pay-row-id so the
          keyboard knows the painted order. */}
      {!isLoading && !error && filtered.length > 0 && (
        <div ref={payTableRef}>
          <DataTable
            urlKey="sort"
            rows={filtered}
            columns={payColumns}
            getRowId={(p) => p.id}
            totalCount={scopedPayments.length}
            noun="payment"
            cardsBelow="xl"
            pageSize={PAYMENTS_PAGE_SIZE}
            mobileCard={(p) => {
            const who = customerOf(p);
            return (
              <div className="bg-paper border border-hairline rounded-lg overflow-hidden">
                <MaybeQuoteLink
                  href={paymentDocHref(p)}
                  enabled={canQuotes}
                  className="block p-3 active:bg-paper-2/50"
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">
                        {cleanDisplayName(who.customerName ?? "—")}
                      </p>
                      <p className="font-mono text-2xs text-ink-3 mt-0.5">{paymentDocId(p)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-serif text-base tabular-nums text-ink">{rupee(p.amount)}</p>
                      <FeeNetLine payment={p} />
                      <p className="text-3xs text-ink-3">{paymentMethodLabel(p.method)}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
                    <span className="text-ink-3 truncate">
                      {p.received_at ? formatDate(p.received_at) : "—"}
                      {p.receipt_voucher_no && <> · <span className="font-mono">{p.receipt_voucher_no}</span></>}
                      {p.bank_account_id && bankNameById.get(p.bank_account_id) && (
                        <> · {bankNameById.get(p.bank_account_id)}</>
                      )}
                    </span>
                    <Badge
                      kind={p.status === "received" ? "success" : "danger"}
                      size="sm"
                      dot
                    >
                      {p.status}
                    </Badge>
                  </div>
                </MaybeQuoteLink>
                {(p.status === "received" || p.receipt_file_path) && (
                <div className="flex flex-wrap border-t border-hairline/60">
                  {p.status === "received" && canWrite && (
                    <button
                      type="button"
                      onClick={() => setEditPayment(p)}
                      className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium text-ink-2 active:bg-paper-2"
                    >
                      <Icon name="edit" size={12} /> Edit details
                    </button>
                  )}
                  {p.receipt_file_path && (
                    <button
                      type="button"
                      onClick={() => openReceipt(p.receipt_file_path!)}
                      className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium text-ink-2 active:bg-paper-2 border-l border-hairline/60"
                    >
                      <Icon name="external" size={12} /> View receipt
                    </button>
                  )}
                  {/* R-1682: Refund at every width — it was only in the ≥1280px table's menu. */}
                  {p.status === "received" && canWrite && (
                    <PaymentRefundButton
                      payment={p}
                      invoiceId={invoiceOf(p).invoiceId}
                      invoiceNumber={invoiceOf(p).invoiceNumber}
                      className="flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium text-rose active:bg-paper-2 border-l border-hairline/60"
                    />
                  )}
                </div>
                )}
              </div>
            );
            }}
            renderRow={(p) => {
                const ctx = quoteById.get(p.quote_id ?? "");
                const who = customerOf(p);
                return (
                  <PaymentRowView
                    key={p.id}
                    p={p}
                    ctx={ctx}
                    who={who}
                    inv={invoiceOf(p)}
                    customer={who.customerId ? customerById.get(who.customerId) : undefined}
                    me={me}
                    bankLabel={p.bank_account_id ? bankNameById.get(p.bank_account_id) : undefined}
                    onEdit={() => setEditPayment(p)}
                    selected={p.id === payKbSelectedId}
                    rowRef={p.id === payKbSelectedId ? selectedRowRef : undefined}
                  />
                );
            }}
          />
        </div>
      )}

      {/* Help */}
      {!isLoading && payments && payments.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <Icon name="info" size={11} />
          A quote can have multiple payments (installments). Open the quote to see its full payment history.
        </div>
      )}
      </>)}

      {/* ── PROJECT payments view (also shown under "All") ── */}
      {(view === "project" || view === "all") && (
        projPays.length === 0 ? (
          view === "project" ? (
          <EmptyState icon="package" title="No project payments yet"
            body="Payments recorded against project milestones show here." />
          ) : null
        ) : (
        <Card flush>
          <div className="px-4 py-3 border-b border-hairline flex items-center gap-2">
            <Icon name="package" size={15} className="text-ink-3" />
            <h2 className="text-sm font-semibold text-ink">Project payments</h2>
            <span className="text-2xs text-ink-3">· {rupee(projCollected)} collected</span>
          </div>

          {/* Mobile card list — phones only */}
          <ul className="md:hidden divide-y divide-hairline">
            {projPays.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {p.customer_id ? (
                      <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline block truncate">{cleanDisplayName(p.customer_name)}</Link>
                    ) : (
                      <span className="font-medium text-ink block truncate">{cleanDisplayName(p.customer_name)}</span>
                    )}
                    <Link href={`/projects/${p.project_id}` as never} className="text-2xs text-ink-2 hover:text-amber-ink hover:underline block truncate">{p.project_title}</Link>
                    <p className="text-2xs text-ink-3 mt-0.5">
                      {paymentMethodLabel(p.method)}{p.bank_txn_id ? " · reconciled" : ""} · {formatDate(p.received_at)}
                    </p>
                  </div>
                  <p className="font-serif text-base tabular-nums text-ink shrink-0">{rupee(p.amount)}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="text-left px-4 py-2">Customer / Project</th>
                  <th className="text-left px-3 py-2">Method</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {projPays.map((p) => (
                  <tr key={p.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-2.5">
                      {p.customer_id ? (
                        <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline">{cleanDisplayName(p.customer_name)}</Link>
                      ) : (
                        <span className="font-medium text-ink">{cleanDisplayName(p.customer_name)}</span>
                      )}
                      <span className="text-ink-3"> · </span>
                      <Link href={`/projects/${p.project_id}` as never} className="text-ink-2 hover:text-amber-ink hover:underline">{p.project_title}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{paymentMethodLabel(p.method)}{p.bank_txn_id ? " · reconciled" : ""}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-ink">{rupee(p.amount)}</td>
                    <td className="px-4 py-2.5 text-ink-2">{formatDate(p.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        )
      )}

      {/* Edit payment details (safe fields only — amount stays locked) */}
      <MultiInvoicePaymentDialog open={multiPayOpen && canRecordMoney(me?.role)} onOpenChange={setMultiPayOpen} />
      {suspendRow && (
        <SuspendSubscriptionDialog
          sub={suspendRow}
          open={!!suspendRow}
          onOpenChange={(v) => { if (!v) setSuspendRow(null); }}
        />
      )}
      <RecordQuotePaymentDialog
        quoteId={payQuoteId}
        open={!!payQuoteId}
        onOpenChange={(o) => { if (!o) setPayQuoteId(null); }}
      />
      <EditPaymentDialog
        open={!!editPayment && canWrite}
        onOpenChange={(o) => { if (!o) setEditPayment(null); }}
        payment={editPayment}
        customerName={
          (editPayment && customerOf(editPayment).customerName) || "Customer"
        }
      />

      {/* Shown only once a key has actually been used — see the note on KeyHintBar. */}
      <KeyHintBar visible={payKeys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/**
 * `useSearchParams()` (the ?customer= filter) forces this page out of static prerender
 * unless it sits under a Suspense boundary — Next fails the BUILD on it, while
 * typecheck, vitest and lint all pass. Same split as the login page, and the same
 * reason: `npm run build` is the only gate that catches this (CLAUDE.md §25.2).
 */
export default function PaymentsPage() {
  return (
    <React.Suspense fallback={null}>
      <PaymentsPageInner />
    </React.Suspense>
  );
}

/** R-237: a quote link for roles that can open quotes, plain content for the rest (billing). */
function MaybeQuoteLink({
  href,
  enabled,
  className,
  children,
}: {
  /** R-1739: the payment's quote page, or its imported Zoho invoice (lib/payments/payment-source). */
  href: string;
  enabled: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return enabled ? (
    <Link href={href as never} className={className}>{children}</Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

function PaymentRowView({
  p,
  ctx,
  who,
  inv,
  customer,
  me,
  bankLabel,
  onEdit,
  selected = false,
  rowRef,
}: {
  p: Payment;
  ctx?: { paymentStatus: string; invoiceId: string | null };
  /** R-1745: whose payment it is (lib/payments/payment-customer.ts). */
  who: PaymentCustomer;
  /** R-1747: which invoice it is on (lib/payments/payment-customer.ts paymentInvoiceLookup). */
  inv: PaymentInvoice;
  customer?: {
    name:           string;
    gstin:          string | null;
    contact_email:  string | null;
    state:          string | null;
    state_code:     string | null;
  };
  me?: ReturnType<typeof useCurrentUser>["data"];
  bankLabel?: string;
  onEdit: () => void;
  /** Keyboard (j/k) selection — the parent owns which row is current. */
  selected?: boolean;
  rowRef?: React.Ref<HTMLTableRowElement>;
}) {
  const router = useRouter();
  const methodInfo = METHOD_META[p.method];
  const [receiptOpen, setReceiptOpen] = React.useState(false);
  /* R-237: billing cannot open quotes — every quote link/row-click below is for the rest. */
  const canQuotes = canOpenQuotes(me?.role);
  const canWrite = canWriteSales(me?.role); // R-255
  const canDelete = canDeleteMoney(me?.role); // R-718: owner / accountant only
  const openQuote = canQuotes
    ? { label: "Open quote", onClick: () => router.push(paymentDocHref(p) as any) }
    : undefined;
  const noQuoteHint = "The next step is on the quote — ask an owner or manager.";
  // When a delete is blocked (invoice issued / bank-reconciled / add-seats / etc.),
  // don't dead-end: show the reason AND a button to where the next step happens
  // (the quote, which lists the exact blocking records + how to clear them).
  const del = useDeletePayment({
    onBlocked: (msg) =>
      toast.error(msg, {
        description: canQuotes ? "It can't be removed here — open the quote for the next step." : noQuoteHint,
        action: openQuote,
      }),
  });
  const confirm = useConfirm();

  /* Refund = paisa sach me wapas (delete = galat entry sudhaarna). R-1682: the flow lives in
     features/payments/payment-refund.tsx so the card list below the table breakpoint has
     it too, and it offers the partial refund of credit-note credit. */
  const refundFlow = usePaymentRefundFlow({
    payment: p,
    invoiceId: inv.invoiceId,
    invoiceNumber: inv.invoiceNumber,
    onBlocked: (msg) =>
      toast.error(msg, {
        description: canQuotes ? "This block is cleared on the quote or in Banking — the next step is there." : noQuoteHint,
        action: openQuote,
      }),
  });

  // Delete = correct a wrong entry. Explains the reversal, then reverses via RPC
  // (guards block if a GST invoice was issued / it's bank-reconciled).
  const handleDelete = async () => {
    const body = `This reverses it: the quote's paid amount + the subscription's outstanding are recalculated. `
      + `If it's the only payment, the subscription + auto-created purchase order from this sale are removed too (the customer is kept).\n\n`
      + `Blocked if a GST invoice was already generated, or it's reconciled to a bank line — handle those first.`;
    if (await confirm({
      title: `Delete this ${rupee(p.amount)} payment on ${paymentDocId(p)}?`,
      body,
      confirmLabel: "Delete",
      danger: true,
    })) del.mutate(p.id);
  };

  // Inter-state if customer's state-code differs from tenant's. Default = intra-state.
  const interState = Boolean(
    customer?.state_code &&
    me?.tenantStateCode &&
    customer.state_code !== me.tenantStateCode,
  );

  const customerName = cleanDisplayName(who.customerName ?? "—");
  return (
    <tr
      ref={rowRef}
      {...{ [PAY_ROW_ATTR]: p.id }}
      className={cn(
        "group border-b border-hairline last:border-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
        canQuotes && "cursor-pointer",
        selected ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40" : "hover:bg-paper-2/50",
      )}
      {...(canQuotes
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Open ${p.quote_id ? "quote" : "invoice"} ${paymentDocId(p)}`,
            onClick: () => router.push(paymentDocHref(p) as any),
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(paymentDocHref(p) as any); } },
          }
        : {})}
      aria-selected={selected}
    >
      <td className="px-3 py-2.5 text-xs text-ink-2 whitespace-nowrap align-top">{formatDate(p.received_at)}</td>
      <td className="px-3 py-2.5 text-sm font-medium align-top" onClick={(e) => e.stopPropagation()}>
        {who.customerId ? (
          <Link href={`/customers/${who.customerId}` as never} className="text-ink hover:text-amber-ink hover:underline break-words leading-snug">{customerName}</Link>
        ) : (
          <span className="text-ink break-words leading-snug">{customerName}</span>
        )}
      </td>
      {/* Amount — cash in, the happiest number; give it weight. */}
      <td className="px-3 py-2.5 text-right tabular-nums align-top">
        <span className="font-serif text-[15px] font-semibold text-emerald">{rupee(p.amount)}</span>
        <FeeNetLine payment={p} className="mt-0.5" />
      </td>
      <td className="px-3 py-2.5 align-top">
        {methodInfo ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Icon name={methodInfo.icon} size={11} className="text-ink-3" />
            {methodInfo.label}
          </span>
        ) : (
          <span className="text-xs text-ink-3">{paymentMethodLabel(p.method)}</span>
        )}
        {bankLabel && (
          <div className="text-3xs text-ink-3 mt-0.5 flex items-center gap-1 truncate">
            <Icon name="receipt" size={9} className="shrink-0" /> <span className="truncate">{bankLabel}</span>
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-ink-2 break-all align-top" title={p.reference ?? undefined}>{p.reference ?? "—"}</td>
      {/* LINKED DOCS — source quote + GST invoice + receipt voucher as clickable
          chips, so the Status column stays a clean single badge. */}
      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1 items-start">
          {canQuotes ? (
            <Link href={paymentDocHref(p) as any} className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-3xs font-semibold text-ink hover:text-amber-ink" title={paymentDocId(p)}>
              {paymentDocId(p)}
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-3xs font-semibold text-ink-2">{paymentDocId(p)}</span>
          )}
          {ctx?.invoiceId && (
            <Link href={`/invoices?open=${ctx.invoiceId}` as any} className="font-mono text-3xs text-indigo-ink hover:underline" title="Open GST invoice">{ctx.invoiceId}</Link>
          )}
          {p.receipt_voucher_no && (
            me
              ? <button type="button" onClick={() => setReceiptOpen(true)} className="font-mono text-3xs text-ink-3 hover:text-amber-ink hover:underline" title="Open receipt voucher">{p.receipt_voucher_no}</button>
              : <span className="font-mono text-3xs text-ink-3">{p.receipt_voucher_no}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 align-top">
        {p.status === "received" ? (
          <Badge kind="success" dot>received</Badge>
        ) : (
          <Badge kind="danger" dot>refunded</Badge>
        )}
      </td>
      <td className="px-2 py-2.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Payment actions"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
              >
                <Icon name="more_h" size={20} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              {canQuotes && (
                <DropdownMenuItem asChild className="gap-2.5 py-2 cursor-pointer">
                  <Link href={paymentDocHref(p) as any}>
                    <Icon name="external" size={16} /> {p.quote_id ? "Open quote" : "Open invoice"}
                  </Link>
                </DropdownMenuItem>
              )}
              {p.status === "received" && canWrite && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}>
                  <Icon name="edit" size={16} /> Edit details
                </DropdownMenuItem>
              )}
              {p.status === "received" && me && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setReceiptOpen(true)}>
                  <Icon name="file" size={16} /> Receipt voucher
                </DropdownMenuItem>
              )}
              {p.receipt_file_path && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => openReceipt(p.receipt_file_path!)}>
                  <Icon name="external" size={16} /> View attached receipt
                </DropdownMenuItem>
              )}
              {canWrite && (<>
              <DropdownMenuSeparator />
              {p.status === "received" && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose" onClick={() => { void refundFlow.start(); }}>
                  <Icon name="rupee" size={16} /> {refundFlow.label}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose" onClick={handleDelete}>
                  <Icon name="trash" size={16} /> Delete payment
                </DropdownMenuItem>
              )}
              </>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {me && (
          <ReceiptVoucherDialog
            open={receiptOpen}
            onOpenChange={setReceiptOpen}
            payment={p}
            customerName={who.customerName ?? "Customer"}
            customerGstin={customer?.gstin}
            customerEmail={customer?.contact_email}
            tenantName={me.tenantName}
            tenantGstin={me.tenantGstin}
            tenantEmail={me.tenantEmail}
            tenantPhone={me.tenantPhone}
            tenantAddress={me.tenantAddress}
            tenantState={me.tenantState}
            interState={interState}
            quoteId={p.quote_id ?? undefined}
            openingInvoiceNumber={inv.openingBalance ? inv.invoiceNumber : undefined}
          />
        )}
        {refundFlow.element}
      </td>
    </tr>
  );
}
