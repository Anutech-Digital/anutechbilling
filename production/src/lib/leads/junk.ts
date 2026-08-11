/**
 * Junk-lead heuristic — flags a lead that LOOKS like spam/fake so the operator
 * can review + mark it (we never auto-mark; the human decides). Deliberately
 * conservative to avoid false positives on real (if sparse) leads.
 *
 * Signals:
 *   • no phone AND no email — nothing to act on
 *   • company too short to be real
 *   • obvious test/placeholder text
 *   • gibberish (same char repeated, 1–2 letters + digits)
 */
import type { Lead } from "@/lib/supabase/database.types";

const JUNK_WORDS = /\b(test|testing|asdf|qwerty|dummy|sample|placeholder|demo123|xxx+)\b/i;
const GIBBERISH  = /^(.)\1{3,}$|^[a-z]{1,2}\d{2,}$/i;

export type JunkVerdict = { suspect: boolean; reason: string };

export function looksLikeJunk(
  l: Pick<Lead, "company" | "contact_name" | "contact_email" | "contact_phone">,
): JunkVerdict {
  const company = (l.company ?? "").trim();
  const name    = (l.contact_name ?? "").trim();
  const hasPhone = !!(l.contact_phone ?? "").trim();
  const hasEmail = !!(l.contact_email ?? "").trim();

  if (!hasPhone && !hasEmail) return { suspect: true, reason: "No phone or email" };
  if (company.length < 2)      return { suspect: true, reason: "No real company name" };
  if (JUNK_WORDS.test(company) || JUNK_WORDS.test(name)) return { suspect: true, reason: "Test / placeholder text" };
  if (GIBBERISH.test(company.replace(/\s/g, "")))        return { suspect: true, reason: "Looks like gibberish" };
  return { suspect: false, reason: "" };
}
