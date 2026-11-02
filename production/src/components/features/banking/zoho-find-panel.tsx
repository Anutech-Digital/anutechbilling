/**
 * R-2359 — "Find in Zoho" in the Reconcile sheet, for a money-in bank line.
 *
 * Pardeep (2 Nov, FY 2026-27 audit): ~140 bank credits are already in Zoho Books with the bank UTR
 * as the payment reference. One press here finds that Zoho payment (UTR, else amount ±₹2 and
 * date ±3 days), shows its customer, invoice number(s) and lines, and fills the sheet's EXISTING
 * "A new sale" form (customer, products, seats, rate, dates). Nothing is booked until the owner
 * presses the sheet's own Save. Read-only to Zoho.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { FindZohoResult, ZohoPaymentMatch, ZohoPaymentRow } from "@/lib/integrations/zoho-books/payment-match";
import { zohoPrefill, type AppCustomerLite, type ZohoPrefill } from "@/lib/integrations/zoho-books/payment-prefill";

export const ZOHO_FIND_URL = "/api/integrations/zoho-books/payment-match";

type Catalog = Parameters<typeof zohoPrefill>[1]["catalog"];

interface Props {
  transactionId: string;
  txnDate: string;
  credit: number;
  customers: readonly AppCustomerLite[];
  catalog: Catalog;
  /** Fill the sale form below (nothing is saved). */
  onPrefill: (p: ZohoPrefill) => void;
  /** Opens the sheet's Add-customer form when Zoho's customer is not in the app. */
  onNewCustomer?: () => void;
}

type Next = { label: string; href?: string };
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string; why: string; next: Next }
  | { kind: "none"; utrs: string[]; from: string; to: string }
  | { kind: "several"; by: "utr" | "amount_date"; candidates: ZohoPaymentRow[] }
  | { kind: "match"; match: ZohoPaymentMatch; prefill: ZohoPrefill };

const box = "rounded-md border border-hairline bg-paper p-2.5 space-y-1.5";

