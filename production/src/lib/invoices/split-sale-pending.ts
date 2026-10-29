/**
 * R-2057 (28 Oct 2026, Pardeep, staging) — "Pending GST invoice generation" on a sale billed in parts.
 *
 * The list showed a quarterly sale (annual commitment, Q1 paid) with a Generate button, and
 * Generate called generate_invoice — the WHOLE term — which the database rightly refuses
 * (reject_full_term_invoice_when_split_billed: "billed quarterly, so it is invoiced one period at a
 * time"). The list said "invoice it", the button said "no".
 *
 * A sale billed in parts is tax-invoiced one part at a time: CGST Act s.31(5)(a) — continuous
 * supply of services: the invoice is issued on/before the due date of each payment — and each part
 * is its own supply (Rule 47's 30 days run per part). The part's invoice comes from the billing
 * cron's one path (raise_subscription_billing via bill_subscription_instalment, which also decides
 * WHETHER a part may be invoiced — R-2044 / R-2048: only when it is paid).
 *
 * Pure rules for the Invoices page:
 *   - pendingPartAction: what a pending row offers, from public.split_sale_invoice_status (migration
 *     20261028151322) — Generate for <part>, a "not paid in full" note, or not pending at all;
 *   - partGenerateResult: what Generate's answer (POST /api/quotes/:id/raise-instalments) means —
 *     the invoice raised now, the one raised before (Generate opens it), or why there is none.
 */
import { planForQuote, type SplitQuoteFields } from "@/lib/billing/instalments";
import { addDaysISO } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

/** One row of public.split_sale_invoice_status. */
export interface SplitSaleStatus {
  quote_id: string;
  state: "ready" | "short" | "invoiced" | "on_request" | "not_laid";
  cycle: string | null;
  period_index: number | null;
  period_label: string | null;
  period_start: string | null;
  /** Exclusive (schedule.ts). */
  period_end: string | null;
  gross: number | null;
  credit: number | null;
  invoice_id: string | null;
  term_start: string | null;
}

export type PendingPartAction =
  /** Not billed in parts — the whole-quote invoice, as before. */
  | { kind: "whole" }
  /** Every due part's invoice exists, or the unpaid part is owed on its own request: not pending. */
  | { kind: "hide" }
  /** "Generate invoice for Q1 · 1 Oct–31 Dec 2026 ₹95,993". */
  | { kind: "part"; part: string; period: string | null; amount: number | null; button: string }
  /** A due part, but the money received does not cover it — no tax invoice yet (R-2044/R-2048). */
  | { kind: "short"; part: string; period: string | null; amount: number; received: number; note: string };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(iso: string): { d: number; m: string; y: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { d, m: MON[m - 1], y };
}

/**
 * "1 Oct–31 Dec 2026" — the words bill_subscription_instalment puts on a part's payment request
 * (to_char FMDD Mon–FMDD Mon YYYY). periodEnd is exclusive.
 */
export function partPeriodText(periodStart: string | null | undefined, periodEndExclusive: string | null | undefined): string | null {
  if (!periodStart || !periodEndExclusive) return null;
  const a = day(periodStart);
  const b = day(addDaysISO(periodEndExclusive, -1));
  return `${a.d} ${a.m}–${b.d} ${b.m} ${b.y}`;
}

/** "Q1" / "H2" / "Month 3" — split_sale_invoice_status's period_label for a part not laid yet. */
export function partName(cycle: string | null | undefined, index: number): string {
  if (cycle === "quarterly") return `Q${index}`;
  if (cycle === "half_yearly") return `H${index}`;
  return `Month ${index}`;
}

function generateLabel(part: string, period: string | null, amount: number | null): string {
  return `Generate invoice for ${part}${period ? ` · ${period}` : ""}${amount != null ? ` ${rupee(amount)}` : ""}`;
}

/**
 * What a pending row offers. `status` undefined = the quote is not billed in parts (the function
 * returns no row for it) → the whole-quote Generate, unchanged.
 */
