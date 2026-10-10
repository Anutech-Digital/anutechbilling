/**
 * R-530 — late payment charges: WHO they apply to.
 *
 * Pardeep (9 Oct 2026): "enable/disable ka system rakhna, customer par bhi, har invoice par bhi,
 * har subscription par bhi". Four levels; the most specific one that is not "Default" wins:
 *
 *   invoice  >  subscription  >  customer  >  company
 *
 * "Default" means "take the level above". The company setting is OFF until the owner turns it
 * on. A waiver is an invoice-level Off that carries a reason.
 *
 * The same precedence is in SQL (late_fee_effective in 20261009233000_late_payment_charges.sql),
 * which bill_late_charges re-checks before raising a debit note. Change both or neither.
 */

export type LateFeeMode = "default" | "on" | "off";
export type LateFeeLevel = "company" | "customer" | "subscription" | "invoice";

export interface LateFeeSettings {
  enabled: boolean;
  /** % a year, simple. */
  interestPct: number;
  /** ₹, whole rupees, charged once per invoice. */
  flatFee: number;
  /** Days after the due date with no charge at all. */
  graceDays: number;
  /** Interest only for GST-registered customers; unregistered ones get the flat fee only. */
  interestRegisteredOnly: boolean;
  /** IST date the company switch was last turned on (charges count from then). */
  enabledOn: string | null;
}

export const DEFAULT_LATE_FEE_SETTINGS: LateFeeSettings = {
  enabled: false,
  interestPct: 18,
  flatFee: 500,
  graceDays: 0,
  interestRegisteredOnly: true,
  enabledOn: null,
};

export interface TenantLateFeeRow {
  late_fee_enabled?: boolean | null;
  late_fee_enabled_at?: string | null;
  late_interest_pct?: number | string | null;
  late_fee_flat?: number | null;
  late_fee_grace_days?: number | null;
  late_interest_registered_only?: boolean | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The tenant row's columns as settings. A missing row (column not migrated yet) reads as OFF. */
export function lateFeeSettingsFromRow(row: TenantLateFeeRow | null | undefined, toIstDate: (s: string) => string): LateFeeSettings {
  if (!row) return { ...DEFAULT_LATE_FEE_SETTINGS };
  const pct = num(row.late_interest_pct);
  const fee = num(row.late_fee_flat);
  const grace = num(row.late_fee_grace_days);
  return {
    enabled: row.late_fee_enabled === true,
    interestPct: pct !== null && pct >= 0 && pct <= 36 ? pct : DEFAULT_LATE_FEE_SETTINGS.interestPct,
    flatFee: fee !== null && fee >= 0 ? Math.round(fee) : DEFAULT_LATE_FEE_SETTINGS.flatFee,
    graceDays: grace !== null && grace >= 0 ? Math.round(grace) : DEFAULT_LATE_FEE_SETTINGS.graceDays,
    interestRegisteredOnly: row.late_interest_registered_only !== false,
    enabledOn: row.late_fee_enabled_at ? toIstDate(row.late_fee_enabled_at) : null,
  };
}

/** One level's override. `since` = IST date it was set (charges count from then when it is On). */
export interface LevelOverride {
  mode: LateFeeMode;
  since?: string | null;
  waived?: boolean;
  waiveReason?: string | null;
}

export interface LateFeeChain {
  company: { enabled: boolean; since: string | null };
  customer?: LevelOverride | null;
  subscription?: LevelOverride | null;
  invoice?: LevelOverride | null;
}

export interface EffectiveLateFee {
  on: boolean;
  source: LateFeeLevel;
  /** An invoice-level waiver by the owner. */
  waived: boolean;
  waiveReason: string | null;
  /** IST date from which charges count, from the winning level. Null = from the due date. */
  since: string | null;
}

/** Most specific non-Default level wins. Levels absent from the chain count as Default. */
export function resolveLateFee(chain: LateFeeChain): EffectiveLateFee {
  const order: ("invoice" | "subscription" | "customer")[] = ["invoice", "subscription", "customer"];
  for (const level of order) {
    const o = chain[level];
    if (o && o.mode !== "default") {
      const waived = level === "invoice" && o.waived === true;
      return {
        on: o.mode === "on" && !waived,
        source: level,
        waived,
        waiveReason: waived ? (o.waiveReason ?? null) : null,
        since: o.mode === "on" ? (o.since ?? null) : null,
      };
    }
  }
  return {
    on: chain.company.enabled,
    source: "company",
    waived: false,
    waiveReason: null,
    since: chain.company.enabled ? chain.company.since : null,
  };
}

const LEVEL_WORD: Record<LateFeeLevel, string> = {
  company: "company setting",
  customer: "customer",
  subscription: "subscription",
  invoice: "invoice",
};

/** "Late fee: On (from customer)" — the line every page shows. */
export function lateFeeLabel(e: Pick<EffectiveLateFee, "on" | "source" | "waived">): string {
  if (e.waived) return "Late fee: Waived (on this invoice)";
  return `Late fee: ${e.on ? "On" : "Off"} (from ${LEVEL_WORD[e.source]})`;
}

/** Owner and manager may switch a level; only the owner bills, waives or edits the company setting. */
export function mayToggleLateFee(role: string | null | undefined): boolean {
  return role === "owner" || role === "manager";
}
export function mayBillLateCharges(role: string | null | undefined): boolean {
  return role === "owner";
}

/** A GSTIN on the invoice (as issued) or on the customer = registered. */
export function isGstRegistered(...gstins: (string | null | undefined)[]): boolean {
  return gstins.some((g) => typeof g === "string" && g.trim().length >= 15);
}
