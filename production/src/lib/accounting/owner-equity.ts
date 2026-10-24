/**
 * R-1839 — owner drawings and capital introduced (proprietor, partners), as pure, tested sums.
 *
 * Indian practice: in a proprietorship or a partnership (per partner), money the owner takes
 * out of the business is DRAWINGS — it reduces the owner's capital on the Balance Sheet and is
 * never an expense (never on the P&L, not deductible). Money the owner puts in is CAPITAL
 * INTRODUCED. Closing capital = opening capital + capital introduced + net profit − drawings.
 *
 * A Pvt Ltd company has no drawings: what a director takes is salary (Payroll), a loan
 * (Companies Act s.185 restricts it), a reimbursement or a dividend — the app's existing paths.
 * An LLP partner's withdrawal works like drawings against that partner's capital account.
 *
 * Rows live in owner_equity_movements (migration 20261024142228_r1839_owner_equity.sql); every
 * row has its bank / cash line, so cash & bank already moves with it — this file only adds
 * the equity side. Money is whole rupees.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";

export type OwnerEquityKind = "drawings" | "capital_introduced";

export interface OwnerEquityMovement {
  id: string;
  kind: OwnerEquityKind;
  movement_date: string;      // YYYY-MM-DD
  amount: number;             // whole rupees, > 0
  bank_account_id: string;
  bank_txn_id: string;
  /** true = the app added the cash line (recorded by hand); false = a statement line booked from Banking. */
  own_line: boolean;
  partner_name: string | null;
  /** R-1847: the register partner (firm_partners). Null on older free-text entries. */
  partner_id?: string | null;
  note: string | null;
}

/** What the screens call things, by company type. */
export interface OwnerEquityWords {
  /** false for Pvt Ltd — no drawings / capital entries; show the director choices instead. */
  allowed: boolean;
  /** Partnership / LLP: each entry belongs to one partner's capital account. */
  needsPartner: boolean;
  drawings: string;           // "Owner drawings" / "Partner drawings" / "Partner withdrawal"
  capital: string;            // "Capital introduced" / "Partner's capital contribution"
  person: string;             // "owner" / "partner"
  /** Page / register title. */
  register: string;
}

/**
 * Not set yet = Pvt Ltd, through the one resolver every screen uses (R-1842 entity.ts; coordinator
 * decision 24 Oct 2026 — the calendar already read it that way). So an empty type shows the
 * director choices, and the screens prompt to set the type (BusinessTypePrompt).
 */
export function ownerEquityWords(type: BusinessType | null | undefined): OwnerEquityWords {
  const p = entityProfile(type);
  switch (p.type) {
    case "pvt_ltd":
      return { allowed: false, needsPartner: false, drawings: "Paid to director", capital: "Money from a director or shareholder",
        person: "director", register: "Drawings & capital" };
    case "partnership":
      return { allowed: true, needsPartner: true, drawings: p.drawingsLabel ?? "Partner drawings", capital: "Capital introduced",
        person: "partner", register: "Partners' drawings & capital" };
    case "llp":
      return { allowed: true, needsPartner: true, drawings: p.drawingsLabel ?? "Partner withdrawal", capital: "Partner's capital contribution",
        person: "partner", register: "Partners' withdrawals & capital" };
    case "proprietor":
      return { allowed: true, needsPartner: false, drawings: p.drawingsLabel ?? "Owner drawings", capital: "Capital introduced",
        person: "owner", register: "Owner drawings & capital" };
  }
}

/**
 * Money paid to a director of a Pvt Ltd company — the existing paths, never "drawings".
 * `caution` is shown with the choice.
 */
export interface DirectorChoice { key: string; label: string; hint: string; href: string; caution?: string }
export const DIRECTOR_CHOICES: readonly DirectorChoice[] = [
  { key: "salary", label: "Director's salary / remuneration", hint: "Book it in Payroll (TDS u/s 192), or as a Director's Remuneration expense.", href: "/accounting/payroll" },
  { key: "loan", label: "Loan to the director", hint: "Book it in Loans given — the director owes it back.", href: "/accounting/loans-given",
    caution: "Companies Act s.185 restricts loans to directors — check with your CA before booking one." },
  { key: "reimbursement", label: "Reimbursement", hint: "The director paid a company expense from their own pocket — settle it in Reimbursements.", href: "/accounting/reimbursements" },
  { key: "dividend", label: "Dividend", hint: "Needs a board resolution and TDS u/s 194 — record it with your CA; it is not an expense.", href: "/accounting/balance-sheet" },
];

export interface MovementTotals { capitalIntroduced: number; drawings: number }

/**
 * Totals of the entries AFTER `after` (exclusive) and up to `upTo` (inclusive). The CA's
 * opening capital (as at its date) already holds everything before it, so the Balance Sheet
 * counts only what came later — the same range as the profit it carries.
 */
