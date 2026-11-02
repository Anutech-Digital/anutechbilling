/**
 * R-2028 (1) — which of the tenant's own catalogue rows might a hand-typed quote line be?
 *
 * A line typed by hand ("Google Workspace Business Starter (1 year)") carries no item_id and
 * cost 0, so the quote cannot judge margin and goes to the owner for approval. The quote
 * builder shows the best 1–3 rows from this list under such a line ("Is this …? Use cost ₹X"),
 * and one click links the row. It only SUGGESTS — nothing is linked without that click.
 *
 * Rules (word match, not a spelling guess):
 *   1. the confident single pick the lead prefill already uses (matchCatalogItemForPlan) first;
 *   2. then rows sharing the typed PRODUCT words (google, workspace, 365 …) — a tier word alone
 *      ("standard") never picks a product;
 *   3. a row of ANOTHER tier is never offered (typed "Starter" ≠ "Standard");
 *   4. words that never say which product it is — "business", "annual", "(1 year)", "seats",
 *      "licence" — are ignored on both sides;
 *   5. at least half of the words on both sides together must be shared.
 */
import { matchCatalogItemForPlan } from "./lead-plan-match";

const TIER_WORDS = new Set(["enterprise", "plus", "standard", "starter", "basic", "premium", "premier", "professional"]);

const IGNORED = new Set([
  "business", "annual", "annually", "yearly", "monthly", "flexible", "flex", "plan", "commitment", "edition",
  "subscription", "year", "years", "yr", "yrs", "month", "months", "mo", "seat", "seats", "user", "users",
  "licence", "license", "licences", "licenses", "per", "for", "the", "of", "and", "with", "a", "an", "x",
]);

const ALIASES: Record<string, readonly string[]> = {
  gw: ["google", "workspace"],
  gsuite: ["google", "workspace"],
  m365: ["microsoft", "365"],
  ms365: ["microsoft", "365"],
  o365: ["microsoft", "365"],
};

/** Words that say which product/tier it is. A lone number ("1" of "(1 year)") never does, but "365" does. */
function productWords(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .flatMap((w) => ALIASES[w] ?? [w])
      .filter((w) => !IGNORED.has(w) && !(/^\d+$/.test(w) && w.length < 3)),
  );
}

export function suggestCatalogMatches<T extends { name: string | null }>(
  catalog: readonly T[],
  typedName: string | null | undefined,
  max = 3,
): T[] {
  const wanted = productWords(typedName);
  if (![...wanted].some((w) => !TIER_WORDS.has(w))) return [];
  const wantedTiers = [...wanted].filter((w) => TIER_WORDS.has(w));

  const scored: Array<{ row: T; score: number; index: number }> = [];
  catalog.forEach((row, index) => {
    if (!row.name?.trim()) return;
    const have = productWords(row.name);
    if (have.size === 0) return;
    const haveTiers = [...have].filter((w) => TIER_WORDS.has(w));
    if (wantedTiers.length > 0 && haveTiers.length > 0 && !haveTiers.some((t) => wantedTiers.includes(t))) return;
    const shared = [...wanted].filter((w) => have.has(w));
    if (!shared.some((w) => !TIER_WORDS.has(w))) return;
    const union = new Set([...wanted, ...have]).size;
    const score = shared.length / union;
    if (score < 0.5) return;
    scored.push({ row, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const out: T[] = [];
  const confident = matchCatalogItemForPlan(catalog, typedName);
  /* The confident pick passes the same tier rule — it never brings back a different tier. */
  if (confident && scored.some((s) => s.row === confident)) out.push(confident);
  for (const s of scored) {
    if (out.length >= max) break;
    if (!out.includes(s.row)) out.push(s.row);
  }
  return out.slice(0, max);
}
