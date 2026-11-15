"use client";
/**
 * R-2740 — the Renewals row drawer: the renewal's whole story on one screen (right side sheet,
 * 480px; full width on a phone). Read-only: its only actions are the row's own ONE button + ⋯
 * (RenewalActions — the same dialogs). Rules + words: ./drawer.ts; the one read: ./drawer-data.ts.
 *
 *   header      customer (link) · plan · seats · vendor · the stage chip + note · the button
 *   Terms       this term · next term · the vendor's own renewal date (R-2823) · amount · how it is billed · term length
 *               (R-2819: owner / manager — Customer pays · Our cost · Margin, or "Cost missing — add in catalogue")
 *   History     (R-2838, right under the header) tabs All · Quotes · Invoices · Payments with counts —
 *               ./drawer-history.ts historyTabs (R-2836): each payment under the invoice it paid, with
 *               that invoice's period; a "Last quote · Last invoice · Last paid" strip; "Show all N";
 *               a link to the customer's whole history. UI: ./drawer-history-section.tsx.
 *   Follow-ups  owner / next date / promise · reminders sent (R-2762: each email / WhatsApp reminder from the logs) · each logged follow-up
 *   Flags       each flag with its reason and one plain line
 */
import * as React from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDate, rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { canOpenInvoices } from "@/lib/invoices/access";
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import { RenewalContact } from "@/components/features/renewals/renewal-contact";
import type { Subscription } from "@/lib/supabase/database.types";
import type { RenewalStage } from "@/lib/renewals/stage";
import type { UserName } from "@/lib/hooks/useUserNames";
import { isNonRenewing } from "@/lib/subscriptions/non-renewing";
import { vendorHoldState, vendorTermEndOf, vendorTermWords } from "@/lib/renewals/vendor-hold";
import { useRenewalDrawerData } from "./drawer-data";
import { useRenewalDrawerCatalog } from "./drawer-cost-data";
import { useRenewalDrawerSeatCuts } from "./drawer-seat-cut-data";
import { CATALOGUE_HREF, booksRupeeLine, drawerMoney, drawerSeatPlan, mayShowRenewalCost, renewalCostForSub, type DrawerMoney } from "./drawer-money";
import {
  currentTermWords, drawerSubFromSearch, drawerViewFromSearch, withDrawerSub, drawerFlagRows, type DrawerView, drawerFollowupRows, remindersWords, termLengthWords,
} from "./drawer";
import { historyTabs } from "./drawer-history";
import { DrawerHistory } from "./drawer-history-section";
import { priorDueInvoiceGap, type LastDocs } from "./last-docs";
import { REMINDER_LOG_MAX, drawerReminderRows, reminderLogCapped, reminderLogWords } from "./reminder-log";
import { currentTermStart } from "@/lib/billing/subscription-schedule";
import type { SubscriptionOwed } from "@/lib/renewals/owed";
import { nextTermWords, subscriptionDomain } from "./row-cells";
import { dueCellFacts } from "./due-anchor";
import type { RenewalAmount } from "./queue";
import type { RenewalFollowup, RenewalFollowupRow } from "./followup";
import type { RowContact } from "./queue-data";

/** R-2762: reminders shown before "Show all N". */
const REMINDERS_PAGE = 5;

/** What opened the drawer (the product button) — focus goes back to it on close. */
let drawerOpener: HTMLElement | null = null;

/**
 * The open drawer's subscription id, kept in ?sub= so the link can be shared and Back closes it.
 * Plain history.pushState / replaceState — Next 15's router keeps them in step without a server
 * round trip (router.push re-requested the /renewals payload on every open). Opening pushes an
 * entry; closing goes back over an entry this page pushed (also one reached again by Forward), or
 * just drops ?sub= when the page was opened from a shared link. Back / Forward re-read it.
 */
