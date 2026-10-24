/**
 * R-1850 (epic R-1841, Phase 3 — Pvt Ltd) — the directors register, as pure, tested rules.
 *
 * Rows live in company_directors (migration 20261024203000_r1850_company_directors.sql); the
 * database checks the same DIN / PAN / designation / date rules — the screen checks first so
 * the person sees the message beside the field.
 *
 * Who sees the register: only a Pvt Ltd, decided by the one resolver (lib/compliance/entity.ts
 * — an empty business type is Pvt Ltd). LLP designated partners live in the partners register
 * (R-1847). "Current" is not stored: a director is current until ceased_on (inclusive).
 *
 * DIR-3 KYC: the rule is R-1856's (G.S.R. 943(E), Rule 12A — once every third consecutive FY,
 * by 30 June; directors whose KYC is up to date are next due 30 June 2028). Per director:
 * last KYC year + 3 → 30 June of that year. Without a last KYC year the Compliance Calendar's
 * common cycle is shown (read from obligationsFor, never a second copy of the year).
 * CA/Hitesh to confirm the per-director reading (R-1856 step). Reminders are R-1857's job.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { obligationsFor } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { panError } from "@/lib/accounting/partners";
import { isMaskedContact } from "@/lib/auth/roles";

export const DESIGNATIONS = [
  "director", "managing_director", "whole_time_director", "additional_director", "nominee_director",
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

export const DESIGNATION_LABEL: Record<Designation, string> = {
  director: "Director",
  managing_director: "Managing Director",
  whole_time_director: "Whole-time Director",
  additional_director: "Additional Director",
  nominee_director: "Nominee Director",
};

export interface CompanyDirector {
  id: string;
  name: string;
  din: string;
  pan: string | null;
  designation: Designation;
  appointed_on: string | null; // YYYY-MM-DD
  ceased_on: string | null;    // YYYY-MM-DD
  dsc_expiry: string | null;   // YYYY-MM-DD
  last_kyc_year: number | null;
  /** Masked ("as••••@…") for a role without can_view_contact_details (R-1009 gateway). */
  email: string | null;
  phone: string | null;
}

export function showsDirectorsRegister(type: BusinessType | null | undefined): boolean {
  return entityProfile(type).type === "pvt_ltd";
}

export function isActiveDirector(d: Pick<CompanyDirector, "ceased_on">, onDate: string): boolean {
  return !d.ceased_on || onDate <= d.ceased_on;
}

const DAY = 864e5;
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A Digital Signature Certificate inside this many days is "soon" (amber). */
export const DSC_WARN_DAYS = 30;

export interface DscStatus {
  kind: "none" | "ok" | "soon" | "expired";
  days: number | null;
  text: string;
}

export function dscStatus(expiry: string | null | undefined, today: string): DscStatus {
  if (!expiry) return { kind: "none", days: null, text: "DSC expiry not added" };
  const days = daysBetween(today, expiry);
  if (days < 0) {
    const ago = -days;
    return { kind: "expired", days, text: ago === 1 ? "DSC expired yesterday" : `DSC expired ${ago} days ago` };
  }
  const kind = days <= DSC_WARN_DAYS ? "soon" : "ok";
  const text = days === 0 ? "DSC expires today" : days === 1 ? "DSC expires tomorrow" : `DSC expires in ${days} days`;
  return { kind, days, text };
}

export interface KycDue {
  dueDate: string;
  overdue: boolean;
  /** True when no last KYC year is recorded and the calendar's common cycle is shown. */
  fromCycle: boolean;
  text: string;
}

/** The Compliance Calendar's DIR-3 KYC date (R-1856) for this day — the one copy of the cycle. */
function commonCycleDue(today: string): string {
  const kyc = obligationsFor({ businessType: "pvt_ltd", gstFiling: null }).find((o) => o.key === "roc_dir3kyc");
  const [y, m, d] = today.split("-").map(Number);
  return kyc ? kyc.next(new Date(y, m - 1, d)).dueDate : `${y}-06-30`;
}

