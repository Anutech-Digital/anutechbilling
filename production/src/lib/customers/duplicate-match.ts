/**
 * R-2715 — "is this customer already on file?" while a new one is typed. ONE rule for the
 * Onboard dialog (R-1443) and /customers/new, tested in duplicate-match.test.ts.
 *
 * Pratik (12 Nov audit): "Forza Medi India Private Limited" did not find
 * "FORZA MEDI ( INDIA) Pvt. Ltd" — the old match was plain word containment. Now:
 *   1. same GSTIN (the strongest fact — one registration, one customer);
 *   2. same company once legal suffixes (Pvt Ltd / Private Limited / LLP / Limited …),
 *      punctuation, "&"/"and" and spacing are normalised away;
 *   3. a business email's domain equal to the customer's website or contact email domain
 *      (never gmail / yahoo / outlook … — thousands of strangers share those);
 *   4. while typing: every typed word inside the normalised name, or the text inside the domain.
 *
 * It is a HINT ("Looks like …"), never a block: "Siemens India Pvt Ltd" and "Siemens Pvt Ltd" share a
 * key although they can be two legal entities — the operator decides, with the GSTIN as the proof.
 */
import { isPublicEmailDomain } from "@/lib/auth/domain";

export interface MatchableCustomer {
  id: string;
  name: string;
  display_name?: string | null;
  domain?: string | null;
  gstin?: string | null;
  contact_email?: string | null;
}

export type CustomerMatchReason = "gstin" | "name" | "email-domain" | "typing";

export interface CustomerMatch<T extends MatchableCustomer> {
  customer: T;
  reason: CustomerMatchReason;
}

/** Legal-form words that do not tell two companies apart. */
const LEGAL_WORDS = new Set([
  "pvt", "private", "ltd", "limited", "llp", "opc", "inc", "incorporated", "corp", "corporation",
  "co", "company", "plc", "llc", "pte", "gmbh", "the",
]);

/** Mailbox providers anyone can sign up to — their domain says nothing about the company. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.in", "hotmail.com", "hotmail.co.in", "live.com",
  "live.in", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "rediffmail.com", "rediff.com",
  "protonmail.com", "proton.me", "pm.me", "zohomail.com", "zohomail.in", "yandex.com", "yandex.ru",
  "gmx.com", "gmx.net", "mail.com", "inbox.com", "tutanota.com", "fastmail.com", "hey.com",
]);

/** The words of a company name that identify it: lower case, no punctuation, no legal form. */
export function companyWords(name: string | null | undefined): string[] {
  const src = name ?? "";
  const hit = wordsCache.get(src);
  if (hit) return hit;
  const all = plainWords(src)
    /* "pvtltd" glued → two legal words. */
    .flatMap((w) => (w === "pvtltd" ? ["pvt", "ltd"] : [w]));
  /* "(P) Ltd" / "P. Ltd" — the single "p" before ltd/limited is "Private". */
  const words = all.filter((w, i) => !LEGAL_WORDS.has(w) && !(w === "p" && (all[i + 1] === "ltd" || all[i + 1] === "limited")));
  /* "( INDIA)" at the end is the same company as no "India" at all. */
  while (words.length > 1 && words[words.length - 1] === "india") words.pop();
  /* Each customer's name is normalised once, not on every keystroke (a few thousand rows). */
  if (wordsCache.size > 20_000) wordsCache.clear();
  wordsCache.set(src, words);
  return words;
}
const wordsCache = new Map<string, string[]>();

/** Lower case, "&" = "and", punctuation → space, split into words (legal form kept). */
function plainWords(s: string): string[] {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
}

/** One key per company: "FORZA MEDI ( INDIA) Pvt. Ltd" and "Forza Medi Private Limited" → "forzamedi". */
export function companyKey(name: string | null | undefined): string {
  return companyWords(name).join("");
}

/** GSTIN as stored: upper case, no spaces; "" when it is not 15 characters. */
export function gstinKey(g: string | null | undefined): string {
  const v = (g ?? "").toUpperCase().replace(/\s+/g, "");
  return v.length === 15 ? v : "";
}

/** The domain of a business email or website, "" for a free-mail address or nothing. */
export function businessDomain(emailOrSite: string | null | undefined): string {
  let v = (emailOrSite ?? "").trim().toLowerCase();
  if (!v) return "";
  if (v.includes("@")) v = v.slice(v.lastIndexOf("@") + 1);
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.+$/, "");
  if (!v.includes(".")) return "";
  /* Ours + the sign-up rule's list (lib/auth/domain.ts), so the two never disagree on e.g. zoho.com. */
  if (FREE_MAIL.has(v) || isPublicEmailDomain(v) || /^(yahoo|ymail|rocketmail)\.[a-z.]+$/.test(v)) return "";
  return v;
}

const RANK: Record<CustomerMatchReason, number> = { gstin: 0, name: 1, "email-domain": 2, typing: 3 };

/**
 * Existing customers that look like the one being typed, strongest reason first, capped.
 * `name` alone works as the old typeahead (2+ letters); `gstin` / `email` add exact matches.
 */
export function findCustomerMatches<T extends MatchableCustomer>(
  list: readonly T[],
  typed: { name?: string | null; gstin?: string | null; email?: string | null },
  limit = 5,
): CustomerMatch<T>[] {
  const g = gstinKey(typed.gstin);
  const mail = businessDomain(typed.email);
  const words = companyWords(typed.name);
  const key = words.join("");
  const raw = (typed.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const typing = raw.length >= 2;
  const rawWords = plainWords(raw);

  const out: CustomerMatch<T>[] = [];
  for (const c of list) {
    let reason: CustomerMatchReason | null = null;
    if (g && gstinKey(c.gstin) === g) reason = "gstin";
    else if (key.length >= 2 && (companyKey(c.name) === key || (!!c.display_name && companyKey(c.display_name) === key))) reason = "name";
    else if (mail && (businessDomain(c.domain) === mail || businessDomain(c.contact_email) === mail)) reason = "email-domain";
    else if (typing) {
      const have = companyWords(c.name).join(" ");
      /* Also against the full name, so a half-typed suffix ("Forza Medi Pv") keeps the hint —
         but only once something besides a legal word was typed. */
      const full = plainWords(c.name).join(" ");
      const nameHit = words.length > 0 && (words.every((w) => have.includes(w)) || rawWords.every((w) => full.includes(w)));
      const compactHit = key.length >= 2 && companyKey(c.name).includes(key);
      const domainHit = !!c.domain && c.domain.toLowerCase().includes(raw);
      if (nameHit || compactHit || domainHit) reason = "typing";
    }
    if (reason) out.push({ customer: c, reason });
  }
  /* Stable: same reason keeps the list's own (A–Z) order. */
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => RANK[a.m.reason] - RANK[b.m.reason] || a.i - b.i)
    .map(({ m }) => m)
    .slice(0, limit);
}

/** Why it matched, for the one-line hint: "Looks like X (same GSTIN) — open it". */
export function matchReasonText(reason: CustomerMatchReason): string | null {
  switch (reason) {
    case "gstin": return "same GSTIN";
    case "name": return "same company name";
    case "email-domain": return "same email domain";
    default: return null;
  }
}
