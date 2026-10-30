/**
 * R-2110 (GP-01, goal G-PERSONAL): what kind of workspace a tenant is.
 *
 *   business  every workspace that exists today — GST invoices, quotes, CRM, the books.
 *   personal  one person's own money + digital assets, no company / GSTIN (G-PERSONAL).
 *
 * The value lives in tenants.workspace_kind (migration 20261030004100_gp01_workspace_kind):
 * NOT NULL DEFAULT 'business', CHECK (personal|business), and platform-owned — the R-720 guard
 * refuses a change from any request role, so only the server (admin client / service_role)
 * sets it. A browser can never turn its business into a personal workspace or back.
 *
 * Pure: no I/O. A missing column (an older DB), null or a stray value reads 'business', the
 * kind every existing workspace has, so nothing that reads this can hide business screens by
 * accident.
 */

export const WORKSPACE_KINDS = ["personal", "business"] as const;

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const DEFAULT_WORKSPACE_KIND: WorkspaceKind = "business";

export function parseWorkspaceKind(value: unknown): WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value)
    ? (value as WorkspaceKind)
    : DEFAULT_WORKSPACE_KIND;
}

export function isPersonalWorkspace(value: unknown): boolean {
  return parseWorkspaceKind(value) === "personal";
}

/**
 * R-2175: is this signed-in person a PERSONAL session? Same either-one rule as the data gateway
 * (server/postgrest/gateway-limits.ts gatewayRole, R-2125): users.role 'personal' OR the
 * tenant's workspace_kind 'personal'. The app shell uses it to skip business-only reads (nav
 * badges, attendance, tasks, leads, contacts, subscriptions) a personal workspace never has and
 * the gateway refuses. Unknown / loading / signed out → false (callers wait for identity first).
 */
export function isPersonalSession(who: { role?: string | null; workspaceKind?: unknown } | null | undefined): boolean {
  if (!who) return false;
  return who.role === "personal" || isPersonalWorkspace(who.workspaceKind);
}
