/**
 * R-1847 (epic R-1841, Phase 2) — the partners register of a partnership firm / LLP, as pure,
 * tested rules. Rows live in firm_partners (migration 20261024190000_r1847_firm_partners.sql);
 * the database checks the same PAN / DIN / share / date rules — the screen checks first so
 * the person sees the message beside the field.
 *
 * LLP = partnership with "designated partner" + DPIN (R-1841 decision 1). "Active" is not
 * stored: a partner is active from joined_on (if any) until left_on (inclusive).
 * Profit shares that do not add up to 100 % are a WARNING, never a block (card R-1847).
 *
 * Who sees the register: only a Partnership or LLP, decided by the one resolver
 * (lib/compliance/entity.ts — an empty type is Pvt Ltd, which has no partners).
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";

export interface FirmPartner {
  id: string;
  name: string;
  pan: string | null;
  din_dpin: string | null;
  /** LLP only: designated partner (files Form 8/11, DIR-3 KYC). */
  is_designated: boolean;
  /** Profit-sharing ratio, 0–100 (numeric(5,2) in the database). */
  profit_share_pct: number;
  /** Capital as per the deed / CA before entries recorded in the app — whole rupees. */
  capital_contribution: number;
  joined_on: string | null;   // YYYY-MM-DD
  left_on: string | null;     // YYYY-MM-DD
  note: string | null;
}

export function showsPartnersRegister(type: BusinessType | null | undefined): boolean {
  const t = entityProfile(type).type;
  return t === "partnership" || t === "llp";
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const DIN_RE = /^[0-9]{8}$/;

export function panError(pan: string | null | undefined): string | null {
  const v = (pan ?? "").trim().toUpperCase();
  if (!v) return null;
  return PAN_RE.test(v) ? null : "PAN must be 10 characters like ABCDE1234F (5 letters, 4 digits, 1 letter).";
}

export function dinError(din: string | null | undefined): string | null {
  const v = (din ?? "").trim();
  if (!v) return null;
  return DIN_RE.test(v) ? null : "DIN / DPIN must be 8 digits.";
}

export function isActivePartner(p: Pick<FirmPartner, "joined_on" | "left_on">, onDate: string): boolean {
  if (p.joined_on && onDate < p.joined_on) return false;
  if (p.left_on && onDate > p.left_on) return false;
  return true;
}

export function activePartners<T extends FirmPartner>(partners: readonly T[], onDate: string): T[] {
  return partners.filter((p) => isActivePartner(p, onDate)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Sum of the active partners' shares, to 2 decimals (numeric comes back as a string sometimes). */
export function shareTotal(partners: readonly FirmPartner[], onDate: string): number {
  const cents = partners.filter((p) => isActivePartner(p, onDate))
    .reduce((s, p) => s + Math.round(Number(p.profit_share_pct) * 100), 0);
  return cents / 100;
}

/**
 * Null when the shares add up to 100 % (within 0.01 per partner, so 33.33 × 3 is fine) or
 * there are no active partners yet.
 */
export function shareWarning(partners: readonly FirmPartner[], onDate: string): string | null {
  const active = partners.filter((p) => isActivePartner(p, onDate));
  if (active.length === 0) return null;
  const total = shareTotal(active, onDate);
  if (Math.abs(total - 100) <= 0.01 * active.length) return null;
  return `Profit shares add up to ${total}% — they should add up to 100%. Check the partnership deed.`;
}

/** The add / edit form, as typed (strings). */
export interface PartnerFormInput {
  name: string;
  pan: string;
  din_dpin: string;
  profit_share_pct: string;
  capital_contribution: string;
  joined_on: string;
  left_on: string;
}

export interface PartnerFormErrors { name?: string; pan?: string; din?: string; share?: string; capital?: string; dates?: string }

const key = (s: string) => s.trim().toLowerCase();

export function partnerFormErrors(
  input: PartnerFormInput,
  existing: readonly Pick<FirmPartner, "id" | "name" | "pan">[],
  editingId: string | null,
): PartnerFormErrors {
  const e: PartnerFormErrors = {};
  const others = existing.filter((p) => p.id !== editingId);
  const name = input.name.trim();
  if (!name) e.name = "Enter the partner's name.";
  else if (name.length > 200) e.name = "The name is too long (200 characters at most).";
  else if (others.some((p) => key(p.name) === key(name))) e.name = `${name} is already in the partners register.`;

  const pan = input.pan.trim().toUpperCase();
  const pe = panError(pan);
  if (pe) e.pan = pe;
  else if (pan && others.some((p) => (p.pan ?? "").toUpperCase() === pan)) e.pan = `PAN ${pan} is already used by another partner.`;

  const de = dinError(input.din_dpin);
  if (de) e.din = de;

  const shareText = input.profit_share_pct.trim();
  const share = shareText === "" ? 0 : Number(shareText);
  if (!Number.isFinite(share) || share < 0 || share > 100 || Math.abs(Math.round(share * 100) - share * 100) > 1e-6) {
    e.share = "Profit share must be between 0 and 100 % (up to 2 decimals).";
  }

  const capText = input.capital_contribution.trim().replace(/,/g, "");
  if (capText !== "" && !/^\d+$/.test(capText)) e.capital = "Enter the capital in whole rupees, e.g. 100000.";

  if (input.joined_on && input.left_on && input.left_on < input.joined_on) e.dates = "The leaving date cannot be before the joining date.";
  return e;
}

export interface PartnerSaveInput {
  name: string;
  pan: string | null;
  din_dpin: string | null;
  profit_share_pct: number;
  capital_contribution: number;
  joined_on: string | null;
  left_on: string | null;
}

/** Call only after partnerFormErrors() is empty. */
export function normalisePartnerInput(input: PartnerFormInput): PartnerSaveInput {
  const nz = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    name: input.name.trim(),
    pan: nz(input.pan)?.toUpperCase() ?? null,
    din_dpin: nz(input.din_dpin),
    profit_share_pct: input.profit_share_pct.trim() === "" ? 0 : Number(input.profit_share_pct),
    capital_contribution: input.capital_contribution.trim() === "" ? 0 : Number(input.capital_contribution.replace(/,/g, "")),
    joined_on: nz(input.joined_on),
    left_on: nz(input.left_on),
  };
}

/**
 * The partner a drawings / capital entry belongs to. Linked (partner_id) → the register's
 * current name; an older free-text entry → its own stored name, not linked (the screen offers
 * "Link to partner"). Null when the entry names no partner.
 */
export function movementPartner(
  m: { partner_id?: string | null; partner_name: string | null },
  partners: readonly Pick<FirmPartner, "id" | "name">[],
): { name: string; linked: boolean } | null {
  if (m.partner_id) {
    const p = partners.find((x) => x.id === m.partner_id);
    return { name: p?.name ?? m.partner_name ?? "Partner", linked: true };
  }
  return m.partner_name ? { name: m.partner_name, linked: false } : null;
}
