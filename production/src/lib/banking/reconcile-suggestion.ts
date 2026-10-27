/**
 * R-2007 — the Suggestion card at the top of the Reconcile sheet (pure part).
 *
 * Pardeep (27 Oct): every line took 4–6 clicks because the sheet never said what it thought the
 * money was. Now, when there is exactly ONE confident answer, the sheet says it in one card —
 * who, what for, the amount check and a "Why:" line — and "Looks right — reconcile" books it
 * through the SAME save path the matching section uses (no new RPC):
 *
 *   money in  → the guessed customer (guessCustomer) and EITHER their project's oldest open
 *               instalments that the money pays — in full or less a common TDS rate
 *               (2,12,400 = 2,36,000 − 10%) — booked by allocate_project_receipt(_with_tds) like
 *               ProjectPaymentSection; OR one open quote / invoice it pays — booked by
 *               reconcile_bank_credit_to_item like CreditPayForSection.
 *   money out → the guessed vendor (guessVendor) and EITHER the one open bill the money pays
 *               exactly, OR the vendor's ONLY open bill as a part payment when the money is less —
 *               booked by reconcile_bank_debit_to_vendor like DebitPayForSection.
 *
 * Two answers, or one that still needs a decision (TDS still to work out for the year, dates of a
 * new subscription, money beyond everything due) → null: no card, the tiles as before. Nothing
 * here saves anything; a wrong guess that books itself is worse than no guess.
 */
import { rupee } from "@/lib/utils";
import { TDS_SECTIONS } from "@/lib/accounting/tds-split";
import { TDS_TOLERANCE } from "@/lib/banking/invoice-credit-match";
import { kindLabel, type OpenItem } from "@/lib/banking/credit-pay-for";
import { cashDue, isRecorded, type VendorOpenItem } from "@/lib/banking/debit-pay-for";
import type { KistRow } from "@/lib/banking/project-receipt-allocation";

/* ─── TDS ──────────────────────────────────────────────────────────────────────────────── */

export interface TdsGuess {
  /** Whole rupees withheld: due − bank. */
  amount: number;
  ratePct: number;
  /** "194J" — the section the rate is filed under. */
  section: string;
  /** TDS_SECTIONS key (ProjectPaymentSection's picker). */
  sectionKey: string;
}

/** The rates a customer withholds on our work: 10% (194J professional) and 2% (194J technical). */
const RATES = [10, 2] as const;

/**
 * Does the bank amount equal `due` less a common TDS rate — on the invoice value (the owner's
 * example: 2,12,400 = 2,36,000 − 23,600) or on the value before GST (`taxable`, else due ÷ 1.18)?
 */
export function inferTds(bank: number, due: number, taxable: number | null): TdsGuess | null {
  const b = Math.round(bank), d = Math.round(due);
  if (!(b > 0) || b >= d) return null;
  const gap = d - b;
  const pre = taxable && taxable > 0 ? Math.round(taxable) : Math.round(d / 1.18);
  for (const r of RATES) {
    if ([d, pre].some((base) => Math.abs(Math.round((base * r) / 100) - gap) <= TDS_TOLERANCE)) {
      const sec = TDS_SECTIONS.find((t) => t.section === "194J" && t.ratePct === r) ?? TDS_SECTIONS[0];
      return { amount: gap, ratePct: r, section: sec.section, sectionKey: sec.key };
    }
  }
  return null;
}

/* ─── The suggestion ───────────────────────────────────────────────────────────────────── */

export interface SuggestMilestone { id: string; seq: number; label: string; remaining: number; invoiceId: string | null }
export interface SuggestProject { id: string; title: string; customerId: string | null; gstRate: number; milestones: readonly SuggestMilestone[] }

interface Base {
  /** The tile it belongs to — "Change" opens it, prefilled. */
  tile: "customer" | "vendor";
  /** "SCN Bharat Apps · SCN Mobile app · Kist 1 + 2 · TDS ₹23,600" */
  title: string;
  /** "Bank ₹2,12,400 + TDS ₹23,600 = ₹2,36,000 due ✓" */
  amountLine: string;
  /** The sentence after "Why:". */
  why: string;
}

