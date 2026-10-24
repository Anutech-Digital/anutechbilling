/**
 * R-1857 (epic R-1841, Phase 4) — the people the Compliance Calendar tracks one by one.
 *
 * A director (directors register, company_directors — R-1850) or an LLP designated partner
 * with a DPIN (partners register, firm_partners — R-1847) holds a DIN, and Rule 12A of the
 * Companies (Appointment and Qualification of Directors) Rules, as substituted by G.S.R. 943(E)
 * (31 Dec 2025, in force 31 Mar 2026), puts the DIR-3 KYC duty on each DIN holder. The rows
 * themselves are built in obligations.ts (personObligations) so the one catalog stays the one
 * place dates come from; this file only turns register rows into that shape (no I/O, no
 * runtime imports — the client hook, the Today page and the reminder cron all use it).
 */

export type PersonRole = "director" | "designated_partner";

export interface CompliancePerson {
  name: string;
  /** DIN (director) or DPIN (designated partner) — the same 8-digit number. */
  din: string;
  role: PersonRole;
  /** Director: ceased_on. Partner: left_on. A person is tracked up to and including this day. */
  ceasedOn: string | null;
  /** Directors register only (partners register has no DSC field yet). */
  dscExpiry: string | null;
  lastKycYear: number | null;
  /** The day the register saw the personal mobile / email change (Rule 12A(2) → 30 days). */
  detailsChangedOn: string | null;
}

export interface DirectorPersonRow {
  name: string;
  din: string;
  ceased_on: string | null;
  dsc_expiry: string | null;
  last_kyc_year: number | null;
  kyc_details_changed_on?: string | null;
}

export function peopleFromDirectors(rows: readonly DirectorPersonRow[]): CompliancePerson[] {
  return rows.map((d) => ({
    name: d.name,
    din: d.din,
    role: "director",
    ceasedOn: d.ceased_on,
    dscExpiry: d.dsc_expiry,
    lastKycYear: d.last_kyc_year == null ? null : Number(d.last_kyc_year),
    detailsChangedOn: d.kyc_details_changed_on ?? null,
  }));
}

export interface PartnerPersonRow {
  name: string;
  din_dpin: string | null;
  is_designated: boolean;
  left_on: string | null;
}

/** Only a designated partner with a DPIN files DIR-3 KYC (R-1841 decision 1). */
export function peopleFromPartners(rows: readonly PartnerPersonRow[]): CompliancePerson[] {
  return rows
    .filter((p) => p.is_designated && p.din_dpin)
    .map((p) => ({
      name: p.name,
      din: p.din_dpin as string,
      role: "designated_partner",
      ceasedOn: p.left_on,
      dscExpiry: null,
      lastKycYear: null,
      detailsChangedOn: null,
    }));
}
