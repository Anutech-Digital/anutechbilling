/**
 * R-2477 independent review (5 Nov 2026) + R-2517 (9 Nov 2026) — a login that already works in
 * another company is never claimed: it ACCEPTS the invite itself, and (R-2517) only through the
 * single-use link in the invite EMAIL — proof of the invited mailbox, not only of the login. Spec:
 * docs/specs/memberships.md §6.1 / §6.3.
 *
 * my_company_invites()            — the signed-in login's own open invites (company, role, the
 *                                   address the email went to, whether it has a link) → the banner,
 *                                   which has NO Accept button.
 * POST /api/team/invites/lookup   → company_invite_by_token: what the emailed link is for.
 * The token arrives in the link's FRAGMENT (/invites/accept#token=…, never sent to a server) and is
 * kept in this tab's sessionStorage while the person signs in (INVITE_TOKEN_KEY).
 * POST /api/team/invites/accept   → accept_company_invite_by_token (all checks in SQL).
 * The server's refusal text is shown unchanged (CLAUDE.md §24).
 */
import { roleLabel } from "@/lib/auth/roles";

export interface CompanyInvite {
  inviteId: string;
  tenantId: string;
  companyName: string;
  role: string;
  roleLabel: string;
  /** The address the invite email was sent to (the login's sign-in address). */
  email: string;
  /** False for an invite made without an emailed link — it can never be accepted; ask again. */
  hasLink: boolean;
}

interface InviteRow {
  invite_id: string;
  tenant_id: string;
  company_name: string | null;
  role: string | null;
  email?: string | null;
  has_link?: boolean | null;
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
      email: r.email?.trim() ?? "",
      hasLink: r.has_link === true,
    }));
}

export async function fetchMyInvites(client: CompanyInvitesClient): Promise<CompanyInvite[]> {
  const { data, error } = await client.rpc("my_company_invites");
  if (error) throw new Error(error.message);
  return toCompanyInvites(data);
}

/** The banner line's next step — the emailed link is the only way to accept. */
export function inviteNextStep(inv: Pick<CompanyInvite, "companyName" | "email" | "hasLink">): string {
  if (!inv.hasLink) return `Ask ${inv.companyName} to invite you again — you will get an email with a link to accept.`;
  return inv.email
    ? `To accept, open the link we emailed to ${inv.email}.`
    : "To accept, open the link in the invite email.";
}

export type InviteLinkState = "open" | "blocked" | "other_login" | "used" | "expired" | "not_found";

export interface InviteLinkInfo {
  state: InviteLinkState;
  /** state 'blocked': why the accept would be refused (the server's words, with the next step). */
  reason: string | null;
  companyName: string | null;
  role: string | null;
  email: string | null;
  signedInAs: string | null;
}

/**
 * A refusal or a lost request, in words the person can act on. `signedOut` → show Sign in;
 * `needsMfa` → two-step sign-in is not finished (the middleware answers 401 for that too, so a
 * 401 alone does not mean signed out).
 */
export class InviteLinkError extends Error {
  constructor(message: string, readonly signedOut = false, readonly needsMfa = false) { super(message); }
}

const MFA_WORDS = /two-step|authenticator app|second sign-in step/i;

async function postToken<T>(path: string, token: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) {
    const msg = body?.error ?? "Couldn't open the invite. Refresh the page and try again.";
    const needsMfa = MFA_WORDS.test(msg);
    throw new InviteLinkError(msg, res.status === 401 && !needsMfa, needsMfa);
  }
  return body;
}

export async function lookupInviteLink(token: string, fetchImpl: typeof fetch = fetch): Promise<InviteLinkInfo> {
  const b = await postToken<Partial<InviteLinkInfo>>("/api/team/invites/lookup", token, fetchImpl);
  return {
    state: (b.state ?? "not_found") as InviteLinkState,
    reason: b.reason ?? null,
    companyName: b.companyName ?? null,
    role: b.role ?? null,
    email: b.email ?? null,
    signedInAs: b.signedInAs ?? null,
  };
}

export interface AcceptResult {
  /** The joined company (null only if an older server did not say). */
  tenantId: string | null;
  companyName: string;
  role: string;
  /** The new company became the one this login works in (their old one was unusable or blank). */
  selected: boolean;
}

export async function acceptInviteLink(token: string, fetchImpl: typeof fetch = fetch): Promise<AcceptResult> {
  const b = await postToken<{ ok?: boolean; tenantId?: string | null; companyName?: string; role?: string; selected?: boolean }>(
    "/api/team/invites/accept", token, fetchImpl);
  if (!b.ok) throw new InviteLinkError("Couldn't accept the invite. Refresh the page and try again.");
  return { tenantId: b.tenantId ?? null, companyName: b.companyName ?? "the company", role: b.role ?? "", selected: !!b.selected };
}

/** sessionStorage key: the emailed token survives Sign in / two-step sign-in in this tab. */
export const INVITE_TOKEN_KEY = "ros.invite-accept.token.v1";

/** The token from the address bar: #token=… (the email link), or ?token=… (older links). */
export function inviteTokenFromLocation(hash: string, search: string): string {
  const fromHash = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  const fromQuery = new URLSearchParams(search).get("token");
  return (fromHash ?? fromQuery ?? "").trim();
}

/** What the person is told after accepting — always with the next step. */
export function acceptedMessage(r: AcceptResult): string {
  const as = r.role ? ` as ${roleLabel(r.role)}` : "";
  return r.selected
    ? `You joined ${r.companyName}${as}. It is now the company you are working in.`
    : `You joined ${r.companyName}${as}. Switch to it from the company switcher in the top bar.`;
}

/** The accept page's words for a link that cannot be accepted (state ≠ open). */
export function inviteLinkStateMessage(info: Pick<InviteLinkInfo, "state" | "reason" | "companyName" | "email" | "signedInAs">): string {
  const company = info.companyName ?? "the company";
  switch (info.state) {
    case "blocked":
      return info.reason ?? `This invite from ${company} cannot be accepted any more. Ask them to invite you again.`;
    case "other_login":
      return `This invite was sent to ${info.email ?? "another address"}, but you are signed in as ${info.signedInAs ?? "another login"}. Sign out, sign in with ${info.email ?? "the invited address"}, then open the link again.`;
    case "used":
      return `This invite link was already used. If you joined ${company}, pick it from the company switcher in the top bar.`;
    case "expired":
      return `This invite from ${company} has expired. Ask them to invite you again.`;
    case "not_found":
      return "This invite link is not valid any more (the company sent a newer invite or withdrew it). Open the newest invite email, or ask the company to invite you again.";
    default:
      return "";
  }
}