export type Suggestion =
  | (Base & {
      kind: "project";
      customerId: string; customerName: string;
      projectId: string; projectTitle: string;
      /** Every open instalment; the ones paid `on` with their amount (ProjectPaymentSection's rows). */
      rows: KistRow[];
      tds: TdsGuess | null;
      /** Bank + TDS. */
      settled: number;
    })
  | (Base & {
      kind: "item";
      customerId: string; customerName: string;
      item: OpenItem;
      tds: TdsGuess | null;
    })
  | (Base & {
      kind: "vendor";
      vendorId: string; vendorName: string;
      item: VendorOpenItem;
      /** Cash from this bank line to the bill, and the TDS already on it (fixed). */
      cash: number; tds: number; tdsSection: string | null;
      /** Less than the bill needs — it stays part-paid. */
      part: boolean;
    });

/** "Kist 1 + 2" — the project's own word for its instalments (the first word every label shares), else "Instalment". */
export function instalmentWords(ms: readonly Pick<SuggestMilestone, "seq" | "label">[]): string {
  const first = ms.map((m) => m.label.trim().split(/\s+/)[0] ?? "");
  const word = first.length > 0 && first.every((w) => w && w.toLowerCase() === first[0].toLowerCase()) && /^[A-Za-z]+$/.test(first[0])
    ? first[0] : "Instalment";
  return `${word} ${ms.map((m) => m.seq).join(" + ")}`;
}

