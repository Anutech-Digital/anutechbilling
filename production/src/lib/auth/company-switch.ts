/**
 * R-2476 (R-2471 slice 2) — the top-bar company switcher's logic, kept out of the component so
 * it can be tested without a browser. Spec: docs/specs/memberships.md §2.2 / §2.5.
 *
 * - `my_companies()` (SECURITY DEFINER) lists the login's ACTIVE memberships with company name,
 *   role there and which one is selected. tenants RLS hides other companies' names, so the list
 *   cannot be a plain select.
 * - `switch_company(uuid)` sets `users.tenant_id` (= the selected company) from the membership.
 *   There are no tenant/role JWT claims (spec §1): the database row is the only truth and the next
 *   request already reads the new company. What can still show the OLD company is the browser:
 *   React Query's cache and the workspace tabs (sessionStorage — record pages and half-typed drafts
 *   of the old company). `finishCompanySwitch` clears both, then loads the app fresh, so no data
 *   from the old company stays on screen.
 */
import type { QueryClient } from "@tanstack/react-query";
import { MFA_PENDING_MARKER } from "@/lib/auth/mfa-gate";
import { roleLabel } from "@/lib/auth/roles";
import { GENERIC_HOME } from "@/lib/nav";

export interface CompanyOption {
  tenantId: string;
  name: string;
  /** Role in THAT company (memberships carry their own role). */
  role: string;
  roleLabel: string;
  isCurrent: boolean;
}

interface CompanyRow {
  tenant_id: string;
  company_name: string | null;
  role: string | null;
  is_current: boolean | null;
}

type RpcResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
/** The two RPCs are newer than the generated Database type — typed here, not in database.types. */
export interface CompanySwitchClient {
  rpc(fn: "my_companies"): RpcResult<CompanyRow[]>;
  rpc(fn: "switch_company", args: { p_tenant_id: string }): RpcResult<string>;
}

export function toCompanyOptions(rows: CompanyRow[] | null | undefined): CompanyOption[] {
  return (rows ?? []).map((r) => ({
    tenantId: r.tenant_id,
    name: (r.company_name ?? "").trim() || "Unnamed company",
    role: r.role ?? "",
    roleLabel: roleLabel(r.role),
    isCurrent: r.is_current === true,
  }));
}

export async function fetchMyCompanies(client: CompanySwitchClient): Promise<CompanyOption[]> {
  const { data, error } = await client.rpc("my_companies");
  if (error) throw new Error(error.message);
  return toCompanyOptions(data);
}

/** The switcher shows only for a login with 2+ active memberships (card R-2476). */
export function shouldShowSwitcher(companies: CompanyOption[] | null | undefined): boolean {
  return (companies?.length ?? 0) >= 2;
}

export async function switchCompany(client: CompanySwitchClient, tenantId: string): Promise<void> {
  const { error } = await client.rpc("switch_company", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
}

export interface SwitchRefusal {
  message: string;
  description: string;
  action?: { label: string; href: string };
}

/**
 * §24 for a refused switch: what happened · why · what to do next (+ a button where one exists).
 * Decided by the message text the database raises (switch_company / the gateway's MFA refusal).
 */
export function describeSwitchRefusal(err: unknown): SwitchRefusal {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/two-step sign-in|authenticator app|aal2|\bmfa\b/i.test(raw) || raw.includes(MFA_PENDING_MARKER)) {
    return {
      message: "Could not switch company — two-step sign-in is not finished.",
      description: "Open the two-step sign-in page, type the 6-digit code from your authenticator app, then switch again.",
      action: { label: "Open two-step sign-in", href: "/mfa" },
    };
  }
  if (/not a member of that company|access there has ended/i.test(raw)) {
    return {
      message: "Could not switch company — your access there has ended.",
      description: "That company's owner removed you or switched you off. Ask them to invite you again from their Team page.",
    };
  }
  return {
    message: "Could not switch company.",
    description: "You are still in the same company. Check your internet connection and try again.",
  };
}

/** Workspace tabs (components/providers/workspace-tabs-provider.tsx STORAGE_KEY). */
export const WORKSPACE_TABS_STORAGE_KEY = "ros.workspace.tabs.v1";

export interface FinishSwitchDeps {
  queryClient: Pick<QueryClient, "cancelQueries" | "clear">;
  storage?: Pick<Storage, "removeItem"> | null;
  /** A full page load (window.location.assign in the app). */
  go: (href: string) => void;
}

/**
 * After switch_company succeeded: nothing of the old company may stay on screen. Stop running
 * reads, drop every cached query, forget the old company's workspace tabs, and load the app fresh
 * at the generic home (a role without /dashboard is sent to its own home, R-1837). A full load
 * also resets every in-memory provider, which router.refresh() alone would keep.
 */
export async function finishCompanySwitch({ queryClient, storage, go }: FinishSwitchDeps): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
  try {
    storage?.removeItem(WORKSPACE_TABS_STORAGE_KEY);
  } catch {
    // storage blocked: the full load below still drops every in-memory tab
  }
  go(GENERIC_HOME);
}
