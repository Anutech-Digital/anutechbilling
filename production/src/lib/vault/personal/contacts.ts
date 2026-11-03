/**
 * R-2392 — Private Vault → People (table personal_contacts, migration
 * 20261103003100_r2392_personal_contacts.sql). Pure: no DB, no UI.
 *
 * A contact is one of the owner's OWN people (family, a friend). Loans from / to a person,
 * Owe-hold entries and Income / Expense rows can point at one (contact_id); the party text
 * stays filled with the name (the DB trigger keeps it so), so older screens keep working.
 *
 * Per person (the People page):
 *   lent      = outstanding of OPEN loans GIVEN to them       (they owe me)
 *   borrowed  = outstanding of OPEN loans TAKEN from them     (I owe them)
 *   oweHold   = OPEN owe/hold entries with them — an advance (byana) they paid me, or money
 *               I hold for them                                (I owe them)
 *   net       = lent − borrowed − oweHold   (> 0 "They owe me", < 0 "I owe them")
 * Outstanding comes from summariseLoan (the same figure as the Loans page). Income received
 * from / spent on them is shown next to it but is not a debt, so it is not in net.
 *
 * Never the company's customers or contacts — nothing here reads or writes a business table.
 */
import { summariseLoan, type LoanLike, type LoanPaymentLike } from "@/lib/vault/personal/loans";
import { isIncomeKind, isSpendKind } from "@/lib/vault/personal/income-expense";
import type { OweHoldLike } from "@/lib/vault/personal/owe-hold";

export type ContactRelation = "family" | "friend" | "business" | "other";

export const CONTACT_RELATIONS: readonly ContactRelation[] = ["family", "friend", "business", "other"];

export const CONTACT_RELATION_LABEL: Record<ContactRelation, string> = {
  family: "Family",
  friend: "Friend",
  business: "Business",
  other: "Other",
};

export interface ContactLike {
  id: string;
  name: string;
  relation: ContactRelation;
  phone: string | null;
  email: string | null;
  pan: string | null;
  archived: boolean;
}

/** Same rule as the DB's unique index: trimmed, case-insensitive. */
export function contactKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Active contacts whose name, phone or email contains the search (case-insensitive), A→Z. */
export function searchContacts<T extends ContactLike>(contacts: readonly T[], q: string, includeArchived = false): T[] {
  const s = q.trim().toLowerCase();
  return contacts
    .filter((c) => includeArchived || !c.archived)
    .filter((c) => !s
      || c.name.toLowerCase().includes(s)
      || (c.phone ?? "").replace(/\s/g, "").includes(s.replace(/\s/g, ""))
      || (c.email ?? "").toLowerCase().includes(s))
    .sort((a, b) => a.name.localeCompare(b.name, "en-IN", { sensitivity: "base" }));
}

/** An active contact with exactly this name (trim / case ignored), if any. */
export function findByName<T extends ContactLike>(contacts: readonly T[], name: string, exceptId?: string): T | null {
  const k = contactKey(name);
  if (!k) return null;
  return contacts.find((c) => !c.archived && c.id !== exceptId && contactKey(c.name) === k) ?? null;
}

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** "abcde 1234 f" → "ABCDE1234F". Empty → null. */
export function normalisePan(input: string): string | null {
  const t = input.replace(/\s/g, "").toUpperCase();
  return t === "" ? null : t;
}

export interface ContactFormInput {
  name: string;
  phone: string;
  email: string;
  pan: string;
}

/** First problem with the form, in plain words — or null when it can be saved. */
export function contactIssue(f: ContactFormInput, contacts: readonly ContactLike[], exceptId?: string): string | null {
  const name = f.name.trim();
  if (!name) return "Type the person's name.";
  if (name.length > 120) return "Name is too long — up to 120 letters.";
  const dup = findByName(contacts, name, exceptId);
  if (dup) return `"${dup.name}" is already in your people — pick it instead of adding it again.`;
  if (f.phone.trim().length > 20) return "Phone is too long — up to 20 characters.";
  const email = f.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Email looks wrong — like name@example.com, or leave it empty.";
  const pan = normalisePan(f.pan);
  if (pan && !PAN_RE.test(pan)) return "PAN is 10 characters like ABCDE1234F — or leave it empty.";
  return null;
}

/* ── per-person position ─────────────────────────────────────────────────────────────────── */

export interface ContactLoanLike extends Pick<LoanLike, "id" | "principal" | "direction" | "status"> {
  contact_id?: string | null;
}

export interface ContactOweHoldLike extends OweHoldLike {
  contact_id?: string | null;
}

export interface ContactPosition {
  /** Open loans given to them: what is still to come back. */
  lent: number;
  /** Open loans taken from them: what I still have to repay. */
  borrowed: number;
  /** Open owe/hold entries with them. */
  oweHold: number;
  /** lent − borrowed − oweHold. > 0 they owe me, < 0 I owe them. */
  net: number;
  openLoans: number;
  openOweHold: number;
}

export function contactPosition(
  contactId: string,
  loans: readonly ContactLoanLike[],
  payments: readonly LoanPaymentLike[],
  oweHold: readonly ContactOweHoldLike[],
): ContactPosition {
  let lent = 0;
  let borrowed = 0;
  let openLoans = 0;
  for (const l of loans) {
    if (l.contact_id !== contactId || l.status !== "open") continue;
    const out = summariseLoan(l, payments).outstanding;
    openLoans += 1;
    if (l.direction === "given") lent += out; else borrowed += out;
  }
  let oh = 0;
  let openOweHold = 0;
  for (const r of oweHold) {
    if (r.contact_id !== contactId || r.status !== "open") continue;
    oh += r.amount;
    openOweHold += 1;
  }
  return { lent, borrowed, oweHold: oh, net: lent - borrowed - oh, openLoans, openOweHold };
}

/** Every contact's position at once (the People list's Net column). */
export function contactPositions(
  contactIds: readonly string[],
  loans: readonly ContactLoanLike[],
  payments: readonly LoanPaymentLike[],
  oweHold: readonly ContactOweHoldLike[],
): Map<string, ContactPosition> {
  return new Map(contactIds.map((id) => [id, contactPosition(id, loans, payments, oweHold)]));
}

export type NetSide = "they_owe" | "i_owe" | "settled";

export function netSide(net: number): NetSide {
  return net > 0 ? "they_owe" : net < 0 ? "i_owe" : "settled";
}

export const NET_SIDE_LABEL: Record<NetSide, string> = {
  they_owe: "They owe me",
  i_owe: "I owe them",
  settled: "Nothing owed",
};

export interface ContactTxLike {
  kind: string;
  amount: number;
}

/** Income received from them and spending paid to them (transfers / card payments are neither). */
export function contactTxTotals(rows: readonly ContactTxLike[]): { received: number; paid: number } {
  let received = 0;
  let paid = 0;
  for (const t of rows) {
    if (isIncomeKind(t.kind)) received += t.amount;
    else if (isSpendKind(t.kind)) paid += t.amount;
  }
  return { received, paid };
}

/** Lenders typed on earlier non-person loans (banks / NBFCs), for the Lender box's suggestions. */
export function pastLenders(loans: readonly Pick<LoanLike, "loan_kind" | "party">[]): string[] {
  const seen = new Map<string, string>();
  for (const l of loans) {
    if (l.loan_kind === "person") continue;
    const k = contactKey(l.party);
    if (k && !seen.has(k)) seen.set(k, l.party.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en-IN", { sensitivity: "base" }));
}
