"use client";
/**
 * R-2866 (Pardeep 16 Nov 2026, staging screenshot — Ravi Shankar, Q-A378-27-0124: "quotation ka pop up window
 * khulna chahiye") — the quote pop-up over Renewals. The row's quote number (row-quote.tsx) opens it; the list,
 * its scroll and its filters stay where they were (Esc / Close gives the focus back to the number).
 *
 * Nothing new is worked out here — every fact comes from the piece that already owns it:
 *   the quote            useQuote (the quote page's read)
 *   type                 quoteKindFor + usePartFacts — "Renewal · Part 1 of 1 · Oct 2026" (the quote page's stamp)
 *   status               last-docs quoteStateLabel (the row's own word); a part request / a cancelled quote as the
 *                        quote page says it (proforma.ts proformaShownState — a part request is never "Expired",
 *                        R-2846). Whether a part request's email went out is not read here, so "Ready to send" is
 *                        only on the quote page
 *   pay by / valid till  a part proforma's due date (usePartDueOn), else the quote's validity
 *   lines + periods      quote-peek.ts (the row's hover card shows the same lines)
 *   totals               the quote's stored subtotal / discount / GST / amount
 *   payments so far      usePaymentsByQuote (the quote page's Payment history)
 * Next steps open what already exists — nothing is sent from here:
 *   Record payment       the same RecordPaymentDialog as Payments Received (RecordQuotePaymentDialog), offered by
 *                        the quote page's money rule (money-stage.ts quoteMoneyActions) with its approval gate
 *                        (payment-approval-gate.ts — a below-cost quote waiting for the owner takes no money) and
 *                        only to a role that records money (roles.ts canRecordMoney)
 *   Send on WhatsApp     the quote page's WhatsApp step (/quotes/<id>?send=whatsapp — its approval / state gate and
 *                        its own Send button stay there)
 *   Copy customer link   the customer's accept link, behind the Quotes list's customer-copy gate
 *                        (customerCopyBlockForRow); a draft's link opens nothing → copy it from the quote page.
 *                        A locked copy says why in words under the facts, with the gate's own fix link (never a
 *                        reason hidden in a disabled button's title). A quote past its validity is closed for
 *                        sending, as on the quote page (quote-expiry.ts shownQuoteStatus + isClosedForSending)
 *   Open full quote      /quotes/<id>
 */
import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { useQuote } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived } from "@/lib/queries/payments";
import { useQuoteCopyParties } from "@/lib/queries/quote-copy-parties";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { usePartFacts } from "@/lib/quotes/quote-kind-facts";
import { quoteKindFor } from "@/lib/quotes/quote-kind";
import { usePartDueOn } from "@/lib/billing/use-part-due";
import { customerCopyBlockForRow } from "@/lib/quotes/customer-copy-rows";
import { customerCopyBlockTitle } from "@/lib/quotes/customer-copy-gate";
import { copyNeedsMarkSent } from "@/lib/quotes/mark-quote-sent";
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { copyCustomerLink } from "@/components/features/quotes/failed-send-toast";
import { quoteTotal } from "@/app/(app)/quotes/[id]/pay-intent";
import { recordPaymentBlock } from "@/app/(app)/quotes/[id]/payment-approval-gate";
import { isClosedForSending } from "@/app/(app)/quotes/[id]/primary-action";
import { quoteMoneyActions } from "@/lib/quotes/money-stage";
import { shownQuoteStatus } from "@/lib/quotes/quote-expiry";
import { proformaShownState } from "@/lib/billing/proforma";
import { canRecordMoney } from "@/lib/auth/roles";
import { RecordQuotePaymentDialog } from "@/app/(app)/payments/record-quote-payment";
import { istToday } from "@/lib/dates/ist";
import { docMoney, quoteStateLabel, type LastDocs } from "./last-docs";
import { rowRenewalQuote } from "./row-quote";
import { useRowQuoteLines, type PeekRef } from "./quote-peek-data";
import { peekLineDetail, peekLineText, peekPeriod, peekTotals, type PeekLine } from "./quote-peek";

/** Statuses a quote can still be sent / shared in (a closed quote's next step is on its own page). */
const SHAREABLE = new Set(["draft", "sent", "viewed", "accepted"]);

export const LINES_FAILED_TEXT = "The product lines couldn't load — close this and reload the page.";
export const DRAFT_LINK_NOTE = "A draft's customer link opens nothing — send the quote from Open full quote first.";

