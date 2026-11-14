"use client";
/**
 * R-2740 — the Renewals row drawer: the renewal's whole story on one screen (right side sheet,
 * 480px; full width on a phone). Read-only: its only actions are the row's own ONE button + ⋯
 * (RenewalActions — the same dialogs). Rules + words: ./drawer.ts; the one read: ./drawer-data.ts.
 *
 *   header      customer (link) · plan · seats · vendor · the stage chip + note · the button
 *   Terms       this term · next term · amount · how it is billed · term length
 *   Documents   every quote + invoice (id link · date · period · amount · status), newest first
 *   Payments    date · amount · method · the invoice it paid
 *   Follow-ups  owner / next date / promise · each logged follow-up · reminders sent
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
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import type { Subscription } from "@/lib/supabase/database.types";
import type { RenewalStage } from "@/lib/renewals/stage";
import type { UserName } from "@/lib/hooks/useUserNames";
import { isNonRenewing } from "@/lib/subscriptions/non-renewing";
import { vendorHoldState } from "@/lib/renewals/vendor-hold";
import { useRenewalDrawerData } from "./drawer-data";
import {
  currentTermWords, drawerSubFromSearch, withDrawerSub, drawerDocRows, drawerFlagRows, drawerFollowupRows, drawerPage, drawerPaymentRows,
  remindersWords, termLengthWords, type DrawerDocRow,
} from "./drawer";
import { priorDueInvoiceGap, type DocTone, type LastDocs } from "./last-docs";
import { priorTermDue } from "./prior-due";
import { nextTermWords } from "./row-cells";
import type { RenewalAmount } from "./queue";
import type { RenewalFollowup, RenewalFollowupRow } from "./followup";

/** What opened the drawer (the product button) — focus goes back to it on close. */
let drawerOpener: HTMLElement | null = null;

/**
 * The open drawer's subscription id, kept in ?sub= so the link can be shared and Back closes it.
 * Plain history.pushState / replaceState — Next 15's router keeps them in step without a server
 * round trip (router.push re-requested the /renewals payload on every open). Opening pushes an
 * entry; closing goes back over an entry this page pushed (also one reached again by Forward), or
 * just drops ?sub= when the page was opened from a shared link. Back / Forward re-read it.
 */
