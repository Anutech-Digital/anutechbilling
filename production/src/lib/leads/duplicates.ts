/**
 * Lead duplicate detection — client-side, non-destructive.
 *
 * Flags likely duplicates so the operator can review and (optionally) merge
 * them. Detection is deliberately conservative — it FLAGS, it never merges on
 * its own. Two signals:
 *   • phone  — same last-10-digit number (strong signal)
 *   • company — same normalised company name, ignoring case, punctuation and
 *     common suffixes (Pvt / Ltd / Technologies …) so "Zeta Soft" and
 *     "Zeta Soft Pvt Ltd" match.
 *
 * Because the operator confirms every merge, an occasional false flag is
 * harmless (they just skip it) — so we err slightly toward catching more.
 */
import type { Lead } from "@/lib/supabase/database.types";

/** Digits only, last 10 (drops +91 / spaces / dashes). "" if not a real number. */
export function normPhone(p?: string | null): string {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

// Common Indian-SME company-name noise words. Matched only as whole words
// (\b…\b) so "soft" won't eat "Softaid".
const COMPANY_NOISE =
  /\b(pvt|private|ltd|limited|llp|inc|co|company|corp|corporation|technologies|technology|solutions|systems|services|enterprises|india|the)\b/g;

/** Lowercased, punctuation- and suffix-stripped company key. "" if too short. */
export function normCompany(c?: string | null): string {
  const key = (c ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key.length >= 3 ? key : "";
}

export type DupReason = "phone" | "company" | "both";
/** The fields the rule reads — a full Lead, or the list's slim row (S40). */
type DupLead = Pick<Lead, "id" | "company" | "contact_phone">;
export type DupMatch<T extends DupLead = Lead> = { lead: T; reason: DupReason };

export interface DuplicateIndex<T extends DupLead = Lead> {
  /** ids of leads that have at least one duplicate match. */
  flagged: Set<string>;
  /** leadId → the other leads it duplicates (with the reason). */
  matchesOf: Map<string, DupMatch<T>[]>;
}

/**
 * Build the duplicate index across the whole lead set. O(n) grouping, then
 * pairwise within each same-key bucket.
 */
export function computeDuplicates<T extends DupLead>(leads: readonly T[]): DuplicateIndex<T> {
  const byPhone = new Map<string, string[]>();
  const byCompany = new Map<string, string[]>();
  const leadById = new Map<string, T>();

  for (const l of leads) {
    leadById.set(l.id, l);
    const p = normPhone(l.contact_phone);
    if (p) {
      const arr = byPhone.get(p); if (arr) arr.push(l.id); else byPhone.set(p, [l.id]);
    }
    const c = normCompany(l.company);
    if (c) {
      const arr = byCompany.get(c); if (arr) arr.push(l.id); else byCompany.set(c, [l.id]);
    }
  }

  const matchesOf = new Map<string, DupMatch<T>[]>();
  const flagged = new Set<string>();

  const link = (aId: string, bId: string, reason: "phone" | "company") => {
    if (aId === bId) return;
    const arr = matchesOf.get(aId) ?? [];
    const existing = arr.find((m) => m.lead.id === bId);
    if (existing) {
      if (existing.reason !== reason) existing.reason = "both";
    } else {
      const b = leadById.get(bId);
      if (b) arr.push({ lead: b, reason });
    }
    matchesOf.set(aId, arr);
    flagged.add(aId);
  };

  const walk = (buckets: Map<string, string[]>, reason: "phone" | "company") => {
    for (const ids of buckets.values()) {
      if (ids.length < 2) continue;
      for (const a of ids) for (const b of ids) link(a, b, reason);
    }
  };
  walk(byPhone, "phone");
  walk(byCompany, "company");

  return { flagged, matchesOf };
}
