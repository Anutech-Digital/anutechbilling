/**
 * R-1845 — the Balance Sheet's equity section, laid out by business type.
 *
 * Until now every company saw one equity block: "Owner's capital" + "Drawings" lines and
 * "Retained earnings" — a proprietor's picture. Indian practice:
 *   • Proprietor — one capital account: Opening capital + Capital introduced + Net profit
 *     − Drawings = Closing capital (R-1839 entries).
 *   • Partnership / LLP — the partners' capital accounts; per partner only where R-1839 entries
 *     name a partner (the partner register is R-1847 / R-1848).
 *   • Pvt Ltd — Shareholders' funds = Share capital + Reserves & surplus (retained earnings).
 *     Share capital is the hand-entered equity line until the shareholder register (R-1851).
 *     A company has no drawings.
 *
 * This file only ARRANGES what the page already has — hand-entered equity lines, the CA's
 * opening figures, the P&L profit and the R-1839 entries. It never changes a total: every row
 * it returns adds up to exactly what the page showed before (test). Old hand lines keep their
 * own labels. "Unexplained difference" and the Zoho "Opening Balance Adjustments" stay on the
 * page, outside these groups.
 *
 * Words come from lib/compliance/entity.ts (one resolver: empty type = Pvt Ltd). Pure.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { ownerEquityWords, type MovementTotals, type OwnerEquityMovement } from "./owner-equity";

export interface ManualEquityLine { id: string; label: string; amount: number; notes: string | null }

export type EquityRow<T extends ManualEquityLine = ManualEquityLine> =
  /** Hand-entered Balance Sheet lines — shown with their own labels, editable. */
  | { kind: "manual"; key: string; items: T[] }
  | { kind: "line"; key: string; label: string; hint: string; amount: number; origin: "auto" | "manual"; source: string; href?: string };

export interface EquityGroup<T extends ManualEquityLine = ManualEquityLine> {
  key: string;
  /** Sub-heading inside the section (Pvt Ltd: "Share capital", "Reserves & surplus"); null = none. */
  title: string | null;
  rows: EquityRow<T>[];
  /** Closing capital / group total. Null while the P&L profit is loading (or the group is empty). */
  total: { label: string; hint: string; amount: number } | null;
}

export interface PartnerEquity { partner: string; capitalIntroduced: number; drawings: number }

export interface EquitySection<T extends ManualEquityLine = ManualEquityLine> {
  type: BusinessType;
  /** Proprietor's capital account · Partners' capital accounts · Shareholders' funds. */
  heading: string;
  groups: EquityGroup<T>[];
  /** Partnership / LLP: R-1839 entries that name a partner, in the Balance Sheet's range. */
  byPartner: PartnerEquity[];
}

export interface EquityInput<T extends ManualEquityLine> {
  businessType: BusinessType | null | undefined;
  manualLines: readonly T[];
  /** CA's opening balances (S45). Null when not entered. */
  opening: { asOf: string; ownerCapital: number | null; retainedEarnings: number | null } | null;
  /** Profit the Balance Sheet carries (after the opening date, else all periods). Null = loading. */
  profit: number | null;
  /** R-1839 entries in the Balance Sheet's range (movementTotals). */
  totals: MovementTotals;
  /** The entries — only for the per-partner breakdown. */
  movements?: readonly Pick<OwnerEquityMovement, "kind" | "amount" | "movement_date" | "partner_name">[];
  /** Same range as `totals`: after `after` (exclusive) up to `upTo`. */
  range?: { after?: string | null; upTo?: string | null };
  /** How the page prints a date ("1 Apr 2026"). */
  formatDate?: (iso: string) => string;
}

/** A hand-entered company equity line that belongs under Reserves & surplus, not Share capital. */
export function isReservesLine(l: Pick<ManualEquityLine, "label" | "notes">): boolean {
  return /premium|reserve|surplus|retained/i.test(`${l.label} ${l.notes ?? ""}`);
}

function rowsTotal(rows: readonly EquityRow<ManualEquityLine>[]): number {
  return rows.reduce((s, r) => s + (r.kind === "manual" ? r.items.reduce((a, i) => a + i.amount, 0) : r.amount), 0);
}

/** Per partner — entries that carry a partner name and fall in the range. */
export function partnerBreakdown(
  movements: EquityInput<ManualEquityLine>["movements"],
  range: EquityInput<ManualEquityLine>["range"] = {},
): PartnerEquity[] {
  const by = new Map<string, PartnerEquity>();
  for (const m of movements ?? []) {
    if (!m.partner_name) continue;
    if (range.after && m.movement_date <= range.after) continue;
    if (range.upTo && m.movement_date > range.upTo) continue;
    const p = by.get(m.partner_name) ?? { partner: m.partner_name, capitalIntroduced: 0, drawings: 0 };
    if (m.kind === "drawings") p.drawings += m.amount; else p.capitalIntroduced += m.amount;
    by.set(m.partner_name, p);
  }
  return [...by.values()].sort((a, b) => a.partner.localeCompare(b.partner));
}

