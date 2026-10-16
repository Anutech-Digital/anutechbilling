/**
 * R-1417 (16 Oct 2026) — "has my company already reported this?"
 *
 * While someone types in Help → Report a problem, the tab shows up to five reports their OWN
 * company already filed that look like the same problem. Abhishek asked for matches "across
 * tenants"; Pardeep's decision (12 Oct) was own company only — another company's report text
 * is their data. The tenant limit is enforced where the rows are read (RLS on `feedback` plus an
 * explicit tenant filter in help-report-matches.tsx); this file only ranks what it is given and
 * hands back titles, never a report body.
 *
 * Matching is plain word overlap on the title — no AI call per keystroke. A report must share
 * at least two meaningful words with what was typed: one shared word ("invoice") matches half
 * the queue and is noise, not help.
 */

export const MAX_SIMILAR = 5;
/** Below two shared words a "match" is a coincidence (see header). */
const MIN_SHARED_WORDS = 2;
/** Only the start of the box is matched: an AI draft adds steps and "Expected:" lines below. */
const MATCH_CHARS = 300;

/** What the matcher needs from a `feedback` row — and all it ever returns. */
export interface ReportTitle {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

/** Words that say nothing about WHICH problem it is (English + the Hinglish people type here). */
const FILLER = new Set([
  "the", "and", "for", "but", "not", "are", "was", "were", "is", "has", "have", "had", "this", "that", "with", "from",
  "when", "then", "than", "what", "why", "how", "where", "which", "who", "can", "cannot", "can't", "does", "doesn't",
  "did", "didn't", "don't", "isn't", "wasn't", "will", "would", "should", "could", "there", "their", "they", "them",
  "its", "it's", "into", "onto", "after", "before", "also", "just", "only", "very", "some", "any", "all", "our", "your",
  "you", "page", "screen", "problem", "issue", "error", "please", "expected", "steps", "step", "click", "clicked",
  "nahi", "nhi", "raha", "rahi", "rahe", "hai", "hain", "tha", "thi", "kar", "karo", "karna", "kiya", "par",
  "pe", "mein", "aur", "bhi", "koi", "kuch", "jab", "toh", "kyu", "kyun", "kaise", "wala", "wali", "ho", "hota", "hoti",
]);

/** The meaningful words of a text: lower-case, 3+ letters, no filler, each once, in order. */
export function matchWords(text: string): string[] {
  const seen = new Set<string>();
  for (const w of text.slice(0, MATCH_CHARS).toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    const word = w.replace(/^'+|'+$/g, "");
    if (word.length < 3 || FILLER.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/** "download" and "downloading" are the same word here; "pdf" and "pdfs" too. */
const sameWord = (a: string, b: string) => a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));

/**
 * Up to MAX_SIMILAR reports whose title shares at least two words with `typed`, most shared
 * words first, newest first on a tie. Returns only id/title/status/created_at.
 */
export function findSimilarReports(typed: string, reports: readonly ReportTitle[]): ReportTitle[] {
  const want = matchWords(typed);
  if (want.length < MIN_SHARED_WORDS) return [];
  const scored: { r: ReportTitle; score: number }[] = [];
  for (const r of reports) {
    const have = matchWords(r.title);
    const score = want.filter((w) => have.some((h) => sameWord(w, h))).length;
    if (score >= MIN_SHARED_WORDS) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || b.r.created_at.localeCompare(a.r.created_at));
  return scored.slice(0, MAX_SIMILAR).map(({ r }) => ({ id: r.id, title: r.title, status: r.status, created_at: r.created_at }));
}
