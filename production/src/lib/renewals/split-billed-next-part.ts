/**
 * R-2095 (staging reconcile, 30 Oct 2026) — Renewals → Generate on a subscription billed in parts.
 *
 * Ravi Shankar (473 seats, billed monthly) and Greentin read "expired 29 days" since 1 Oct, and
 * Generate answered "billed monthly, each part gets its own invoice on its date" — but no part bill
 * existed, so month 2 could not be billed at all. R-808 is right that a whole-term renewal QUOTE
 * would bill twice; the answer to Generate is the NEXT PART's bill: roll the term on (what the
 * renewals cron does on the new term's first day — splitBilledRenewalStep) and bill the part that
 * is due (the billing job's own path: a payment request, or the tax invoice when it is paid).
 */
import type { SplitRenewalFields } from "./split-billed-renewal";
import { splitBilledRenewalStep } from "./split-billed-renewal";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { addMonthsClamped, addDaysISO, CYCLE_MONTHS } from "@/lib/billing/schedule";

/** The renewal_date after rolling every term that has begun by today (at most 24 terms). */
export function rolledRenewalDate(
  sub: SplitRenewalFields & { renewal_quote_id: string | null },
  todayISO: string,
): { renewalDate: string | null; rolls: number; heldBy: string | null } {
  let cur = { ...sub };
  let rolls = 0;
  for (let i = 0; i < 24; i++) {
    const step = splitBilledRenewalStep(cur, todayISO);
    if (step.kind === "held_open_quote") return { renewalDate: cur.renewal_date, rolls, heldBy: step.quoteId };
    if (step.kind !== "roll") break;
    cur = { ...cur, renewal_date: step.newRenewalDate };
    rolls++;
  }
  return { renewalDate: cur.renewal_date, rolls, heldBy: null };
}

export interface NextPartOutcome {
  raised: { period_index: number; invoice_id: string }[];
  requests: { period_index: number; quote_id: string }[];
  requestsOpen: { period_index: number; quote_id: string; status: string }[];
}

/** What Generate tells the owner, and where to go next (a request / invoice), or why nothing. */
export function nextPartMessage(customer: string | null, o: NextPartOutcome, skipReason: string | null):
  { ok: boolean; text: string; href: string | null } {
  const who = customer ?? "this customer";
  const inv = o.raised[0];
  if (inv) return { ok: true, text: `Tax invoice ${inv.invoice_id} raised for ${who}'s next part (it was paid).`, href: `/invoices/${inv.invoice_id}` };
  const req = o.requests[0];
  if (req) return { ok: true, text: `Payment request ${req.quote_id} made for ${who}'s next part. Its tax invoice is raised when it is paid.`, href: `/quotes/${req.quote_id}` };
  const open = o.requestsOpen[0];
  if (open) return { ok: true, text: `${who}'s next part already has payment request ${open.quote_id} (${open.status}).`, href: `/quotes/${open.quote_id}` };
  return { ok: false, text: skipReason ?? `Nothing is due yet for ${who} — the next part is billed on its date.`, href: null };
}

/* ── R-2095 (staging, 30 Oct, P0 money) — the OLDEST unbilled period first ─────────────────────
   Greentin, monthly, renewal_date 11 Sep: Generate rolled the term twice in one go (11 Sep → 11 Nov)
   and then billed only the term it landed in, 11 Oct–10 Nov (Q-A378-27-0122). 11 Sep–10 Oct was
   never billed — the billing job only ever bills the CURRENT term. Now each term is rolled ONE at a
   time and billed before the next roll: renewal_date moves exactly one term per bill, a GST
   document per period, oldest first. A term that cannot be billed is rolled back and stops the
   run — a period is never jumped over. */

export interface TermBill extends NextPartOutcome {
  skip: { code: string; reason: string } | null;
}

export interface TermsBilled {
  /** An open renewal quote holds the roll (R-808). */
  heldBy: string | null;
  /** Each term billed now, oldest first. periodEnd inclusive. */
  terms: { periodStart: string; periodEnd: string; bill: TermBill }[];
  /** A bill failed — the terms before it stay billed, renewal_date stays on the failed term. */
  error: string | null;
  /** A rolled term produced no bill (and was rolled back) — why. */
  stoppedReason: string | null;
}

function billedSomething(b: TermBill): boolean {
  return b.raised.length + b.requests.length + b.requestsOpen.length > 0;
}

/**
 * Bill every term that has begun by today, oldest first. `roll(from, to)` moves renewal_date
 * (guarded on `from`; throws when it cannot), `billCurrentTerm()` bills the term renewal_date now
 * closes (syncSubscriptionInstalments). Nothing to roll → the current term's due part, as before.
 */