export function equitySection<T extends ManualEquityLine>(input: EquityInput<T>): EquitySection<T> {
  const profile = entityProfile(input.businessType);
  const words = ownerEquityWords(profile.type);
  const fmt = input.formatDate ?? ((d: string) => d);
  const { opening, profit, totals } = input;
  const asOf = opening ? fmt(opening.asOf) : "";
  const company = profile.type === "pvt_ltd";

  type Row = EquityRow<T>;
  const manual = (key: string, items: readonly T[]): Row[] => (items.length ? [{ kind: "manual", key, items: [...items] }] : []);
  const line = (key: string, label: string, hint: string, amount: number, origin: "auto" | "manual", source: string, href?: string): Row =>
    ({ kind: "line", key, label, hint, amount, origin, source, ...(href ? { href } : {}) });

  const openingCapital: Row[] = opening && (opening.ownerCapital ?? 0) !== 0
    ? [line("opening_capital", `${profile.capitalLabel} (opening)`, `from your CA, as at ${asOf}`, opening.ownerCapital ?? 0, "manual", "Opening balances")]
    : [];
  const openingReserves: Row[] = opening && (opening.retainedEarnings ?? 0) !== 0
    ? [line("opening_reserves", company ? "Reserves & surplus b/f" : "Profit brought forward",
        `earlier years' profit from your CA, as at ${asOf}`, opening.retainedEarnings ?? 0, "manual", "Opening balances")]
    : [];
  const profitRow = line("profit",
    opening ? `Profit since ${asOf}` : company ? "Profit and loss balance" : "Net profit",
    profit === null ? "net profit per P&L — loading…" : opening ? "net profit per P&L after the opening date" : "cumulative net profit per P&L, all periods",
    profit ?? 0, "auto", "P&L", "/accounting/pnl");
  /* R-1839 entries: each has its bank / cash line already, so this is only the equity side. */
  const entries: Row[] = [
    ...(totals.capitalIntroduced !== 0 ? [line("capital_introduced", words.capital,
      opening ? `money put in after ${asOf}` : "money put into the business",
      totals.capitalIntroduced, "auto", "Entries", "/accounting/balance-sheet#drawings")] : []),
    ...(totals.drawings !== 0 ? [line("drawings", `Less: ${words.drawings}`,
      `money the ${words.person} took out — lowers capital, not an expense`,
      -totals.drawings, "auto", "Entries", "/accounting/balance-sheet#drawings")] : []),
  ];

  if (company) {
    const share: Row[] = [
      ...manual("manual_share", input.manualLines.filter((l) => !isReservesLine(l))),
      ...openingCapital,
      /* Entries recorded while the company was set up as another type stay visible, never dropped. */
      ...entries,
    ];
    const reserves: Row[] = [...manual("manual_reserves", input.manualLines.filter(isReservesLine)), ...openingReserves, profitRow];
    return {
      type: profile.type,
      heading: profile.equityTitle,
      groups: [
        { key: "share_capital", title: "Share capital", rows: share,
          total: share.length ? { label: "Total share capital", hint: "paid-up capital (hand-entered until the shareholder register)", amount: rowsTotal(share) } : null },
        { key: "reserves", title: "Reserves & surplus", rows: reserves,
          total: profit === null ? null : { label: "Total reserves & surplus", hint: "retained earnings — profit kept in the company", amount: rowsTotal(reserves) } },
      ],
      byPartner: [],
    };
  }

  const rows: Row[] = [...manual("manual", input.manualLines), ...openingCapital, ...openingReserves, profitRow, ...entries];
  return {
    type: profile.type,
    heading: profile.equityTitle,
    groups: [{
      key: "capital", title: null, rows,
      total: profit === null ? null
        : { label: "Closing capital", hint: "opening capital + capital introduced + net profit − drawings", amount: rowsTotal(rows) },
    }],
    byPartner: profile.type === "proprietor" ? [] : partnerBreakdown(input.movements, input.range),
  };
}

/** Every row of the section added up — what the old equity lines summed to. */
export function equitySectionTotal(s: EquitySection<ManualEquityLine>): number {
  return s.groups.reduce((a, g) => a + rowsTotal(g.rows), 0);
}

/* ── Add-line dialog: what a hand-entered equity line can be, by type ────────────────────── */

export interface EquityLineCategory { value: string; label: string; examples: string; contra?: boolean }

/**
 * A company never gets "Drawings" — it gets Share capital and Securities premium (reserves).
 * The others keep the capital line and, where real entries cannot be recorded, a drawings line
 * (the page hides it when they can — R-1839).
 */
export function equityLineCategories(type: BusinessType | null | undefined): EquityLineCategory[] {
  const p = entityProfile(type);
  if (p.type === "pvt_ltd") {
    return [
      { value: "share_capital", label: "Share capital", examples: "Paid-up capital — shares issued × face value" },
      { value: "securities_premium", label: "Securities premium", examples: "Money received above the face value of shares (shown under Reserves & surplus)" },
    ];
  }
  const w = ownerEquityWords(p.type);
  return [
    { value: "owners_capital", label: p.capitalLabel, examples: p.type === "proprietor" ? "Money you put into the business" : "Money the partners put into the firm" },
    { value: "drawings", label: `${w.drawings} (–)`, examples: `Money the ${w.person} took out for personal use`, contra: true },
  ];
}
