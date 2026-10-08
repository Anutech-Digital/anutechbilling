/**
 * R-357 — a new report goes to the AI queue on its own, no "Run AI Auto-Fix" press.
 *
 * Pardeep, 7 Oct 2026: "ye sab full automation par hona chahiye automatic". Until now a report
 * sat in Open until someone pressed Run AI Auto-Fix, and nothing told the reporter the AI had
 * picked it up. Three small pieces live here so the routes stay thin and testable:
 *
 *   - the workspace switch (`tenants.feedback_auto_send`, default ON),
 *   - which reports may be sent without a human (first triage, still open, not junk),
 *   - the shape of a board card id the AI worker reports back.
 *
 * Works BEFORE the migration (20261007110000_feedback_agent_claim.sql) is applied: a missing
 * column reads as "not set", so the switch is ON and nothing is claimed — today's behaviour
 * plus the automatic send.
 */

/** Board card ids look like R-357. Anything else is refused before it reaches the row. */
export const AGENT_CARD_RE = /^R-\d{1,5}$/;

/** The columns this card adds. Kept in one place so a missing-column error names them. */
export const AUTO_SEND_COLUMN = "feedback_auto_send";
export const AGENT_CARD_COLUMN = "agent_card";
export const AGENT_CLAIMED_AT_COLUMN = "agent_claimed_at";
export const AGENT_CLAIM_MIGRATION = "20261007110000_feedback_agent_claim.sql";

/** Read a column that may not exist yet (migration not applied) without a cast to any. */
export function optionalColumn(row: object | null | undefined, key: string): unknown {
  if (!row || !(key in row)) return undefined;
  return (row as Record<string, unknown>)[key];
}

/** The workspace switch. Missing column, missing row or null → ON (the card's default). */
export function isAutoSendOn(tenant: object | null | undefined): boolean {
  return optionalColumn(tenant, AUTO_SEND_COLUMN) !== false;
}

/** Was this report already taken by an AI card? Missing column → no. */
export function agentClaim(row: object | null | undefined): { card: string; claimedAt: string } | null {
  const card = optionalColumn(row, AGENT_CARD_COLUMN);
  const at = optionalColumn(row, AGENT_CLAIMED_AT_COLUMN);
  if (typeof card !== "string" || !card || typeof at !== "string" || !at) return null;
  return { card, claimedAt: at };
}

/** True when PostgREST/Postgres says a column does not exist (migration not applied). */
export function isMissingColumnError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "PGRST204" || err.code === "42703") return true;
  return /column .* (does not exist|could not find)|could not find the .* column/i.test(err.message ?? "");
}

/** Words that, alone, are a tester poking the box rather than a report. */
const JUNK_ONLY = /^(test(ing)?|asdf+|qwerty|hello|hi|hey|ok(ay)?|abc|xyz|\.+|-+|1+|123+)$/i;

export interface AutoDispatchInput {
  status: string;
  dispatchedAt: string | null;
  /** triaged_at BEFORE this triage ran — a re-triage is a human's call, not a new report. */
  triagedAtBefore: string | null;
  title: string;
  body: string;
}

/**
 * Should this report go to the AI queue without anyone pressing a button?
 * Only a report being triaged for the first time, still Open, never dispatched, with real words.
 */
export function shouldAutoDispatch(r: AutoDispatchInput): boolean {
  if (r.status !== "open") return false;
  if (r.dispatchedAt) return false;
  if (r.triagedAtBefore) return false;
  return !isJunkReport(r.body || r.title);
}

export function isJunkReport(text: string): boolean {
  const t = (text ?? "").trim();
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length < 6) return true;
  return JUNK_ONLY.test(t.replace(/[!?.\s]+$/g, ""));
}