export function pendingPartAction(
  status: SplitSaleStatus | undefined,
  quote: SplitQuoteFields & { payment_amount?: number | null },
): PendingPartAction {
  if (!status) return { kind: "whole" };
  switch (status.state) {
    case "invoiced":
    case "on_request":
      return { kind: "hide" };
    case "ready": {
      const part = status.period_label ?? partName(status.cycle, status.period_index ?? 1);
      const period = partPeriodText(status.period_start, status.period_end);
      const amount = status.gross ?? null;
      return { kind: "part", part, period, amount, button: generateLabel(part, period, amount) };
    }
    case "short": {
      const part = status.period_label ?? partName(status.cycle, status.period_index ?? 1);
      const period = partPeriodText(status.period_start, status.period_end);
      const amount = status.gross ?? 0;
      const received = Math.max(0, Math.min(status.credit ?? 0, amount));
      return {
        kind: "short", part, period, amount, received,
        note: `${part} is ${rupee(amount)}; ${rupee(received)} received (${rupee(amount - received)} short). `
          + `Its tax invoice is issued when ${part} is paid in full — record the rest on the quote.`,
      };
    }
    case "not_laid": {
      /* The billing job has not laid this term's parts yet. Generate lays them and bills the due
         one through the same path; this preview comes from the same schedule engine. */
      const part = partName(status.cycle, 1);
      const plan = status.term_start ? planForQuote(quote, status.term_start) : null;
      const first = plan?.lines[0] ?? null;
      const period = first ? partPeriodText(first.periodStart, first.periodEnd) : null;
      const amount = first?.gross ?? null;
      const received = Math.max(0, status.credit ?? quote.payment_amount ?? 0);
      if (first && received < first.gross) {
        return {
          kind: "short", part, period, amount: first.gross, received,
          note: `${part} is ${rupee(first.gross)}; ${rupee(received)} received (${rupee(first.gross - received)} short). `
            + `Its tax invoice is issued when ${part} is paid in full — record the rest on the quote.`,
        };
      }
      return { kind: "part", part, period, amount, button: generateLabel(part, period, amount) };
    }
    default:
      return { kind: "whole" };
  }
}

/** One due part's invoice, as POST /api/quotes/:id/raise-instalments reports it (R-2057). */
export interface PartInvoice {
  subscription_id: string;
  period_index: number;
  part: string;
  invoice_id: string;
  gross: number;
  period_start: string;
  /** Exclusive. */
  period_end: string;
  raised_now: boolean;
}

export interface PartGenerateAnswer {
  raised?: { invoice_id: string }[];
  errors?: { message: string }[];
  invoices?: PartInvoice[];
}

export type PartGenerateResult =
  | { kind: "raised" | "existing"; invoiceId: string; title: string; description: string }
  | { kind: "refused"; title: string; description: string };

/**
 * What Generate's answer means. Raised now → "Q1 invoice INV-… issued"; nothing new but the due
 * part is invoiced → that invoice (Generate opens it, never a second one); neither → why.
 */
export function partGenerateResult(a: PartGenerateAnswer): PartGenerateResult {
  const all = a.invoices ?? [];
  const now = all.filter((i) => i.raised_now);
  const pick = (now.length > 0 ? now : all).at(-1) ?? null;
  if (pick) {
    const period = partPeriodText(pick.period_start, pick.period_end);
    const desc = `${period ? `${period} · ` : ""}${rupee(pick.gross)}`;
    if (now.length > 0) {
      const more = now.length > 1 ? ` (${now.map((i) => i.part).join(", ")} — ${now.length} invoices)` : "";
      return { kind: "raised", invoiceId: pick.invoice_id, title: `${pick.part} invoice ${pick.invoice_id} issued${more}`, description: desc };
    }
    return { kind: "existing", invoiceId: pick.invoice_id, title: `${pick.part} is already invoiced — ${pick.invoice_id}`, description: desc };
  }
  const why = a.errors?.[0]?.message;
  return {
    kind: "refused",
    title: "No invoice was issued",
    description: why ?? "The part that is due is not paid in full yet. Its tax invoice is issued when it is paid — record the payment on the quote.",
  };
}

