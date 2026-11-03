/**
 * R-1516 — Payment Follow-up (/collections): everyone who still owes money, whom to chase
 * first, what they promised and who owns the follow-up.
 *
 * R-2408 — a worklist first: age tiles (Overdue · 1–30 · 31–60 · 61–90 · 90+ · Not due yet,
 * click = filter), search / owner / age / sort, then compact one-line rows with ONE next-step
 * button + a ⋯ menu (Follow-up R-1517, Remind R-1518, Send pending dues and Record payment
 * R-1526 — the same dialogs as before). Not due yet is hidden by default (its own tile). The
 * owner's "This week" report (R-1518) folds open under the list. Logic: ./worklist.ts; cells:
 * ./owed-cells.tsx; buttons: ./row-actions.tsx.
 *
 * R-2409 — a "Today" view (follow-ups due + promises due today + broken promises, every age),
 * "Today's work first" = broken promises, then today's work, each by ₹ due × days late, and ONE
 * stage chip per row (Not contacted · Reminded · Promised · Broken · Disputed · Part-paid) under
 * the customer's name. Rules: lib/collections/priority.ts.
 *
 * Rules and reads live in lib/queries/collections.ts (tested in ./collections.test.ts):
 * the balance is the same invoiceAmountDue as Customer Aging, every read pages past 1000.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { rupee } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { canOpenRoute } from "@/lib/nav";
import { FollowupDialog } from "@/components/features/collections/followup-dialog";
import { ReminderDialog } from "@/components/features/collections/reminder-dialog";
import { PendingDuesDialog } from "@/components/features/collections/pending-dues-dialog";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { canRecordMoney } from "@/lib/auth/roles";
import { CollectionsOwnerReport } from "@/components/features/collections/owner-report";
import { maySeeCollectionsReport } from "@/lib/collections/weekly-report";
import {
  COLLECTION_VIEWS, defaultCollectionView, filterCollectionRows, useCollections,
  type CollectionRow, type CollectionView,
} from "@/lib/queries/collections";
import {
  AGE_LABEL, AGE_VIEWS, DEFAULT_AGE, SORT_KEYS, UNASSIGNED, WORKLIST_COLS,
  buildWorklist, hasOverdueLine, ownerKey, ownerKeys, type AgeKey, type AgeView,
} from "./worklist";
import { AgeTileRow } from "./age-tiles";
import { WorklistToolbar } from "./worklist-toolbar";
import { RowActions, type RowDialog } from "./row-actions";
import { AmountCell, CustomerName, NextText, OverdueBadge, OwedCell, PromiseText, StageChip, type CanOpen } from "./owed-cells";
import { isTodayWork, todayCounts } from "@/lib/collections/priority";

const VIEW_LABEL: Record<CollectionView, string> = {
  today: "Today",
  mine: "Mere",
  all: "All",
  broken: "Broken promises",
};
const URL_VIEWS = ["", ...COLLECTION_VIEWS] as const;

export default function CollectionsPage() {
  const { data: rows, isLoading, isError, refetch } = useCollections();
  const { data: me } = useCurrentUser();
  const { data: names } = useUserNames();
  const [picked, setPicked] = useUrlChoice<(typeof URL_VIEWS)[number]>("view", URL_VIEWS, "");
  const view: CollectionView = picked || defaultCollectionView(me?.role);
  /* R-2409: Today's work is any age (a promise due today can be on a bill not late yet). */
  const ageDefault: AgeView = view === "today" ? "all" : DEFAULT_AGE;
  const [age, setAge] = useUrlChoice<AgeView>("age", AGE_VIEWS, ageDefault);
  const [sort, setSort] = useUrlChoice("sort", SORT_KEYS, "priority");
  const [q, setQ] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [reportOpen, setReportOpen] = React.useState(false);
  const role = me?.role ?? null;
  const canOpen = React.useCallback((href: string) => canOpenRoute(role, href), [role]);

  const all = rows ?? [];
  const viewRows = filterCollectionRows(all, view, me?.userId);
  const list = buildWorklist(viewRows, { q, owner, age, sort });
  const shown = list.shown;
  const ownerLabel = (key: string): string => (key === UNASSIGNED ? "Unassigned" : names?.get(key)?.label ?? "a colleague");
  const ownerName = (r: CollectionRow): string => ownerLabel(ownerKey(r));
  /* Pressing the pressed tile goes back to the default list (Overdue). */
  const pickTile = (key: AgeKey) => setAge(age === key ? ageDefault : key);
  const toggle = (key: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  /* The row whose dialog is open. Kept by key so the dialog follows the refreshed row after a
     save (the list is re-read at once). */
  const [dialog, setDialog] = React.useState<{ kind: RowDialog; key: string } | null>(null);
  const openDialog = React.useCallback((kind: RowDialog, key: string) => setDialog({ kind, key }), []);
  const dlgRow = dialog ? all.find((r) => r.key === dialog.key) ?? null : null;
  const closeIf = (o: boolean) => { if (!o) setDialog(null); };
  const canPay = canRecordMoney(role);
  const showReport = maySeeCollectionsReport(role);
  const owing = React.useMemo(
    /* R-2401: a renewal-only row owes nothing yet — the weekly report stays real dues.
       R-2408: "No follow-up for 7+ days" counts only customers with a late line. */
    () => (rows ?? []).filter((r) => !!r.customerId && r.amountDue > 0)
      .map((r) => ({ customerId: r.customerId!, customerName: r.customerName, amountDue: r.amountDue, overdue: hasOverdueLine(r) })),
    [rows],
  );
  const todayCount = shown.filter(isTodayWork).length;
  const today = todayCounts(all);
  const filtered = q.trim() !== "" || owner !== "" || age !== ageDefault;
  const resetFilters = () => { setQ(""); setOwner(""); setAge("all"); };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Billing</p>
        <h1 className="font-serif text-3xl tracking-tight">Payment Follow-up</h1>
        <p className="text-sm text-ink-3 mt-1">Who is late with money, and whom to call first — one button per customer.</p>
      </div>

      {!isLoading && !isError && viewRows.length > 0 && <AgeTileRow tiles={list.tiles} active={age} onPick={pickTile} />}

      <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="Show">
        {COLLECTION_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setPicked(v)}
            className={`min-h-[44px] md:min-h-0 px-3 py-1.5 rounded-full border text-sm transition-colors ${
              view === v ? "border-amber bg-amber-soft text-ink" : "border-hairline bg-paper text-ink-2 hover:border-amber/60"
            }`}
          >
            {VIEW_LABEL[v]}
            {v === "today" && today.total > 0 && <span className="ml-1 tabular-nums text-rose-600 font-semibold">{today.total}</span>}
          </button>
        ))}
        {!isLoading && !isError && shown.length > 0 && (
          <span className="text-sm text-ink-3 ml-auto tabular-nums">
            {AGE_LABEL[age]}: {shown.length} {shown.length === 1 ? "customer" : "customers"} · <b className="text-ink">{rupee(list.total)}</b> due
            {list.renewalTotal > 0 && <> · + {rupee(list.renewalTotal)} renewals</>}
            {view === "today"
              ? <> · {today.followUps} follow-ups due · {today.promisesToday} promised today · <span className={today.broken > 0 ? "text-rose" : undefined}>{today.broken} broken</span></>
              : todayCount > 0 && <> · <span className="text-rose">{todayCount} to chase today</span></>}
          </span>
        )}
      </div>

      {!isLoading && !isError && viewRows.length > 0 && (
        <WorklistToolbar
          q={q} onQ={setQ}
          owner={owner} onOwner={setOwner} owners={ownerKeys(viewRows)} ownerLabel={ownerLabel}
          age={age} onAge={setAge}
          sort={sort} onSort={setSort}
        />
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : isError && !rows ? (
        <LoadError what="Payment follow-up list" onRetry={() => { void refetch(); }} />
      ) : viewRows.length === 0 ? (
        <Card className="py-2">
          <Empty view={view} anyRows={all.length > 0} onAll={() => setPicked("all")} canOpen={canOpen} />
        </Card>
      ) : shown.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="check_circle"
            title={filtered ? `No customers in "${AGE_LABEL[age]}"${q.trim() ? ` matching "${q.trim()}"` : ""}` : "Nothing to show"}
            body={age === "overdue" && !q.trim() && !owner
              ? "Nobody is late with money right now — customers whose invoices are not due yet are under the Not due yet tile."
              : "Change the search, owner or age to see more customers."}
            action={(
              <button type="button" onClick={resetFilters} className="min-h-[44px] px-4 rounded-full border border-hairline text-sm text-ink hover:border-amber/60">
                Show every customer
              </button>
            )}
          />
        </Card>
      ) : (
        <>
          {/* Phone: card list (§20) */}
          <ul className="md:hidden space-y-2">
            {shown.map((r) => (
              <li key={r.key}>
                <Card className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 break-words font-medium text-ink leading-tight"><CustomerName r={r} canOpen={canOpen} /></div>
                    <div className="shrink-0 text-right"><AmountCell r={r} className="font-serif text-lg leading-none" /></div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    <OverdueBadge days={r.daysOverdue} />
                    <StageChip stage={r.stage} />
                    {r.followUpDue && <Badge kind="warning" dot>Follow up today</Badge>}
                  </div>
                  <div className="mt-2 text-sm"><OwedCell r={r} canOpen={canOpen} open={expanded.has(r.key)} onToggle={() => toggle(r.key)} /></div>
                  <dl className="grid grid-cols-3 gap-x-2 mt-2 text-xs">
                    <div className="min-w-0"><dt className="text-ink-3">Promise</dt><dd><PromiseText r={r} /></dd></div>
                    <div className="min-w-0"><dt className="text-ink-3">Next follow-up</dt><dd><NextText r={r} /></dd></div>
                    <div className="min-w-0"><dt className="text-ink-3">Owner</dt><dd className="break-words">{ownerName(r)}</dd></div>
                  </dl>
                  <RowActions r={r} canPay={canPay} onOpen={openDialog} className="mt-2" />
                </Card>
              </li>
            ))}
          </ul>

          {/* Tablet / desktop: one line per customer, fixed column budget (worklist.ts WORKLIST_COLS) */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                {WORKLIST_COLS.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
              </colgroup>
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  {WORKLIST_COLS.map((c) => (
                    <th key={c.key} scope="col" className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {shown.map((r) => (
                  <tr key={r.key} className="align-top hover:bg-paper-2/40">
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink truncate" title={r.customerName}><CustomerName r={r} canOpen={canOpen} /></div>
                      <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                        <StageChip stage={r.stage} />
                        {r.lastNote && <span className="text-2xs text-ink-3 truncate" title={r.lastNote}>“{r.lastNote}”</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2"><OwedCell r={r} canOpen={canOpen} open={expanded.has(r.key)} onToggle={() => toggle(r.key)} /></td>
                    <td className="px-3 py-2 text-right"><AmountCell r={r} className="font-mono font-semibold" /></td>
                    <td className="px-3 py-2"><OverdueBadge days={r.daysOverdue} /></td>
                    <td className="px-3 py-2 text-xs"><PromiseText r={r} /></td>
                    <td className="px-3 py-2 text-xs"><NextText r={r} /></td>
                    <td className="px-3 py-2 text-xs text-ink-2 truncate" title={ownerName(r)}>{ownerName(r)}</td>
                    <td className="px-3 py-2"><RowActions r={r} canPay={canPay} onOpen={openDialog} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {showReport && !isLoading && !isError && (
        <section className="mt-5" aria-label="This week report">
          <button
            type="button"
            aria-expanded={reportOpen}
            onClick={() => setReportOpen((o) => !o)}
            className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"
          >
            <Icon name={reportOpen ? "chevron_down" : "chevron_right"} size={14} />
            This week — received, promises, follow-ups by person
          </button>
          {reportOpen && <CollectionsOwnerReport owing={owing} />}
        </section>
      )}

      {dialog?.kind === "followup" && dlgRow?.customerId && (
        <FollowupDialog
          open
          onOpenChange={closeIf}
          customerId={dlgRow.customerId}
          customerName={dlgRow.customerName}
          ownerId={dlgRow.ownerId}
          /* R-2401: a renewal can be the follow-up's subject too — linked as its subscription. */
          items={[
            ...dlgRow.items,
            ...dlgRow.renewals
              .filter((i) => !dlgRow.items.some((o) => o.kind === "subscription" && o.id === i.id))
              .map((i) => ({ kind: "subscription" as const, id: i.id, label: `${i.label} (renewal)`, quoteId: i.quoteId })),
          ]}
          stillOwes={dlgRow.amountDue > 0}
          payments={dlgRow.payments}
          amountDue={dlgRow.amountDue}
          onRemind={() => setDialog({ kind: "remind", key: dlgRow.key })}
        />
      )}
      {dialog?.kind === "remind" && dlgRow?.customerId && (
        <ReminderDialog
          open
          onOpenChange={closeIf}
          customerId={dlgRow.customerId}
          customerName={dlgRow.customerName}
        />
      )}
      {dialog?.kind === "dues" && dlgRow?.customerId && (
        <PendingDuesDialog
          open
          onOpenChange={closeIf}
          customerId={dlgRow.customerId}
          customerName={dlgRow.customerName}
        />
      )}
      {canPay && dialog?.kind === "pay" && dlgRow?.customerId && (
        <MultiInvoicePaymentDialog
          open
          onOpenChange={closeIf}
          customerId={dlgRow.customerId}
          customerName={dlgRow.customerName}
        />
      )}
    </div>
  );
}

function Empty({ view, anyRows, onAll, canOpen }: { view: CollectionView; anyRows: boolean; onAll: () => void; canOpen: CanOpen }) {
  const showAll = (
    <button type="button" onClick={onAll} className="min-h-[44px] px-4 rounded-full border border-hairline text-sm text-ink hover:border-amber/60">
      Show all customers
    </button>
  );
  if (view === "mine" && anyRows) {
    return <EmptyState icon="users" title="None of your customers owe money" body="Customers you own (or whose follow-up was handed to you) show here." action={showAll} />;
  }
  if (view === "today" && anyRows) {
    return <EmptyState icon="check_circle" title="Nothing to chase today" body="No follow-up is due, no promise falls today and no promise is broken." action={showAll} />;
  }
  if (view === "broken" && anyRows) {
    return <EmptyState icon="check_circle" title="No broken promises" body="Every promise-to-pay date is still ahead, or the money came in." action={showAll} />;
  }
  return (
    <EmptyState
      icon="check_circle"
      title="Nobody owes you money right now"
      body="Unpaid invoices and subscription balances appear here as soon as they are issued."
      action={canOpen("/invoices") ? (
        <Link href="/invoices" className="inline-flex items-center min-h-[44px] px-4 rounded-full border border-hairline text-sm text-ink hover:border-amber/60">
          Open invoices
        </Link>
      ) : undefined}
    />
  );
}
