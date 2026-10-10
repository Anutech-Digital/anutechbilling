/**
 * Customers — the reseller's book of business.
 *
 * Rebuilt to read like a relationship + money tool (not an accountant's ledger):
 *   • money-first StatStrip (customers · MRR · ARR · receivables) — the receivables
 *     figure is loud + clickable because "who owes me" is the action number;
 *   • visible segment chips (was a hidden dropdown) so the shape of the book shows;
 *   • a sortable table with a colored avatar + an MRR column (the value of each
 *     relationship) so the eye is drawn to the valuable and the at-risk.
 * Money math is unchanged — this is layout/hierarchy only.
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { CUSTOMER_VIEWS } from "@/lib/navigation/drilldown";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { useProjectReceivablesByCustomer, useProjectSales, useReceivedThisFyByCustomer } from "@/lib/queries/projects";
import { customerPortfolioStatus, countsAsNoBusiness, projectValue, type ProjectLike } from "@/lib/customers/portfolio-status";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useOutstandingReceivables } from "@/lib/queries/payments";
import { ImportCustomersDialog } from "@/components/features/customers/import-customers-dialog";
import { ImportDomainsDialog } from "@/components/features/customers/import-domains-dialog";
import { CustomerProfile } from "@/components/features/customers/customer-profile";
import { CustomersBulkBar } from "@/components/features/customers/customers-bulk-bar";
import { useCustomerGroups, useSetCustomerGroup } from "@/lib/queries/customer-groups";
import {
  useCustomers, useCustomersPaged, useCustomerListCounts, fetchAllCustomers, CUSTOMERS_PAGE_SIZE,
  useOpenCreditsByCustomer, useDeleteCustomer, useSetCustomerActive,
} from "@/lib/queries/customers";
import { createClient } from "@/lib/supabase/client";
import {
  customerViewCounts, customerMoneyTotals, contactMatchedCustomerIds, customerListMode, type ViewCtx,
} from "./server-list";
import { useContactSearchIndex } from "@/lib/queries/contacts";
import { customerMatchesContact } from "@/lib/contacts/search-index";
import { newestFirst } from "@/lib/sort/newest-first";
import { bulkOutcomeMessage, type BulkFailure } from "@/lib/customers/bulk-outcome";
import { CUSTOMERS_CSV_HEADERS, customersCsvRows } from "@/lib/export/crm-csv";
import { downloadCSV } from "@/lib/csv";
import { InvoiceChooserDialog } from "@/components/features/invoices/invoice-chooser-dialog";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { rupee, cn, cleanDisplayName, phoneSuffixOf } from "@/lib/utils";
import { missingInvoiceState } from "@/lib/gst/gstin-state";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canWriteSales } from "@/lib/nav";
import { ViewOnlyNote } from "@/components/shared/view-only-note";

// Saved-view segments (Zoho-style) — compact filters over already-loaded data
// (receivables + unused credit + subscriptions).
/* R-005: `projects` joined this in Sep 2026. A reseller who also sells custom software
   had those customers reading as dead accounts, because every filter here asked only
   about subscriptions. ViewCtx lives in ./server-list.ts (R-210), which counts the chips. */
const VIEW_DEFS: { id: string; label: string; test: (x: ViewCtx) => boolean }[] = [
  { id: "all",        label: "All",              test: () => true },
  { id: "unpaid",     label: "Has receivables",  test: (x) => x.amount > 0 },
  { id: "subscribed", label: "With subscriptions", test: (x) => x.hasSub },
  { id: "projects",   label: "With projects",    test: (x) => x.projects.length > 0 },
  /* Reads as "dead accounts", so a customer mid-build must not be in it —
     `countsAsNoBusiness` is the tested rule, shared with the row pill. */
  { id: "nosub",      label: "No business",      test: (x) => countsAsNoBusiness({ hasActiveSub: x.hasSub, projects: x.projects }) },
  { id: "credit",     label: "Has credit",       test: (x) => x.credit > 0 },
  /* R-118: the "Received (this FY)" figure's own customers — the tile had no list to open. */
  { id: "received",   label: "Paid this FY",     test: (x) => x.received > 0 },
  /* R-166: tax invoices refuse these ("no state on record") — 17 live customers on 6 Oct.
     Same rule as generate_invoice (missingInvoiceState). Editing in a state clears it. */
  { id: "nostate",    label: "State missing",    test: (x) => x.noState },
];

// Columns tuned for a reseller: who they are (name + who-to-call folded in) ·
// subscription status · place of supply · what they're worth (MRR) · what they
// owe (receivables) · credit on file · a per-row actions menu. Widths are
// percentages so the table always fills its container — no h-scroll.
/* First column is the bulk-select checkbox. Taken out of Customer's share rather than
   added to the total, so the table still sums to 100% and nothing reflows. */
const CUST_COL_WIDTHS = ["3%", "27%", "13%", "12%", "13%", "16%", "12%", "4%"];

/* "recent" is the DEFAULT — see lib/sort/newest-first.ts. The record you just created
   must be the first thing you see, on every table. */
type SortKey = "recent" | "name" | "mrr" | "receivables" | "credits" | "received";

// Stable per-customer avatar colour so the list is scannable by shape/colour.
const AVATAR_COLORS = ["amber", "indigo", "slate", "emerald", "ink", "muted"] as const;
function avatarColor(seed: string): (typeof AVATAR_COLORS)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// The muted line under a customer's name: who to call. Shows the contact person
// ONLY when it differs from the customer name (an individual customer IS the
// contact — repeating the name is noise), then the phone; else falls back to
// domain / email / state so the cell is never empty-but-informative.
type CustomerLike = {
  name: string; display_name: string | null; contact_name: string | null;
  contact_phone: string | null; contact_email: string | null; domain: string | null; state: string | null;
};
function customerSubline(c: CustomerLike): string {
  const primary = cleanDisplayName(c.display_name || c.name);
  const parts: string[] = [];
  if (c.contact_name?.trim() && c.contact_name.trim() !== primary) parts.push(c.contact_name.trim());
  const phone = c.contact_phone?.trim() || phoneSuffixOf(c.display_name || c.name);
  if (phone) parts.push(phone);
  if (parts.length) return parts.join(" · ");
  return c.domain || c.contact_email || c.state || "";
}

