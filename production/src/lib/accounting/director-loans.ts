/**
 * R-1853 (epic R-1841, Phase 3 — Pvt Ltd) — loans to and from the company's directors, as pure,
 * tested rules. The director is picked from the directors register (R-1850, company_directors),
 * never typed. Rows: loans_given.director_id + s185_basis, business_loans.director_id +
 * director_declaration (migration 20261024225000_r1853_director_loans.sql — the RPCs check the
 * same reasons and designations).
 *
 * SOURCES (read 24 Oct 2026 — the Act text, not memory):
 *   Companies Act 2013 as on India Code (Legislative Department):
 *   https://www.indiacode.nic.in/bitstream/123456789/2114/5/A2013-18.pdf
 *     s.185 (substituted by Act 1 of 2018, w.e.f. 7-5-2018): (1) no loan to a director of the
 *       company / its holding company, their partner or relative, or a firm they are partners in.
 *       (3)(a) except to a managing or whole-time director (i) as part of the conditions of service
 *       extended to all employees, or (ii) under a scheme approved by the members by special
 *       resolution. (4) contravention: company fine ₹5 lakh – ₹25 lakh; the officer in default and
 *       the director who took it: up to 6 months' imprisonment or fine ₹5 lakh – ₹25 lakh.
 *     s.186(2): loans + guarantees + investments may not exceed 60% of paid-up share capital +
 *       free reserves + securities premium, or 100% of free reserves + securities premium,
 *       whichever is more; (3) above that a special resolution is needed first. Explanation:
 *       "person" excludes an employee. (7) no loan at a rate below the G-sec yield closest to its
 *       tenor.
 *   Loans FROM a director: Form DPT-3 (Companies (Acceptance of Deposits) Amendment Rules 2022,
 *   G.S.R. 663(E), Gazette 29 Aug 2022) lists "any amount received from a person who, at the time
 *   of the receipt of the amount, was a director of the company" among the receipts that are not
 *   deposits. The written-declaration condition (rule 2(1)(c)(viii), amended by G.S.R. 695(E),
 *   15 Sep 2015) is quoted from secondary sources only — the MCA PDF did not open — so the
 *   wording is for the CA to confirm (Hitesh step on R-1853).
 *
 * WHAT THE APP DOES: a CAUTION, never a legal ruling. Lending to a director needs one of the
 * three reasons below picked before the loan is saved; the s.186 figure is a rough floor
 * (free reserves and securities premium are not counted — they only raise the limit).
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { DESIGNATION_LABEL, isActiveDirector, type CompanyDirector, type Designation } from "@/lib/company/directors";

export const COMPANIES_ACT_SOURCE = "https://www.indiacode.nic.in/bitstream/123456789/2114/5/A2013-18.pdf";

/** Director loans exist only for a company (the one resolver — an empty type is Pvt Ltd). */
export function showsDirectorLoans(type: BusinessType | null | undefined): boolean {
  return entityProfile(type).type === "pvt_ltd";
}

export const S185_BASES = ["md_wtd_service", "md_wtd_scheme", "ca_confirmed"] as const;
export type S185Basis = (typeof S185_BASES)[number];

const MD_WTD: readonly Designation[] = ["managing_director", "whole_time_director"];

export const S185_BASIS_LABEL: Record<S185Basis, string> = {
  md_wtd_service: "Managing / whole-time director — part of the service terms all employees get",
  md_wtd_scheme: "Managing / whole-time director — under a scheme the members approved by special resolution",
  ca_confirmed: "My CA has confirmed an exemption applies to this loan",
};

const S185_SECTION: Record<S185Basis, string> = {
  md_wtd_service: "s.185(3)(a)(i)",
  md_wtd_scheme: "s.185(3)(a)(ii)",
  ca_confirmed: "exemption — ask your CA which one and keep it on file",
};

export function s185BasisAllowed(basis: S185Basis, designation: Designation): boolean {
  if (!(S185_BASES as readonly string[]).includes(basis)) return false;
  if (basis === "ca_confirmed") return true;
  return MD_WTD.includes(designation);
}

export interface S185Option {
  key: S185Basis;
  label: string;
  section: string;
  allowed: boolean;
  /** Why the option is closed (empty when allowed). */
  why: string;
}

export function s185Options(designation: Designation): S185Option[] {
  return S185_BASES.map((key) => {
    const allowed = s185BasisAllowed(key, designation);
    return {
      key,
      label: S185_BASIS_LABEL[key],
      section: S185_SECTION[key],
      allowed,
      why: allowed ? "" : `Only for a managing or whole-time director — this director is a ${DESIGNATION_LABEL[designation]}.`,
    };
  });
}

/** s.186(2) uses 60% of paid-up capital + free reserves + premium; we count paid-up only. */
export const S186_PAID_UP_SHARE = 0.6;

export interface S186Estimate {
  /** Whole rupees — 60% of paid-up capital, rounded down. */
  limit: number;
  /** Loans given still outstanding + this loan. */
  total: number;
  over: boolean;
}

export function s186Estimate(input: { paidUpCapital: number | null; loansOutstanding: number; newLoan: number }): S186Estimate | null {
  if (!input.paidUpCapital || input.paidUpCapital <= 0) return null;
  const limit = Math.floor(input.paidUpCapital * S186_PAID_UP_SHARE);
  const total = Math.max(0, Math.round(input.loansOutstanding)) + Math.max(0, Math.round(input.newLoan));
  return { limit, total, over: total > limit };
}

/**
 * The Balance Sheet's "Bank / business loans" total (from the report RPC — the one figure)
 * split into the part owed to directors and the rest. The two always add back to the total.
 */
export function splitLoansTaken(
  totalPayable: number,
  loans: readonly { director_id?: string | null; outstanding: number }[],
): { fromDirectors: number; others: number } {
  const total = Math.max(0, totalPayable);
  const owed = loans.reduce((s, l) => s + (l.director_id ? Math.max(0, l.outstanding) : 0), 0);
  const fromDirectors = Math.min(total, owed);
  return { fromDirectors, others: total - fromDirectors };
}

/** Director loans still owed with no copy of the director's written declaration on file. */
export function undeclaredDirectorLoans(
  loans: readonly { director_id?: string | null; director_declaration?: boolean | null; outstanding: number }[],
): number {
  return loans.filter((l) => l.director_id && l.director_declaration !== true && l.outstanding > 0).length;
}

export interface DirectorChoice { id: string; name: string; label: string; designation: Designation }

/** Directors in office on `onDate`, labelled "Name · Designation · DIN 12345678". */
export function directorChoices(
  directors: readonly Pick<CompanyDirector, "id" | "name" | "din" | "designation" | "ceased_on">[],
  onDate: string,
): DirectorChoice[] {
  return directors
    .filter((d) => isActiveDirector(d, onDate))
    .map((d) => ({ id: d.id, name: d.name, label: `${d.name} · ${DESIGNATION_LABEL[d.designation]} · DIN ${d.din}`, designation: d.designation }));
}
