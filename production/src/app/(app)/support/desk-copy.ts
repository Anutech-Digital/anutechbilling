/**
 * R-1487: the /support subtitle. "Across all workspaces" is true only for a platform admin
 * (isPlatformAdmin) — the API returns `crossTenant` for that. Every other user's list is
 * their own company's tickets (API tenant filter + RLS support_tickets_select_own_tenant),
 * so they must not be told otherwise. Unknown (still loading) reads as the narrow copy.
 */
export function supportDeskSubtitle(crossTenant: boolean | undefined): string {
  return crossTenant
    ? "Manage feedback and support queries from Tenants / Customers + internal employee bug reports across all workspaces."
    : "Manage feedback and support queries from your company's customers and team. Only your company's tickets are shown here.";
}
