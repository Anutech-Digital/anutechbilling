/**
 * Which catalogue row is a lead's plan? (moved out of quote-builder.tsx for R-388)
 *
 * The lead prefill and the late-catalogue cost backfill must agree on the row, so the
 * match lives in one place. Tries exact name, then substring, then a tier keyword.
 * Lead plans from the buy page are slugs ("google-workspace-standard"); catalogue names
 * use spaces ("Google Workspace Standard"), so both are normalised first.
 */
const normalize = (s: string) => s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

const TIER_KEYWORDS = ["enterprise", "plus", "standard", "starter"] as const;

export function matchCatalogItemForPlan<T extends { name: string | null }>(
  catalog: readonly T[],
  plan: string | null | undefined,
): T | undefined {
  const target = plan ? normalize(plan) : "";
  if (!target) return undefined;

  const name = (c: T) => normalize(c.name ?? "");

  const exact = catalog.find((c) => name(c) === target);
  if (exact) return exact;

  const sub = catalog.find((c) => {
    const n = name(c);
    return n !== "" && (n.includes(target) || target.includes(n));
  });
  if (sub) return sub;

  const tierWord = TIER_KEYWORDS.find((k) => target.includes(k));
  return tierWord ? catalog.find((c) => name(c).includes(tierWord)) : undefined;
}