export function quoteHref(id: string): string {
  return `/quotes/${encodeURIComponent(id)}`;
}

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="break-words text-sm text-ink tabular-nums" data-testid={testId}>{children}</dd>
    </div>
  );
}

function MoneyRow({ label, value, strong = false, testId }: { label: string; value: string; strong?: boolean; testId?: string }) {
  return (
    <div className={strong ? "flex justify-between gap-3 border-t border-hairline pt-1 font-semibold text-ink" : "flex justify-between gap-3 text-ink-2"}>
      <dt>{label}</dt>
      <dd className="tabular-nums" data-testid={testId}>{value}</dd>
    </div>
  );
}

/**
 * `quoteId` null = closed. `lines`: the quote's product lines from the rows' one read (quote-peek-data.ts);
 * undefined = not read yet; `linesFailed`: that read failed (said in words — never a skeleton for ever).
 * `todayIst`: the page's today (the status word's "Expired").
 */
export function QuotePeekDialog({ quoteId, onClose, lines, linesFailed = false, todayIst, returnFocusTo }: {
  /** The element that opened the pop-up (the row's quote number). Radix returns focus only to a DialogTrigger - this dialog has none, so Esc / close left focus on body. */
  returnFocusTo?: () => HTMLElement | null;
  quoteId: string | null;
  onClose: () => void;
  lines: readonly PeekLine[] | undefined;
  linesFailed?: boolean;
  todayIst: string;
}) {
  const open = !!quoteId;
  const { data: quote, isLoading, isError } = useQuote(quoteId ?? undefined);
  const { data: payments } = usePaymentsByQuote(quoteId);
  const { data: me } = useCurrentUser();
  const leadBillingId = (quote as { subscription_billing_id?: string | null } | null | undefined)?.subscription_billing_id ?? null;
  const { data: partFacts } = usePartFacts([leadBillingId]);
  const { data: partDue } = usePartDueOn(leadBillingId);
  const { data: parties } = useQuoteCopyParties(quote?.customer_id ? [quote.customer_id] : [], quote && !quote.customer_id && quote.lead_id ? [quote.lead_id] : []);
  /* Record payment is the SAME dialog as everywhere; the pop-up closes for it (one layer at a time) */
  const [payFor, setPayFor] = React.useState<string | null>(null);

  const receivedSoFar = payments ? totalReceived(payments) : null;
  /* the quote page's money rule, with its approval gate; the split-billed part plan is not read here — the same
     record-payment dialog and the server keep that rule */
  const money = quote && receivedSoFar != null ? quoteMoneyActions({
    status: quote.status, paymentStatus: quote.payment_status, invoiceId: quote.invoice_id, total: quoteTotal(quote), received: receivedSoFar,
    partRequest: !!leadBillingId, approvalWait: !!recordPaymentBlock(quote as typeof quote & { below_cost?: boolean | null }),
  }, String) : null;
  const canPay = !!money?.canRecordPayment && canRecordMoney(me?.role);
  const shownStatus = quote ? shownQuoteStatus(quote, todayIst) : null;
  const shareable = !!quote && !!shownStatus && SHAREABLE.has(quote.status) && !isClosedForSending({ status: shownStatus, supersededBy: quote.superseded_by })
    && quote.payment_status !== "received" && !quote.invoice_id;
  const block = quote ? customerCopyBlockForRow(quote, parties && me ? { ...parties, seller: { state_code: me.tenantStateCode, gstin: me.tenantGstin }, role: me.role } : null) : null;
  const blockTitle = customerCopyBlockTitle(block);
  const draft = copyNeedsMarkSent(quote?.status);

  const body = () => {
    if (isError) return <p className="text-sm text-ink-3" role="alert">Couldn&apos;t load this quote — close and open it again.</p>;
    if (isLoading || quote === undefined) return <Skeleton className="h-40 w-full" aria-label="Loading quote" />;
    if (!quote) return <p className="text-sm text-ink-3">This quote is not available to you.</p>;

    const fx = Number(quote.exchange_rate);
    const cur = { currency: quote.currency ?? null, fxRate: Number.isFinite(fx) && fx > 0 ? fx : null };
    const money = (inr: number) => docMoney(cur, inr);
    const stamp = quoteKindFor(quote, leadBillingId ? partFacts?.get(leadBillingId)?.facts ?? null : null);
    const type = [stamp?.chip, stamp?.part].filter(Boolean).join(" · ") || null;
    const partState = proformaShownState({
      isPartRequest: !!leadBillingId, status: quote.status, cancelledAt: (quote as { cancelled_at?: string | null }).cancelled_at,
      invoiceId: quote.invoice_id, paymentStatus: quote.payment_status, mailed: true /* not read here — see the header */,
      dueOn: partDue?.dueOn ?? null, todayISO: todayIst, validityEnded: shownStatus === "expired",
    });
    const state = partState?.label ?? quoteStateLabel(quote, todayIst);
    const payBy = leadBillingId
      ? (partDue?.dueOn ? `Pay by ${formatDate(partDue.dueOn)}` : null)
      : (quote.expires_date ? `Valid till ${formatDate(quote.expires_date)}` : null);
    const period = lines ? peekPeriod(lines) : null;
    const t = peekTotals(quote);
    const received = receivedSoFar;
    const due = received == null ? null : Math.max(0, t.total - received);
    const shown = (payments ?? []).filter((p) => p.status === "received");

    return (
      <div className="space-y-4" data-testid="quote-peek-body">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Fact label="Type" testId="quote-peek-type">{type ?? "—"}</Fact>
          <Fact label="Status" testId="quote-peek-status">{state}{payBy ? ` · ${payBy}` : ""}</Fact>
          <Fact label="Period" testId="quote-peek-period">{period ?? "—"}</Fact>
          <Fact label="Quote date" testId="quote-peek-date">{quote.created_date ? formatDate(quote.created_date) : "—"}</Fact>
        </dl>

        <section aria-label="Lines">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Lines</h3>
          {lines === undefined ? (linesFailed ? <p className="text-sm text-ink-3" role="alert" data-testid="quote-peek-lines-failed">{LINES_FAILED_TEXT}</p> : <Skeleton className="h-10 w-full" aria-label="Loading lines" />)
            : lines.length === 0 ? <p className="text-sm text-ink-3">No product lines on this quote.</p>
            : (
              <ul className="divide-y divide-hairline/70 text-sm" data-testid="quote-peek-lines">
                {lines.map((l, n) => (
                  <li key={n} className="py-1.5" data-testid="quote-peek-line">
                    <p className="break-words text-ink">{l.name}</p>
                    {/* R-2922: seats × the rate a seat in the quote's own currency, like a renewal quotation's line */}
                    {peekLineDetail(l, money) && <p className="break-words text-xs text-ink-3 tabular-nums" data-testid="quote-peek-line-detail">{peekLineDetail(l, money)}</p>}
                    <span className="sr-only">{peekLineText(l)}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <dl className="ml-auto w-full max-w-xs space-y-1 text-sm" aria-label="Totals" data-testid="quote-peek-totals">
          <MoneyRow label="Subtotal" value={money(t.subtotal)} />
          {t.discount > 0 && <MoneyRow label="Discount" value={`− ${money(t.discount)}`} />}
          <MoneyRow label={t.gstRate > 0 ? `GST ${t.gstRate}%` : "GST"} value={money(t.gst)} testId="quote-peek-gst" />
          <MoneyRow label="Total incl. GST" value={money(t.total)} strong testId="quote-peek-total" />
        </dl>

        <section aria-label="Payments so far">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Payments so far</h3>
          {payments === undefined ? <Skeleton className="h-6 w-full" aria-label="Loading payments" />
            : shown.length === 0 ? <p className="text-sm text-ink-3" data-testid="quote-peek-no-payments">No payment recorded on this quote yet.</p>
            : (
              <ul className="text-sm" data-testid="quote-peek-payments">
                {shown.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3 py-0.5">
                    <span className="min-w-0 break-words text-ink-2"><span className="tabular-nums">{formatDate(p.received_at)}</span> · {paymentMethodLabel(p.method)}</span>
                    <span className="shrink-0 font-medium tabular-nums text-ink">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          {received != null && due != null && (
            <p className="mt-1 text-sm text-ink-2 tabular-nums" data-testid="quote-peek-received">
              Received {money(received)} of {money(t.total)}{due > 0 ? ` · ${money(due)} still due` : " · nothing due"}
            </p>
          )}
        </section>

        {/* a locked customer copy says why HERE, in words, with the gate's own fix — never only in a disabled button's title */}
        {shareable && (block || draft) && (
          <p className="rounded-sm border border-hairline px-2 py-1.5 text-xs text-ink-2" role="note" data-testid="quote-peek-share-note">
            {block ? (
              <>
                Customer link and WhatsApp are locked — {block.kind === "approval" ? "this quote needs approval first. Open full quote to see the approval." : `${block.reason} ${block.nextStep}`}
                {block.action && <>{" "}<Link href={block.action.href as never} className="font-medium underline underline-offset-2">{block.action.label}</Link></>}
              </>
            ) : DRAFT_LINK_NOTE}
          </p>
        )}
      </div>
    );
  };

  const copy = () => {
    if (!quote) return;
    copyCustomerLink(`${window.location.origin}/quote/${quote.id}/accept?t=${encodeURIComponent(quote.public_token)}`);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="md:!max-w-[640px]" data-testid="quote-peek-dialog" onCloseAutoFocus={(e) => { const el = returnFocusTo?.(); if (el?.isConnected) { e.preventDefault(); el.focus(); } }}>
          <DialogHeader>
            <DialogTitle className="font-mono">Quote {quoteId}</DialogTitle>
            <DialogDescription>{quote?.customer_name ?? "Renewal quote"}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">{body()}</div>
          <DialogFooter className="flex-wrap gap-2">
            {quote && shareable && (
              <>
                <Button variant="ghost" icon="link" disabled={!!block || draft} onClick={copy}
                  title={block ? blockTitle : draft ? "A draft's link opens nothing — send it from the full quote first" : "Copy the customer's accept link — share it yourself by email, WhatsApp or chat"}>
                  Copy customer link
                </Button>
                {block ? (
                  <Button variant="ghost" icon="whatsapp" disabled title={blockTitle}>Send on WhatsApp</Button>
                ) : (
                  <Button asChild variant="ghost" icon="whatsapp" title="Opens the quote's WhatsApp step — nothing is sent until you press Send there">
                    <Link href={`${quoteHref(quote.id)}?send=whatsapp` as never}>Send on WhatsApp</Link>
                  </Button>
                )}
              </>
            )}
            {quoteId && (
              <Button asChild variant={canPay ? "default" : "primary"} icon="file">
                <Link href={quoteHref(quoteId) as never} data-testid="quote-peek-open-full">Open full quote</Link>
              </Button>
            )}
            {quote && canPay && (
              <Button variant="primary" icon="rupee" data-testid="quote-peek-record-payment" onClick={() => { setPayFor(quote.id); onClose(); }}>
                Record payment
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RecordQuotePaymentDialog quoteId={payFor} open={!!payFor} onOpenChange={(o) => { if (!o) setPayFor(null); }} />
    </>
  );
}

/**
 * The Renewals list's wiring in one call (page.tsx stays thin): ONE lines read for the quotes of the rows on
 * screen, which quote's pop-up is open, and the pop-up itself. `enabled` false (a role that cannot open quotes)
 * → no read, no pop-up.
 */
export function useRowQuotePeek(
  rows: readonly { sub: { id: string; domain?: string | null; start_date?: string | null; term_months?: number | null }; docs?: LastDocs; stage: { quoteId: string | null } | null }[],
  enabled: boolean,
) {
  const refs: PeekRef[] = enabled ? rows.flatMap((r) => {
    const q = rowRenewalQuote(r.docs, r.stage);
    return q ? [{ quoteId: q.id, sub: { id: r.sub.id, domain: r.sub.domain ?? null, start_date: r.sub.start_date ?? null, term_months: r.sub.term_months ?? null } }] : [];
  }) : [];
  const { data, isPlaceholderData, isError } = useRowQuoteLines(refs);
  const [openId, setOpenId] = React.useState<string | null>(null);
  /* the number that was focused when the pop-up opened - focus goes back to it on close (a keyboard user keeps their place) */
  const opener = React.useRef<HTMLElement | null>(null);
  const openFor = React.useCallback((id: string) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpenId(id); }, []);
  /* read done, quote not in the answer (not readable) → no lines, never "Loading…" for ever. While the rows changed
     ("Show 50 more", a filter) and the last answer is still on screen, a quote it does not hold is NOT read yet —
     never a false "No product lines". */
  const linesOf = (quoteId: string) => (!data ? undefined : data.has(quoteId) ? data.get(quoteId) : isPlaceholderData ? undefined : []);
  const failed = !!isError;
  return {
    linesOf,
    /** the lines read failed — the hover and the pop-up say so instead of loading for ever */
    failed,
    open: enabled ? openFor : undefined,
    dialog: enabled ? <QuotePeekDialog returnFocusTo={() => opener.current} quoteId={openId} onClose={() => setOpenId(null)} lines={openId ? linesOf(openId) : undefined} linesFailed={failed} todayIst={istToday()} /> : null,
  };
}
