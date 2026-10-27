/**
 * R-2025 — who REALLY paid a money-in bank line ("payer"), and whether that is the customer.
 *
 * Pardeep (27 Oct, staging, ₹16,709):
 *   NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759
 * "the account the payment came from and the company that owns the account are different — there
 * should be a warning, and a system to manage them: the client often pays from another account and
 * sometimes gets a third party to pay."
 *
 *   payerFromNarration   — the payer named by the rail (NEFT / RTGS / IMPS / UPI), never our own
 *                          company (the tenant name, which banks also write on a credit).
 *   payerMatchesCustomer — is the payer the chosen customer (by name, or a known payer of theirs)?
 *                          No → the sheet warns and asks who it is (own other account / on their
 *                          behalf / wrong customer).
 *   knownPayerCustomer   — the learned memory (customer_payers): one customer → the guess;
 *                          two customers → no guess at all (pick by hand).
 *   onBehalfLine         — the receipt's line. The GST invoice and the receipt stay in the
 *                          CUSTOMER's name; the payer is only recorded.
 *
 * The database twin of the key is the same lower-case-letters rule (customer_payers.payer_name_key,
 * migration *_r2025_customer_payers.sql).
 */
import { customerNameTokens } from "@/lib/accounting/credit-match";
import { bankDetailsFromNarration } from "./narration-bank-details";

export type PayerRelation = "own_account" | "group_company" | "director" | "third_party";

export const PAYER_RELATIONS: ReadonlyArray<readonly [PayerRelation, string]> = [
  ["group_company", "Group company"],
  ["director", "Director / partner / owner"],
  ["third_party", "Third party"],
  ["own_account", "Customer’s own other account"],
];

export function relationLabel(r: PayerRelation | string | null | undefined): string {
  return PAYER_RELATIONS.find(([k]) => k === r)?.[1] ?? "Payer";
}

export interface NarrationPayer {
  /** As the bank wrote it (spaces tidied). */
  name: string;
  /** payerKey(name). */
  key: string;
  ifsc: string | null;
  upi: string | null;
  accountTail: string | null;
}

/** One customer_payers row. */
export interface KnownPayer {
  id: string;
  customer_id: string;
  payer_name: string;
  payer_name_key: string;
  relation: PayerRelation;
  note: string | null;
  ifsc: string | null;
  upi_id: string | null;
  account_tail: string | null;
  uses: number;
  first_seen_txn: string | null;
  created_at: string;
}

/** Lower-case letters and single spaces; null when under 3 letters (nothing stable). */
export function payerKey(name: string | null | undefined): string | null {
  const k = (name ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  return k.length >= 3 ? k : null;
}

const isName = (s: string | undefined): s is string =>
  !!s && /^[A-Za-z][A-Za-z .&']*[A-Za-z.]$/.test(s.trim()) && s.trim().length >= 3;

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/** Is this name our own company (every meaningful word of it is in one of our names)? */
function isOwn(name: string, ownNames: readonly string[]): boolean {
  const toks = customerNameTokens(name);
  if (toks.length === 0) return true;   // only "PRIVATE LIMITED" etc. — not a payer either
  return ownNames.some((own) => {
    const mine = new Set(customerNameTokens(own));
    return mine.size > 0 && toks.every((t) => mine.has(t));
  });
}

/** The name slots each rail uses, in the order to try. */
function nameSlots(text: string): string[] {
  const dash = text.split("-").map((s) => s.trim());
  const slash = text.split("/").map((s) => s.trim());
  if (/^(NEFT|RTGS)(\s+(CR|DR))?$/i.test(dash[0] ?? "")) return [dash[2], dash[3]].filter(Boolean) as string[];
  if (/^IMPS$/i.test(dash[0] ?? "")) return [dash[2]].filter(Boolean) as string[];
  if (/^UPI$/i.test(slash[0] ?? "") && slash.length > 2) return [slash[2]];
  if (/^UPI$/i.test(dash[0] ?? "")) return (dash[2] ?? "").includes("@") ? [dash[1]] : [dash[2]].filter(Boolean) as string[];
  return [];
}

export function payerFromNarration(description: string | null | undefined, ownNames: readonly string[]): NarrationPayer | null {
  const text = (description ?? "").trim();
  if (!text) return null;
  const name = nameSlots(text).find((s) => isName(s) && !isOwn(s, ownNames));
  if (!name) return null;
  const key = payerKey(name);
  if (!key) return null;
  const d = bankDetailsFromNarration(text);
  return { name: tidy(name), key, ifsc: d.ifsc, upi: d.upi, accountTail: d.accountTail };
}

/* Words banks cut short at the end of a long name ("…TECHNOLOGIES PRI"). */
const TAIL_WORDS = ["private", "limited", "technologies", "technology", "solutions", "services", "enterprises",
  "industries", "international", "corporation", "company", "infotech", "software"];

function distinctive(name: string): string[] {
  const toks = customerNameTokens(name);
  const last = toks[toks.length - 1];
  if (last && TAIL_WORDS.some((w) => w !== last && w.startsWith(last))) toks.pop();
  return toks;
}

/**
 * Is the payer the customer? Yes when it is one of their known payers, or when one name holds
 * every meaningful word of the other ("SHREE NANDIK TECHNOLOGIES PRI" = "Shree Nandik Technologies
 * Pvt Ltd"). One shared word is NOT enough: director "RAJESH KUMAR" paying for "Kumar Traders" is
 * someone else paying. A name with no meaningful word cannot be judged → treated as a match (no
 * false alarm).
 */
export function payerMatchesCustomer(payer: NarrationPayer, customerName: string, knownForCustomer: readonly KnownPayer[]): boolean {
  if (knownForCustomer.some((k) => k.payer_name_key === payer.key)) return true;
  const p = distinctive(payer.name), c = distinctive(customerName);
  if (p.length === 0 || c.length === 0) return true;
  const cs = new Set(c), ps = new Set(p);
  return p.every((t) => cs.has(t)) || c.every((t) => ps.has(t));
}

/** Who this payer is known for: one customer, several (→ no guess), or nobody. */
export function knownPayerCustomer(key: string | null, payers: readonly KnownPayer[]):
  { kind: "one"; payer: KnownPayer } | { kind: "many" } | null {
  if (!key) return null;
  const hits = payers.filter((k) => k.payer_name_key === key);
  if (hits.length === 0) return null;
  return new Set(hits.map((h) => h.customer_id)).size === 1 ? { kind: "one", payer: hits[0] } : { kind: "many" };
}

/**
 * The receipt's line (R-2025 (3)) — the receipt and the GST invoice stay in the customer's name.
 * "Received from SHREE NANDIK … (group company) on behalf of Links Infotech".
 */
export function onBehalfLine(payerName: string | null | undefined, relation: string | null | undefined, customerName: string): string | null {
  const name = (payerName ?? "").trim();
  if (!name || !relation) return null;
  if (relation === "own_account") return `Received from ${customerName}'s other account (${name})`;
  const word = relation === "director" ? "director" : relation === "group_company" ? "group company" : "third party";
  return `Received from ${name} (${word}) on behalf of ${customerName}`;
}