export function movementTotals(
  movements: readonly Pick<OwnerEquityMovement, "kind" | "amount" | "movement_date">[],
  range: { after?: string | null; upTo?: string | null } = {},
): MovementTotals {
  let capitalIntroduced = 0, drawings = 0;
  for (const m of movements) {
    if (range.after && m.movement_date <= range.after) continue;
    if (range.upTo && m.movement_date > range.upTo) continue;
    if (m.kind === "drawings") drawings += m.amount; else capitalIntroduced += m.amount;
  }
  return { capitalIntroduced, drawings };
}

export interface CapitalStatement {
  opening: number;            // CA's owner's capital + retained earnings b/f (0 when not entered)
  capitalIntroduced: number;
  netProfit: number;          // the Balance Sheet's profit (after the opening date, else all periods)
  drawings: number;
  closing: number;            // opening + capital introduced + net profit − drawings
}

/** Closing capital = opening capital + capital introduced + net profit − drawings. */
export function capitalStatement(args: { opening: number; netProfit: number; totals: MovementTotals }): CapitalStatement {
  const { opening, netProfit, totals } = args;
  return {
    opening,
    capitalIntroduced: totals.capitalIntroduced,
    netProfit,
    drawings: totals.drawings,
    closing: opening + totals.capitalIntroduced + netProfit - totals.drawings,
  };
}

/**
 * The Balance Sheet's unexplained difference once the entries are counted:
 * what the sheet needs to balance (`retained`, after manual equity lines) − the CA's opening
 * equity − the profit − (capital introduced − drawings). A drawing recorded here moves cash
 * down AND equity down, so it no longer sits in the difference.
 */
export function unexplainedAfterEntries(args: { retained: number; openingEquity: number; profit: number; totals: MovementTotals }): number {
  const { retained, openingEquity, profit, totals } = args;
  return retained - openingEquity - profit - (totals.capitalIntroduced - totals.drawings);
}

/** A hand-entered equity line that looks like drawings — could count the same money twice. */
export function looksLikeDrawingsLine(label: string): boolean {
  return /drawing|withdraw/i.test(label);
}

// ── Register: by month, with a total for the FY ────────────────────────────────────────────

export interface RegisterMonth { month: string; capitalIntroduced: number; drawings: number; count: number }
export interface DrawingsRegister { months: RegisterMonth[]; totals: MovementTotals; byPartner: { partner: string; capitalIntroduced: number; drawings: number }[] }

/** FY = 1 Apr (fyStartYear) → 31 Mar. Months in order, only those with entries. */
export function drawingsRegister(movements: readonly OwnerEquityMovement[], fyStartYear: number): DrawingsRegister {
  const from = `${fyStartYear}-04-01`, to = `${fyStartYear + 1}-03-31`;
  const inFy = movements.filter((m) => m.movement_date >= from && m.movement_date <= to);
  const byMonth = new Map<string, RegisterMonth>();
  const byPartner = new Map<string, { partner: string; capitalIntroduced: number; drawings: number }>();
  for (const m of inFy) {
    const month = m.movement_date.slice(0, 7);
    const r = byMonth.get(month) ?? { month, capitalIntroduced: 0, drawings: 0, count: 0 };
    if (m.kind === "drawings") r.drawings += m.amount; else r.capitalIntroduced += m.amount;
    r.count += 1;
    byMonth.set(month, r);
    if (m.partner_name) {
      const p = byPartner.get(m.partner_name) ?? { partner: m.partner_name, capitalIntroduced: 0, drawings: 0 };
      if (m.kind === "drawings") p.drawings += m.amount; else p.capitalIntroduced += m.amount;
      byPartner.set(m.partner_name, p);
    }
  }
  return {
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    totals: movementTotals(inFy),
    byPartner: [...byPartner.values()].sort((a, b) => a.partner.localeCompare(b.partner)),
  };
}

/** CSV rows for the CA: one line per entry, then the FY totals. */
export function drawingsRegisterCsv(
  movements: readonly OwnerEquityMovement[],
  fyStartYear: number,
  accountName: (id: string) => string,
  words: OwnerEquityWords,
): { header: string[]; rows: (string | number)[][] } {
  const from = `${fyStartYear}-04-01`, to = `${fyStartYear + 1}-03-31`;
  const inFy = movements.filter((m) => m.movement_date >= from && m.movement_date <= to)
    .sort((a, b) => a.movement_date.localeCompare(b.movement_date));
  const header = ["Date", "Type", ...(words.needsPartner ? ["Partner"] : []), "Account", "Capital introduced (INR)", "Drawings (INR)", "Note"];
  const rows: (string | number)[][] = inFy.map((m) => [
    m.movement_date,
    m.kind === "drawings" ? words.drawings : words.capital,
    ...(words.needsPartner ? [m.partner_name ?? ""] : []),
    accountName(m.bank_account_id),
    m.kind === "capital_introduced" ? m.amount : "",
    m.kind === "drawings" ? m.amount : "",
    m.note ?? "",
  ]);
  const t = movementTotals(inFy);
  rows.push(["Total", `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`, ...(words.needsPartner ? [""] : []), "", t.capitalIntroduced, t.drawings, ""]);
  return { header, rows };
}
