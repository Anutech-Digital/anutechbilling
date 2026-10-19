/**
 * Which catalogue row is a lead's plan? (moved out of quote-builder.tsx for R-388)
 *
 * The lead prefill, the late-catalogue cost backfill and the lead card all use this, so
 * they agree on the row. Lead plans from the buy page are slugs ("google-workspace-standard");
 * catalogue names use spaces ("Google Workspace Business Standard"), so both are normalised.
 *
 * Order, first hit wins:
 *   1. exact name;
 *   2. substring — only when the plan names a product, not just a tier word;
 *   3. product FAMILY first, then tier (R-1667): every word of the plan (aliases like
 *      "gw" / "m365" spelled out, filler like "business" / "annual" dropped) must appear in
 *      the row's name. Several rows → the one with the fewest extra words, and only when
 *      that is a single row. A plan that is ONLY a tier word must match exactly one row.
 *
 * R-1667 (staging, 19 Oct 2026): step 3 used to be "first row containing the tier word",
 * so "Google Workspace Standard" became "Google Voice Standard" (₹9,600 instead of
 * ₹12,960) because Voice sat earlier in the catalogue. No confident match now returns
 * undefined; the caller leaves the line empty and says so, rather than guessing a price.
 */
const normalize = (s: string) => s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

const TIER_WORDS = new Set(["enterprise", "plus", "standard", "starter", "basic", "premium", "premier", "professional"]);

/** Words that never say WHICH product it is. */
const FILLER = new Set([
  "business", "annual", "yearly", "monthly", "flexible", "flex", "plan", "commitment", "edition", "subscription",
]);

/** Short names spelled out, so "gw-standard" and "m365-business-standard" find their family. */
const ALIASES: Record<string, readonly string[]> = {
  gw: ["google", "workspace"],
  gsuite: ["google", "workspace"],
  m365: ["microsoft", "365"],
  ms365: ["microsoft", "365"],
  o365: ["microsoft", "365"],
};

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .flatMap((w) => ALIASES[w] ?? [w]);
}

export function matchCatalogItemForPlan<T extends { name: string | null }>(
  catalog: readonly T[],
  plan: string | null | undefined,
): T | undefined {
  const target = plan ? normalize(plan) : "";
  if (!target) return undefined;

  const name = (c: T) => normalize(c.name ?? "");

  const exact = catalog.find((c) => name(c) === target);
  if (exact) return exact;

  const wanted = [...new Set(words(target).filter((w) => !FILLER.has(w)))];
  if (wanted.length === 0) return undefined;
  const namesAProduct = wanted.some((w) => !TIER_WORDS.has(w));

  if (namesAProduct) {
    const sub = catalog.find((c) => {
      const n = name(c);
      return n !== "" && (n.includes(target) || target.includes(n));
    });
    if (sub) return sub;
  }

  const candidates = catalog
    .map((c) => ({ c, have: new Set(words(c.name ?? "").filter((w) => !FILLER.has(w))) }))
    .filter(({ have }) => have.size > 0 && wanted.every((w) => have.has(w)));
  if (candidates.length === 1) return candidates[0].c;
  if (candidates.length === 0 || !namesAProduct) return undefined;

  const scored = candidates.map(({ c, have }) => ({ c, extra: have.size - wanted.length }));
  const fewest = Math.min(...scored.map((e) => e.extra));
  const best = scored.filter((e) => e.extra === fewest);
  return best.length === 1 ? best[0].c : undefined;
}
