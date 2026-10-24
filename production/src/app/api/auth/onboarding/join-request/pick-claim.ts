/**
 * R-858: which `tenant_domains` claim a manual join request goes to.
 *
 * Since R-858 a domain may carry several UNVERIFIED claims (the unique index covers verified rows
 * only), so `.maybeSingle()` on the domain would error and silently drop the request — even when
 * the real company is verified. The rule:
 *   - a verified claim exists → that company (there can be only one);
 *   - exactly one claim, unverified → that company (the behaviour before R-858);
 *   - several unverified claims → nobody: never guess between a company and a squatter.
 */
export interface JoinClaimRow {
  tenant_id: string;
  verified_at: string | null;
  tenants?: { name?: string } | Array<{ name?: string }> | null;
}

export function pickJoinClaim<T extends JoinClaimRow>(rows: readonly T[] | null | undefined): T | null {
  const list = rows ?? [];
  const verified = list.find((r) => r.verified_at !== null);
  if (verified) return verified;
  return list.length === 1 ? list[0] : null;
}