/* The row pill moved to `lib/customers/portfolio-status.ts` (R-005) so it and the
   segment filters cannot disagree about what a customer is — the tags and the counts
   are now the same tested function. The local `subStatus` it replaced knew only about
   subscriptions. */

export default function CustomersPage() {
  const { data: subscriptions } = useSubscriptions();
  const { data: outstanding } = useOutstandingReceivables();
  const { data: creditsByCustomer = {} } = useOpenCreditsByCustomer();
  const { data: projRecv = {} } = useProjectReceivablesByCustomer();
  /* R-005: money actually received this FY — payments + project payments, TDS included. */
  const { data: receivedBy = {} } = useReceivedThisFyByCustomer();
  /* R-005. Already fetched for the Project Sales page, so this is a cache hit in
     practice rather than a new round trip. */
  const { data: allProjects } = useProjectSales();

  // customer_id → outstanding = subscription dues + project invoiced-but-unpaid,
  // so project receivables show on the list too (matches the customer 360 page).
  const outstandingByCustomer = React.useMemo(() => {
    const map = new Map<string, { days: number; amount: number }>();
    for (const o of outstanding ?? []) {
      if (!o.customer_id) continue;
      const prev = map.get(o.customer_id);
      if (!prev || o.days_outstanding > prev.days) {
        map.set(o.customer_id, { days: o.days_outstanding, amount: o.outstanding_amount });
      }
    }
    // Add project receivables (invoiced milestones not yet paid).
    for (const [custId, amt] of Object.entries(projRecv)) {
      if (!amt) continue;
      const prev = map.get(custId);
      map.set(custId, { days: prev?.days ?? 0, amount: (prev?.amount ?? 0) + amt });
    }
    return map;
  }, [outstanding, projRecv]);

  const router = useRouter();
  const goAdd = () => router.push("/customers/new" as never);
  /* R-255: the accountant reads customers; adding, importing and editing stay with the team. */
  const canWrite = canWriteSales(useCurrentUser().data?.role);
  /* `?contact=` arrives from the "Serves N customers" chip on a contact. It seeds the
     search box rather than living as a filter of its own, so the operator lands on an
     ordinary search they can widen, narrow or clear — and so there is one filter to
     reason about instead of two that could disagree.

     Read once, in the initialiser: as an effect it would fight the user, re-seeding the
     box every time the URL re-rendered while they were typing.

     Read from `window`, not from `useSearchParams()` — that hook opts the whole page out
     of prerendering unless it sits inside a Suspense boundary, and `npm run build` fails
     on it ("useSearchParams() should be wrapped in a suspense boundary at page
     /customers"). Wrapping this entire page in Suspense to seed one text box would be a
     large change for a small convenience. The guard is for the server pass, where there
     is no window and the box simply starts empty. */
  const [search, setSearch] = React.useState(() =>
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("contact") ?? "",
  );
  const [importOpen, setImportOpen] = React.useState(false);
  const [domainsOpen, setDomainsOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  /* ── Bulk selection ────────────────────────────────────────────────────────
     A Set of ids, held on the page rather than per row, because "select all" and the
     floating bar both need the whole set. Desktop table only: the mobile card list has
     no room for a checkbox column and a bulk bar over a phone screen covers the rows it
     acts on. */
  const [pickedIds, setPickedIds] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const { data: groups } = useCustomerGroups();
  const setGroup = useSetCustomerGroup();
  const setActive = useSetCustomerActive();
  const deleteCustomer = useDeleteCustomer();

  const togglePicked = (id: string) => setPickedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearPicked = () => setPickedIds(new Set());

  const [helpOpen, setHelpOpen] = React.useState(false);
  const [view, setView] = useUrlChoice<string>("view", CUSTOMER_VIEWS, "all"); // R-118
  // Archived (is_active=false) customers are hidden by default; this toggle
  // swaps the whole list to show ONLY archived ones (Zoho-style status filter).
  const [showArchived, setShowArchived] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "recent", dir: "desc" });
  const [visible, setVisible] = React.useState(CUSTOMERS_PAGE_SIZE);
  const [kpiOpen, setKpiOpen] = React.useState(true);
  // Row action → "Create invoice": open the invoice chooser for that customer.
  const [invoiceForCustomer, setInvoiceForCustomer] = React.useState<string | null>(null);
  const [projInvoiceForCustomer, setProjInvoiceForCustomer] = React.useState<string | null>(null);

  // MRR/ARR per customer from active subscriptions.
  const subsByCustomer = React.useMemo(() => {
    const map = new Map<string, { mrr: number; arr: number }>();
    for (const s of subscriptions ?? []) {
      if (!s.customer_id || s.status !== "active") continue;
      const prev = map.get(s.customer_id) ?? { mrr: 0, arr: 0 };
      map.set(s.customer_id, { mrr: prev.mrr + s.mrr, arr: prev.arr + s.mrr * 12 });
    }
    return map;
  }, [subscriptions]);

  // customer_id -> that customer's projects, any status. The status buckets live in
  // portfolio-status.ts; this only groups.
  const projectsByCustomer = React.useMemo(() => {
    const map = new Map<string, ProjectLike[]>();
    for (const p of allProjects ?? []) {
      if (!p.customer_id) continue;
      const list = map.get(p.customer_id);
      if (list) list.push(p); else map.set(p.customer_id, [p]);
    }
    return map;
  }, [allProjects]);
  const NO_PROJECTS: readonly ProjectLike[] = React.useMemo(() => [], []);

  /* Who serves which customers, so the search box below can find a customer by the
     person rather than only by the company. One fetch, shared with Subscriptions
     through the query cache. */
  const { data: contactIndex } = useContactSearchIndex();

  /* ── R-210: WHICH READ FEEDS THE LIST ────────────────────────────────────────
     The default screen (All, newest first) reads 50 customers at a time from the server,
     search and archived switch included, with an exact total. The other views and the
     money sorts filter or order by other tables, so they read the full list as before —
     server-list.ts#customerListMode says exactly when. The search box waits 250 ms after
     the last key before asking the server, so typing a name is one request, not eight. */
  const [serverSearch, setServerSearch] = React.useState(search);
  React.useEffect(() => {
    const t = setTimeout(() => setServerSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const contactIds = React.useMemo(
    () => contactMatchedCustomerIds(contactIndex, serverSearch),
    [contactIndex, serverSearch],
  );
  const mode = customerListMode({ view, sortKey: sort.key, sortDir: sort.dir, contactIds });
  const paged = useCustomersPaged(
    { search: serverSearch, archived: showArchived, contactIds },
    { enabled: mode === "server" },
  );
  const full = useCustomers({ enabled: mode === "full" });
  const listCounts = useCustomerListCounts();
  const customers = mode === "server" ? paged.rows : full.data;
  const isLoading = mode === "server" ? paged.isLoading : full.isLoading;
  const error = (mode === "server" ? paged.error : full.error) ?? listCounts.error;
  const refetch = () => {
    void listCounts.refetch();
    if (mode === "server") void paged.refetch(); else void full.refetch();
  };
  /* "Has this workspace any customer at all" — the server count, not the rows on screen,
     since a page of 50 (or a filtered page) says nothing about the rest. */
  const anyCustomers = listCounts.data ? listCounts.data.all > 0 : (customers?.length ?? 0) > 0;

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant.
  const customersByWorkspace = React.useMemo(() => customers ?? [], [customers]);

  const activeView = VIEW_DEFS.find((v) => v.id === view) ?? VIEW_DEFS[0];

  /* R-210: the per-customer facts the chips and KPIs are built from — all loaded in full
     already, so neither needs the customer rows (server-list.ts#customerViewCounts). */
  const facts = React.useMemo(() => ({
    outstanding: outstandingByCustomer,
    credits: creditsByCustomer,
    subs: subsByCustomer,
    projects: projectsByCustomer,
    received: receivedBy,
    noState: new Set(listCounts.data?.noStateIds ?? []),
  }), [outstandingByCustomer, creditsByCustomer, subsByCustomer, projectsByCustomer, receivedBy, listCounts.data]);
  const viewCounts = React.useMemo(
    () => customerViewCounts(listCounts.data?.all ?? 0, facts, VIEW_DEFS),
    [listCounts.data, facts],
  );

  // Filter — segment then free-text. In server mode the server already did both.
  const archivedCount = listCounts.data?.archived ?? 0;
  const filtered = mode === "server" ? customersByWorkspace : customersByWorkspace.filter((c) => {
    // Active by default; the Archived toggle swaps to show only inactive ones.
    if ((c.is_active === false) !== showArchived) return false;
    const out = outstandingByCustomer.get(c.id);
    const ctx: ViewCtx = { amount: out?.amount ?? 0, credit: creditsByCustomer[c.id] ?? 0, hasSub: subsByCustomer.has(c.id), projects: projectsByCustomer.get(c.id) ?? NO_PROJECTS, received: receivedBy[c.id]?.total ?? 0, noState: missingInvoiceState(c) };
    if (!activeView.test(ctx)) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase().trim();
    return (
      c.name.toLowerCase().includes(s) ||
      (c.display_name?.toLowerCase().includes(s) ?? false) ||
      (c.domain?.toLowerCase().includes(s) ?? false) ||
      (c.contact_name?.toLowerCase().includes(s) ?? false) ||
      (c.contact_email?.toLowerCase().includes(s) ?? false) ||
      /* ── SEARCH BY THE PERSON YOU DEAL WITH ──────────────────────────────
         The two clauses above read `customers.contact_*`, which hold only the
         customer's FIRST contact. Since 18 Sep 2026 one person can serve several
         customers, so those columns find one of them and silently miss the rest —
         type "anjali" and Doodh Sang appears while FF Impex does not, which reads
         as "she is not on that customer" rather than "this box cannot see her".

         This clause reads the link table, so every customer a person is actually on
         matches, by their name, email or phone. */
      (contactIndex ? customerMatchesContact(contactIndex, c.id, s) : false)
    );
  });

  // Sort by the chosen column.
  const sortVal = React.useCallback((c: (typeof filtered)[number], key: SortKey): number | string => {
    if (key === "mrr") return subsByCustomer.get(c.id)?.mrr ?? 0;
    if (key === "receivables") return outstandingByCustomer.get(c.id)?.amount ?? 0;
    if (key === "credits") return creditsByCustomer[c.id] ?? 0;
    if (key === "received") return receivedBy[c.id]?.total ?? 0;
    return (c.display_name || c.name).toLowerCase();
  }, [subsByCustomer, outstandingByCustomer, creditsByCustomer, receivedBy]);

  const sorted = React.useMemo(() => {
    /* The default. Kept out of `sortVal` because that returns a number-or-string for a
       generic comparator, and a timestamp squeezed through String().localeCompare()
       sorts "2026-9-1" after "2026-10-1". One shared implementation, same as every
       other table. */
    /* R-210: server pages arrive already in this order (newest first, nulls last, A–Z). */
    if (mode === "server") return filtered;
    if (sort.key === "recent") {
      const byNewest = newestFirst(filtered);
      return sort.dir === "desc" ? byNewest : byNewest.reverse();
    }
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = sortVal(a, sort.key);
      const vb = sortVal(b, sort.key);
      let cmp = 0;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort, sortVal, mode]);

  /* Server mode: every loaded row is on screen and "Load more" asks the server for the next
     50. Full mode: the old in-browser paging over the whole list. */
  const shown = mode === "server" ? sorted : sorted.slice(0, visible);
  const leftCount = mode === "server"
    ? Math.max(0, (paged.total ?? sorted.length) - sorted.length)
    : sorted.length - shown.length;
  const loadMore = () => {
    if (mode === "server") void paged.fetchNextPage();
    else setVisible((v) => v + CUSTOMERS_PAGE_SIZE);
  };

  /* ── Bulk actions ──────────────────────────────────────────────────────────
     Each of these is N independent writes, not one transaction, so every one reports
     what actually happened through bulkOutcomeMessage rather than assuming success.
     Delete is the case that makes this necessary: the server refuses any customer
     carrying a document, so a partial run is normal. */
  const pickedCustomers = React.useMemo(
    () => sorted.filter((c) => pickedIds.has(c.id)),
    [sorted, pickedIds],
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
      /* description spelled out at the call site, not passed through a variable: §24 is
         machine-enforced by toast-error-ratchet.test.ts, which reads the SOURCE. A
         `{...opts}` that happens to contain a description at runtime still counts as a
         bare error toast, and rightly — the next person editing this line cannot see
         whether a reason survives. */
      toast.error(m.title, {
        description: m.description ?? "Nothing was changed. Open the companies to see why.",
      });
    }
    /* A partial or failed run keeps the selection: the refused rows are exactly the ones
       the operator still has to deal with, and re-ticking them by hand is the punishment
       for the app having done half a job. */
  };

  const bulkExport = () => {
    if (pickedCustomers.length === 0) return;
    downloadCSV(
      `customers-${new Date().toISOString().slice(0, 10)}.csv`,
      [...CUSTOMERS_CSV_HEADERS],
      customersCsvRows(pickedCustomers),
    );
    toast.success(`Exported ${pickedCustomers.length} compan${pickedCustomers.length === 1 ? "y" : "ies"} to CSV`);
  };

  /** Archive or reactivate. One code path — the flag is the only difference. */
  const bulkSetActive = async (isActive: boolean) => {
    if (pickedCustomers.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    const failed: BulkFailure[] = [];
    for (const c of pickedCustomers) {
      /* Already in the target state — not a failure, and not a write either. */
      if ((c.is_active !== false) === isActive) { done += 1; continue; }
      try { await setActive.mutateAsync({ id: c.id, isActive }); done += 1; }
      catch (e) { failed.push({ name: c.name, reason: (e as Error).message }); }
    }
    setBulkBusy(false);
    reportBulk(done, failed, isActive ? "Reactivated" : "Archived");
  };

  const bulkSetGroup = async (groupId: string | null) => {
    if (pickedCustomers.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    const failed: BulkFailure[] = [];
    for (const c of pickedCustomers) {
      try { await setGroup.mutateAsync({ customerId: c.id, groupId }); done += 1; }
      catch (e) { failed.push({ name: c.name, reason: (e as Error).message }); }
    }
    setBulkBusy(false);
    reportBulk(done, failed, groupId ? "Moved" : "Removed from parent account");
  };

  /**
   * Bulk delete.
   *
   * No client-side pre-check. `delete_customer` (migration 0174) refuses any customer
   * with a subscription, payment, invoice, quote or project, and IT is the authority —
   * a twin check here would be a second rulebook to keep in step, and the list page does
   * not even hold the counts it would need. So every id is offered and the refusals come
   * back as real reasons, which is also what makes the report trustworthy.
   */
  const bulkDelete = async () => {
    if (pickedCustomers.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    const failed: BulkFailure[] = [];
    for (const c of pickedCustomers) {
      try { await deleteCustomer.mutateAsync(c.id); done += 1; }
      catch (e) { failed.push({ name: c.name, reason: (e as Error).message }); }
    }
    setBulkBusy(false);
    /* If the pane is showing one of the deleted customers, close it — it is now a
       profile of nothing. */
    if (selectedId && pickedIds.has(selectedId) && !failed.some((f) => f.name === selectedId)) {
      setSelectedId(null);
    }
    reportBulk(done, failed, "Deleted");
  };

  const hasMore = leftCount > 0;

  /* j / k / Enter / o over the full-width table (the same pattern as /leads,
     /quotes, /subscriptions, /enquiries). Disabled while a customer is open —
     the table isn't rendered then, and the 360 panel has its own keys.
     `count` is the visible length so the highlight re-clamps when a filter,
     search, or "Show more" changes the list. onOpen mirrors a row click. */
  const custKeys = useListKeys({
    count: shown.length,
    enabled: !selectedId,
    onOpen: (i) => {
      const c = shown[i];
      if (c) setSelectedId(c.id);
    },
  });
  const selectedRowRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [custKeys.index]);
  /* Keyed by id, not index, so only the ONE desktop table below reacts — the
     mobile card list and the split-view rail iterate the same `shown` and must
     not light up. */
  const kbSelectedId = custKeys.index >= 0 ? shown[custKeys.index]?.id ?? null : null;
  React.useEffect(() => { setVisible(CUSTOMERS_PAGE_SIZE); }, [search, view]);

  // Toggle sort: same key flips direction; a new money key defaults to desc
  // (biggest first — the reseller wants top payers / biggest debtors on top).
  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );

  // KPIs — calculated over active workspace customers.
  /* R-210: from the server counts and the fact maps, not from the rows on screen — a page
     of 50 would otherwise make "Customers 50" and a ₹ total of just those 50. */
  const total = listCounts.data
    ? (showArchived ? listCounts.data.archived : listCounts.data.all - listCounts.data.archived)
    : 0;
  const { mrr: totalMRR, arr: totalARR, receivables: totalReceivables, received: totalReceived } =
    customerMoneyTotals(facts);

  /* Contract value of WON project work across the portfolio (R-005). */
  const totalProjectValue = React.useMemo(
    () => projectValue(allProjects ?? []),
    [allProjects],
  );

  const stats: React.ComponentProps<typeof StatStrip>["items"] = [];
  if (!isLoading && customers && listCounts.data) {
    stats.push({ label: "Companies", value: total, onClick: () => setView("all"), active: view === "all" });
    /* R-005: these are subscription MRR / ARR only. Named "Monthly / Yearly revenue" they
       read as total income — a customer who paid ₹11.8L for a project showed ₹0 in all of them. */
    /* R-118: subsByCustomer holds ACTIVE subscriptions only, and "With subscriptions" tests
       exactly that map — so these two open the customers whose MRR they add up. */
    stats.push({ label: "Recurring monthly (subscriptions)", value: rupee(totalMRR, { compact: true }),
      onClick: () => setView("subscribed"), active: view === "subscribed" });
    stats.push({ label: "Recurring yearly (subscriptions)", value: rupee(totalARR, { compact: true }),
      onClick: () => setView("subscribed") });
    stats.push({ label: "Received (this FY)", value: rupee(totalReceived, { compact: true }), tone: "emerald",
      onClick: () => setView("received"), active: view === "received" });
    /* R-005. Kept OUT of Monthly/Yearly revenue on purpose — those are recurring
       figures, and a one-off build is not recurring. Folding a ₹10.8L ERP into "Yearly
       revenue" would make the next year's forecast wrong by the whole amount. Won
       projects only; a quotation in a portfolio total is a number nobody agreed to. */
    if (totalProjectValue > 0) {
      stats.push({
        label: "Project value",
        value: rupee(totalProjectValue, { compact: true }),
        onClick: () => setView("projects"),
        active: view === "projects",
      });
    }
    stats.push({
      label: "To collect",
      value: rupee(totalReceivables, { compact: true }),
      tone: totalReceivables > 0 ? "rose" : "default",
      // The money-owed number is the action figure — tap it to see who owes.
      ...(totalReceivables > 0 ? { onClick: () => setView("unpaid"), active: view === "unpaid" } : {}),
    });
  }

  /* R-210: the export is every customer, not the 50 on screen — read in full on click. */
  async function handleExport() {
    let rows: NonNullable<typeof full.data>;
    try {
      rows = mode === "full" && full.data ? full.data : await fetchAllCustomers(createClient());
    } catch (e) {
      toast.error("Could not export companies", { description: (e as Error).message });
      return;
    }
    if (rows.length === 0) { toast.error("No companies to export yet."); return; }
    const cols = ["name", "contact_name", "contact_email", "contact_phone", "gstin", "state", "domain", "since"] as const;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const c of rows) lines.push(cols.map((k) => esc((c as Record<string, unknown>)[k])).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} compan${rows.length === 1 ? "y" : "ies"} to CSV`);
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Sales</p>
          <h1 className="font-serif text-2xl sm:text-3xl md:text-4xl leading-tight">Companies</h1>
          <p className="text-xs sm:text-sm text-ink-3 mt-0.5 hidden sm:block">Your book of business — recurring revenue, money owed, and who to grow.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon="more_h" size="sm">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={handleExport}>
                <Icon name="download" size={15} /> Export CSV
              </DropdownMenuItem>
              {canWrite && (<>
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setImportOpen(true)}>
                <Icon name="upload" size={15} /> Import companies
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setDomainsOpen(true)}>
                <Icon name="link" size={15} /> Link domains
              </DropdownMenuItem>
              </>)}
            </DropdownMenuContent>
          </DropdownMenu>
          {canWrite && (
            <Button variant="primary" size="sm" icon="plus" onClick={goAdd} className="whitespace-nowrap font-semibold shadow-xs">
              Add company
            </Button>
          )}
        </div>
      </div>

      {!canWrite && <ViewOnlyNote what="add, import or edit companies" />}

      {/* Collapsible Customer Analytics Banner */}
      {stats.length > 0 && !selectedId && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Company Portfolio &amp; Receivables</span>
              <Badge kind="info" size="sm" className="ml-1">{total} Accounts</Badge>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline bg-paper">
              {/* Built from `stats` (R-005). A redesign hardcoded four tiles here and the
                  "Project value" tile added to `stats` silently stopped showing. */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                {stats.map((t) => {
                  const tone = t.tone === "rose" ? "text-rose-600" : t.tone === "emerald" ? "text-emerald" : "text-ink";
                  const body = (
                    <>
                      <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">{t.label}</p>
                      <p className={cn("font-serif text-lg font-bold tabular-nums mt-0.5", tone)}>{t.value}</p>
                    </>
                  );
                  return t.onClick ? (
                    <button key={t.label} type="button" onClick={t.onClick}
                      className={cn("bg-paper-2/40 border rounded-lg p-3 text-left cursor-pointer transition-colors",
                        t.active ? "border-amber" : "border-hairline hover:border-amber/60")}>
                      {body}
                    </button>
                  ) : (
                    <div key={t.label} className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">{body}</div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sticky Segment chips + search */}
      {!isLoading && customers && anyCustomers && !selectedId && (
        <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-2.5">
          <div className="flex justify-between items-center gap-3 flex-wrap sm:flex-nowrap">
            <div className="w-full sm:w-64 shrink-0">
              <Input
                prefix={<Icon name="search" size={14} />}
                aria-label="Search companies"
                placeholder="Search company, contact, phone or domain…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto [ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-0.5 min-w-0 flex-1">
              {VIEW_DEFS.map((v) => {
                const active = view === v.id;
                const isDebt = v.id === "unpaid";
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setView(v.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer shrink-0",
                      active
                        ? "border-amber bg-amber-soft text-amber-ink"
                        : "border-hairline text-ink-2 hover:bg-paper-2",
                    )}
                  >
                    {v.label}
                    <span className={cn(
                      "rounded-full px-1.5 tabular-nums text-2xs",
                      active ? "bg-amber/25 text-amber-ink"
                        : isDebt && viewCounts[v.id] > 0 ? "bg-rose-soft text-rose-ink"
                        : "bg-paper-2 text-ink-3",
                    )}>{viewCounts[v.id]}</span>
                  </button>
                );
              })}
            </div>
            {(archivedCount > 0 || showArchived) && (
              <button
                type="button"
                onClick={() => { setShowArchived((v) => !v); setSelectedId(null); }}
                aria-pressed={showArchived}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer shrink-0",
                  showArchived ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
                )}
                title={showArchived ? "Back to active companies" : "Show archived companies"}
              >
                <Icon name="inbox" size={13} />
                {showArchived ? "Active" : "Archived"}
                <span className="rounded-full bg-paper-2 px-1.5 tabular-nums text-2xs text-ink-3">{archivedCount}</span>
              </button>
            )}
            {canWrite && (
              <Button variant="primary" size="sm" icon="plus" onClick={goAdd} className="shrink-0 font-semibold shadow-xs hidden sm:inline-flex">
                Add company
              </Button>
            )}
          </div>
          {/* Quick Sort Bar */}
          <div className="flex items-center gap-2 pt-1 border-t border-hairline/60 text-xs text-ink-3 overflow-x-auto [ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="font-semibold text-ink-2 shrink-0">Sort:</span>
            {/* First, and selected on load. The bar would otherwise claim "Name A-Z"
                while the table is in creation order — a sort bar that misreports the
                order it is showing is worse than none. */}
            <button
              type="button"
              onClick={() => toggleSort("recent")}
              className={cn(
                "px-2.5 py-1 rounded border text-2xs font-medium transition-colors cursor-pointer shrink-0",
                sort.key === "recent" ? "bg-amber-soft border-amber text-amber-ink" : "border-hairline hover:bg-paper-2 text-ink-2",
              )}
            >
              🕘 Recently added {sort.key === "recent" ? (sort.dir === "desc" ? "↓" : "↑") : ""}
            </button>
            <button
              type="button"
              onClick={() => toggleSort("mrr")}
              className={cn(
                "px-2.5 py-1 rounded border text-2xs font-medium transition-colors cursor-pointer shrink-0",
                sort.key === "mrr" ? "bg-amber-soft border-amber text-amber-ink" : "border-hairline hover:bg-paper-2 text-ink-2",
              )}
            >
              💰 Highest Revenue {sort.key === "mrr" ? (sort.dir === "desc" ? "↓" : "↑") : ""}
            </button>
            <button
              type="button"
              onClick={() => toggleSort("receivables")}
              className={cn(
                "px-2.5 py-1 rounded border text-2xs font-medium transition-colors cursor-pointer shrink-0",
                sort.key === "receivables" ? "bg-rose-soft border-rose text-rose-ink" : "border-hairline hover:bg-paper-2 text-ink-2",
              )}
            >
              🚨 Highest Debtors {sort.key === "receivables" ? (sort.dir === "desc" ? "↓" : "↑") : ""}
            </button>
            <button
              type="button"
              onClick={() => toggleSort("name")}
              className={cn(
                "px-2.5 py-1 rounded border text-2xs font-medium transition-colors cursor-pointer shrink-0",
                sort.key === "name" ? "bg-amber-soft border-amber text-amber-ink" : "border-hairline hover:bg-paper-2 text-ink-2",
              )}
            >
              🔤 Name A-Z {sort.key === "name" ? (sort.dir === "asc" ? "↓" : "↑") : ""}
            </button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load companies"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
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

      {/* ── Empty ── */}
      {!isLoading && !error && listCounts.data && listCounts.data.all === 0 && (
        <EmptyState
          icon="users"
          title="No companies yet"
          body="Add your first company to start tracking subscriptions, invoices, and renewals."
          action={canWrite ? <Button variant="primary" icon="plus" onClick={goAdd}>Add your first company</Button> : undefined}
          secondary={canWrite ? <Button icon="download" onClick={() => setImportOpen(true)}>Import CSV</Button> : undefined}
        />
      )}

      {/* ── Mobile card list ── */}
      {!isLoading && !error && sorted.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {shown.map((c) => {
            const outInfo = outstandingByCustomer.get(c.id);
            const receivable = outInfo?.amount ?? 0;
            const days = outInfo?.days ?? 0;
            const credit = creditsByCustomer[c.id] ?? 0;
            const mrr = subsByCustomer.get(c.id)?.mrr ?? 0;
            return (
              <li key={c.id}>
                {/* R-191: the card is a plain div, not a <Link>. The customer link sits on
                    the name and stretches over the whole card (after:inset-0), and the
                    WhatsApp link is a sibling raised above it (relative z-10) — so there is
                    no <a> inside an <a> (hydration error) and WhatsApp never opens the card. */}
                <div
                  className={cn(
                    "relative bg-paper border rounded-lg p-3 active:bg-paper-2/50",
                    "has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-amber",
                    receivable > 0 ? "border-rose/40" : "border-hairline",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Avatar name={cleanDisplayName(c.display_name || c.name)} color={avatarColor(c.id)} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Link
                          href={`/customers/${c.id}` as never}
                          data-card-link
                          className="block min-w-0 font-medium text-ink truncate focus-visible:outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
                        >
                          {cleanDisplayName(c.display_name || c.name)}
                        </Link>
                        {/* Same rule as the desktop table (R-005) — a project client
                            must not read as a dead account on a phone either. The plain
                            "No subscription" state stays badge-less, as it was, so this
                            adds a label only where there is something to say. */}
                        {(() => {
                          const m = customerPortfolioStatus({
                            hasActiveSub: subsByCustomer.has(c.id),
                            projects:     projectsByCustomer.get(c.id) ?? NO_PROJECTS,
                            archived:     c.is_active === false,
                          });
                          return m.label === "No subscription"
                            ? null
                            : <Badge kind={m.kind} size="sm" dot={m.dot}>{m.label}</Badge>;
                        })()}
                        {/* R-166: same warning as the desktop Place of supply cell. */}
                        {missingInvoiceState(c) && <Badge kind="warning" size="sm">State missing</Badge>}
                      </div>
                      <p className="text-2xs text-ink-3 truncate mt-0.5">
                        {customerSubline(c) || "—"}
                      </p>
                    </div>
                    {mrr > 0 && (
                      <span className="text-xs tabular-nums text-ink-2 shrink-0">{rupee(mrr, { compact: true })}<span className="text-ink-3">/mo</span></span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-hairline/60 text-xs">
                    <span className="text-ink-3">
                      To collect <b className={receivable > 0 ? "text-rose" : "text-ink-2"}>{rupee(receivable)}</b>
                      {receivable > 0 && days > 0 && <span className={days > 45 ? "text-rose" : "text-ink-3"}> · {days}d overdue</span>}
                      {(receivedBy[c.id]?.total ?? 0) > 0 && (
                        <span> · Received <b className="text-emerald">{rupee(receivedBy[c.id]!.total, { compact: true })}</b></span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      {c.contact_phone && (
                        <a
                          href={`https://wa.me/${c.contact_phone.replace(/\D/g, "")}`}
                          target="_blank"
                          rel="noreferrer"
                          className="relative z-10 inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded bg-emerald-soft text-emerald font-medium hover:bg-emerald hover:text-white transition-colors"
                        >
                          <Icon name="message_square" size={12} /> WhatsApp
                        </a>
                      )}
                      <span className="text-ink-3">
                        Credit <b className={credit > 0 ? "text-emerald" : "text-ink-2"}>{rupee(credit)}</b>
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
          {hasMore && (
            <li className="pt-1 text-center">
              <Button variant="default" size="sm" onClick={loadMore} disabled={paged.isFetchingNextPage}>
                Load {Math.min(leftCount, CUSTOMERS_PAGE_SIZE)} more ({leftCount} left)
              </Button>
            </li>
          )}
        </ul>
      )}

      {/* ── Desktop table — full-width (no customer selected) ── */}
      {!isLoading && !error && sorted.length > 0 && !selectedId && (
        <div className="hidden md:block">
          <Card flush>
            <div className="relative">
              <table className="w-full table-fixed">
                <colgroup>
                  {CUST_COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
                </colgroup>
                <thead className="bg-paper-2 border-b border-hairline-strong">
                  <tr>
                    {/* Select-all covers the rows ON SCREEN, not the whole filtered set.
                        "Show more" paginates this list, and a tick that silently selected
                        rows the operator cannot see is how a bulk delete goes wrong. */}
                    <th className="px-2 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all companies on screen"
                        className="cursor-pointer accent-amber"
                        checked={shown.length > 0 && shown.every((c) => pickedIds.has(c.id))}
                        ref={(el) => {
                          if (el) {
                            const n = shown.filter((c) => pickedIds.has(c.id)).length;
                            el.indeterminate = n > 0 && n < shown.length;
                          }
                        }}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setPickedIds((prev) => {
                            const next = new Set(prev);
                            for (const c of shown) { if (on) next.add(c.id); else next.delete(c.id); }
                            return next;
                          });
                        }}
                      />
                    </th>
                    <SortHead label="Company"         sortKey="name"        sort={sort} onSort={toggleSort} />
                    <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                    <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Place of supply</th>
                    <SortHead label="Monthly"         sortKey="mrr"         sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="Received (FY)"   sortKey="received"    sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="To collect"      sortKey="receivables" sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="Unused credits"  sortKey="credits"     sort={sort} onSort={toggleSort} align="right" />
                    <th className="px-2 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const outInfo = outstandingByCustomer.get(c.id);
                    const receivable = outInfo?.amount ?? 0;
                    const days = outInfo?.days ?? 0;
                    const credit = creditsByCustomer[c.id] ?? 0;
                    const mrr = subsByCustomer.get(c.id)?.mrr ?? 0;
                    const st = customerPortfolioStatus({
                      hasActiveSub: subsByCustomer.has(c.id),
                      projects:     projectsByCustomer.get(c.id) ?? NO_PROJECTS,
                      archived:     c.is_active === false,
                    });
                    const primaryName = cleanDisplayName(c.display_name || c.name);
                    return (
                      <tr
                        key={c.id}
                        ref={c.id === kbSelectedId ? selectedRowRef : undefined}
                        onClick={() => setSelectedId(c.id)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${primaryName}`}
                        /* aria-selected, not only a tint: a screen reader has to know which
                           row Enter/o will open. */
                        aria-selected={c.id === kbSelectedId}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(c.id); } }}
                        className={cn(
                          "group border-b border-hairline last:border-0 cursor-pointer transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                          c.id === kbSelectedId
                            ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40"
                            : receivable > 0 ? "hover:bg-rose-soft/20" : "hover:bg-paper-2/50",
                        )}
                      >
                        {/* stopPropagation: the whole row opens the profile, so without it
                            every tick would also swap the pane — and ticking five rows
                            would open five profiles on the way. */}
                        <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${primaryName}`}
                            className="cursor-pointer accent-amber"
                            checked={pickedIds.has(c.id)}
                            onChange={() => togglePicked(c.id)}
                            onKeyDown={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className={cn("px-3 py-2.5", receivable > 0 && "border-l-2 border-l-rose")}>
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Avatar name={primaryName} color={avatarColor(c.id)} size="sm" className="shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-sm text-ink truncate flex items-center gap-1.5 flex-wrap">
                                <span>{primaryName}</span>
                              </div>
                              {customerSubline(c) && (
                                <div className="text-2xs text-ink-3 truncate mt-0.5">{customerSubline(c)}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge kind={st.kind} size="sm" dot={st.dot}>{st.label}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-ink-2 truncate">{missingInvoiceState(c)
                          ? <Badge kind="warning" size="sm" title="Tax invoice will not issue until a state is chosen — Edit the company">{c.state ? `${c.state} · no code` : "State missing"}</Badge>
                          : (c.state || <span className="text-ink-3">N/A</span>)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {mrr > 0
                            ? <span className="text-sm font-medium text-ink">{rupee(mrr, { compact: true })}<span className="text-2xs text-ink-3">/mo</span></span>
                            : <span className="text-sm text-ink-3">{rupee(0)}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {(receivedBy[c.id]?.total ?? 0) > 0 ? (
                            <span
                              className="text-sm font-medium text-emerald"
                              title={receivedBy[c.id]!.tds > 0 ? `of which TDS ${rupee(receivedBy[c.id]!.tds)}` : undefined}
                            >
                              {rupee(receivedBy[c.id]!.total)}
                              {receivedBy[c.id]!.tds > 0 && <span className="block text-2xs text-ink-3 font-normal">incl. TDS {rupee(receivedBy[c.id]!.tds)}</span>}
                            </span>
                          ) : <span className="text-sm text-ink-3">{rupee(0)}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {receivable > 0 ? (
                            <div>
                              <div className="text-sm font-semibold text-rose">{rupee(receivable)}</div>
                              {days > 0 && (
                                <div className={cn("text-2xs", days > 45 ? "text-rose font-medium" : "text-ink-3")}>{days}d outstanding</div>
                              )}
                            </div>
                          ) : <span className="text-sm text-ink-3">{rupee(0)}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span className={credit > 0 ? "text-sm font-medium text-emerald" : "text-sm text-ink-3"}>{credit > 0 ? rupee(credit) : rupee(0)}</span>
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <RowActions
                            customerName={primaryName}
                            onView={() => setSelectedId(c.id)}
                            onEdit={() => router.push(`/customers/${c.id}/edit` as never)}
                            onNewQuote={() => router.push(`/quotes/new?customer=${c.id}` as never)}
                            onInvoice={() => setInvoiceForCustomer(c.id)}
                            onManageSubs={() => router.push(`/customers/${c.id}` as never)}
                            readOnly={!canWrite}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-3">
            <Icon name="info" size={11} />
            Click any row to open the Customer 360 — activity, subscriptions, invoices, and contacts. Click a column header to sort.
          </div>
          {hasMore && (
            <div className="flex justify-center py-3">
              <Button variant="default" size="sm" onClick={loadMore} disabled={paged.isFetchingNextPage}>
                Load {Math.min(leftCount, CUSTOMERS_PAGE_SIZE)} more ({leftCount} left)
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Search / filter empty ── */}
      {!isLoading && !error && customers && anyCustomers && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No companies match"
            body={search ? `No results for "${search}". Try a different search term.` : "No companies in this view."}
            action={<Button icon="x" onClick={() => { setSearch(""); setView("all"); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* ── Master-detail (a customer is selected, desktop) ──
          Fixed viewport-height + internal scroll ONLY in the 2xl split view (so
          the list rail scrolls independently). Below 2xl the panel is full-width
          and flows in the page — auto height, no nested scrollbar (single page
          scrollbar instead of the ugly double one). */}
      {!isLoading && !error && selectedId && (
        <div className="hidden md:flex border border-hairline rounded-xl overflow-hidden bg-paper xl:h-[calc(100vh-200px)] xl:min-h-[480px]">
          {/* List rail only on very wide screens — below 2xl the detail panel
              takes the FULL width so its content never gets squeezed/cut. The
              panel's own Close (×) returns to the full list. */}
          <div className="hidden xl:flex w-[300px] border-r border-hairline flex-col min-h-0">
            <div className="p-2 border-b border-hairline">
              <Input
                prefix={<Icon name="search" size={14} />}
                aria-label="Search companies"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {shown.map((c) => {
                const sub = subsByCustomer.get(c.id);
                const receivable = outstandingByCustomer.get(c.id)?.amount ?? 0;
                const active = c.id === selectedId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 border-b border-hairline/60 transition-colors flex items-center gap-2.5",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                      active ? "bg-amber-soft/50" : "hover:bg-paper-2/50",
                    )}
                  >
                    <Avatar name={cleanDisplayName(c.display_name || c.name)} color={avatarColor(c.id)} size="sm" className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm text-ink truncate">{cleanDisplayName(c.display_name || c.name)}</div>
                      <div className="flex items-center justify-between gap-2 text-2xs mt-0.5">
                        <span className="truncate text-ink-3">{c.domain || c.contact_email || "—"}</span>
                        {receivable > 0
                          ? <span className="tabular-nums flex-shrink-0 text-rose font-medium">{rupee(receivable, { compact: true })}</span>
                          : sub ? <span className="tabular-nums flex-shrink-0 text-ink-3">{rupee(sub.mrr, { compact: true })}/mo</span> : null}
                      </div>
                    </div>
                  </button>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={loadMore} disabled={paged.isFetchingNextPage}
                  className="w-full text-center py-2 text-xs text-amber-ink hover:bg-paper-2/50"
                >
                  Load {Math.min(leftCount, CUSTOMERS_PAGE_SIZE)} more ({leftCount} left)
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0">
            {/* The FULL profile, not a summary (Abhishek, 14 Sep 2026). Same component
                the /customers/[id] page renders — see customer-profile.tsx for why the
                two surfaces must not be separate implementations. */}
            <CustomerProfile customerId={selectedId} variant="panel" onClose={() => setSelectedId(null)} />
          </div>
        </div>
      )}

      {/* Floating bulk bar — renders nothing at zero selected, so it costs no space. */}
      <CustomersBulkBar
        count={pickedIds.size}
        groups={groups ?? []}
        busy={bulkBusy}
        onExport={bulkExport}
        onArchive={() => void bulkSetActive(false)}
        onReactivate={() => void bulkSetActive(true)}
        onSetGroup={(g) => void bulkSetGroup(g)}
        onDelete={() => void bulkDelete()}
        onDeselectAll={clearPicked}
        readOnly={!canWrite}
      />

      <ImportCustomersDialog open={importOpen} onOpenChange={setImportOpen} onImportComplete={() => refetch()} />
      <ImportDomainsDialog open={domainsOpen} onOpenChange={setDomainsOpen} onComplete={() => refetch()} />

      {/* Row action → Create invoice (subscription/one-off or project). */}
      <InvoiceChooserDialog
        open={!!invoiceForCustomer}
        onOpenChange={(o) => { if (!o) setInvoiceForCustomer(null); }}
        customerId={invoiceForCustomer ?? ""}
        onChooseProject={() => { setProjInvoiceForCustomer(invoiceForCustomer); setInvoiceForCustomer(null); }}
      />
      <CreateProjectQuoteDialog
        open={!!projInvoiceForCustomer}
        onOpenChange={(o) => { if (!o) setProjInvoiceForCustomer(null); }}
        mode="invoice"
        prefillCustomerId={projInvoiceForCustomer ?? undefined}
      />

      {/* Shown only once a key has actually been used — see the note on KeyHintBar. */}
      <KeyHintBar visible={custKeys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** Sortable column header — click to sort, shows the active direction arrow. */
function SortHead({
  label, sortKey, sort, onSort, align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  return (
    <th className={cn("group px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}${active ? (sort.dir === "asc" ? " (ascending)" : " (descending)") : ""}`}
        className={cn(
          "inline-flex items-center gap-1 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded",
          align === "right" && "flex-row-reverse",
          active && "text-ink",
        )}
      >
        {label}
        {/* Modern sort indicator: only shown when active, or faintly on hover. */}
        <Icon
          name={active && sort.dir === "asc" ? "chevron_up" : "chevron_down"}
          size={13}
          className={cn(
            "transition-opacity",
            active ? "text-amber opacity-100" : "text-ink-3 opacity-0 group-hover:opacity-60",
          )}
        />
      </button>
    </th>
  );
}

/** Per-row overflow menu (View · Edit · New quote · Create invoice · Manage subs).
 *  stopPropagation on the trigger so opening it doesn't also fire the row click. */
function RowActions({
  customerName, onView, onEdit, onNewQuote, onInvoice, onManageSubs, readOnly = false,
}: {
  customerName: string;
  /** R-255: view-only role — View details and the profile only. */
  readOnly?: boolean;
  onView: () => void;
  onEdit: () => void;
  onNewQuote: () => void;
  onInvoice: () => void;
  onManageSubs: () => void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <IconButton
          icon="more_h"
          size="sm"
          variant="ghost"
          aria-label={`Actions for ${customerName}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onView)}>
          <Icon name="eye" size={15} /> View details
        </DropdownMenuItem>
        {!readOnly && (<>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onEdit)}>
          <Icon name="edit" size={15} /> Edit company
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onNewQuote)}>
          <Icon name="plus" size={15} /> New quote
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onInvoice)}>
          <Icon name="receipt" size={15} /> Create invoice
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onManageSubs)}>
          <Icon name="refresh" size={15} /> Manage subscriptions
        </DropdownMenuItem>
        </>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