const why = (reason: string, rest: string) => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}; ${rest}`;
const tdsWords = (t: TdsGuess) => `TDS ${rupee(t.amount)} (${t.ratePct}%)`;

interface ProjectHit { p: SuggestProject; upto: SuggestMilestone[]; due: number; tds: TdsGuess | null }

/** The project instalments, oldest first, that the bank amount pays in full (or less TDS). */
function projectHits(bank: number, projects: readonly SuggestProject[]): ProjectHit[] {
  const out: ProjectHit[] = [];
  for (const p of projects) {
    const kists = [...p.milestones].filter((m) => m.remaining > 0).sort((a, b) => a.seq - b.seq);
    let due = 0;
    for (let k = 0; k < kists.length; k++) {
      due += Math.round(kists[k].remaining);
      const upto = kists.slice(0, k + 1);
      if (due === bank) { out.push({ p, upto, due, tds: null }); continue; }
      const tds = inferTds(bank, due, Math.round(due / (1 + (p.gstRate || 0) / 100)));
      if (tds) out.push({ p, upto, due, tds });
    }
  }
  return out;
}

/**
 * Money in. `customer` = guessCustomer's answer (null → no card). `projects` = open projects (any
 * customer — only this customer's are used); `items` = the customer's bank_credit_open_items
 * (null while loading → no card yet).
 */
export function suggestMoneyIn(input: {
  bank: number;
  customer: { id: string; name: string } | null;
  guessReason: string;
  projects: readonly SuggestProject[] | null;
  items: readonly OpenItem[] | null;
}): Suggestion | null {
  const { customer } = input;
  const bank = Math.round(input.bank);
  if (!customer || !(bank > 0) || !input.projects || !input.items) return null;

  const mine = input.projects.filter((p) => p.customerId === customer.id);
  const projects = projectHits(bank, mine);
  /* An instalment's own invoice is the same money as the project row — not a second answer. */
  const kistInvoices = new Set(mine.flatMap((p) => p.milestones.map((m) => m.invoiceId).filter(Boolean)));
  const items = input.items
    .filter((i) => !i.makes_subscription && !(i.invoice_id && kistInvoices.has(i.invoice_id)))
    .map((i) => ({ i, tds: i.amount_due === bank ? null : inferTds(bank, i.amount_due, i.taxable_value || null) }))
    .filter((x) => x.i.amount_due === bank || x.tds !== null);

  if (projects.length + items.length !== 1) return null;

  if (projects.length === 1) {
    const { p, upto, due, tds } = projects[0];
    const on = new Map(upto.map((m) => [m.id, Math.round(m.remaining)]));
    const rows: KistRow[] = [...p.milestones].sort((a, b) => a.seq - b.seq).map((m) => ({
      id: m.id, seq: m.seq, on: on.has(m.id), amount: on.get(m.id) ?? Math.round(m.remaining), raiseInvoice: !m.invoiceId,
    }));
    const kists = instalmentWords(upto);
    return {
      kind: "project", tile: "customer",
      customerId: customer.id, customerName: customer.name, projectId: p.id, projectTitle: p.title,
      rows, tds, settled: due,
      title: `${customer.name} · ${p.title} · ${kists}${tds ? ` · TDS ${rupee(tds.amount)}` : ""}`,
      amountLine: tds ? `Bank ${rupee(bank)} + TDS ${rupee(tds.amount)} = ${rupee(due)} due ✓` : `Bank ${rupee(bank)} = ${rupee(due)} due ✓`,
      why: why(input.guessReason, tds
        ? `${rupee(bank)} + ${tdsWords(tds)} = ${rupee(due)}, the oldest open instalments (${kists}) of ${p.title}.`
        : `${rupee(bank)} = ${rupee(due)}, the oldest open instalments (${kists}) of ${p.title}.`),
    };
  }

  const { i, tds } = items[0];
  const doc = i.invoice_id ?? i.quote_id ?? "";
  return {
    kind: "item", tile: "customer", customerId: customer.id, customerName: customer.name, item: i, tds,
    title: `${customer.name} · ${kindLabel(i.kind)} ${doc}${tds ? ` · TDS ${rupee(tds.amount)}` : ""}`,
    amountLine: tds ? `Bank ${rupee(bank)} + TDS ${rupee(tds.amount)} = ${rupee(i.amount_due)} due ✓` : `Bank ${rupee(bank)} = ${rupee(i.amount_due)} due ✓`,
    why: why(input.guessReason, tds
      ? `${rupee(bank)} + ${tdsWords(tds)} = ${rupee(i.amount_due)} due on ${doc}, their only open item that fits.`
      : `${rupee(bank)} is exactly what is due on ${doc}, their only open item that fits.`),
  };
}

/**
 * Money out. `vendor` = guessVendor's answer (null → no card); `items` = its
 * bank_debit_vendor_open_items (null while loading → no card yet).
 */
export function suggestMoneyOut(input: {
  debit: number;
  vendor: { id: string; name: string; default_tds_section?: string | null } | null;
  guessReason: string;
  items: readonly VendorOpenItem[] | null;
}): Suggestion | null {
  const { vendor, items } = input;
  const debit = Math.round(input.debit);
  if (!vendor || !items || !(debit > 0)) return null;
  const open = items.filter((i) => !i.in_run);
  /* The TDS section DebitPayForSection would use; with one, an expense bill's TDS depends on the
     vendor's year so far (and 194Q on goods) — that stays the section's work, no card. */
  const section = ((vendor.default_tds_section || open.find((i) => i.tds_section)?.tds_section) ?? "").trim().toUpperCase();
  const fixedTds = (i: VendorOpenItem) => (i.source === "expense" && i.tds_amount > 0 ? i.tds_amount : 0);
  const needsTds = (i: VendorOpenItem) => !isRecorded(i)
    && (i.source === "expense" ? !(i.tds_amount > 0) && i.tds_base > 0 && section !== "" : section === "194Q");

  const card = (i: VendorOpenItem, cash: number, part: boolean): Suggestion => {
    const due = cashDue(i, fixedTds(i));
    const name = isRecorded(i) ? "the payment already recorded" : i.bill_no ? `Bill ${i.bill_no}` : i.source === "expense" ? "Expense bill" : "COGS bill";
    return {
      kind: "vendor", tile: "vendor", vendorId: vendor.id, vendorName: vendor.name, item: i,
      cash, tds: fixedTds(i), tdsSection: fixedTds(i) > 0 ? i.tds_section : null, part,
      title: `${vendor.name} · ${name}${part ? " · part payment" : ""}`,
      amountLine: part
        ? `Bank ${rupee(cash)} of ${rupee(due)} due · ${rupee(due - cash)} stays due`
        : `Bank ${rupee(cash)} = ${rupee(due)} due ✓`,
      why: why(input.guessReason, part
        ? `it is their only open bill and the bank paid ${rupee(cash)} of ${rupee(due)} due — booked as a part payment.`
        : `${rupee(cash)} is exactly what is due on ${name}.`),
    };
  };

  const recorded = open.filter((i) => isRecorded(i) && i.amount_due === debit);
  if (recorded.length > 1) return null;
  if (recorded.length === 1) return card(recorded[0], debit, false);

  const bills = open.filter((i) => !isRecorded(i));
  const exact = bills.filter((i) => cashDue(i, fixedTds(i)) === debit);
  if (exact.length > 1) return null;
  if (exact.length === 1) return needsTds(exact[0]) ? null : card(exact[0], debit, false);

  if (open.length === 1 && bills.length === 1) {
    const b = bills[0];
    if (b.can_part && !needsTds(b) && debit < cashDue(b, fixedTds(b))) return card(b, debit, true);
  }
  return null;
}