export function useRenewalDrawerSub(): [string | null, (id: string, view?: DrawerView) => void, () => void, DrawerView | null] {
  const [id, setId] = React.useState<string | null>(null);
  /* R-2839: ?view=history — opened from the row's History button (focus goes to the History section) */
  const [view, setView] = React.useState<DrawerView | null>(null);
  /* the ?sub= entry on screen was pushed by this page (so Close = Back) */
  const pushed = React.useRef(false);
  const pushedAny = React.useRef(false);
  React.useEffect(() => {
    const read = () => {
      const next = drawerSubFromSearch(window.location.search);
      pushed.current = !!next && pushedAny.current;
      setId(next);
      setView(drawerViewFromSearch(window.location.search));
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const open = React.useCallback((next: string, nextView?: DrawerView) => {
    drawerOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setId(next);
    setView(nextView ?? null);
    pushed.current = true;
    pushedAny.current = true;
    window.history.pushState(null, "", withDrawerSub(window.location.href, next, nextView ?? null));
  }, []);
  const close = React.useCallback(() => {
    setId(null);
    setView(null);
    if (pushed.current) { pushed.current = false; window.history.back(); }
    else window.history.replaceState(null, "", withDrawerSub(window.location.href, null));
  }, []);
  return [id, open, close, view];
}

/**
 * R-2839: opened with view=history → scroll the History section into view and focus its active tab
 * (arrow keys then move between All · Quotes · Invoices · Payments). "nearest": History sits right under the
 * header, so the header (customer, button, Close) stays on screen. True when it found the section.
 */
function focusHistory(box: HTMLDivElement | null): boolean {
  if (!box) return false;
  box.scrollIntoView?.({ block: "nearest" });
  const tab = box.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  (tab ?? box).focus({ preventScroll: true });
  return true;
}

/**
 * The sheet's onOpenAutoFocus does it when the content is there (the normal case); this effect covers a
 * shared ?sub=&view=history link whose row arrives after the sheet opened — once per open / renewal, and
 * never when focus already sits inside History.
 */
function useFocusHistory(ref: React.RefObject<HTMLDivElement | null>, key: string | null) {
  React.useEffect(() => {
    if (!key) return;
    let tries = 0;
    let frame = 0;
    const go = () => {
      const box = ref.current;
      if (box?.contains(document.activeElement)) return;
      /* the sheet's content is portalled in a beat later — wait for it a few frames */
      if (!focusHistory(box) && tries++ < 30) frame = requestAnimationFrame(go);
    };
    frame = requestAnimationFrame(go);
    return () => cancelAnimationFrame(frame);
  }, [ref, key]);
}


export interface DrawerItem {
  sub: Subscription;
  daysUntil: number;
  stage: RenewalStage | null;
  amount: RenewalAmount;
  frequency: string | null;
  followup: RenewalFollowup;
  payHref: string | null;
  /** The row's own documents (already read) — the flags' wording uses the same facts as the row's chip. */
  docs: LastDocs | undefined;
  /** R-2818: what the previous term still owes (the row's own figure, lib/renewals/owed.ts); null = none / not read. */
  prior?: SubscriptionOwed | null;
  /** R-2824: the customer's main contact (undefined while the page still reads the contacts). */
  contact?: RowContact;
}

/** R-2834: the head's date line = the row's Due tooltip (dueCellFacts); a missing renewal date is still said. */
function renewsWords(title: string | null, renewalDate: string | null): string {
  if (!title) return "Renews — no date";
  return renewalDate ? title : `${title} · no renewal date`;
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="border-t border-hairline pt-4" data-testid={testId} aria-label={title}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-0.5 text-sm">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

/** R-2819: Our cost + Margin (owner / manager only), or the way to the catalogue when the cost is missing. */
function CostFacts({ money }: { money: DrawerMoney }) {
  if (money.kind === "loading") return <Fact label="Our cost"><Skeleton className="h-4 w-28" aria-label="Loading our cost" /></Fact>;
  if (money.kind === "unread") {
    return <Fact label="Our cost"><span className="text-ink-3" data-testid="renewal-drawer-cost">Couldn&apos;t read the catalogue — close and open again.</span></Fact>;
  }
  if (money.kind === "termUnknown") {
    return (
      <>
        <Fact label="Our cost"><span className="text-ink-3" data-testid="renewal-drawer-cost">Cost unknown — check term</span></Fact>
        <Fact label="Margin"><span className="text-ink-3" data-testid="renewal-drawer-margin">Unknown — no cost</span></Fact>
      </>
    );
  }
  if (money.kind === "costMissing") {
    return (
      <>
        <Fact label="Our cost">
          <span data-testid="renewal-drawer-cost">
            <Link href={CATALOGUE_HREF as never} className="font-medium text-amber-ink underline underline-offset-2 hover:text-ink">Cost missing — add in catalogue</Link>
            <span className="block text-xs text-ink-3">{money.reason[0].toUpperCase() + money.reason.slice(1)}.</span>
          </span>
        </Fact>
        <Fact label="Margin"><span className="text-ink-3" data-testid="renewal-drawer-margin">Unknown — no cost</span></Fact>
      </>
    );
  }
  return (
    <>
      <Fact label="Our cost"><span className="tabular-nums" data-testid="renewal-drawer-cost">{money.cost}</span> <span className="text-ink-3">from catalogue</span>
        {money.seatNote ? <span className="block text-xs text-ink-3" data-testid="renewal-drawer-seat-note">{money.seatNote[0].toUpperCase() + money.seatNote.slice(1)}</span> : null}
      </Fact>
      <Fact label="Margin">
        {money.kind === "noAmount"
          ? <span className="text-ink-3" data-testid="renewal-drawer-margin">Unknown — no renewal amount set</span>
          : <span className={cn("tabular-nums", money.loss ? "font-medium text-rose-600" : "text-ink")} data-testid="renewal-drawer-margin">{money.margin} · {money.pct < 0 ? "−" : ""}{Math.abs(money.pct)}%{money.loss ? " (loss)" : ""}</span>}
      </Fact>
    </>
  );
}

export function RenewalDrawer({ item, open, view = null, onClose, names, followupRows, onFollowup, strong }: {
  /** The row it is about; null while ?sub= names a renewal not on this page. */
  item: DrawerItem | null;
  open: boolean;
  /** R-2839: "history" = opened from the row's History button — scroll to History and focus its tab. */
  view?: DrawerView | null;
  onClose: () => void;
  names: Map<string, UserName> | undefined;
  /** The page's payment_followups rows (already read) — this renewal's are picked here. */
  followupRows: readonly RenewalFollowupRow[];
  onFollowup?: () => void;
  strong: boolean;
}) {
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  const canInvoices = canOpenInvoices(me?.role);
  const sub = item?.sub ?? null;
  const q = useRenewalDrawerData(open && sub ? sub : null);
  const todayIst = istToday();
  /* R-2823: the vendor's own renewal date (subscriptions.vendor_term_end). */
  const vendorWords = sub ? vendorTermWords({ ...sub, vendor_term_end: vendorTermEndOf(sub) || null }, todayIst) : null;
  /* Esc / Close returns focus to what opened it (the product button), even after the row re-rendered. */
  const restoreFocus = (e: Event) => {
    const el = drawerOpener;
    drawerOpener = null;
    if (el?.isConnected) { e.preventDefault(); el.focus(); }
  };
  /* R-2839: the History button's open lands on History (the sheet's own first-element focus is skipped then) */
  const historyRef = React.useRef<HTMLDivElement>(null);
  const toHistory = open && view === "history" && !!sub;
  useFocusHistory(historyRef, toHistory ? sub.id : null);

  const docs = q.data?.docs;
  /* R-2838: ONE History from R-2836's rules (R-2818's no-receipt lines kept). subQuoteId: instalment invoices
     billed from the subscription take payments on its own quote (R-1564) — without it they would show twice. */
  const paid = q.data?.paid;
  const subQuoteId = sub?.quote_id ?? null;
  const tds = q.data?.tds;
  const tabs = React.useMemo(() => historyTabs(docs, paid, { subQuoteId, todayIst, tds }), [docs, paid, subQuoteId, todayIst, tds]);
  const nameOf = (id: string) => names?.get(id)?.label ?? null;
  const fuRows = sub ? drawerFollowupRows(followupRows.filter((r) => r.subscription_id === sub.id), nameOf) : [];
  /* R-2762: every renewal reminder from the email + WhatsApp logs (read in the drawer's one query). */
  const reminderLog = q.data?.reminders;
  const reminderRows = React.useMemo(() => drawerReminderRows(reminderLog), [reminderLog]);
  /* only the logs' own read failing says so (a documents failure is said under History) */
  const reminderLogFailed = q.isSuccess && reminderLog === null;
  const termStart = sub?.renewal_date ? currentTermStart({ term_months: sub.term_months ?? 12, start_date: sub.start_date ?? null, renewal_date: sub.renewal_date }) : null;
  const [showAllReminders, setShowAllReminders] = React.useState(false);
  React.useEffect(() => setShowAllReminders(false), [sub?.id]);
  const remindersShown = showAllReminders ? reminderRows : reminderRows.slice(0, REMINDERS_PAGE);
  const flags = item?.stage && sub
    ? drawerFlagRows(item.stage.flags, {
        priorDueGap: priorDueInvoiceGap(item.docs, item.prior ?? null, todayIst),
        nonRenewing: isNonRenewing(sub) ? { reason: sub.non_renew_reason, saidOn: sub.non_renew_said_on } : null,
        renewedAnyway: vendorHoldState(sub as Parameters<typeof vendorHoldState>[0]) === "overridden",
      })
    : [];
  /* R-2819: cost is internal — only a role that may open the catalogue sees it; nobody else's drawer reads it. */
  const showCost = mayShowRenewalCost(me?.role);
  const catalog = useRenewalDrawerCatalog(sub?.tenant_id ?? null, open && !!sub && showCost);
  /* R-2835: price the seats the next quote bills — a cut scheduled for this renewal is applied the way the quote does (same loader + rule) */
  const seatCuts = useRenewalDrawerSeatCuts(sub?.tenant_id ?? null, sub?.id ?? null, open && !!sub && showCost);
  const seatCutsLoading = seatCuts.data === undefined && !seatCuts.isError;
  const seatPlan = React.useMemo(
    () => (sub ? drawerSeatPlan(sub, seatCuts.isError ? null : seatCuts.data ?? []) : null),
    [sub, seatCuts.data, seatCuts.isError],
  );
  const cost = React.useMemo(
    () => (!sub || catalog.isError ? null : catalog.data && !seatCutsLoading ? renewalCostForSub(catalog.data, { ...sub, seats: seatPlan?.seats ?? sub.seats }) : undefined),
    [sub, catalog.data, catalog.isError, seatCutsLoading, seatPlan],
  );
  const money = item ? drawerMoney(item.amount, cost, sub?.term_months, seatPlan ?? undefined) : ({ kind: "loading" } as const);
  const booksLine = item ? booksRupeeLine(item.amount, sub?.term_months) : null;
  const fu = item?.followup;
  const owner = fu?.ownerId ? nameOf(fu.ownerId) ?? "a colleague" : "Nobody yet";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:w-[30rem] sm:max-w-[95vw]" data-testid="renewal-drawer" onCloseAutoFocus={restoreFocus}
        onOpenAutoFocus={(e) => { if (toHistory && focusHistory(historyRef.current)) e.preventDefault(); }}>
        {!item || !sub ? (
          <SheetHeader>
            <SheetTitle>Renewal not on this page</SheetTitle>
            <SheetDescription>This link points to a renewal that is not in the Renewals list now (renewed, ended or no date).</SheetDescription>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="mb-2">
              <SheetTitle className="pr-8">
                {sub.customer_id
                  ? <Link href={`/customers/${sub.customer_id}` as never} className="hover:underline">{sub.customer_name}</Link>
                  : sub.customer_name}
              </SheetTitle>
              <SheetDescription>
                {[sub.plan, sub.seats != null ? `${sub.seats} seats` : null, sub.vendor ? sub.vendor[0].toUpperCase() + sub.vendor.slice(1) : null, subscriptionDomain(sub)].filter(Boolean).join(" · ")}
              </SheetDescription>
              <RenewalContact contact={item.contact} customerId={sub.customer_id} loading={!item.contact} />
              <div className="mt-2 flex flex-wrap items-start justify-between gap-3" data-testid="renewal-drawer-head">
                <div className="min-w-0">
                  {item.stage
                    ? <Badge kind={item.stage.tone} dot className="whitespace-normal text-left">{item.stage.label}</Badge>
                    : <Skeleton className="h-5 w-24" aria-label="Loading status" />}
                  {item.stage?.note && <p className="mt-1 text-xs text-ink-3">{item.stage.note}</p>}
                  {/* R-2834: the row's Due answer (R-2817 anchor) — "Part due 1 Oct 2026 · renews 31 Oct 2026" when a part fell due first. */}
                  <p className="mt-1 text-xs text-ink-3 tabular-nums" data-testid="renewal-drawer-renews">{renewsWords(dueCellFacts(item.stage, sub, item.daysUntil).title, sub.renewal_date)}</p>
                </div>
                <div className="shrink-0">
                  <RenewalActions sub={sub} daysUntil={item.daysUntil} layout="card" strong={strong} onFollowup={onFollowup} messaging stage={item.stage} payHref={item.payHref} />
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-4 px-6 pb-6">
              {/* R-2839: the History button's target (scrolled to; its active tab gets focus) */}
              <div ref={historyRef} tabIndex={-1} className="scroll-mt-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber" data-testid="renewal-drawer-history-target">
                <DrawerHistory
                  key={sub.id} tabs={tabs} loading={q.isLoading} failed={q.isError}
                  customer={sub.customer_id ? { id: sub.customer_id, name: sub.customer_name } : null}
                  canQuotes={canQuotes} canInvoices={canInvoices}
                />
              </div>

              <Section title="Terms" testId="renewal-drawer-terms">
                <dl>
                  <Fact label="This term">{currentTermWords(sub) ?? "—"}</Fact>
                  <Fact label="Next term">{nextTermWords(sub) ?? "—"}</Fact>
                  {/* R-2823: the vendor's own renewal date, only when known and not the same as ours. */}
                  {vendorWords && <Fact label="At the vendor"><span className="tabular-nums" data-testid="renewal-drawer-vendor-term">{vendorWords}</span></Fact>}
                  <Fact label={showCost ? "Customer pays" : "Amount"}><span className="tabular-nums">{item.amount.text}</span> <span className="text-ink-3">{item.amount.gst}</span>
                    {showCost && booksLine && <span className="block text-xs text-ink-3 tabular-nums" data-testid="renewal-drawer-books">{booksLine}</span>}
                    {item.amount.quoteNote && <span className="block text-xs text-ink-3">{item.amount.quoteNote}</span>}</Fact>
                  {showCost && <CostFacts money={money} />}
                  <Fact label="Billed">{item.frequency ?? "—"}</Fact>
                  <Fact label="Term length">{termLengthWords(sub.term_months)}</Fact>
                </dl>
              </Section>

              <Section title="Follow-ups" testId="renewal-drawer-followups">
                <dl className="mb-2">
                  <Fact label="Owner">{owner}</Fact>
                  <Fact label="Next follow-up">{fu?.nextFollowUpOn ? formatDate(fu.nextFollowUpOn) : "—"}</Fact>
                  {fu?.promisedOn && (
                    <Fact label="Promise">
                      {formatDate(fu.promisedOn)}{fu.promisedAmount ? ` · ${rupee(fu.promisedAmount)}` : ""}
                      {fu.promiseStatus ? ` · ${fu.promiseStatus === "broken" ? "broken" : fu.promiseStatus === "kept" ? "kept" : "waiting"}` : ""}
                    </Fact>
                  )}
                  <Fact label="Confirmed">{fu?.confirmed ? "Yes — customer confirmed the renewal" : "Not yet"}</Fact>
                  <Fact label="Reminders">
                    {q.isLoading ? <Skeleton className="inline-block h-4 w-40 align-middle" aria-label="Loading reminders" /> : (
                      <span data-testid="renewal-drawer-reminders-summary">{q.isError || reminderLogFailed ? remindersWords(sub) : reminderLogWords(reminderRows, sub, termStart)}</span>
                    )}
                    {reminderLogCapped(reminderLog) && <span className="block text-xs text-ink-3">Only the latest {REMINDER_LOG_MAX} per channel are listed.</span>}
                    {reminderLogFailed && <span className="block text-xs text-ink-3">Couldn&apos;t load the reminder list — close and open again.</span>}
                  </Fact>
                </dl>
                {reminderRows.length > 0 && (
                  <div className="mb-2" data-testid="renewal-drawer-reminders">
                    <ul className="divide-y divide-hairline/70">
                      {remindersShown.map((r) => (
                        <li key={r.id} className="py-1.5 text-sm" data-testid="renewal-drawer-reminder" data-channel={r.channel}>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 text-ink-2"><span className="tabular-nums">{r.when}</span> · {r.channel} · {r.what}</span>
                            <span className={cn("shrink-0 text-right text-xs", r.reached ? "text-ink-2" : "font-medium text-rose-600")}>{r.status}</span>
                          </div>
                          {r.to && <p className="truncate text-xs text-ink-3" title={r.to}>to {r.to}</p>}
                        </li>
                      ))}
                    </ul>
                    {!showAllReminders && reminderRows.length > REMINDERS_PAGE && (
                      <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAllReminders(true)}>
                        Show all {reminderRows.length}
                      </Button>
                    )}
                  </div>
                )}
                {fuRows.length === 0 ? (
                  <p className="text-sm text-ink-3">No follow-up logged yet.</p>
                ) : (
                  <ul className="divide-y divide-hairline/70">
                    {fuRows.map((f) => (
                      <li key={f.id} className="py-1.5 text-sm" data-testid="renewal-drawer-followup">
                        <p className="text-xs text-ink-3">{[f.when, f.kind, f.who].filter(Boolean).join(" · ")}</p>
                        {f.note && <p className="break-words text-ink">{f.note}</p>}
                        {[f.outcome, f.promise, f.next].filter(Boolean).length > 0 && (
                          <p className="text-xs text-ink-2">{[f.outcome, f.promise, f.next].filter(Boolean).join(" · ")}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {flags.length > 0 && (
                <Section title="Flags" testId="renewal-drawer-flags">
                  <ul className="space-y-2">
                    {flags.map((f) => (
                      <li key={f.key} className="text-sm" data-testid="renewal-drawer-flag" data-flag={f.key}>
                        <p className="font-medium text-ink">{f.title} <span className="font-normal text-ink-2">— {f.reason}</span></p>
                        <p className="text-xs text-ink-3">{f.explain}</p>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