export function useRenewalDrawerSub(): [string | null, (id: string) => void, () => void] {
  const [id, setId] = React.useState<string | null>(null);
  /* the ?sub= entry on screen was pushed by this page (so Close = Back) */
  const pushed = React.useRef(false);
  const pushedAny = React.useRef(false);
  React.useEffect(() => {
    const read = () => {
      const next = drawerSubFromSearch(window.location.search);
      pushed.current = !!next && pushedAny.current;
      setId(next);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const open = React.useCallback((next: string) => {
    drawerOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setId(next);
    pushed.current = true;
    pushedAny.current = true;
    window.history.pushState(null, "", withDrawerSub(window.location.href, next));
  }, []);
  const close = React.useCallback(() => {
    setId(null);
    if (pushed.current) { pushed.current = false; window.history.back(); }
    else window.history.replaceState(null, "", withDrawerSub(window.location.href, null));
  }, []);
  return [id, open, close];
}

/** A row press outside its links, buttons and boxes opens the drawer (R-2740). */
export function isRowOpenClick(target: EventTarget | null): boolean {
  return !(target instanceof Element) || !target.closest("a,button,input,select,textarea,label,[role=menuitem],[role=checkbox],[data-no-drawer]");
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
}

const TONE: Record<DocTone, string> = {
  ok: "text-emerald",
  warn: "font-medium text-ink",
  danger: "font-medium text-rose-600",
  muted: "text-ink-3",
};

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

function DocId({ row, canQuotes, canInvoices }: { row: DrawerDocRow; canQuotes: boolean; canInvoices: boolean }) {
  const href = row.kind === "invoice" ? (canInvoices ? invoiceHref(row.id) : null) : (canQuotes ? `/quotes/${encodeURIComponent(row.id)}` : null);
  return href
    ? <Link href={href as never} className="font-mono underline underline-offset-2 hover:text-ink">{row.id}</Link>
    : <span className="font-mono">{row.id}</span>;
}

export function RenewalDrawer({ item, open, onClose, names, followupRows, onFollowup, strong }: {
  /** The row it is about; null while ?sub= names a renewal not on this page. */
  item: DrawerItem | null;
  open: boolean;
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
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => setShowAll(false), [sub?.id]);
  const todayIst = istToday();
  /* Esc / Close returns focus to what opened it (the product button), even after the row re-rendered. */
  const restoreFocus = (e: Event) => {
    const el = drawerOpener;
    drawerOpener = null;
    if (el?.isConnected) { e.preventDefault(); el.focus(); }
  };

  const docs = q.data?.docs;
  const docRows = React.useMemo(() => drawerDocRows(docs, todayIst), [docs, todayIst]);
  const page = drawerPage(docRows, showAll);
  const payments = drawerPaymentRows(q.data?.paid);
  const nameOf = (id: string) => names?.get(id)?.label ?? null;
  const fuRows = sub ? drawerFollowupRows(followupRows.filter((r) => r.subscription_id === sub.id), nameOf) : [];
  const flags = item?.stage && sub
    ? drawerFlagRows(item.stage.flags, {
        priorDueGap: priorDueInvoiceGap(item.docs, priorTermDue(sub), todayIst),
        nonRenewing: isNonRenewing(sub) ? { reason: sub.non_renew_reason, saidOn: sub.non_renew_said_on } : null,
        renewedAnyway: vendorHoldState(sub as Parameters<typeof vendorHoldState>[0]) === "overridden",
      })
    : [];
  const fu = item?.followup;
  const owner = fu?.ownerId ? nameOf(fu.ownerId) ?? "a colleague" : "Nobody yet";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:w-[30rem] sm:max-w-[95vw]" data-testid="renewal-drawer" onCloseAutoFocus={restoreFocus}>
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
                {[sub.plan, sub.seats != null ? `${sub.seats} seats` : null, sub.vendor ? sub.vendor[0].toUpperCase() + sub.vendor.slice(1) : null, sub.domain].filter(Boolean).join(" · ")}
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-start justify-between gap-3" data-testid="renewal-drawer-head">
                <div className="min-w-0">
                  {item.stage
                    ? <Badge kind={item.stage.tone} dot className="whitespace-normal text-left">{item.stage.label}</Badge>
                    : <Skeleton className="h-5 w-24" aria-label="Loading status" />}
                  {item.stage?.note && <p className="mt-1 text-xs text-ink-3">{item.stage.note}</p>}
                  <p className="mt-1 text-xs text-ink-3 tabular-nums">Renews {sub.renewal_date ? formatDate(sub.renewal_date) : "— no date"}</p>
                </div>
                <div className="shrink-0">
                  <RenewalActions sub={sub} daysUntil={item.daysUntil} layout="card" strong={strong} onFollowup={onFollowup} messaging stage={item.stage} payHref={item.payHref} />
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-4 px-6 pb-6">
              <Section title="Terms" testId="renewal-drawer-terms">
                <dl>
                  <Fact label="This term">{currentTermWords(sub) ?? "—"}</Fact>
                  <Fact label="Next term">{nextTermWords(sub) ?? "—"}</Fact>
                  <Fact label="Amount"><span className="tabular-nums">{item.amount.text}</span> <span className="text-ink-3">{item.amount.gst}</span></Fact>
                  <Fact label="Billed">{item.frequency ?? "—"}</Fact>
                  <Fact label="Term length">{termLengthWords(sub.term_months)}</Fact>
                </dl>
              </Section>

              <Section title={`Quotes & invoices${docRows.length ? ` (${docRows.length})` : ""}`} testId="renewal-drawer-docs">
                {q.isLoading ? <Skeleton className="h-16 w-full" /> : q.isError ? (
                  <p className="text-sm text-ink-3">Couldn&apos;t load the documents — close and open again.</p>
                ) : docRows.length === 0 ? (
                  <p className="text-sm text-ink-3">No quotes or invoices yet.</p>
                ) : (
                  <>
                    <ul className="divide-y divide-hairline/70">
                      {page.shown.map((r) => (
                        <li key={`${r.kind}-${r.id}`} className={cn("py-2 text-sm", r.tone === "muted" && r.kind === "invoice" && "opacity-70")} data-testid="renewal-drawer-doc" data-kind={r.kind}>
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="min-w-0 truncate">
                              <span className="mr-1.5 text-2xs uppercase text-ink-3">{r.kind === "invoice" ? "Invoice" : "Quote"}</span>
                              <DocId row={r} canQuotes={canQuotes} canInvoices={canInvoices} />
                            </p>
                            <span className="shrink-0 tabular-nums text-ink">{r.amount ?? "—"}</span>
                          </div>
                          <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs">
                            <span className="min-w-0 break-words text-ink-3 tabular-nums">
                              {r.date ? formatDate(r.date) : "No date"}{r.period ? ` · for ${r.period}` : ""}
                            </span>
                            <span className={cn("shrink-0 text-right", TONE[r.tone])} data-testid="renewal-drawer-doc-status">{r.status}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {page.hidden > 0 && (
                      <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>
                        Show all {docRows.length}
                      </Button>
                    )}
                  </>
                )}
              </Section>

              <Section title={`Payments${payments.length ? ` (${payments.length})` : ""}`} testId="renewal-drawer-payments">
                {q.isLoading ? <Skeleton className="h-10 w-full" /> : q.isError ? (
                  <p className="text-sm text-ink-3">Couldn&apos;t load the payments — close and open again.</p>
                ) : payments.length === 0 ? (
                  <p className="text-sm text-ink-3">No payment recorded in the app for this subscription.</p>
                ) : (
                  <ul className="divide-y divide-hairline/70">
                    {payments.map((p) => (
                      <li key={p.id} className="flex items-baseline justify-between gap-2 py-1.5 text-sm" data-testid="renewal-drawer-payment">
                        <span className="min-w-0 text-ink-2">
                          <span className="tabular-nums">{p.date}</span> · {p.method}
                          {p.doc && (
                            <> · for {p.docKind === "invoice"
                              ? (canInvoices ? <Link href={invoiceHref(p.doc) as never} className="font-mono underline underline-offset-2 hover:text-ink">{p.doc}</Link> : <span className="font-mono">{p.doc}</span>)
                              : (canQuotes ? <Link href={`/quotes/${encodeURIComponent(p.doc)}` as never} className="font-mono underline underline-offset-2 hover:text-ink">{p.doc}</Link> : <span className="font-mono">{p.doc}</span>)}
                            </>
                          )}
                          {p.shared ? <span className="text-ink-3"> · {p.shared}</span> : null}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-ink">{p.amount}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                  <Fact label="Reminders">{remindersWords(sub)}</Fact>
                </dl>
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
