/**
 * R-1846 (epic R-1841) — an owner's own "salary" is not an expense.
 *
 * Indian practice: a proprietor cannot employ themselves. What the owner takes out of the
 * business for personal use — "my salary", "owner salary" — is DRAWINGS: it lowers the owner's
 * capital (R-1839, owner_equity_movements) and is never on the P&L. Booking it as an expense
 * understates profit and the income tax.
 *
 * A partner of a firm is different only in one way: the firm may deduct a working partner's
 * remuneration (and interest on capital) IF the partnership deed provides for it, within the
 * Income-tax Act s.40(b) limits. Without such a clause, money paid to a partner is drawings.
 * The app does not know the deed, so it CAUTIONS and offers drawings — it never blocks.
 *
 * A Pvt Ltd (and an empty type, which means Pvt Ltd — lib/compliance/entity.ts) pays its
 * directors a real salary through Payroll / Director's Remuneration: no caution there.
 * Pure — no I/O.
 */
import type { BusinessType } from "@/lib/compliance/obligations";
import { entityProfile } from "@/lib/compliance/entity";
import { isActivePartner, type FirmPartner } from "@/lib/accounting/partners";

export const OWNER_PAY_CATEGORY = "Director's Remuneration";

type PartnerLike = Pick<FirmPartner, "name" | "joined_on" | "left_on">;

export interface OwnerPayCaution {
  who: "owner" | "partner";
  /** The register partner this money went to, when the payee / employee name is one. */
  partnerName: string | null;
  title: string;
  body: string;
}

/* "owner salary", "my salary", "apni salary", "proprietor's pay", "partner remuneration", "self salary" … */
const OWNER_PAY_RE =
  /\b(?:owner'?s?|proprietor'?s?|partner'?s?|my|own|self|apni|apna|meri|mera|khud ki)\s+(?:salary|salaries|pay|remuneration|tankha|tankhwah|tanakhwah)\b/i;

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function matchPartner(name: string | null | undefined, partners: readonly PartnerLike[] | undefined, onDate: string): string | null {
  const n = norm(name);
  if (!n) return null;
  const hit = (partners ?? []).find((p) => norm(p.name) === n && isActivePartner(p, onDate));
  return hit ? hit.name : null;
}

function ownerText(): OwnerPayCaution {
  return {
    who: "owner", partnerName: null,
    title: "A proprietor's own salary is not an expense",
    body: "Money you take out of your own business for yourself is Drawings, not an expense. It lowers your capital on the Balance Sheet and never reduces profit or income tax. Booking it as an expense makes the profit and the tax wrong.",
  };
}

function partnerText(partnerName: string | null): OwnerPayCaution {
  const who = partnerName ?? "a partner";
  return {
    who: "partner", partnerName,
    title: `Money paid to ${who} — expense only if the deed allows it`,
    body: `A partner's salary (remuneration) is a firm expense only when the partnership deed provides for it, within the Income-tax Act s.40(b) limits. If the deed does not, this is Drawings by ${who}: it lowers that partner's capital and is not an expense. Ask your CA if you are not sure.`,
  };
}

/** The expense form: category, payee and the written note. Null = nothing to say. */
export function ownerPayCaution(args: {
  businessType: BusinessType | null | undefined;
  category?: string | null;
  payee?: string | null;
  /** Description + notes, as typed. */
  text?: string | null;
  partners?: readonly PartnerLike[];
  /** The expense date (YYYY-MM-DD) — partners who had left by then do not match. */
  onDate?: string;
}): OwnerPayCaution | null {
  const type = entityProfile(args.businessType).type;
  if (type === "pvt_ltd") return null;
  const said = args.category === OWNER_PAY_CATEGORY || OWNER_PAY_RE.test(`${args.payee ?? ""} ${args.text ?? ""}`);
  if (type === "proprietor") return said ? ownerText() : null;
  const partner = matchPartner(args.payee, args.partners, args.onDate ?? "9999-12-31");
  return partner || said ? partnerText(partner) : null;
}

/* Designation words that mean "this is the owner", not a staff member.
   "Partner" only as a word on its own or with Managing / Working / Senior — "Channel Partner Manager" is staff. */
const OWNER_DESIGNATION_RE = /\b(?:owner|proprietor|proprietress|founder|co-?founder)\b/i;
const PARTNER_DESIGNATION_RE = /^(?:(?:managing|working|senior|designated|active)\s+)?partner$/i;

/** Payroll → Add employee: the owner / a partner being added as staff. */
export function employeeOwnerCaution(args: {
  businessType: BusinessType | null | undefined;
  name?: string | null;
  designation?: string | null;
  partners?: readonly PartnerLike[];
  onDate?: string;
}): OwnerPayCaution | null {
  const type = entityProfile(args.businessType).type;
  if (type === "pvt_ltd") return null;
  const d = (args.designation ?? "").trim();
  if (type === "proprietor") return OWNER_DESIGNATION_RE.test(d) ? ownerText() : null;
  const partner = matchPartner(args.name, args.partners, args.onDate ?? "9999-12-31");
  return partner || PARTNER_DESIGNATION_RE.test(d) || OWNER_DESIGNATION_RE.test(d) ? partnerText(partner) : null;
}

export type DrawingsFromExpense = { ok: true; amount: number; accountId: string } | { ok: false; error: string };

/**
 * The expense form's amount and "paid from" → the drawings entry R-1839's RPC records
 * (whole rupees, one bank / cash account). Anything missing → the message to show; nothing is saved.
 */
export function drawingsFromExpense(args: {
  amount: number;
  method: string | null | undefined;
  bankAccountId: string | null | undefined;
  pettyCashAccountId: string | null | undefined;
}): DrawingsFromExpense {
  const { amount, method } = args;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter the amount first." };
  if (!Number.isInteger(amount)) return { ok: false, error: "Drawings are recorded in whole rupees — enter the amount without paise." };
  if (method === "employee_advance") return { ok: false, error: "Drawings come from a bank or cash account — pick how the money was paid." };
  const accountId = method === "cash" ? args.pettyCashAccountId : args.bankAccountId;
  if (!accountId) {
    return { ok: false, error: method === "cash" ? "Pick the cash account in \"Paid from petty cash\" below." : "Pick the account in \"From which account?\" below." };
  }
  return { ok: true, amount, accountId };
}
