/**
 * R-1516 — Payment Follow-up (/collections): everyone who still owes money, whom to chase
 * first, what they promised and who owns the follow-up. Each row opens the Follow-up dialog
 * (R-1517: log a call / promise, next date, history) and "Remind" (R-1518: the AI drafts a
 * reminder, a person edits it and sends it on WhatsApp or email — nothing is sent on its own).
 * Owner / manager / accountant also see "This week" (R-1518 owner report) on top.
 *
 * Rules and reads live in lib/queries/collections.ts (tested in ./collections.test.ts):
 * the balance is the same invoiceAmountDue as Customer Aging, every read pages past 1000.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { rupee, formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { canOpenRoute } from "@/lib/nav";
import { tdsShortfallLine } from "@/lib/accounting/tds-match";
import { Button } from "@/components/ui/button";
import { FollowupDialog } from "@/components/features/collections/followup-dialog";
import { ReminderDialog } from "@/components/features/collections/reminder-dialog";
import { PendingDuesDialog } from "@/components/features/collections/pending-dues-dialog";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { canRecordMoney } from "@/lib/auth/roles";
import { CollectionsOwnerReport } from "@/components/features/collections/owner-report";
import { maySeeCollectionsReport } from "@/lib/collections/weekly-report";
import {
  COLLECTION_VIEWS, defaultCollectionView, filterCollectionRows, useCollections,
  type CollectionRow, type CollectionView, type OwedItem,
} from "@/lib/queries/collections";

const VIEW_LABEL: Record<CollectionView, string> = {
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
  const role = me?.role ?? null;
  const canOpen = React.useCallback((href: string) => canOpenRoute(role, href), [role]);

  const all = rows ?? [];
  const shown = filterCollectionRows(all, view, me?.userId);
  const ownerName = (r: CollectionRow): string => {
    const id = r.assignedTo ?? r.ownerId;
    if (!id) return "Unassigned";
    return names?.get(id)?.label ?? "a colleague";
  };

  /* R-1517: the row whose Follow-up dialog is open. Kept by key so the dialog follows the
     refreshed row after a save (the list is re-read at once). */
  const [fuKey, setFuKey] = React.useState<string | null>(null);
  const fuRow = fuKey ? all.find((r) => r.key === fuKey) ?? null : null;
  /* R-1518: the row whose Remind dialog is open. */
  const [remKey, setRemKey] = React.useState<string | null>(null);
  const remRow = remKey ? all.find((r) => r.key === remKey) ?? null : null;
  /* R-1526: the row whose "Send pending dues" dialog is open, and the one whose R-1525
     "Record payment — multiple invoices" dialog is open (money roles only). */
  const [duesKey, setDuesKey] = React.useState<string | null>(null);
  const duesRow = duesKey ? all.find((r) => r.key === duesKey) ?? null : null;
  const [payKey, setPayKey] = React.useState<string | null>(null);
  const payRow = payKey ? all.find((r) => r.key === payKey) ?? null : null;
  const canPay = canRecordMoney(role);
  const showReport = maySeeCollectionsReport(role);
  const owing = React.useMemo(
    () => (rows ?? []).filter((r) => !!r.customerId).map((r) => ({ customerId: r.customerId!, customerName: r.customerName, amountDue: r.amountDue })),
    [rows],
  );

  const total = shown.reduce((s, r) => s + r.amountDue, 0);
  const todayCount = shown.filter((r) => r.followUpDue || r.promiseBroken).length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-5">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Billing</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Payment Follow-up</h1>
        <p className="text-sm text-ink-3 mt-1">
          Who still owes money, and whom to call first — today&apos;s follow-ups and broken promises on top.
        </p>
      </div>

      {showReport && !isLoading && !isError && <CollectionsOwnerReport owing={owing} />}

      <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Show">
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
          </button>
        ))}
        {!isLoading && !isError && shown.length > 0 && (
          <span className="text-sm text-ink-3 ml-auto tabular-nums">
            {shown.length} {shown.length === 1 ? "customer" : "customers"} · <b className="text-ink">{rupee(total)}</b> due
            {todayCount > 0 && <> · <span className="text-rose">{todayCount} to chase today</span></>}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : isError && !rows ? (
        <LoadError what="Payment follow-up list" onRetry={() => { void refetch(); }} />
      ) : shown.length === 0 ? (
        <Card className="py-2">
          <Empty view={view} anyRows={all.length > 0} onAll={() => setPicked("all")} canOpen={canOpen} />
        </Card>
      ) : (
        <>
          {/* Phone: card list (§20) */}
          <ul className="md:hidden space-y-2.5">
            {shown.map((r) => (
              <li key={r.key}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 break-words font-medium text-ink leading-tight">
                      <CustomerName r={r} canOpen={canOpen} />
                    </div>
                    <div className="shrink-0 font-serif text-lg text-ink leading-none tabular-nums whitespace-nowrap">{rupee(r.amountDue)}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <OverdueBadge days={r.daysOverdue} />
                    {r.promiseBroken && <Badge kind="danger" dot>Promise broken</Badge>}
                    {r.followUpDue && <Badge kind="warning" dot>Follow up today</Badge>}
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {r.items.map((i) => <li key={`${i.kind}:${i.id}`}><OwedLine item={i} canOpen={canOpen} /></li>)}
                  </ul>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3 text-sm">
                    <dt className="text-ink-3">Promise</dt>
                    <dd className="min-w-0"><PromiseText r={r} /></dd>
                    <dt className="text-ink-3">Next follow-up</dt>
                    <dd className="min-w-0"><NextText r={r} /></dd>
                    <dt className="text-ink-3">Owner</dt>
                    <dd className="min-w-0 break-words">{ownerName(r)}</dd>
                  </dl>
                  {r.lastNote && <p className="mt-2 text-sm text-ink-2 break-words">“{r.lastNote}”</p>}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <FollowupButton r={r} onOpen={setFuKey} className="w-full justify-center" />
                    <RemindButton r={r} onOpen={setRemKey} className="w-full justify-center" />
                    <DuesButton r={r} onOpen={setDuesKey} className="w-full justify-center" />
                    {canPay && <PayButton r={r} onOpen={setPayKey} className="w-full justify-center" />}
                  </div>
                </Card>
              </li>
            ))}
          </ul>

          {/* Tablet / desktop: table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[28%]" />
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th scope="col" className="text-left px-3 py-3">Customer</th>
                  <th scope="col" className="text-left px-3 py-3">What&apos;s owed</th>
                  <th scope="col" className="text-right px-3 py-3">Amount due</th>
                  <th scope="col" className="text-left px-3 py-3">Overdue</th>
                  <th scope="col" className="text-left px-3 py-3">Promise to pay</th>
                  <th scope="col" className="text-left px-3 py-3">Next follow-up</th>
                  <th scope="col" className="text-left px-3 py-3">Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {shown.map((r) => (
                  <tr key={r.key} className="align-top hover:bg-paper-2/40">
                    <td className="px-3 py-3 break-words">
                      <div className="font-medium text-ink"><CustomerName r={r} canOpen={canOpen} /></div>
                      {r.lastNote && <div className="text-xs text-ink-3 mt-0.5 line-clamp-2" title={r.lastNote}>“{r.lastNote}”</div>}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <FollowupButton r={r} onOpen={setFuKey} />
                        <RemindButton r={r} onOpen={setRemKey} />
                        <DuesButton r={r} onOpen={setDuesKey} />
                        {canPay && <PayButton r={r} onOpen={setPayKey} />}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <ul className="space-y-1">
                        {r.items.map((i) => <li key={`${i.kind}:${i.id}`}><OwedLine item={i} canOpen={canOpen} /></li>)}
                      </ul>
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-ink tabular-nums">{rupee(r.amountDue)}</td>
                    <td className="px-3 py-3"><OverdueBadge days={r.daysOverdue} /></td>
                    <td className="px-3 py-3"><PromiseText r={r} /></td>
                    <td className="px-3 py-3"><NextText r={r} /></td>
                    <td className="px-3 py-3 break-words text-ink-2">{ownerName(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {fuRow?.customerId && (
        <FollowupDialog
          open
          onOpenChange={(o) => { if (!o) setFuKey(null); }}
          customerId={fuRow.customerId}
          customerName={fuRow.customerName}
          ownerId={fuRow.ownerId}
          items={fuRow.items}
          stillOwes={fuRow.amountDue > 0}
          amountDue={fuRow.amountDue}
          onRemind={() => { setFuKey(null); setRemKey(fuRow.key); }}
        />
      )}
      {remRow?.customerId && (
        <ReminderDialog
          open
          onOpenChange={(o) => { if (!o) setRemKey(null); }}
          customerId={remRow.customerId}
          customerName={remRow.customerName}
        />
      )}
      {duesRow?.customerId && (
        <PendingDuesDialog
          open
          onOpenChange={(o) => { if (!o) setDuesKey(null); }}
          customerId={duesRow.customerId}
          customerName={duesRow.customerName}
        />
      )}
      {canPay && payRow?.customerId && (
        <MultiInvoicePaymentDialog
          open
          onOpenChange={(o) => { if (!o) setPayKey(null); }}
          customerId={payRow.customerId}
          customerName={payRow.customerName}
        />
      )}
    </div>
  );
}

/** R-1517: opens the Follow-up dialog. A line with no customer record cannot carry follow-ups. */
function FollowupButton({ r, onOpen, className }: { r: CollectionRow; onOpen: (key: string) => void; className?: string }) {
  if (!r.customerId) {
    return <p className={`text-xs text-ink-3 ${className ?? ""}`}>Link this invoice to a customer to log follow-ups.</p>;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      icon="phone"
      className={className}
      aria-label={`Log a follow-up for ${r.customerName}`}
      onClick={() => onOpen(r.key)}
    >
      Follow-up
    </Button>
  );
}

/** R-1518: the AI drafts a reminder; a person edits and sends it. Needs a customer record. */
function RemindButton({ r, onOpen, className }: { r: CollectionRow; onOpen: (key: string) => void; className?: string }) {
  if (!r.customerId) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      icon="send"
      className={className}
      aria-label={`Draft a payment reminder for ${r.customerName}`}
      onClick={() => onOpen(r.key)}
    >
      Remind
    </Button>
  );
}

/** R-1526: preview the statement of pending dues and send it (a person sends — R-1514). */
function DuesButton({ r, onOpen, className }: { r: CollectionRow; onOpen: (key: string) => void; className?: string }) {
  if (!r.customerId) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      icon="file"
      className={className}
      aria-label={`Send pending dues statement to ${r.customerName}`}
      onClick={() => onOpen(r.key)}
    >
      Send pending dues
    </Button>
  );
}

/** R-1526: when the customer pays the total — R-1525's one-payment-many-invoices dialog. */
function PayButton({ r, onOpen, className }: { r: CollectionRow; onOpen: (key: string) => void; className?: string }) {
  if (!r.customerId) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      icon="rupee"
      className={className}
      aria-label={`Record a payment from ${r.customerName} across their invoices`}
      onClick={() => onOpen(r.key)}
    >
      Record payment
    </Button>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

type CanOpen = (href: string) => boolean;

function MaybeLink({ href, canOpen, children, className }: { href: string | null; canOpen: CanOpen; children: React.ReactNode; className?: string }) {
  if (!href || !canOpen(href)) return <span className={className}>{children}</span>;
  // Typed routes (Next build, not tsc): a computed href is cast, as in kpi.tsx / academy.
  return <Link href={href as Route} className={`${className ?? ""} text-ink hover:underline underline-offset-2`}>{children}</Link>;
}

function CustomerName({ r, canOpen }: { r: CollectionRow; canOpen: CanOpen }) {
  return <MaybeLink href={r.customerHref} canOpen={canOpen}>{r.customerName}</MaybeLink>;
}

function OwedLine({ item, canOpen }: { item: OwedItem; canOpen: CanOpen }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-3xs uppercase tracking-wider text-ink-3">{item.kind === "invoice" ? "Invoice" : "Subscription"}</span>
        <MaybeLink href={item.href} canOpen={canOpen} className="font-mono text-xs break-all">{item.label}</MaybeLink>
        <span className="font-mono text-xs text-ink-2 tabular-nums">{rupee(item.amountDue)}</span>
        {item.quoteHref && item.quoteId && (
          <MaybeLink href={item.quoteHref} canOpen={canOpen} className="text-xs text-ink-3">Quote {item.quoteId}</MaybeLink>
        )}
        {item.kind === "invoice" && item.subscriptionHref && (
          <MaybeLink href={item.subscriptionHref} canOpen={canOpen} className="text-xs text-ink-3">Subscription</MaybeLink>
        )}
      </div>
      {item.tdsHint && (
        <p className="text-xs text-amber-ink mt-0.5">
          <Icon name="info" size={12} className="inline mr-1 align-text-bottom" />
          {tdsShortfallLine(item.tdsHint)} —{" "}
          <MaybeLink href={item.href} canOpen={canOpen} className="underline">Record payment me TDS darj karo</MaybeLink>
        </p>
      )}
    </div>
  );
}

function OverdueBadge({ days }: { days: number }) {
  if (days <= 0) return <Badge kind="muted">Not due yet</Badge>;
  return <Badge kind={days > 60 ? "danger" : days > 30 ? "warning" : "muted"}>{days} {days === 1 ? "day" : "days"}</Badge>;
}

function PromiseText({ r }: { r: CollectionRow }) {
  if (!r.promisedOn) return <span className="text-ink-3">—</span>;
  return (
    <span className={r.promiseBroken ? "text-rose font-medium" : "text-ink-2"}>
      {formatDate(r.promisedOn)}
      {r.promisedAmount != null && r.promisedAmount > 0 && <span className="tabular-nums"> · {rupee(r.promisedAmount)}</span>}
      {r.promiseBroken && <span className="block text-xs">Date passed, still owed</span>}
    </span>
  );
}

function NextText({ r }: { r: CollectionRow }) {
  if (!r.nextFollowUpOn) return <span className="text-ink-3">Not set</span>;
  return <span className={r.followUpDue ? "text-rose font-medium" : "text-ink-2"}>{formatDate(r.nextFollowUpOn)}</span>;
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