export function kycDue(lastKycYear: number | null | undefined, today: string): KycDue {
  const fromCycle = !lastKycYear;
  const dueDate = lastKycYear ? `${lastKycYear + 3}-06-30` : commonCycleDue(today);
  const overdue = today > dueDate;
  const text = overdue ? `KYC overdue since ${shortDate(dueDate)}` : `KYC due ${shortDate(dueDate)}`;
  return { dueDate, overdue, fromCycle, text };
}

// ── The add / edit form ───────────────────────────────────────────────────────────────────

export interface DirectorFormInput {
  name: string;
  din: string;
  pan: string;
  designation: Designation;
  appointed_on: string;
  ceased_on: string;
  dsc_expiry: string;
  last_kyc_year: string;
  email: string;
  phone: string;
}

export interface DirectorFormErrors {
  name?: string; din?: string; pan?: string; dates?: string; kyc?: string; email?: string; phone?: string;
}

const DIN_RE = /^[0-9]{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The first DIR-3 KYC year (the form started in 2018). */
const FIRST_KYC_YEAR = 2018;

const cleanPhone = (s: string) => s.trim().replace(/[\s()-]/g, "");

export function directorFormErrors(
  input: DirectorFormInput,
  existing: readonly Pick<CompanyDirector, "id" | "name" | "din">[],
  editingId: string | null,
  today: string,
): DirectorFormErrors {
  const e: DirectorFormErrors = {};
  const others = existing.filter((d) => d.id !== editingId);

  const name = input.name.trim();
  if (!name) e.name = "Enter the director's name.";
  else if (name.length > 200) e.name = "The name is too long (200 characters at most).";

  const din = input.din.trim();
  if (!din) e.din = "Enter the director's DIN (8 digits).";
  else if (!DIN_RE.test(din)) e.din = "DIN must be 8 digits.";
  else if (others.some((d) => d.din === din)) e.din = `DIN ${din} is already in the directors register.`;

  const pe = panError(input.pan);
  if (pe) e.pan = pe;

  if (input.appointed_on && input.ceased_on && input.ceased_on < input.appointed_on) {
    e.dates = "The cessation date cannot be before the appointment date.";
  }

  const kyc = input.last_kyc_year.trim();
  const thisYear = Number(today.slice(0, 4));
  if (kyc && (!/^\d{4}$/.test(kyc) || Number(kyc) < FIRST_KYC_YEAR || Number(kyc) > thisYear)) {
    e.kyc = `Last KYC year must be between ${FIRST_KYC_YEAR} and ${thisYear}.`;
  }

  const email = input.email.trim();
  if (email && !isMaskedContact(email) && (!EMAIL_RE.test(email) || email.length > 320)) {
    e.email = "Enter a valid email, e.g. name@company.in.";
  }
  const phone = input.phone.trim();
  if (phone && !isMaskedContact(phone) && !/^\+?\d{10,15}$/.test(cleanPhone(phone))) {
    e.phone = "Enter a phone number of 10 to 15 digits.";
  }
  return e;
}

export interface DirectorSaveInput {
  name: string;
  din: string;
  pan: string | null;
  designation: Designation;
  appointed_on: string | null;
  ceased_on: string | null;
  dsc_expiry: string | null;
  last_kyc_year: number | null;
  /** A masked value is sent as it is: save_company_director keeps the stored one. */
  email: string | null;
  phone: string | null;
}

/** Call only after directorFormErrors() is empty. */
export function normaliseDirectorInput(input: DirectorFormInput): DirectorSaveInput {
  const nz = (s: string) => (s.trim() === "" ? null : s.trim());
  const phone = nz(input.phone);
  return {
    name: input.name.trim(),
    din: input.din.trim(),
    pan: nz(input.pan)?.toUpperCase() ?? null,
    designation: input.designation,
    appointed_on: nz(input.appointed_on),
    ceased_on: nz(input.ceased_on),
    dsc_expiry: nz(input.dsc_expiry),
    last_kyc_year: nz(input.last_kyc_year) ? Number(input.last_kyc_year.trim()) : null,
    email: nz(input.email),
    phone: phone && !isMaskedContact(phone) ? cleanPhone(phone) : phone,
  };
}
