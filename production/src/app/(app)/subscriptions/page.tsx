/**
 * Subscriptions — list matching prototype design.
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { SUBSCRIPTION_TABS } from "@/lib/navigation/drilldown";
import { SUB_FOLDERS, folderOf, folderCounts } from "@/lib/subscriptions/folders";
import { SUB_FOCI, SUB_FOCUS_LABEL, subInFocus, type SubFocus } from "@/lib/subscriptions/focus";
import { FocusBanner } from "@/components/shared/focus-banner";
import { hasNoPrice } from "@/lib/subscriptions/list-price-mrr";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { useRouter } from "next/navigation";
import { useSubscriptions, useSetSubscriptionDomain, useDeleteSubscription } from "@/lib/queries/subscriptions";
import { useContactSearchIndex } from "@/lib/queries/contacts";
import { customerMatchesContact } from "@/lib/contacts/search-index";
import { initialSubscriptionSearch, SUBSCRIPTION_SEARCH_EVENT } from "./palette-links";
import { newestFirst } from "@/lib/sort/newest-first";
import { subscriptionFacts } from "@/lib/subscriptions/facts";
import { sortSubscriptions, defaultDirFor, type SubSort, type SubSortKey } from "@/lib/subscriptions/sort";
import { assessLeakage } from "@/lib/vendor/leakage";
import { useActiveTrials } from "@/lib/queries/trials";
import ExtendSubscriptionDialog from "@/components/features/subscriptions/extend-subscription-dialog";
import AddSeatsDialog            from "@/components/features/subscriptions/add-seats-dialog";
import { AddSubscriptionDialog } from "@/components/features/subscriptions/add-subscription-dialog";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import type { QuoteLine } from "@/lib/subscriptions/orphan-quote";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/client";
import { prefillFromLead, type LeadPrefill } from "@/lib/subscriptions/lead-prefill";
/* One countdown, shared with /payments and with the onboarding dialog's hint, so the
   three cannot disagree about whether the same customer is late. */
/* Only the row HIGHLIGHT is decided here — the chip itself moved into
   subscriptionExceptions() on 11 Sep 2026 so the mobile card gets it too. */
import { paymentDueState, todayIST } from "@/lib/subscriptions/payment-due";
import type { Route } from "next";

/** What onboarding hands over when the operator says the money has arrived. */
interface PendingPaymentHandoff {
  quoteId: string;
  customerId: string;
  customerName: string;
  expectedAmount: number;
  lineItems: QuoteLineItem[];
  domain: string;
}
import { EditSubscriptionDialog } from "@/components/features/subscriptions/edit-subscription-dialog";
import { BillingScheduleCard } from "@/components/features/subscriptions/billing-schedule-card";
import { CancelSubscriptionDialog, cancelNote } from "@/components/features/subscriptions/cancel-subscription-dialog";
import { useItems } from "@/lib/queries/items";
import { subscriptionCogs, cogsBadge, cogsTotals } from "@/lib/vendor/cogs";
import { LicenseLeakageCard } from "@/components/features/subscriptions/license-leakage-card";
import { SeatRequestsCard } from "@/components/features/subscriptions/seat-requests-card";
import { useSeatRequests, useAmendments } from "@/lib/queries/seat-requests";
import { AmendmentHistory } from "@/components/features/subscriptions/amendment-history";
import { LateChargesPreview } from "@/components/features/late-charges/customer-late-charges";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { localDateISO } from "@/lib/leads/outcomes";
import { ImportSubscriptionsDialog } from "@/components/features/subscriptions/import-subscriptions-dialog";
import { ReconcileGoogleDialog } from "@/components/features/subscriptions/reconcile-google-dialog";
import { ImportGoogleSubsDialog } from "@/components/features/subscriptions/import-google-subs-dialog";
import { MarginAlertsCard } from "@/components/features/subscriptions/margin-alerts-card";
import Link from "next/link";
import { toast } from "sonner";
import { toastError, describeError } from "@/lib/errors/toast-error";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { downloadCSV } from "@/lib/csv";
import { bulkOutcomeMessage, type BulkFailure } from "@/lib/customers/bulk-outcome";
import { SubscriptionsBulkBar } from "@/components/features/subscriptions/subscriptions-bulk-bar";
import { PORTABLE_SUBSCRIPTION_HEADERS, portableSubscriptionRow } from "@/lib/export/subscription-portable";
import { useCustomers } from "@/lib/queries/customers";
import { usePrimaryContacts } from "@/lib/queries/contacts";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import { subscriptionExceptions } from "@/lib/subscriptions/exceptions";
import { term, renewalDistance, termValue, termValueLabel } from "@/lib/subscriptions/renewal-display";
import { useQuotes } from "@/lib/queries/quotes";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Subscription } from "@/lib/supabase/database.types";

/* R-317: ?price=missing on the list (Reports links here). */
const PRICE_FILTERS = ["", "missing"] as const;
type PriceFilter = (typeof PRICE_FILTERS)[number];

// Vendor pill — capitalised label + a stable colour per vendor (Google/Microsoft
// blue, Zoho green) so the vendor reads at a glance.
function vendorMeta(v: string): { label: string; kind: "info" | "success" | "muted" } {
  const s = (v ?? "").toLowerCase();
  if (s === "google")    return { label: "Google",    kind: "info" };
  if (s === "microsoft") return { label: "Microsoft", kind: "info" };
  if (s === "zoho")      return { label: "Zoho",      kind: "success" };
  return { label: v ? v.charAt(0).toUpperCase() + v.slice(1) : "—", kind: "muted" };
}

/* The margin heuristic that used to live here — `cost = mrr × 0.83`, commented
   "Heuristic: ~17% margin on typical reseller subs" — is gone. It returned 17% for
   every subscription in the app, not because they earned 17% but because the number
   was defined to be 17%, and it sorted a column, coloured a badge and fed a KPI tile.
   Cost now comes from lib/vendor/cogs.ts: the vendor's own bill where one has been
   recorded, the catalogue otherwise, and "Unknown" when neither exists. */

/**
 * The facts about a subscription that stay invisible until they matter —
 * auto-renew off, cadence position, money owed, idle seats, suspension,
 * write-off. Every one of these fields was previously unreachable from this
 * page, on mobile and on desktop alike.
 *
 * The decision lives in `lib/subscriptions/exceptions.ts` and is tested there,
 * because none of these branches fire against today's production data — a bug
 * in any of them would look exactly like silence on screen.
 */
function SubExceptions({ sub, size = "sm" }: { sub: Subscription; size?: "sm" | "md" }) {
  const flags = subscriptionExceptions(sub);
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => (
        <Badge key={f.key} kind={f.tone} size={size} dot title={f.title}>
          {f.label}
        </Badge>
      ))}
    </>
  );
}

/**
 * A clickable column header.
 *
 * A `<button>` inside the `<th>`, not a click handler on the `<th>` itself: a th is not
 * focusable and does not respond to Enter, so a header-as-div is a sort the keyboard
 * cannot reach. `aria-sort` on the th is what a screen reader reads out, and it has to
 * live on the cell rather than the button.
 */