export async function billDueTermsOldestFirst(args: {
  sub: SplitRenewalFields & { renewal_quote_id: string | null };
  todayISO: string;
  roll: (from: string, to: string) => Promise<void>;
  billCurrentTerm: () => Promise<TermBill>;
  maxTerms?: number;
}): Promise<TermsBilled> {
  const out: TermsBilled = { heldBy: null, terms: [], error: null, stoppedReason: null };
  let cur = { ...args.sub };
  const termOf = (s: SplitRenewalFields) => {
    const end = followingTermStart(s);
    return { periodStart: addMonthsClamped(end, -Math.max(1, s.term_months ?? 12)), periodEnd: addDaysISO(end, -1) };
  };
  const first = splitBilledRenewalStep(cur, args.todayISO);
  if (first.kind === "held_open_quote") { out.heldBy = first.quoteId; return out; }
  if (first.kind !== "roll") {
    try {
      const bill = await args.billCurrentTerm();
      if (billedSomething(bill)) out.terms.push({ ...termOf(cur), bill });
      else out.stoppedReason = bill.skip?.reason ?? null;
    } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
    return out;
  }
  for (let i = 0; i < (args.maxTerms ?? 24); i++) {
    const step = splitBilledRenewalStep(cur, args.todayISO);
    if (step.kind !== "roll" || !cur.renewal_date) break;
    const from = cur.renewal_date;
    try {
      await args.roll(from, step.newRenewalDate);
    } catch (e) { out.error = e instanceof Error ? e.message : String(e); break; }
    cur = { ...cur, renewal_date: step.newRenewalDate };
    let bill: TermBill;
    try {
      bill = await args.billCurrentTerm();
    } catch (e) {
      /* The bill failed: renewal_date goes back — it moves only with a bill. */
      out.error = e instanceof Error ? e.message : String(e);
      try { await args.roll(step.newRenewalDate, from); } catch { /* the error above is reported */ }
      break;
    }
    if (billedSomething(bill) || bill.skip?.code === "billed_elsewhere") {
      if (billedSomething(bill)) out.terms.push({ ...termOf(cur), bill });
      continue;
    }
    /* Nothing billed for a term that has begun — put renewal_date back so this period stays
       the next one to bill, and stop (never jump over it). */
    out.stoppedReason = bill.skip?.reason ?? `Nothing could be billed for the period from ${step.nextTermStart}.`;
    try { await args.roll(step.newRenewalDate, from); } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
    break;
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayMon(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** What Generate tells the owner after billing one or more terms. */
export function termsMessage(customer: string | null, r: TermsBilled): { ok: boolean; text: string; href: string | null } {
  const who = customer ?? "this customer";
  if (r.terms.length <= 1) {
    const one = r.terms[0]?.bill ?? { raised: [], requests: [], requestsOpen: [] };
    const base = nextPartMessage(customer, one, r.error ?? r.stoppedReason);
    return r.terms.length === 1 && r.error ? { ...base, text: `${base.text} The next period was not billed: ${r.error}` } : base;
  }
  const docs = r.terms.map((t) => {
    const doc = t.bill.raised[0]?.invoice_id ?? t.bill.requests[0]?.quote_id ?? t.bill.requestsOpen[0]?.quote_id ?? "?";
    return `${doc} (${dayMon(t.periodStart)}–${dayMon(t.periodEnd)})`;
  });
  const firstBill = r.terms[0].bill;
  const href = firstBill.raised[0] ? `/invoices/${firstBill.raised[0].invoice_id}`
    : firstBill.requests[0] ? `/quotes/${firstBill.requests[0].quote_id}`
    : firstBill.requestsOpen[0] ? `/quotes/${firstBill.requestsOpen[0].quote_id}` : null;
  const tail = r.error ? ` The next period was not billed: ${r.error}` : r.stoppedReason ? ` Stopped: ${r.stoppedReason}` : "";
  return { ok: true, text: `${r.terms.length} periods billed for ${who}, oldest first: ${docs.join(", ")}.${tail}`, href };
}

const CYCLE_UNIT: Record<string, [string, string]> = {
  monthly: ["month", "months"], quarterly: ["quarter", "quarters"], half_yearly: ["half-year", "half-years"],
};

/**
 * The Renewals row's "N months due": the periods after renewal_date whose start has come by today
 * (a sub billed in parts only). Null when none.
 */
export function partsDue(sub: SplitRenewalFields, todayISO: string): { count: number; from: string; text: string } | null {
  const unit = sub.billing_cycle ? CYCLE_UNIT[sub.billing_cycle] : undefined;
  if (!unit || !sub.renewal_date) return null;
  const from = followingTermStart(sub);
  const step = CYCLE_MONTHS[sub.billing_cycle!];
  let count = 0;
  while (count < 120 && addMonthsClamped(from, count * step) <= todayISO) count++;
  if (count === 0) return null;
  return { count, from, text: `${count} ${count === 1 ? unit[0] : unit[1]} due` };
}
