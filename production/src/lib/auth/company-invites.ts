/**
 * R-2477 independent review (5 Nov 2026) — a login that already works in another company is never
 * claimed: it sees the invite in its own app and ACCEPTS it (spec docs/specs/memberships.md §6.1).
 *
 * my_company_invites()  — the signed-in login's own open invites, with the inviting company's name.
 * POST /api/team/invites/:id/accept → accept_company_invite (all checks in SQL: the invite is
 * addressed to this login, not expired, MFA done). The server's refusal text is shown unchanged
 * (CLAUDE.md §24).
 */
import { roleLabel } from "@/lib/auth/roles";

export interface CompanyInvite {
  inviteId: string;
  tenantId: string;
  companyName: string;
  role: string;
  roleLabel: string;
}

interface InviteRow {
  invite_id: string;
  tenant_id: string;
  company_name: string | null;
  role: string | null;
}

export interface CompanyInvitesClient {
  rpc: (fn: "my_company_invites") => PromiseLike<{ data: InviteRow[] | null; error: { message: string } | null }>;
}

export function toCompanyInvites(rows: InviteRow[] | null | undefined): CompanyInvite[] {
  return (rows ?? [])
    .filter((r) => !!r.invite_id && !!r.tenant_id)
    .map((r) => ({
      inviteId: r.invite_id,
      tenantId: r.tenant_id,
      companyName: r.company_name?.trim() || "A company",
      role: r.role ?? "",
      roleLabel: roleLabel(r.role),
    }));
}

export async function fetchMyInvites(client: CompanyInvitesClient): Promise<CompanyInvite[]> {
  const { data, error } = await client.rpc("my_company_invites");
  if (error) throw new Error(error.message);
  return toCompanyInvites(data);
}

export interface AcceptResult {
  companyName: string;
  role: string;
  /** The new company became the one this login works in (their old one was unusable or blank). */
  selected: boolean;
}

export async function acceptInvite(inviteId: string, fetchImpl: typeof fetch = fetch): Promise<AcceptResult> {
  const res = await fetchImpl(`/api/team/invites/${encodeURIComponent(inviteId)}/accept`, { method: "POST", cache: "no-store" });
  const body = await res.json().catch(() => null) as
    | { ok?: boolean; error?: string; companyName?: string; role?: string; selected?: boolean }
    | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? "Couldn't accept the invite. Refresh the page and try again.");
  }
  return { companyName: body.companyName ?? "the company", role: body.role ?? "", selected: !!body.selected };
}

/** What the person is told after accepting — always with the next step. */
export function acceptedMessage(r: AcceptResult): string {
  const as = r.role ? ` as ${roleLabel(r.role)}` : "";
  return r.selected
    ? `You joined ${r.companyName}${as}. It is now the company you are working in.`
    : `You joined ${r.companyName}${as}. Switch to it from the company switcher in the top bar.`;
}
