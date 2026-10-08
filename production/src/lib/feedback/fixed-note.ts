/**
 * R-356 (7 Oct 2026) — reading what the AI wrote when it fixed a report, and noticing the
 * moment a report becomes fixed while the page is open.
 *
 * /api/agent/feedback-fixed stores one free-text `resolution_note` plus `resolved_at`. The
 * worker prompt writes it as "AI ne theek kiya: R-354 (279cb0d2) - <what changed>. Staging
 * par ... Tab browser test." — so the card id and commit are pulled out of that note
 * rather than stored in new columns. A note that does not follow the shape still shows,
 * word for word; nothing here hides text it cannot parse.
 */

export interface FixedNote {
  /** Board card id, e.g. "R-354", or null when the note names none. */
  card: string | null;
  /** Short commit sha (first 8 chars), or null. */
  commit: string | null;
  /** The note without the "AI ne theek kiya: R-xxx (sha) - " lead-in. Never empty when the note is not. */
  text: string;
}

const CARD_RE = /\bR-\d{2,5}\b/;
/* A sha in brackets first — "(279cb0d2)" is how the prompt writes it — then a bare one.
   Bare matches need at least one digit AND one a–f letter so "deadline" / "12345678"
   are not mistaken for commits. */
const SHA_IN_BRACKETS_RE = /\(([0-9a-f]{7,40})\)/i;
const BARE_SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
const LEAD_IN_RE = /^\s*AI ne theek kiya\s*:?\s*(R-\d{2,5})?\s*(\([0-9a-f]{7,40}\))?\s*[-–—:]?\s*/i;

export function parseFixedNote(note: string | null | undefined): FixedNote {
  const raw = (note ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { card: null, commit: null, text: "" };
  const card = CARD_RE.exec(raw)?.[0] ?? null;
  const sha = SHA_IN_BRACKETS_RE.exec(raw)?.[1] ?? BARE_SHA_RE.exec(raw)?.[0] ?? null;
  const stripped = raw.replace(LEAD_IN_RE, "").trim();
  return {
    card,
    commit: sha ? sha.slice(0, 8).toLowerCase() : null,
    text: stripped || raw,
  };
}

export type StatusById = Record<string, string>;

/**
 * Report ids that were NOT fixed in `prev` and are fixed in `next`. `prev === null` is the
 * first load — nothing "just" changed then, so nothing is announced. An id that is new in
 * `next` (filed and fixed between two polls) counts as just fixed too.
 */
export function newlyFixedIds(prev: StatusById | null, next: StatusById): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const [id, status] of Object.entries(next)) {
    if (status === "fixed" && prev[id] !== "fixed") out.push(id);
  }
  return out;
}