export function ZohoFindPanel({ transactionId, txnDate, credit, customers, catalog, onPrefill, onNewCustomer }: Props) {
  const [state, setState] = React.useState<State>({ kind: "idle" });
  React.useEffect(() => { setState({ kind: "idle" }); }, [transactionId]);

  const run = async (paymentId?: string) => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(ZOHO_FIND_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId, ...(paymentId ? { paymentId } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; result: FindZohoResult }
        | { ok: false; error?: string; why?: string; next?: Next }
        | null;
      if (!body || !body.ok) {
        setState({
          kind: "error",
          error: body?.error ?? "Could not read from Zoho Books.",
          why: body?.why ?? "The server did not answer.",
          next: body?.next ?? { label: "Try again" },
        });
        return;
      }
      const r = body.result;
      if (r.kind === "match") {
        const prefill = zohoPrefill(r.match, { customers, catalog, txnDate });
        setState({ kind: "match", match: r.match, prefill });
        onPrefill(prefill);
      } else {
        setState(r);
      }
    } catch {
      setState({ kind: "error", error: "Could not reach the server.", why: "The internet connection dropped.", next: { label: "Try again" } });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="default" icon="search" loading={state.kind === "loading"} onClick={() => { void run(); }}>
          {state.kind === "loading" ? "Looking in Zoho…" : "Find in Zoho"}
        </Button>
        <span className="text-xs text-ink-3">Finds this payment in Zoho Books by its UTR and fills the sale below. Nothing is saved until you press Save.</span>
      </div>

      {state.kind === "error" && (
        <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft/30 p-2.5 space-y-1.5">
          <p className="text-xs text-rose-ink break-words"><b>{state.error}</b> {state.why}</p>
          {state.next.href ? (
            <Button size="sm" variant="default" asChild>
              <Link href={state.next.href as never}>{state.next.label}</Link>
            </Button>
          ) : (
            <Button size="sm" variant="default" onClick={() => { void run(); }}>{state.next.label}</Button>
          )}
        </div>
      )}

      {state.kind === "none" && (
        <div role="status" className={box}>
          <p className="text-xs text-ink-2 break-words">
            <b>No Zoho payment found.</b>{" "}
            {state.utrs.length ? <>No Zoho payment reference has {state.utrs.join(" or ")}, and</> : <>This line has no UTR, and</>}{" "}
            no payment of {rupee(credit)} (±₹2) is dated {formatDate(state.from)} – {formatDate(state.to)}.
          </p>
          <p className="text-xs text-ink-3">Pick the customer below by hand, or check the payment in Zoho Books.</p>
        </div>
      )}

      {state.kind === "several" && (
        <div className={box}>
          <p className="text-xs text-ink-2">
            Zoho has {state.candidates.length} payments that could be this one ({state.by === "utr" ? "same UTR" : `${rupee(credit)} within 3 days`}) — pick the right one:
          </p>
          <ul className="space-y-1">
            {state.candidates.map((c) => (
              <li key={c.zohoId} className="flex flex-wrap items-center gap-2 text-xs text-ink">
                <span className="min-w-0 flex-1 break-words tabular-nums">
                  #{c.number} · {formatDate(c.date)} · {rupee(c.amount)} · {c.customerName}{c.reference ? ` · Ref ${c.reference}` : ""}
                </span>
                <Button size="sm" variant="default" onClick={() => { void run(c.zohoId); }}>Use this payment</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.kind === "match" && <MatchBox match={state.match} prefill={state.prefill} onNewCustomer={onNewCustomer} />}
    </div>
  );
}

function MatchBox({ match, prefill, onNewCustomer }: { match: ZohoPaymentMatch; prefill: ZohoPrefill; onNewCustomer?: () => void }) {
  const p = match.payment;
  const lines = match.invoices.flatMap((i) => i.lines);
  return (
    <div role="status" aria-label="Zoho match" className={box}>
      <p className="text-xs text-ink-2 break-words tabular-nums">
        <b>Zoho payment #{p.number}</b> · {formatDate(p.date)} · {rupee(p.amount)}{p.reference ? ` · Ref ${p.reference}` : ""}
        {" "}({match.by === "utr" ? "matched by UTR" : match.by === "amount_date" ? "matched by amount and date" : "picked by you"})
      </p>
      <p className="text-xs text-ink break-words">
        Customer in Zoho: <b>{match.customer.name}</b>{match.customer.gstin ? ` · GSTIN ${match.customer.gstin}` : ""}
        {prefill.customer ? (
          <span className="text-ink-3"> → {prefill.customer.name} (matched by {prefill.customer.by === "gstin" ? "GSTIN" : "name"})</span>
        ) : null}
      </p>
      {!prefill.customer && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-amber-ink">No match — this customer is not in ResellerOS yet.</span>
          {onNewCustomer && <Button size="sm" variant="default" icon="plus" onClick={onNewCustomer}>Create customer</Button>}
        </div>
      )}
      <p className="text-xs text-ink break-words">
        Zoho invoice{prefill.invoiceNumbers.length === 1 ? "" : "s"}: <b>{prefill.invoiceNumbers.join(", ") || "none applied"}</b>
      </p>
      {lines.length > 0 && (
        <ul className="text-xs text-ink-2 space-y-0.5">
          {lines.map((l, i) => (
            <li key={i} className="break-words tabular-nums">
              {l.name} × {l.qty}{l.rate !== null ? ` @ ${rupee(l.rate, { decimals: l.rate % 1 ? 2 : 0 })}` : ""}
              {l.start && l.end ? ` · ${formatDate(l.start)} – ${formatDate(l.end)}` : ""}
              {l.domain ? ` · ${l.domain}` : ""}
            </li>
          ))}
        </ul>
      )}
      {prefill.unmatched.length > 0 && (
        <p className="text-xs text-amber-ink break-words">Not in your catalogue (kept as typed lines): {prefill.unmatched.join(", ")}.</p>
      )}
      {prefill.notes.map((n, i) => <p key={i} className="text-xs text-amber-ink break-words">{n}</p>)}
      <p className="text-xs text-ink-3">
        {prefill.lines.length > 0 ? "Filled below as a new sale — check it, then press Save." : "Zoho has no line items to fill — choose what this money is for below."}
      </p>
    </div>
  );
}
