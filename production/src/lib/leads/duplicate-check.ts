/**
 * The Add-lead form's duplicate warning — the client half of find_lead_duplicates()
 * (R-072, migration 20260930200000). Pure, tested (duplicate-check.test.ts).
 *
 * Before R-072 the form asked list_leads' dup_like, which matched phone and company only: the
 * same customer re-typed with a new phone but the same email or GSTIN became a second lead.
 * The RPC now matches four keys, strongest first — GSTIN, email, phone, company — and returns
 * the owner's name so the warning can say whose lead it already is.
 *
 * Each key here is the TS twin of the SQL key function, and a key that normalises to "" is
 * never sent (so a half-typed GSTIN or a two-letter company asks nothing):
 *   phone   → duplicates.ts#normPhone     = lead_norm_phone
 *   company → duplicates.ts#normCompany   = lead_norm_company ("pvt ltd", punctuation out)
 *   email   → normEmail                   = lead_norm_email
 *   GSTIN   → normGstin                   = lead_norm_gstin
 *
 * It WARNS, never blocks: the form saves whatever the rep decides.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { normCompany, normPhone } from "@/lib/leads/duplicates";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";

/** lead_norm_email: lower + trim; "" unless there is an "@" after the first character. */
export function normEmail(e?: string | null): string {
  const t = (e ?? "").trim();
  return t.indexOf("@") > 0 ? t.toLowerCase() : "";
}

/** lead_norm_gstin: upper, whitespace out; "" unless exactly 15 characters. */
export function normGstin(g?: string | null): string {
  const t = (g ?? "").replace(/\s/g, "");
  return t.length === 15 ? t.toUpperCase() : "";
}

export interface DupCheckKeys { phone: string; email: string; gstin: string; company: string }

/**
 * What the form sends: each field as typed, or "" when its key is empty. Sending the typed
 * text (not the key) keeps one normaliser — the server's — authoritative; the TS twins only
 * decide whether there is anything worth asking.
 */
export function dupCheckKeys(v: {
  phone?: string | null; email?: string | null; gstin?: string | null; company?: string | null;
}): DupCheckKeys {
  return {
    phone:   normPhone(v.phone) ? (v.phone ?? "").trim() : "",
    email:   normEmail(v.email) ? (v.email ?? "").trim() : "",
    gstin:   normGstin(v.gstin) ? (v.gstin ?? "").trim() : "",
    company: normCompany(v.company) ? (v.company ?? "").trim() : "",
  };
}

export function hasDupKeys(k: DupCheckKeys): boolean {
  return k.phone !== "" || k.email !== "" || k.gstin !== "" || k.company !== "";
}

/** One row of find_lead_duplicates(). */
export interface LeadDuplicate {
  id: string;
  company: string;
  contact_name: string | null;
  stage: string;
  is_junk: boolean;
  owner_id: string | null;
  owner_name: string | null;
  /** Strongest first: gstin, email, phone, company. */
  matched_on: string[];
  created_at: string;
}

/**
 * The one the warning names: the strongest match (the RPC's order), skipping — for an
 * existing customer — their closed (won / lost) leads, which are history, not a duplicate: a
 * new need from them is exactly what this lead is.
 */
export function pickDuplicate(rows: readonly LeadDuplicate[] | undefined, forCustomer: boolean): LeadDuplicate | null {
  return (rows ?? []).find((d) => !(forCustomer && (d.stage === "won" || d.stage === "lost"))) ?? null;
}

const MATCH_LABEL: Record<string, string> = { gstin: "GSTIN", email: "email", phone: "phone", company: "company name" };

/** R-1821: what the data gateway sends a role that sees masked contacts instead of matched_on. */
export const COARSE_MATCH = "possible";

/** "Ye pehle se hai: Acme (Quote Sent, Ravi)" — owner "koi owner nahi" when unassigned. */
export function duplicateWarning(d: LeadDuplicate): { title: string; matched: string } {
  const stage = STAGE_LABEL[d.stage as Lead["stage"]] ?? d.stage;
  const owner = d.owner_name?.trim() || (d.owner_id ? "owner" : "unassigned");
  const name = d.company.trim() || d.contact_name?.trim() || d.id;
  return {
    title: `Already exists: ${name} (${stage}${d.is_junk ? ", junk" : ""}, ${owner})`,
    matched: d.matched_on.includes(COARSE_MATCH)
      ? "Possible duplicate — ask the owner or a manager to compare the details"
      : `Same ${d.matched_on.map((m) => MATCH_LABEL[m] ?? m).join(" + ")}`,
  };
}