function SortHeader({
  label, col, sort, onSort, align = "left", title, hint,
}: {
  label: string;
  col: SubSortKey;
  sort: SubSort | null;
  onSort: (key: SubSortKey) => void;
  align?: "left" | "right";
  title?: string;
  /** Second line under the label, e.g. what the two seat numbers mean. */
  hint?: string;
}) {
  const active = sort?.key === col;
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-2xs font-semibold uppercase tracking-wider",
        align === "right" ? "text-right" : "text-left",
        active ? "text-ink" : "text-ink-3",
      )}
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        title={title ?? `Sort by ${label.toLowerCase()}`}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink transition-colors cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm",
          align === "right" ? "flex-row-reverse" : "",
        )}
      >
        <span>
          {label}
          {hint && <span className="block normal-case font-normal tracking-normal text-3xs">{hint}</span>}
        </span>
        {/* The arrow only appears on the sorted column. An arrow on every header is a
            row of arrows, and none of them says which one is in force. */}
        <span className={cn("text-3xs", active ? "opacity-100" : "opacity-0")} aria-hidden="true">
          {active && sort!.dir === "asc" ? "↑" : "↓"}
        </span>
      </button>
    </th>
  );
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  /* The catalogue is what makes a margin real rather than a multiplier — see
     lib/vendor/cogs.ts. Empty while it loads, which resolves to "Unknown" rather
     than to a wrong number. */
  const { data: catalogItems } = useItems();
  const catalog = React.useMemo(() => catalogItems ?? [], [catalogItems]);
  const { data: seatRequestRows, refetch: refetchRequests } = useSeatRequests({ pendingOnly: true });
  const seatRequests = React.useMemo(() => seatRequestRows ?? [], [seatRequestRows]);
  const { data: trials } = useActiveTrials();
  /* ─── THE CONTRACTED ANNUAL, SO THE SCREEN STOPS INVENTING RUPEES ──────────
     `subscriptions` stores only a MONTHLY figure, so this page was rebuilding the annual
     as mrr × 12 — and a support plan quoted at ₹2,000/yr came back as ₹2,004, because
     round(2000 / 12) × 12 = 2004. Reported live by Pardeep. It is invisible on ₹45,360,
     which divides evenly by 12, and wrong on anything that does not — so the Google line
     was right while the support line beside it was not.

     The originating quote still holds the negotiated annual rate and the subscription
     carries `quote_id`. Keyed by quote AND plan name, because one quote routinely carries
     a licence line and a support line at completely different prices. */
  const { data: allQuotes } = useQuotes();
  const contractedAnnual = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const q of allQuotes ?? []) {
      const lines = Array.isArray(q.line_items) ? q.line_items : [];
      for (const l of lines as { name?: string | null; qty?: number | null; rate?: number | null }[]) {
        const name = (l.name ?? "").trim().toLowerCase();
        const amt  = (l.rate ?? 0) * (l.qty ?? 0);
        if (name && amt > 0) m.set(`${q.id}|${name}`, amt);
      }
    }
    return m;
  }, [allQuotes]);
  const annualFor = React.useCallback(
    (sub: { quote_id?: string | null; plan: string }) =>
      sub.quote_id
        ? contractedAnnual.get(`${sub.quote_id}|${sub.plan.trim().toLowerCase()}`) ?? null
        : null,
    [contractedAnnual],
  );
  const [tab, setTab] = useUrlChoice<string>("tab", SUBSCRIPTION_TABS, "all"); // R-118
  /* R-118: the money tiles' exact set (lib/subscriptions/focus.ts) — "" = none. */
  const [focus, setFocus] = useUrlChoice<SubFocus>("focus", SUB_FOCI, "");
  /* R-317: ?price=missing — the active subscriptions with no price, linked from the
     Reports MRR line. Open one to set its plan; until then it adds ₹0 to MRR. */
  const [price, setPrice] = useUrlChoice<PriceFilter>("price", PRICE_FILTERS, "");
  const tabOn = (t: string) => { setFocus(""); setTab(t); };
  const focusOn = (f: SubFocus) => { setTab("all"); setFocus(f); };
  const [vendor, setVendor] = React.useState("all");
  const [search, setSearch] = React.useState("");
  /* R-244: ?q= pre-fills the search — Ctrl+K opens a subscription as the list filtered to it.
     Read once after mount (no useSearchParams: build rule, see ?from_lead below). */
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const q = initialSubscriptionSearch(window.location.search);
    if (q) setSearch(q);
    const onPick = (e: Event) => setSearch(String((e as CustomEvent<string>).detail ?? ""));
    window.addEventListener(SUBSCRIPTION_SEARCH_EVENT, onPick);
    return () => window.removeEventListener(SUBSCRIPTION_SEARCH_EVENT, onPick);
  }, []);
  const [extendSub,  setExtendSub]   = React.useState<Subscription | null>(null);
  const [scheduleSub, setScheduleSub] = React.useState<Subscription | null>(null);
  /** Null = the newest-first default. Set when a column header is clicked. */
  const [sort, setSort] = React.useState<SubSort | null>(null);
  /* First click opens the column the way it is usually asked about; clicking the SAME
     column again flips it. Clicking a third time does not clear — a sort that vanishes
     on a click the operator did not intend as "reset" is worse than one they re-click. */
  const toggleSort = (key: SubSortKey) =>
    setSort((prev) => (prev?.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: defaultDirFor(key) }));
  /** Ticked rows, by subscription id. Held here, not per row, so select-all and Clear
   *  are one state change rather than N. */
  const [pickedIds, setPickedIds] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const clearPicked = () => setPickedIds(new Set());
  const [addSeatsSub, setAddSeatsSub] = React.useState<Subscription | null>(null);
  /** Seats to prefill "Manage seats" with — the leak gap, when opened from a fix button. */
  const [addSeatsPrefill, setAddSeatsPrefill] = React.useState<number | undefined>(undefined);
  /** Open Manage seats for a subscription, optionally with the seat count already right. */
  const openAddSeats = (sub: Subscription, prefill?: number) => {
    setAddSeatsPrefill(prefill);
    setAddSeatsSub(sub);
  };
  const [editSub,     setEditSub]     = React.useState<Subscription | null>(null);
  /* R-455: END a real subscription (customer left) — separate from Delete (wrong entry). */
  const [cancelSub,   setCancelSub]   = React.useState<Subscription | null>(null);
  const delSub = useDeleteSubscription();
  const confirm = useConfirm();
  const handleDeleteSub = async (s: Subscription) => {
    const body = `This removes the subscription (and any draft purchase order for it). `
      + `Only for a wrong or duplicate entry. If the customer is leaving, use Cancel subscription instead — it keeps the record.\n\n`
      + `Blocked if it came from a paid quote — in that case delete the payment in Payments instead (that unwinds it cleanly).`;
    if (await confirm({
      title: `Delete ${s.customer_name}'s "${s.plan}" subscription?`,
      body,
      confirmLabel: "Delete",
      danger: true,
    })) delSub.mutate(s.id);
  };
  const [importOpen,     setImportOpen]     = React.useState(false);
  const [addDirectOpen,  setAddDirectOpen]  = React.useState(false);
  /* R-073: ?from_lead=<lead id> — "Create subscription" on a won deal lands here and opens
     the form filled from that deal. Read once after mount (no useSearchParams: build rule). */
  const [leadPrefill, setLeadPrefill] = React.useState<LeadPrefill | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const leadId = new URLSearchParams(window.location.search).get("from_lead");
    if (!leadId) return;
    let live = true;
    void createClient().from("leads")
      .select("id, company, customer_id, domain, contact_name, contact_email, contact_phone, plan, seats, billing_cycle")
      .eq("id", leadId).maybeSingle()
      .then(({ data }) => {
        if (!live || !data) return;
        setLeadPrefill(prefillFromLead(data));
        setAddDirectOpen(true);
      });
    return () => { live = false; };
  }, []);
  /** Set when onboarding chose "Payment Received" — carries what Record payment needs. */
  const [pendingPayment, setPendingPayment] =
    React.useState<PendingPaymentHandoff | null>(null);

  /**
   * Raise the GST invoice once the money is genuinely recorded.
   *
   * ─── WHY IT IS HERE AND NOT INSIDE THE PAYMENT SHEET ────────────────────────
   * RecordPaymentDialog is opened from several screens. Making it issue a GST document
   * on every success would change all of them at once — including the ones where an
   * invoice already exists. This runs only on the onboarding path that asked for it.
   *
   * ─── ONLY WHEN FULLY PAID ───────────────────────────────────────────────────
   * A part payment must not produce a tax invoice: the receipt voucher record_payment
   * already issued is the correct document for an advance (CGST §31(3)(d)). Invoicing
   * the whole amount against a partial receipt would overstate output GST for the
   * period.
   *
   * ─── AND IT DOES NOT SEND ───────────────────────────────────────────────────
   * Generated, not emailed — Abhishek's instruction, 9 Sep 2026. An invoice that leaves
   * automatically is in the customer's inbox before anyone can notice a wrong amount,
   * and a GST document cannot be recalled. Sending stays a deliberate click.
   */
  /**
   * The payment sheet was closed WITHOUT recording anything.
   *
   * ─── WHY THIS HAS TO SAY SOMETHING ─────────────────────────────────────────
   * The quote has to exist before the sheet opens — record_payment is given a quote id.
   * So dismissing the sheet leaves an accepted quote awaiting payment with no payment
   * and no subscription: a half-finished sale.
   *
   * Measured 9 Sep 2026 on real data: Q-2026-2884 (5 seats, ₹18,691) sat exactly like
   * that for ten minutes while a second attempt was made, and NOTHING on any screen
   * mentioned it. The quote is perfectly usable — recording the payment on it still
   * creates the subscription — but only if the operator knows it is there.
   *
   * Deliberately does NOT delete it (§24 gives a way forward, not a cleanup): deleting
   * a quote somebody may have already sent is worse than naming it.
   */
  /* The sheet calls onRecorded and THEN onOpenChange(false), so a successful payment
     closes it too. Without this flag the close would be read as an abandonment and the
     operator would get "no payment recorded" immediately after paying. A ref, not
     state: it has to be true before the very next call in the same tick. */
  const recordedRef = React.useRef(false);

  const abandonPendingPayment = React.useCallback(() => {
    const p = pendingPayment;
    setPendingPayment(null);
    if (recordedRef.current) { recordedRef.current = false; return; }
    if (!p) return;
    toast.warning(`No payment recorded — ${p.quoteId} is waiting, and no subscription was created yet`, {
      description: `${p.customerName} · ${rupee(p.expectedAmount)} due. Record the payment on the quote to activate the subscription, or delete the quote if it was a mistake.`,
      duration: 12000,
      action: { label: "Open quote", onClick: () => router.push(`/quotes/${p.quoteId}` as Route) },
    });
    refetch();
  }, [pendingPayment, refetch, router]);

  const raiseInvoiceFor = React.useCallback(async (
    quoteId: string,
    res: { isFullyPaid: boolean },
  ) => {
    /* Set BEFORE anything else: the sheet closes right after this returns, and the
       close handler must not mistake a completed payment for an abandoned one. */
    recordedRef.current = true;
    setPendingPayment(null);
    if (!res.isFullyPaid) {
      toast.info("Part payment recorded — the GST invoice is raised once the quote is fully paid.", {
        duration: 7000,
      });
      refetch();
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.rpc("generate_invoice", { p_quote_id: quoteId });
    if (error) {
      /* §24: say what happened, why, and where to finish it by hand. The money is
         already safely recorded — only the document is missing, and the quote page can
         raise it. Never a bare "failed". */
      toast.error("Payment saved, but the GST invoice could not be raised", {
        description: `${describeError(error).message} Open the quote to raise it.`,
        action: { label: "Open quote", onClick: () => router.push(`/quotes/${quoteId}` as Route) },
      });
    } else {
      toast.success(`GST invoice ${String(data ?? "")} raised · subscription is live 🎉`, {
        description: "Not sent yet — open it to email or download the PDF.",
        duration: 8000,
        action: { label: "Open invoice", onClick: () => router.push("/invoices" as Route) },
      });
    }
    refetch();
  }, [refetch, router]);
  const [reconcileOpen,  setReconcileOpen]  = React.useState(false);
  const [helpOpen,       setHelpOpen]       = React.useState(false);
  const [addGoogleOpen,  setAddGoogleOpen]  = React.useState(false);
  /* Both analytics cards start CLOSED (Abhishek, 12 Sep 2026). They are reference, not
     the day's work: this page is opened to act on a subscription, and two tall panels
     above the list pushed the table itself below the fold. Each collapsed header still
     carries its own headline numbers, so nothing is hidden — only unstacked. */
  const [kpiOpen, setKpiOpen] = React.useState(false);
  const [visible, setVisible] = React.useState(60);  // render cap — paginates large lists
  const today = new Date();
  /* One "today" for every folder decision on this page, in IST — a date derived per call
     would let two rows disagree about which day it is across a midnight render. */
  const todayISO = localDateISO(today);
  const daysUntil = (renewal: string | null) =>
    renewal ? daysBetween(today, renewal) : null;

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant.
  const subsByWorkspace = React.useMemo(() => subs ?? [], [subs]);

  /* ── Folder membership comes from ONE tested rule ────────────────────────
     These used to be three inline predicates, and they OVERLAPPED: an active
     subscription renewing in twenty days matched both `active` and `expiring`, so the
     two counts beside each other could not be added. Numbers side by side get added —
     the same arithmetic that made the leads chips unreadable.

     SUB_FOLDERS is a partition now: active | expiring | suspended | ended, every row in
     exactly one, summing to the total. See lib/subscriptions/folders.ts. */
  /* Who serves which customers — lets the search box find a subscription by the person
     you deal with. Shared with the Customers page through the query cache. */
  const { data: contactIndex } = useContactSearchIndex();
  /* For the portable export: the customer's own identity (number, GSTIN, state) and the
     person who receives their invoices. Both are needed to rebuild a customer on import. */
  const { data: customers } = useCustomers();
  const customerIdsForExport = React.useMemo(
    () => [...new Set((subs ?? []).map((x) => x.customer_id).filter((id): id is string => !!id))],
    [subs],
  );
  const { data: primaryContacts } = usePrimaryContacts(customerIdsForExport);

  const filtered = subsByWorkspace.filter((s) => {
    if (tab === "trials") return false;  // trials handled in separate table below
    if (tab !== "all" && folderOf(s, todayISO) !== tab) return false;
    if (focus && !subInFocus(s, focus)) return false;   // the tile's own predicate
    if (price === "missing" && !hasNoPrice(s)) return false;   // R-317
    if (vendor !== "all" && s.vendor !== vendor) return false;
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      if (
        !s.customer_name.toLowerCase().includes(q) &&
        !(s.domain?.toLowerCase().includes(q) ?? false) &&
        !s.plan.toLowerCase().includes(q) &&
        /* ── SEARCH BY THE PERSON, NOT ONLY THE COMPANY ────────────────────
           Abhishek, 18 Sep 2026: "filter customer and subscription who attached with
           single contact". This page knew nothing about contacts at all, so the only
           way to see everything one person looks after was to remember every company
           they are on — which is exactly the thing a person cannot do, and the reason
           a contact may now serve several customers in the first place.

           Matched through the customer, because a subscription belongs to a company
           and the person is attached to the company, not to the plan. */
        !(contactIndex && s.customer_id ? customerMatchesContact(contactIndex, s.customer_id, q) : false)
      ) {
        return false;
      }
    }
    return true;
  });

  /* ── Newest first, except in Expiring ─────────────────────────────────────
     `useSubscriptions` fetches in renewal-date order, which is right for the dashboard
     and for anything asking "what is coming up". On this table the question is usually
     "where is the one I just created", so the default is creation order — Abhishek,
     18 Sep 2026, for every table in the app.

     The Expiring folder keeps renewal order, because that folder IS the deadline view:
     its whole reason to exist is what runs out soonest, and burying next week's renewal
     under a subscription created this morning would defeat it. */
  const ordered = React.useMemo(
    () => {
      /* A clicked column wins over every default, including the Expiring folder's
         renewal order — the operator asked a specific question and the table should
         answer THAT one. Applied over `filtered`, so the tab, vendor pills and search
         still decide WHICH rows; this only decides their order. */
      if (sort) {
        return sortSubscriptions(filtered, sort, (sub) =>
          subscriptionCogs(sub, catalog).marginMonthly);
      }
      return tab === "expiring" ? filtered : newestFirst(filtered);
    },
    [filtered, tab, sort, catalog],
  );

  // Render only the first `visible` rows — avoids hanging on 800+ subscriptions.
  const shown = ordered.slice(0, visible);

  /* ── Bulk actions ──────────────────────────────────────────────────────────
     Each is N independent operations, not one transaction, so every one reports what
     ACTUALLY happened through bulkOutcomeMessage instead of assuming success. Delete is
     the case that makes this necessary: the server refuses any subscription that came
     from a paid quote, so a partial run is the normal outcome, not an edge case.

     Scoped to `shown`, the rendered slice — the same rule the select-all checkbox
     follows. Acting on rows the operator cannot see is how a bulk delete goes wrong. */
  const pickedSubs = React.useMemo(
    () => shown.filter((sub) => pickedIds.has(sub.id)),
    [shown, pickedIds],
  );

  /** Report an outcome on the right channel, and clear only on a clean run. */
  const reportBulk = (done: number, failed: BulkFailure[], verbPast: string) => {
    const m = bulkOutcomeMessage({ done, failed }, verbPast);
    if (m.tone === "success") {
      toast.success(m.title);
      clearPicked();
    } else if (m.tone === "warning") {
      toast.warning(m.title, { description: m.description });
    } else {
      /* description spelled out here, not passed through a variable: §24 is enforced by
         toast-error-ratchet.test.ts, which reads the SOURCE. */
      toast.error(m.title, {
        description: m.description ?? "Nothing was changed. Open the subscriptions to see why.",
      });
    }
    /* A partial or failed run KEEPS the selection: the refused rows are exactly the ones
       still needing attention, and re-ticking them by hand is a punishment for the app
       having done half a job. */
  };

  /* ── THE PORTABLE EXPORT ──────────────────────────────────────────────────
     One builder for both export buttons, joining each subscription to its customer and
     that customer's primary contact. The contact is not decoration: a re-import creates
     a missing customer, and this app refuses to create one without a contact person — so
     a file without it cannot restore. See lib/export/subscription-portable.ts for why
     the monthly rate is written as its own column rather than derived on the way back. */
  const exportRows = React.useCallback((rows: readonly Subscription[]) => {
    const custById = new Map((customers ?? []).map((c) => [c.id, c]));
    return rows.map((sub) => {
      const c = sub.customer_id ? custById.get(sub.customer_id) : undefined;
      const contact = sub.customer_id ? primaryContacts?.get(sub.customer_id) : undefined;
      return portableSubscriptionRow({
        customer_number: c?.customer_number,
        customer_name: sub.customer_name ?? c?.name,
        domain: sub.domain ?? c?.domain,
        gstin: c?.gstin,
        state: c?.state,
        contact_name: contact?.name,
        contact_email: contact?.email,
        contact_phone: contact?.phone,
        plan: sub.plan,
        vendor: sub.vendor,
        seats: sub.seats,
        status: sub.status,
        mrr: sub.mrr,
        outstanding_amount: sub.outstanding_amount,
        start_date: sub.start_date,
        renewal_date: sub.renewal_date,
        vendor_seats: sub.vendor_seats,
      });
    });
  }, [customers, primaryContacts]);

  const bulkExport = () => {
    if (pickedSubs.length === 0) return;
    downloadCSV(
      `subscriptions-${new Date().toISOString().slice(0, 10)}.csv`,
      [...PORTABLE_SUBSCRIPTION_HEADERS],
      exportRows(pickedSubs),
    );
    toast.success(`Exported ${pickedSubs.length} subscription${pickedSubs.length === 1 ? "" : "s"} to CSV`, {
      description: "Includes the customer and contact details, so this file can be imported back.",
    });
  };

  /**
   * Create-or-reuse each renewal quote and email it.
   *
   * The same endpoint the Renewals page's own bulk button uses, and the same one the
   * per-row "Send now" uses — so a renewal sent from here is byte-identical to one sent
   * from there, and `createOrGetRenewalQuote` keeps it idempotent: pressing this twice
   * re-sends the SAME quote rather than minting a second one at a second price.
   */
  const bulkSendRenewals = async () => {
    if (pickedSubs.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    let stub = false;
    const failed: BulkFailure[] = [];
    for (const sub of pickedSubs) {
      try {
        const res = await fetch("/api/renewals/send-now", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription_id: sub.id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          failed.push({ name: cleanDisplayName(sub.customer_name), reason: json?.error ?? `The server refused it (${res.status}).` });
          continue;
        }
        done += 1;
        if (json?.email_mode === "stub") stub = true;
      } catch (e) {
        failed.push({ name: cleanDisplayName(sub.customer_name), reason: (e as Error).message });
      }
    }
    setBulkBusy(false);
    refetch();
    reportBulk(done, failed, "Sent a renewal quote to");
    /* Said separately and only when true. A run that "succeeded" while the mailer is in
       stub mode has logged everything and delivered nothing, and an operator who thinks
       fifteen customers were emailed will not chase them. */
    if (stub && done > 0) {
      toast.warning("Email is in stub mode — nothing actually left the building", {
        description: "The quotes were created and the sends were logged, but no mail was delivered. Set the Resend key under Settings to send for real.",
      });
    }
  };

  const bulkDelete = async () => {
    if (pickedSubs.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    const failed: BulkFailure[] = [];
    for (const sub of pickedSubs) {
      try { await delSub.mutateAsync(sub.id); done += 1; }
      catch (e) { failed.push({ name: cleanDisplayName(sub.customer_name), reason: (e as Error).message }); }
    }
    setBulkBusy(false);
    /* The drawer may be showing one of the deleted rows — it is now a drawer about
       nothing. */
    if (scheduleSub && pickedIds.has(scheduleSub.id)) setScheduleSub(null);
    reportBulk(done, failed, "Deleted");
  };
  const hasMore = ordered.length > shown.length;
  React.useEffect(() => { setVisible(60); }, [tab, vendor, search]);

  // Trial-specific filter (for the Trials tab)
  const filteredTrials = (trials ?? []).filter((t) => {
    if (vendor !== "all") {
      // Derive vendor from plan label (trials don't have explicit vendor column)
      const pl = (t.plan ?? "").toLowerCase();
      const v  = pl.includes("google") ? "google"
              : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
              : pl.includes("zoho") ? "zoho" : "other";
      if (v !== vendor) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !t.company.toLowerCase().includes(q) &&
        !(t.domain?.toLowerCase().includes(q) ?? false) &&
        !(t.plan?.toLowerCase().includes(q) ?? false)
      ) {
        return false;
      }
    }
    return true;
  });
  /* ── j / k over the table ─────────────────────────────────────────────────
     `count` is `shown`, the RENDERED slice — not `filtered`. This list paginates at 60
     rows, and keying against the full filtered length would let j walk the selection into
     rows that are not on the page, where Enter opens a subscription the operator never
     saw highlighted. */
  const subKeys = useListKeys({
    count: shown.length,
    /* Opens THIS SUBSCRIPTION, not its customer — same as clicking the row.
       See the row's onClick for why. */
    onOpen: (i) => {
      const s = shown[i];
      if (s) setScheduleSub(s);
    },
  });
  const selectedSubRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedSubRef.current?.scrollIntoView({ block: "nearest" });
  }, [subKeys.index]);

  const folderCount = folderCounts(subsByWorkspace, todayISO);

  /* All + the four lifecycle folders, then Trials LAST and visibly apart.
     Trials are a different table entirely — they are not subscriptions — so putting
     them in the middle of a partition invited exactly the addition the partition
     exists to prevent. */
  const tabs: TabBarItem[] = [
    { id: "all", label: "All", count: subsByWorkspace.length },
    ...SUB_FOLDERS.map((f) => ({
      id: f.id,
      label: f.label,
      count: folderCount[f.id],
      dot: f.dot,
    })),
    { id: "trials", label: "Trials (separate)", count: trials?.length ?? 0, dot: "amber" as const },
  ];

  // KPIs
  const activeSubs = subsByWorkspace.filter((s) => subInFocus(s, "active"));
  const activeMRR = activeSubs.reduce((s, x) => s + x.mrr, 0);
  const activeARR = activeMRR * 12;
  const totalSeats = activeSubs.reduce((s, x) => s + x.seats, 0);
  const usedSeats = activeSubs.reduce((s, x) => s + x.used, 0);
  /* Margin from real cost. Subscriptions whose cost is unknown are EXCLUDED from the
     total rather than counted as free — including them would inflate the margin by
     exactly the amount nobody has measured. `marginUnknownCount` puts that on screen
     so the tile is not read as covering everything. */
  const cogsRows = activeSubs.map((s) => subscriptionCogs(s, catalog));
  const cogsRollup = cogsTotals(cogsRows);
  const monthlyMargin = cogsRollup.marginMonthly;
  const annualMargin = monthlyMargin * 12;
  const marginUnknownCount = cogsRollup.unknownCount;
  const marginEstimatedCount = cogsRollup.estimatedCount;
  /* Weighted by revenue, not a mean of percentages: averaging percentages lets a
     ₹500 subscription move the figure as much as a ₹5,00,000 one. */
  const knownMrr = cogsRows.reduce((a, c, i) => a + (c.monthlyCost == null ? 0 : activeSubs[i].mrr), 0);
  const avgMarginPct = knownMrr > 0 ? Math.round((monthlyMargin / knownMrr) * 100) : 0;
  const atRiskCount = subsByWorkspace.filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).length;
  const atRiskMRR = subsByWorkspace.filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).reduce((s, x) => s + x.mrr, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Subscriptions</h1>
          <p className="text-sm text-ink-3 mt-1">All active + expired across vendors</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setAddDirectOpen(true)}
            title="1-Click Onboard Subscription: Auto-syncs Customer CRM, Quote/Invoice & Active Subscription"
          >
            Add Subscription
          </Button>
          {/* ── "MATCH REAL MAILBOXES" WAS REMOVED HERE — 21 Sep 2026 ─────────
              There used to be a second button beside this one, reading a customer's
              Google Admin USER EXPORT and comparing the mailboxes that exist against
              what we bill. Abhishek removed it, and was right to:

              A user export is a list of every employee's name and address at a
              customer's company. Delegated admin rights make it POSSIBLE; they do not
              make it ours to take. Under DPDP that is the customer's staff's personal
              data being pulled into the reseller's own tooling, and no customer agreed
              to that when they bought mailboxes. The dialog read the file in the browser
              and saved nothing, which helped — but the export itself happens before the
              app ever sees it, so no code change could make it appropriate.

              Nothing about MONEY was lost. Both money questions — are we paying for
              seats we do not bill, is a customer paying for seats they do not have — are
              answered by the button below, from a file containing only domains and
              counts. What went is the churn signal ("bought 50, only 30 in use"), which
              is genuinely useful and is not worth handling staff PII for.

              If that signal is wanted later, the Google Admin SDK reports licence
              ASSIGNMENT COUNTS per domain — numbers, no names, no addresses. Same
              insight, none of the exposure. Do it that way; do not restore this.

              Deleted with it: licence-audit-dialog.tsx, lib/subscriptions/licence-audit.ts
              and its tests. They are in git history if the parsing is ever wanted. */}
          <Button
            icon="refresh"
            onClick={() => setReconcileOpen(true)}
            title="Upload the reseller-console export — compares what Google invoices you against what you bill the customer."
          >
            Match Google&apos;s bill
          </Button>
          <Button icon="upload" onClick={() => setImportOpen(true)}>Import CSV</Button>
        </div>
      </div>

      {/* Collapsible Subscriptions Analytics Banner */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Subscriptions Revenue Analytics</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2 font-mono font-medium">MRR: <b className="text-amber-ink">{rupee(activeMRR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">ARR: <b className="text-emerald">{rupee(activeARR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Seats: <b className="text-ink">{usedSeats}/{totalSeats}</b></span>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline space-y-3 bg-paper">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <button type="button" onClick={() => focusOn("active")} aria-pressed={focus === "active"} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active MRR</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(activeMRR, { compact: true })}</p>
                </button>
                <button type="button" onClick={() => focusOn("active")} aria-pressed={focus === "active"} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active ARR</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(activeARR, { compact: true })}</p>
                </button>
                <button type="button" onClick={() => focusOn("active")} aria-pressed={focus === "active"} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Margin (ARR)</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(annualMargin, { compact: true })} <span className="text-xs text-ink-3 font-normal">({avgMarginPct}%)</span></p>
                  {/* A total that silently drops the unmeasured rows reads as covering
                      everything. Both counts are stated so it cannot. */}
                  {marginUnknownCount > 0 && (
                    <p className="mt-0.5 text-3xs leading-snug text-amber-ink">
                      {marginUnknownCount} excluded — no cost
                    </p>
                  )}
                  {marginEstimatedCount > 0 && (
                    <p className="mt-0.5 text-3xs leading-snug text-ink-3">
                      {marginEstimatedCount} from catalogue, not vendor bills
                    </p>
                  )}
                </button>
                <button type="button" onClick={() => tabOn("all")} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Total Subscriptions</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{subsByWorkspace.length} <span className="text-xs text-emerald font-normal">({folderCount.active + folderCount.expiring} live)</span></p>
                </button>
                <button type="button" onClick={() => focusOn("active")} aria-pressed={focus === "active"} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Seats In Use</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{usedSeats} <span className="text-xs text-ink-3 font-normal">/ {totalSeats}</span></p>
                </button>
                <button type="button" onClick={() => tabOn("trials")} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active Trials</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{trials?.length ?? 0}</p>
                </button>
              </div>

              {/* Renewal intelligence */}
              {atRiskCount > 0 && (
                <GeminiCard
                  title="Renewal intelligence"
                  actions={
                    <Button size="sm" variant="primary" icon="mail" onClick={() => router.push("/renewals" as never)}>Bulk renewal email</Button>
                  }
                  compact
                >
                  <b>{atRiskCount} subscription{atRiskCount === 1 ? "" : "s"} expiring in next 30 days.</b>{" "}
                  Worth {rupee(atRiskMRR, { compact: true })} MRR — start renewal conversations now.
                </GeminiCard>
              )}
            </div>
          )}
        </div>
      )}

      {/* Margin at risk — losses / thin margins at today's vendor cost, plus the
          subscriptions whose cost we cannot look up at all. Self-hiding when there
          is nothing to say, so it costs no vertical space on a good day. */}
      {!isLoading && <MarginAlertsCard />}

      {/* Customers asking for seats. Approving applies them and raises the quote. */}
      {!isLoading && (
        <SeatRequestsCard
          requests={seatRequests}
          subscriptions={subsByWorkspace}
          onDecided={() => { void refetchRequests(); void refetch(); }}
        />
      )}

      {/* Revenue retention MOVED to Accounting → SaaS Metrics on 12 Sep 2026. That page
          already carries the same six-part decomposition in its MRR waterfall and can only
          print "Not tracked" for Expansion and Contraction; this card supplies both, so the
          two belong together. Subscriptions is an operating list — a period-over-period
          revenue comparison is not something anybody acts on here. */}

      {/* Seats the vendor bills us for vs seats we bill the customer. */}
      {!isLoading && subsByWorkspace.length > 0 && (
        <LicenseLeakageCard
          subscriptions={subsByWorkspace}
          catalog={catalog}
          onReconcile={() => setReconcileOpen(true)}
          onBillGap={(sub, seats) => openAddSeats(sub, seats)}
        />
      )}

      {/* Trials in progress — virtual subs */}
      {!isLoading && trials && trials.length > 0 && tab !== "trials" && (
        <Card
          title="Trials in progress"
          sub={`${trials.length} trial${trials.length === 1 ? "" : "s"} active · seats provisioned, billing pending`}
          className="mb-4"
        >
          <ul className="divide-y divide-hairline -my-1">
            {trials.map((t) => {
              const dr = t.days_remaining ?? 0;
              return (
                <li key={t.id} className="py-2">
                  <Link
                    href={`/leads?lead=${t.id}` as never}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 hover:bg-paper-2/40 -mx-2 px-2 py-1.5 rounded transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{t.company}</p>
                      <p className="text-2xs text-ink-3 truncate flex items-center gap-2">
                        {t.domain && <span className="font-mono">{t.domain}</span>}
                        <span>·</span>
                        <span>{t.plan?.replace(/^google-workspace-/, "Google Workspace ").replace(/-/g, " ")}</span>
                        <span>·</span>
                        <span className="tabular-nums">{t.seats ?? 0} seats</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Trial ends</p>
                      <p className="text-xs tabular-nums text-ink-2">
                        {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                      </p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : `${dr}d left`}
                    </Badge>
                    <Button size="sm" variant="primary" icon="check_circle">
                      Convert
                    </Button>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Sticky Horizontal TabBar + Vendor Filter + Search */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
          {focus && (
            <FocusBanner label={SUB_FOCUS_LABEL[focus]} count={filtered.length} onClear={() => setFocus("")} />
          )}
          {price === "missing" && (
            <FocusBanner
              label="No price — active, ₹0 MRR (open one and set its plan)"
              count={filtered.length}
              onClear={() => setPrice("")}
            />
          )}
          <TabBar className="overflow-y-hidden" value={tab} onChange={tabOn} items={tabs} />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            {/* Vendor pills and search sit TOGETHER on the left — they are one act
                ("narrow the list"), and `justify-between` across three children used to
                strand the search box alone in the middle of the bar. Export stays right:
                it acts on the result, not on the filtering. */}
            <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
            <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5">
              {[
                { value: "all", label: "All Vendors" },
                { value: "google", label: "Google" },
                { value: "microsoft", label: "Microsoft" },
                { value: "zoho", label: "Zoho" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setVendor(opt.value)}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer",
                    vendor === opt.value ? "bg-paper text-ink shadow-xs font-semibold" : "text-ink-3 hover:text-ink"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="w-full sm:w-64">
              <Input
                prefix={<Icon name="search" size={14} />}
                aria-label="Search subscriptions"
                placeholder="Customer, contact, plan, domain…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            </div>
            {/* Data-portability (audit B7). */}
            <Button
              variant="outline"
              icon="download"
              onClick={() => {
                downloadCSV(`subscriptions-${new Date().toISOString().slice(0, 10)}.csv`, [...PORTABLE_SUBSCRIPTION_HEADERS], exportRows(subs ?? []));
                toast.success(`Exported ${(subs ?? []).length} subscriptions to CSV`, {
                  description: "Includes the customer and contact details, so this file can be imported back.",
                });
              }}
            >
              <span className="hidden md:inline">Export</span>
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load subscriptions"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5, 6].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && subs && subs.length === 0 && (
        <EmptyState
          icon="refresh"
          title="No subscriptions yet"
          body="Subscriptions are created automatically when an accepted quote moves to provisioning. Start by creating a quote."
          action={
            <Button asChild variant="primary" icon="file">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- pre-existing plain <a> (full navigation), kept as-is by the Next 15 upgrade; eslint-plugin-next 15 now also scans app/ */}
              <a href="/quotes/new">Create a quote</a>
            </Button>
          }
        />
      )}

      {/* Adaptive card list — phones, tablets, and medium viewports (< 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {shown.map((s) => {
            const dl = daysUntil(s.renewal_date);
            const t  = term(s.start_date, s.renewal_date);
            const vm = vendorMeta(s.vendor);
            /* Seat gap only — the money needs the catalogue, and this card deliberately
               shows no margin figure (see the note further down about estimateMargin). */
            const cardLeak = assessLeakage({
              vendorSeats: s.vendor_seats,
              billedSeats: s.seats,
              assignedSeats: s.used,
              costPerSeatMonth: null,
              pricePerSeatMonth: null,
            });
            return (
              /* Tappable, same as the desktop row. The card carried no action at all,
                 so on a phone a subscription could be read and never opened — every
                 detail lived behind a menu the card does not have. 44px is met by the
                 card's own height. */
              <li
                key={s.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${s.plan} for ${cleanDisplayName(s.customer_name)}`}
                onClick={() => setScheduleSub(s)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScheduleSub(s); } }}
                className="bg-paper border border-hairline rounded-lg p-3 cursor-pointer hover:bg-paper-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              >
                {/* Who they are, and what they pay */}
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{cleanDisplayName(s.customer_name)}</p>
                    <DomainCell sub={s} compact />
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(s.mrr)}</p>
                    {/* Same shape as the table: vendor / billed, with the problem named
                        underneath. §20 — a number that exists only on the desktop table
                        is a number half the users never see. */}
                    {/* Same single comparison as the table: Google / you. */}
                    <p className="text-3xs text-ink-3">/mo · {s.seats} seats</p>
                    {cardLeak.kind !== "unknown" && (
                      <p className={cn(
                        "text-3xs font-semibold uppercase tracking-wider",
                        cardLeak.kind === "under_billed" ? "text-rose"
                          : cardLeak.kind === "over_billed" ? "text-amber-ink"
                          : "text-emerald",
                      )}>
                        {s.vendor_seats} / {s.seats} ·{" "}
                        {cardLeak.kind === "under_billed" ? "leaking"
                          : cardLeak.kind === "over_billed" ? "over-billed"
                          : "matches"}
                      </p>
                    )}
                  </div>
                </div>

                {/* Plan wraps rather than truncates — on a phone this is the
                    only place the plan name appears (§20: don't hide data). */}
                <p className="text-xs text-ink-2 mb-2 break-words leading-snug">{s.plan}</p>

                {/* Vendor, and the term with what renewal actually bills —
                    both desktop-only until now.

                    NO MARGIN BADGE HERE, deliberately. `estimateMargin()` is
                    `mrr * 0.83`, a hardcoded heuristic, so it returns 17% for
                    every subscription that has ever existed. Putting it on the
                    card would place a fabricated constant next to real numbers
                    and imply cost data is tracked. Same rule as the seat-
                    utilisation gate: don't assert what isn't measured. */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge kind={vm.kind} size="sm" dot>{vm.label}</Badge>
                  {t && (
                    <Badge kind="muted" size="sm"
                           title={`${t.label} term — ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)} invoiced at each renewal`}>
                      {t.label}{t.months > 1 ? ` · ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)}` : ""}
                    </Badge>
                  )}
                </div>

                {/* Status, anything abnormal, and the renewal clock. The day
                    count is always shown — see renewalDistance() for why. */}
                <div className="flex items-end justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <Badge
                      kind={
                        s.status === "active"    ? "success" :
                        s.status === "paused"    ? "warning" :
                        s.status === "cancelled" ? "danger"  : "muted"
                      }
                      size="sm"
                      dot
                    >
                      {s.status}
                    </Badge>
                    <SubExceptions sub={s} />
                  </div>
                  <div className="text-right shrink-0">
                    {/* The date needs saying what it IS. On desktop the column
                        header does that job; the card has no header, so a bare
                        date could read as "started", "paid" or "expires". */}
                    <p className="text-3xs uppercase tracking-wider text-ink-3 leading-none mb-0.5">Renewal</p>
                    <p className="text-xs text-ink-2 tabular-nums">
                      {s.renewal_date ? formatDate(s.renewal_date) : "—"}
                    </p>
                    {dl !== null && (
                      <p className={cn(
                        "text-3xs tabular-nums",
                        dl <= 7  ? "text-rose font-medium"     :
                        dl <= 30 ? "text-amber-ink font-medium" : "text-ink-3"
                      )}>
                        {renewalDistance(dl)}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Desktop table — viewports >= 1280px */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden xl:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  {/* ── Select-all covers the rows ON SCREEN, not the whole filtered set ──
                      This list paginates at 60. A checkbox that silently selected 800 rows
                      and then deleted them is the failure this narrower promise avoids —
                      the operator can see everything the tick applies to. Indeterminate
                      when only some are picked, so "all" never lies. */}
                  <th className="px-2 py-2.5 w-9">
                    <input
                      type="checkbox"
                      aria-label="Select all subscriptions on screen"
                      className="cursor-pointer accent-amber"
                      checked={shown.length > 0 && shown.every((sub) => pickedIds.has(sub.id))}
                      ref={(el) => {
                        if (el) {
                          const n = shown.filter((sub) => pickedIds.has(sub.id)).length;
                          el.indeterminate = n > 0 && n < shown.length;
                        }
                      }}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setPickedIds((prev) => {
                          const next = new Set(prev);
                          for (const sub of shown) { if (on) next.add(sub.id); else next.delete(sub.id); }
                          return next;
                        });
                      }}
                    />
                  </th>
                  {/* ── CLICK A HEADER TO SORT BY IT ─────────────────────────────
                      Asked for on 21 Sep 2026. The page had a fixed order and no way to
                      ask it a different question — "who is worth most", "what renews
                      first", "where is margin worst" all meant exporting to Excel.

                      Clicking an already-sorted column flips its direction, so the
                      second click is never a surprise. Each column opens the way it is
                      usually asked about — see defaultDirFor: money and seats
                      biggest-first, margin WORST-first, text and dates naturally.

                      Sorting does not disturb the tab, vendor filter or search; it
                      reorders what those already selected. Clearing it returns to the
                      newest-first default. */}
                  <SortHeader label="Customer · Domain" col="customer" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Plan" col="plan" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Vendor" col="vendor" sort={sort} onSort={toggleSort} />
                  <SortHeader
                    label="Seats" col="seats" align="right" sort={sort} onSort={toggleSort}
                    title="What Google bills us for / what we bill the customer"
                    hint="Google / you"
                  />
                  <SortHeader label="MRR" col="mrr" align="right" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Margin" col="margin" align="right" sort={sort} onSort={toggleSort} title="Monthly margin" />
                  <SortHeader label="Started" col="started" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Renewal" col="renewal" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Status" col="status" sort={sort} onSort={toggleSort} />
                  <th className="px-2 py-2.5 text-right w-28"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s, rowIndex) => {
                  const cogs = subscriptionCogs(s, catalog);
                  const mb = cogsBadge(cogs);
                  /* The SAME call the License leakage card makes, so the row and the card
                     can never disagree about whether a subscription is leaking. */
                  const leak = assessLeakage({
                    vendorSeats: s.vendor_seats,
                    billedSeats: s.seats,
                    assignedSeats: s.used,
                    costPerSeatMonth: cogs.perSeatMonth,
                    pricePerSeatMonth: s.seats > 0 ? Math.round(s.mrr / s.seats) : null,
                  });
                  const dl = daysUntil(s.renewal_date);
                  const t  = term(s.start_date, s.renewal_date);
                  const isUrgent = dl !== null && dl >= 0 && dl <= 30;
                  /* Postpaid credit clock. `none` for everything else, so prepaid rows
                     and pre-10-Sep-2026 rows look exactly as they did. */
                  const due = paymentDueState(s.payment_due_date, todayIST(), s.outstanding_amount ?? 0);
                  const kbSelected = rowIndex === subKeys.index;
                  return (
                    <tr
                      key={s.id}
                      ref={kbSelected ? selectedSubRef : undefined}
                      /* aria-selected as well as the tint: a screen reader has to know
                         which row Enter will open. */
                      aria-selected={kbSelected}
                      className={cn(
                        "group border-b border-hairline last:border-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                        kbSelected
                          ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40"
                          /* Overdue postpaid stays lit for as long as the balance is
                             owed. A row that fades back into the list is the exact
                             problem this feature exists to fix. Keyboard selection
                             still wins, so the operator never loses their place. */
                          : due.highlight
                            ? "bg-rose-soft/40 hover:bg-rose-soft/60"
                            : "hover:bg-paper-2/50",
                      )}
                      role="button"
                      tabIndex={0}
                      /* ── A SUBSCRIPTION ROW OPENS THAT SUBSCRIPTION ──────────
                         It used to push to `/customers/{id}`, which is a different
                         object: that page lists ALL of a customer's subscriptions,
                         invoices and payments, and nothing on it says which row you
                         clicked. With one subscription per customer it passed unnoticed;
                         with four it answers a question you did not ask. Reported by
                         Abhishek, 19 Sep 2026.

                         The tell was already in the menu — `⋯ → Open customer` goes to
                         exactly the same place, so the row click was duplicating a menu
                         item instead of doing the obvious thing.

                         A drawer rather than a page, deliberately: the list keeps its
                         tab, vendor filter, search and scroll position, so a rep can
                         open five subscriptions in a row while comparing them. A
                         /subscriptions/[id] page would lose that on every click, and
                         would mostly re-render what the customer page already shows. */
                      aria-label={`Open ${s.plan} for ${cleanDisplayName(s.customer_name)}`}
                      onClick={() => setScheduleSub(s)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScheduleSub(s); } }}
                    >
                      {/* align-middle on EVERY cell in this row, not align-top.
                          A postpaid subscription stacks three badges in the Status
                          column — Active · ₹ due · Pay by — which makes the row taller
                          than its neighbours. With align-top the customer name, plan,
                          seats, MRR and dates all clung to the top of that taller row
                          and left a band of empty space beneath them (reported 11 Sep
                          2026). Centring them vertically makes a tall row read as one
                          line of information rather than a half-filled box. */}
                      {/* ── The guard sits on the DOMAIN, not the whole cell ──────
                          It used to be on this <td>, which made the leftmost column —
                          the customer name, the most natural thing in the row to click —
                          do nothing at all. Asked directly, 19 Sep 2026: "is whole card
                          is clickable or not". It was not, and the one dead spot was the
                          spot people aim for.

                          Only DomainCell needs the guard: it is click-to-edit, so a
                          click meant for the domain input would otherwise also open the
                          drawer over the top of it. */}
                      {/* stopPropagation, or ticking a row would also open its drawer. */}
                      <td className="px-2 py-2.5 align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${cleanDisplayName(s.customer_name)} — ${s.plan}`}
                          className="cursor-pointer accent-amber"
                          checked={pickedIds.has(s.id)}
                          onChange={(e) => {
                            const on = e.target.checked;
                            setPickedIds((prev) => {
                              const next = new Set(prev);
                              if (on) next.add(s.id); else next.delete(s.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        <div className="font-medium text-sm text-ink break-words leading-snug flex items-center gap-2 flex-wrap">
                          <span>{cleanDisplayName(s.customer_name)}</span>
                        </div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <DomainCell sub={s} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-middle">
                        <div className="break-words leading-snug">{s.plan}</div>
                        {t && (
                          <Badge kind="muted" size="sm" className="mt-1"
                                 title={`${t.label} term — ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)} invoiced at each renewal`}>
                            {t.label}{t.months > 1 ? ` · ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)}` : ""}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        {(() => { const vm = vendorMeta(s.vendor); return <Badge kind={vm.kind} dot>{vm.label}</Badge>; })()}
                      </td>
                      {/* Seats — used / licensed; flag low utilisation (unused
                          licences = churn risk at renewal OR a missed upsell). */}
                      {/* `used` is 0 on every row in this database and nothing writes
                          it, so colouring the count as "low usage" asserts idle
                          licences that are almost certainly in use. assessUtilisation()
                          treats an unsynced zero as UNKNOWN and says so in the tooltip
                          — see lib/subscriptions/utilisation.ts. */}
                      {/* ── ONE COMPARISON: WHAT GOOGLE CHARGES vs WHAT YOU BILL ──
                          This column used to carry TWO different pairs of numbers with
                          only a small label to tell them apart — vendor/billed when a
                          row had been reconciled, used/billed when it had not. Abhishek,
                          21 Sep 2026: "its bit confusing here having two much meaning
                          for different things". He was right, and the usage half had no
                          business being here at all:

                          NOTHING in this app fetches seat usage. Every insert path writes
                          `used: 0` and nothing updates it (see lib/subscriptions/
                          utilisation.ts). The only rows that showed a usage figure were
                          four DEMO rows seeded on 8 Sep 2026 — their `used_synced_at` is
                          null, so those numbers came from nowhere. A column whose only
                          real values are fabricated is worse than an empty one.

                          So the column is now one question with one answer: what the
                          vendor bills us against what we bill the customer. That is the
                          comparison tied to money, it is the one the reconcile flow
                          actually populates, and it is the one with a fix attached.

                          Usage still exists on the subscription and still appears in the
                          drawer, where there is room to say what it means. */}
                      <td
                        className="px-3 py-2.5 text-right tabular-nums text-sm align-middle"
                        title={leak.kind === "unknown"
                          ? `Never reconciled against Google, so we do not know how many seats they bill us for. You bill this customer for ${s.seats}.`
                          : leak.message}
                      >
                        <span className={cn(
                          "font-semibold",
                          leak.kind === "under_billed" ? "text-rose"
                            : leak.kind === "over_billed" ? "text-amber-ink"
                            : leak.kind === "aligned" ? "text-ink"
                            : "text-ink-3",
                        )}>
                          {leak.kind === "unknown" ? "—" : s.vendor_seats}
                        </span>
                        <span className="text-ink-3"> / {s.seats}</span>
                        <span className={cn(
                          "block text-3xs font-semibold uppercase tracking-wider",
                          leak.kind === "under_billed" ? "text-rose"
                            : leak.kind === "over_billed" ? "text-amber-ink"
                            : leak.kind === "aligned" ? "text-emerald"
                            : "text-ink-3",
                        )}>
                          {leak.kind === "under_billed" ? "leaking"
                            : leak.kind === "over_billed" ? "over-billed"
                            : leak.kind === "aligned" ? "matches"
                            : "not checked"}
                        </span>
                      </td>
                      {/* MRR — the money, given weight. */}
                      <td className="px-3 py-2.5 text-right tabular-nums align-middle">
                        <span className="font-serif text-[15px] font-semibold text-ink">{rupee(s.mrr)}</span>
                      </td>
                      {/* Margin — colour-coded badge. */}
                      <td className="px-3 py-2.5 text-right align-middle">
                        <div className="flex flex-col items-end gap-0.5">
                          {/* The tooltip carries the SOURCE. A catalogue estimate and a
                              vendor-billed figure look identical on screen and are not
                              equally trustworthy. */}
                          <Badge kind={mb.kind} size="sm" title={mb.title}>{mb.label}</Badge>
                          {cogs.marginMonthly != null && (
                            <span className="text-3xs text-ink-2 tabular-nums font-medium">{rupee(cogs.marginMonthly)}</span>
                          )}
                          {cogs.source === "catalog" && (
                            <span className="text-3xs uppercase tracking-wider text-ink-3">est.</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-middle whitespace-nowrap">{s.start_date ? formatDate(s.start_date) : "—"}</td>
                      <td className="px-3 py-2.5 text-sm align-middle whitespace-nowrap">
                        <div className="text-ink-2">{s.renewal_date ? formatDate(s.renewal_date) : "—"}</div>
                        {dl !== null && s.status !== "expired" && dl >= 0 && dl <= 30 ? (
                          <div className="mt-0.5"><Badge kind={dl <= 7 ? "danger" : "warning"} dot>{dl === 0 ? "Due today" : `In ${dl}d`}</Badge></div>
                        ) : dl !== null && s.status !== "expired" ? (
                          // Beyond 30 days the badge would be alarmist, but the
                          // distance still beats making the reader subtract dates.
                          <div className="mt-0.5 text-2xs text-ink-3 tabular-nums">{renewalDistance(dl)}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        {s.status === "expired" && dl !== null ? (
                          <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>
                        ) : s.status === "active" ? (
                          <Badge kind="success" dot>Active</Badge>
                        ) : (
                          <Badge kind="muted">{s.status}</Badge>
                        )}
                        {/* Outstanding, auto-renew off, cadence position,
                            suspension, write-off — one shared component so the
                            table and the mobile card can never drift apart. */}
                        <div className="flex flex-col items-start gap-1 mt-1 empty:mt-0">
                          <SubExceptions sub={s} size="md" />
                        </div>
                      </td>
                      {/* ── ONE ACTION ON THE ROW, THE REST IN THE DRAWER ────────
                          This cell used to carry a ⋯ menu of seven items. They now live
                          in the drawer the row opens, where they sit beside the
                          subscription they act on — Abhishek, 19 Sep 2026.

                          Renew stays because it is the one thing done WHILE SCANNING:
                          you run down the list looking for what expires soon and send
                          the quote, and it already appears only on expired or urgent
                          rows, so it is not clutter on the other thirteen.

                          Delete was NOT promoted to a row icon, which was the other half
                          of the proposal. It is the most destructive action here — a
                          subscription carries invoices and payments — and it is
                          currently the hardest thing to reach. A one-click trash on
                          every row would make it the easiest thing on the page. It stays
                          two deliberate clicks away, at the bottom of the drawer. */}
                      <td className="px-2 py-2.5 text-right align-middle" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {(s.status === "expired" || isUrgent) && (
                            <Button size="sm" variant={s.status === "expired" ? "danger" : "primary"} icon="refresh" title="Send the renewal quote" onClick={() => router.push("/renewals" as never)}>Renew</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}
      {!isLoading && !error && tab !== "trials" && hasMore && (
        <div className="flex justify-center py-3">
          <Button variant="default" size="sm" onClick={() => setVisible((v) => v + 100)}>
            Show more ({filtered.length - shown.length} left)
          </Button>
        </div>
      )}

      {/* Trials tab — same column layout, virtual-sub rows */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider" title="Licensed seats · seats in use">Seats</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">MRR</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Started</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Trial ends</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filteredTrials.map((t) => {
                  const dr = t.days_remaining ?? 0;
                  const planLabel = (t.plan ?? "")
                    .replace(/^google-workspace-/, "Google Workspace ")
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  const pl = (t.plan ?? "").toLowerCase();
                  const v  = pl.includes("google") ? "google"
                          : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
                          : pl.includes("zoho") ? "zoho" : "other";
                  return (
                    <tr
                      key={t.id}
                      onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                      className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer"
                    >
                      <td className="p-3">
                        <div className="font-medium text-sm text-ink">{t.company}</div>
                        {t.domain && <div className="text-2xs text-ink-3 font-mono">{t.domain}</div>}
                      </td>
                      <td className="p-3 text-sm text-ink-2">{planLabel}</td>
                      <td className="p-3">
                        <Badge kind={v === "zoho" ? "success" : "info"}>{v}</Badge>
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">{t.seats ?? 0}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-3">—</td>
                      <td className="p-3 text-right tabular-nums text-xs text-ink-3">—</td>
                      <td className="p-3 text-sm text-ink-2">
                        {t.trial_started_at ? formatDate(t.trial_started_at) : "—"}
                      </td>
                      <td className="p-3 text-sm">
                        <div>{t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}</div>
                        <div className="mt-0.5">
                          <Badge
                            kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                            size="sm"
                            dot
                          >
                            {dr === 0 ? "today" : `${dr}d left`}
                          </Badge>
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge kind="warning" dot>Trial</Badge>
                      </td>
                      <td className="p-3">
                        <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                          Convert
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}

      {/* Trials tab — mobile card list (phones only). Without this the Trials
          tab was fully BLANK on mobile — the table is `hidden md:block` and the
          main mobile card `<ul>` excludes trials. */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <ul className="md:hidden space-y-2">
          {filteredTrials.map((t) => {
            const dr = t.days_remaining ?? 0;
            const planLabel = (t.plan ?? "")
              .replace(/^google-workspace-/, "Google Workspace ")
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                  className="w-full text-left bg-paper border border-hairline rounded-lg p-3"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">{t.company}</p>
                      {t.domain && <p className="text-2xs text-ink-3 font-mono truncate">{t.domain}</p>}
                      <p className="text-2xs text-ink-3 truncate mt-0.5">{planLabel} · {t.seats ?? 0} seats</p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : `${dr}d left`}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                    <span className="text-2xs text-ink-3">
                      Trial ends {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                    </span>
                    <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                      Convert
                    </Button>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Trials tab — empty state */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="clock"
            title="No active trials"
            body="Trials start at /buy/workspace or via the Start Trial button on the Deal Pipeline page."
            compact
          />
        </div>
      )}

      {/* Filtered empty */}
      {!isLoading && !error && tab !== "trials" && subs && subs.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No subscriptions match"
            body="Try changing tab, vendor filter, or search term."
            action={<Button icon="x" onClick={() => { setTab("all"); setVendor("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Extend dialog */}
      {extendSub && (
        <ExtendSubscriptionDialog
          sub={extendSub}
          open={!!extendSub}
          onOpenChange={(v) => { if (!v) setExtendSub(null); }}
        />
      )}

      {/* Add seats dialog */}
      {addSeatsSub && (
        <AddSeatsDialog
          sub={addSeatsSub}
          initialSeats={addSeatsPrefill}
          open={!!addSeatsSub}
          onOpenChange={(v) => { if (!v) setAddSeatsSub(null); }}
        />
      )}

      {/* ── The subscription drawer ───────────────────────────────────────────
          Since 19 Sep 2026 this is what a ROW opens, not just a menu item. That changed
          what it has to contain: reached from the menu you had just read the row, so
          seats, revenue, status and what is owed were all fresh in your head. Reached by
          clicking the row itself, leaving them out reads as "this subscription has no
          seats". The facts strip below restates them; the schedule and the amendments
          are what the drawer was already for. */}
      {scheduleSub && (
        <Sheet open={!!scheduleSub} onOpenChange={(v) => { if (!v) setScheduleSub(null); }}>
          <SheetContent side="right" className="w-full sm:w-[30rem] sm:max-w-[95vw] overflow-y-auto">
            <SheetHeader className="mb-4">
              <SheetTitle>{cleanDisplayName(scheduleSub.customer_name)}</SheetTitle>
              <SheetDescription>
                {scheduleSub.plan}{scheduleSub.domain ? ` · ${scheduleSub.domain}` : ""}
              </SheetDescription>
            </SheetHeader>
            {/* ── The body carries its own padding ──────────────────────────────
                SheetContent has NO horizontal padding — SheetHeader brings its own p-6
                and BillingScheduleCard is a Card, so both looked fine while the
                amendment list, which is neither, ran flush into the right edge and
                clipped "1 recorded · cannot be edited". Reported 11 Sep 2026.
                Padded here rather than on the shared primitive: other sheets lay out
                their own edge-to-edge content and would gain an indent nobody asked
                for. */}
            <div className="px-6 pb-6">
              {/* ── WHAT TO DO ABOUT THE LEAK, NOT JUST THAT THERE IS ONE ────────
                  The row and the card both learned to SHOW leakage on 21 Sep 2026, and
                  Abhishek's next words were the right ones: "user dont know what action
                  he have to take". A red tag that names a problem and stops is a nag.

                  So this panel does three things in order: states the gap in one
                  sentence, says what it costs, and puts the fix one click away with the
                  number already filled in — the gap is known exactly, so making somebody
                  retype it is just an opportunity to get it wrong.

                  Only for LEAKING. Over-billed is deliberately not given a fix button:
                  it is usually intentional (a customer buying seats ahead of new staff),
                  so a button offering to "correct" it would be pushing the operator
                  toward undoing something they meant to do. */}
              {(() => {
                const leak = assessLeakage({
                  vendorSeats: scheduleSub.vendor_seats,
                  billedSeats: scheduleSub.seats,
                  assignedSeats: scheduleSub.used,
                  costPerSeatMonth: subscriptionCogs(scheduleSub, catalog).perSeatMonth,
                  pricePerSeatMonth: scheduleSub.seats > 0 ? Math.round(scheduleSub.mrr / scheduleSub.seats) : null,
                });
                if (leak.kind !== "under_billed" || leak.seatGap == null) return null;
                const gap = leak.seatGap;
                const sub = scheduleSub;
                return (
                  <div className="mb-4 rounded-lg border border-rose/40 bg-rose-soft/40 p-3">
                    <p className="text-xs font-semibold text-rose mb-1">
                      Leaking {gap} seat{gap === 1 ? "" : "s"}
                    </p>
                    <p className="text-2xs leading-snug text-ink-2">
                      Google bills you for {sub.vendor_seats} seats. This customer is billed for {sub.seats}.
                      {leak.monthlyImpact == null
                        ? " This plan has no catalogue cost, so the rupee amount is unknown — add it under Products."
                        : ` That is ${rupee(leak.monthlyImpact)}/month of margin going out.`}
                    </p>
                    <p className="text-2xs leading-snug text-ink-3 mt-1.5">
                      Fix it either way: bill the extra seat{gap === 1 ? "" : "s"} below, or remove
                      {gap === 1 ? " it" : " them"} in the Google admin console if nobody is using
                      {gap === 1 ? " it" : " them"}.
                    </p>
                    <Button
                      variant="primary"
                      size="sm"
                      icon="plus"
                      className="mt-2.5"
                      onClick={() => { setScheduleSub(null); openAddSeats(sub, gap); }}
                    >
                      Bill the {gap} extra seat{gap === 1 ? "" : "s"}
                    </Button>
                  </div>
                );
              })()}

              {/* Four facts, before the forecast. Two columns so each stays on one line
                  at the 30rem the sheet is; `rupee()` output is the widest of them. */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4 pb-4 border-b border-hairline">
                {subscriptionFacts(scheduleSub).map((f) => (
                  <div key={f.label}>
                    <dt className="text-2xs uppercase tracking-wider text-ink-3 mb-0.5">{f.label}</dt>
                    <dd className={cn(
                      "text-sm tabular-nums",
                      f.tone === "owed" ? "text-rose font-semibold" : "text-ink",
                    )}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <BillingScheduleCard subscription={scheduleSub} todayISO={todayIST()} />
              {/* The contract's own history, next to its schedule — the two questions a
                  rep opens this drawer with are "what will they be billed?" and "what
                  changed?". */}
              <AmendmentHistorySection subscription={scheduleSub} />
              {/* R-530: late fee On/Off for this subscription + charges on its invoices. */}
              <LateChargesPreview level="subscription" id={scheduleSub.id} />

              {/* ── The actions, where the subscription is ────────────────────
                  Moved off the row's ⋯ menu on 19 Sep 2026. They act on this
                  subscription, so they belong beside it rather than behind a menu on a
                  list — and a seven-item menu on every row was most of that row's
                  clutter for something few people opened.

                  "Billing schedule" is not among them: this drawer IS the billing
                  schedule, so the item would have reopened the thing it was clicked in.

                  Each one CLOSES the drawer first. Every action below either navigates
                  away or opens its own dialog, and a dialog stacked on an open sheet
                  leaves two dismissable layers over the page — close the wrong one and
                  the form is still there, behind. */}
              <div className="mt-6 pt-4 border-t border-hairline">
                <p className="text-2xs uppercase tracking-wider text-ink-3 mb-2">Actions</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    icon="plus"
                    onClick={() => { const sub = scheduleSub; setScheduleSub(null); openAddSeats(sub); }}
                  >
                    Manage seats
                  </Button>
                  <Button
                    icon="clock"
                    onClick={() => { const sub = scheduleSub; setScheduleSub(null); setExtendSub(sub); }}
                  >
                    Extend term
                  </Button>
                  {scheduleSub.customer_id && (
                    <Button
                      icon="users"
                      onClick={() => { const id = scheduleSub.customer_id; setScheduleSub(null); router.push(`/customers/${id}` as never); }}
                    >
                      Open customer
                    </Button>
                  )}
                  {/* The statement, one click from here. A renewal conversation is
                      exactly when somebody asks "and what do they actually owe us?", and
                      the answer used to be four clicks away through Accounting with the
                      customer picked by hand. ?customer= seeds the picker; the Tally XML
                      and CSV exports on that page are the ones a CA imports. */}
                  {scheduleSub.customer_id && (
                    <Button
                      icon="book"
                      onClick={() => { const id = scheduleSub.customer_id; setScheduleSub(null); router.push(`/accounting/ledger?customer=${id}` as never); }}
                    >
                      Statement
                    </Button>
                  )}
                  <Button
                    icon="edit"
                    className="col-span-2"
                    onClick={() => { const sub = scheduleSub; setScheduleSub(null); setEditSub(sub); }}
                  >
                    Correct details
                  </Button>
                </div>

                {/* ── Kept at arm's length, on purpose ──────────────────────────
                    The other half of the 19 Sep proposal was to promote this to a trash
                    icon on every row. It was declined: a subscription carries invoices
                    and payments, and the design that makes the most destructive action
                    the easiest one to reach is the wrong way round. It sits last, below
                    a rule, visually apart from the five above, and still asks for
                    confirmation naming the customer and the plan. */}
                <div className="mt-4 pt-3 border-t border-hairline space-y-2">
                  {/* R-455: two different things, two buttons. Cancel = the customer is
                      leaving (keeps the record, leaves MRR/renewals). Delete = this entry
                      should never have existed. The old single "Cancel / delete" button only
                      deleted, and was blocked for every paid sale. */}
                  {scheduleSub.status === "cancelled" ? (
                    <p className="text-2xs text-ink-3">{cancelNote(scheduleSub)}</p>
                  ) : (
                    <Button
                      variant="danger"
                      icon="x"
                      className="w-full"
                      onClick={() => { const sub = scheduleSub; setScheduleSub(null); setCancelSub(sub); }}
                    >
                      Cancel subscription
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    icon="trash"
                    className="w-full text-rose"
                    onClick={() => { const sub = scheduleSub; setScheduleSub(null); handleDeleteSub(sub); }}
                  >
                    Delete (wrong entry)
                  </Button>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {cancelSub && (
        <CancelSubscriptionDialog
          sub={cancelSub}
          open={!!cancelSub}
          onOpenChange={(v) => { if (!v) setCancelSub(null); }}
        />
      )}

      {/* Correct subscription details */}
      {editSub && (
        <EditSubscriptionDialog
          sub={editSub}
          open={!!editSub}
          onOpenChange={(v) => { if (!v) setEditSub(null); }}
        />
      )}

      {/* Import subscriptions (CSV migration) */}
      <ImportSubscriptionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* Reconcile vs Google reseller panel (read-only report) → Phase 2 matcher */}
      <ReconcileGoogleDialog
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
        onAddMissing={() => setAddGoogleOpen(true)}
      />

      {/* Phase 2 — add the missing Google subscriptions (match by customer number) */}
      <ImportGoogleSubsDialog
        open={addGoogleOpen}
        onOpenChange={setAddGoogleOpen}
        onComplete={() => refetch()}
      />

      {/* Shown only once a key has actually been used — see the note on KeyHintBar. */}
      <KeyHintBar visible={subKeys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />

      {/* "Subscriptions by Plan" was REMOVED here on 12 Sep 2026 — not moved.
          Accounting → SaaS Metrics already carries "MRR by tier", which is the same
          breakdown done properly: it normalises the plan text through tierFromPlan, so
          Workspace Starter is ONE row. This card grouped on the raw `plan` string, and
          because the seat count is baked into that string it split a single product four
          ways — "Google Workspace Starter", "… (1 seats)", "… (2 seats)", "… (5 seats)" —
          making the catalogue look like seven products when it is about four, and hiding
          that Starter is the biggest line by customer count. A breakdown that
          miscounts is worse than no breakdown. */}

      {/* 1-Click Onboard Subscription Modal */}
      <AddSubscriptionDialog
        open={addDirectOpen}
        onOpenChange={setAddDirectOpen}
        onSuccess={refetch}
        /* "Payment Received" hands off here instead of creating the subscription
           itself — record_payment does that, atomically, along with the receipt
           voucher and the ledger entries. See Step 3a in the dialog. */
        onNeedsPayment={setPendingPayment}
        prefill={leadPrefill}
      />

      {/* Record payment — opened by the onboarding dialog's "Payment Received" path. */}
      {pendingPayment && (
        <RecordPaymentDialog
          open
          onOpenChange={(o) => { if (!o) abandonPendingPayment(); }}
          quoteId={pendingPayment.quoteId}
          customerId={pendingPayment.customerId}
          customerName={pendingPayment.customerName}
          expectedAmount={pendingPayment.expectedAmount}
          lineItems={pendingPayment.lineItems as unknown as QuoteLine[]}
          askDomain
          defaultDomain={pendingPayment.domain}
          onRecorded={(res) => raiseInvoiceFor(pendingPayment.quoteId, res)}
        />
      )}

      {/* Mobile primary FAB */}
      {/* Renders nothing at zero selected, so it costs the normal page nothing. */}
      <SubscriptionsBulkBar
        count={pickedIds.size}
        onExport={bulkExport}
        onSendRenewals={bulkSendRenewals}
        onDelete={bulkDelete}
        onDeselectAll={clearPicked}
        busy={bulkBusy}
      />

      <FAB icon="plus" label="Add Subscription" onClick={() => setAddDirectOpen(true)} />
    </div>
  );
}

// ============================================================
// Domain cell — read-only when populated, inline editor when missing.
// Subs created before migration 0018 (or via manual paths that skip the
// lead/quote flow) can lack a domain — operator can fix it without leaving
// the list.
// ============================================================
function DomainCell({ sub, compact = false }: { sub: Subscription; compact?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue]     = React.useState("");
  const mut                   = useSetSubscriptionDomain();

  if (sub.domain && !editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(sub.domain ?? ""); setEditing(true); }}
        className={cn(
          "font-mono text-2xs text-ink-3 hover:text-ink truncate text-left transition-colors",
          compact && "mt-0.5",
        )}
        title="Click to edit domain"
      >
        {sub.domain}
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(""); setEditing(true); }}
        className={cn(
          "inline-flex items-center gap-1 text-2xs text-amber-ink hover:underline",
          compact && "mt-0.5",
        )}
      >
        <Icon name="plus" size={11} />
        Add domain
      </button>
    );
  }

  const submit = () => {
    const v = value.trim();
    if (!v) {
      toast.error("Domain can't be blank", { description: "Type the customer's domain, e.g. example.com." });
      return;
    }
    mut.mutate(
      { id: sub.id, domain: v },
      {
        onSuccess: () => { toast.success("Domain saved"); setEditing(false); },
        onError:   (e) => { toastError(e, { fallback: "Could not save the domain" }); },
      },
    );
  };

  return (
    <div className={cn("flex items-center gap-1", compact && "mt-1")}>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Domain"
        placeholder="e.g. acme.in"
        className="h-7 text-2xs font-mono py-0"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <IconButton
        icon="check"
        size="sm"
        aria-label="Save domain"
        onClick={submit}
        disabled={mut.isPending}
      />
      <IconButton
        icon="x"
        size="sm"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        disabled={mut.isPending}
      />
    </div>
  );
}

/**
 * The amendment ledger for one subscription.
 *
 * Its own component so the query is scoped to whichever subscription the drawer has
 * open, rather than fetching every subscription's history to render one.
 */
function AmendmentHistorySection({ subscription }: { subscription: Subscription }) {
  const { data: amendments } = useAmendments(subscription.id);
  return <AmendmentHistory amendments={amendments ?? []} currentSeats={subscription.seats} />;
}
