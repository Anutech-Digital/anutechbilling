/**
 * Team — real teammate management (migration 0073).
 *
 * An owner invites a teammate by email + role. The invite pre-authorizes that
 * email: when they first sign in with Google, the OAuth callback finds the
 * invite and adds them to THIS tenant (instead of creating a new empty one).
 *
 * This is also how a second Google account (e.g. the Google reseller-admin
 * info@…) joins the tenant so it can run the live "Sync from Google".
 *
 * Security: team_invites is owner-only via RLS; the unique index on lower(email)
 * means an email can belong to at most one tenant's invite (no ambiguity).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SendResetLinkButton } from "@/components/features/team/send-reset-link-button";
import { SetTempPasswordButton, TempPasswordField, TempPasswordReveal } from "@/components/features/team/set-temp-password-button";
import { canSetTempPassword, checkTypedTempPassword } from "@/lib/auth/temp-password";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { FAB } from "@/components/ui/fab";
import { KPI } from "@/components/shared/kpi";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { eligibleManagers } from "@/lib/team/visibility";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { PendingJoinRequestsCard } from "@/components/features/team/pending-join-requests-card";
import { ClaimColleagueCard } from "@/components/features/team/claim-colleague-card";
import { INVITABLE_ROLES, ROLE_LABEL, type InvitableRole } from "@/lib/auth/roles";

/* Role vocabulary comes from roles.ts, not from here. This file used to carry its
   own ROLES list and ROLE_LABEL map — a fourth description of roles alongside the
   union, the nav gates and the permission matrix. The visible cost was on this very
   page: the Claim-a-colleague card offered "sales_senior" while the table below it
   said "Sales Senior". roles.ts already exists because two disagreeing role unions
   caused a bug once; this is the same mistake in a smaller font. */
type Role = InvitableRole;
const ROLES: readonly Role[] = INVITABLE_ROLES;
const ROLE_TONE: Record<Role, "success" | "info" | "muted" | "warning"> = {
  owner: "info", manager: "info", sales: "success", sales_senior: "info",
  billing: "success", accountant: "warning", delivery: "info", support: "muted",
};

interface Member { id: string; full_name: string | null; email: string | null; role: Role; initials: string | null; color: string | null; is_active: boolean | null; can_view_deals: boolean | null; manager_id: string | null; gets_new_leads: boolean | null; }
interface Invite { id: string; email: string; role: Role; created_at: string; }

export default function TeamPage() {
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const { data: members = [] } = useQuery({
    queryKey: ["team", "members"],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        /* manager_id is safe to name here: it is LIVE in production, verified 18 Aug 2026.
           Naming a column that does not exist makes PostgREST reject the whole request
           (PGRST201) — the failure that once left the sidebar reading "Loading…" for ever. */
        .select("id, full_name, email, role, initials, color, is_active, can_view_deals, manager_id, gets_new_leads")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["team", "invites"],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("team_invites")
        .select("id, email, role, created_at")
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Invite[];
    },
    enabled: isOwner,
  });

  const removeInvite = useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("team_invites").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team", "invites"] }); toast.success("Invite removed"); },
    onError: (e) => toastError(e, { fallback: "Couldn't remove the invite." }),
  });

  const updateMember = useMutation({
    mutationFn: async (input: { id: string; patch: { role?: Role; can_view_deals?: boolean; manager_id?: string | null; gets_new_leads?: boolean } }) => {
      const supabase = createClient();
      const { error } = await supabase.from("users").update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["team", "members"] }); toast.success("Member updated"); },
    onError: (e) => toastError(e, { fallback: "Couldn't update this member." }),
  });

  const owners = members.filter((m) => m.role === "owner").length;

  /* The shape src/lib/team/visibility.ts reasons in. No useMemo: this list is a handful of
     people, and a hook added below a conditional return is how the last rules-of-hooks
     error got in. */
  const tree = members.map((m) => ({ id: m.id, role: m.role, managerId: m.manager_id }));
  const nameOf = (id: string) => {
    const found = members.find((m) => m.id === id);
    return found?.full_name ?? found?.email ?? "Unknown";
  };

  /* An invite is only marked accepted when the OAuth callback itself performs the
     join. A users row created any other way — a hand-edited row, a claim through
     the RPC — leaves the invite open forever, so the same person shows up twice:
     once as an active member and once as "not joined yet", with the KPI counting
     them as still pending.
     Measured on this workspace: ranjeet@anutech.in is a member AND a pending
     invite, so "Pending invites 4" was really 3. Split the list so the stale ones
     are visibly stale and can be cleared, instead of quietly inflating a number. */
  const memberEmails = new Set(
    members.map((m) => (m.email ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const staleInvites  = invites.filter((i) => memberEmails.has(i.email.trim().toLowerCase()));
  const openInvites   = invites.filter((i) => !memberEmails.has(i.email.trim().toLowerCase()));

  return (
    <div className="mx-auto max-w-[1500px] px-4 pb-20 pt-6 md:px-6 md:pt-7 lg:px-8">
      <div className="mb-6 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">System</p>
          <h1 className="font-serif text-3xl text-ink md:text-4xl">Team</h1>
          <p className="mt-1 text-sm text-ink-3">Invite teammates, assign roles, manage access</p>
        </div>
        {isOwner && (
          <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>Invite member</Button>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KPI label="Members" value={members.length} icon="users" />
        {/* openInvites, not invites — someone already inside is not pending. */}
        <KPI label="Pending invites" value={openInvites.length} icon="mail" />
        <KPI label="Owners" value={owners} icon="award" />
        <KPI label="Active" value={members.filter((m) => m.is_active !== false).length} icon="check_circle" />
      </div>

      {/* People waiting on a decision, and people who fell outside the workspace
          entirely. Both are above the member table because both are states where
          somebody is currently locked out — the member list can wait. */}
      <PendingJoinRequestsCard isOwner={isOwner} />
      <ClaimColleagueCard isOwner={isOwner} />

      {/* Desktop / tablet — table (unchanged) */}
      {isOwner && (
        /* Says what "Reports to" does and — the part that matters — what it does not do.
           A reporting line that looks like a permission is how somebody concludes peer
           isolation is finished. The database wall is a separate, deliberate switch. */
        <p className="mb-3 text-2xs leading-snug text-ink-3">
          <span className="font-medium text-ink-2">Reports to</span> builds the reporting tree.
          It decides who appears under <span className="font-medium">Team view</span> on Leads and
          Quotes — a manager sees their reports, a rep sees only themselves.{" "}
          {/* An explicit space, not just the span's ml-1: the margin is visual only, so a
              screen reader would otherwise read "themselves.It filters". */}
          <span className="text-amber-ink">
            It filters what a screen shows; it does not yet stop a teammate reaching a record
            directly.
          </span>
        </p>
      )}

      <Card flush className="hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Member</th>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Email</th>
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Role</th>
                {isOwner && <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Reports to</th>}
                {isOwner && <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Deals access</th>}
                {isOwner && <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3" title="New website, WhatsApp and IndiaMART leads are shared in turn between the ticked people">New leads</th>}
                <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Status</th>
                {isOwner && <th className="p-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-3">Password</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar initials={m.initials ?? "?"} color={(m.color as never) ?? "slate"} size="sm" />
                      <p className="font-medium text-ink">{m.full_name ?? "—"}{m.id === me?.userId && <span className="text-ink-3 font-normal"> (you)</span>}</p>
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-ink-2">{m.email}</td>
                  <td className="p-3">
                    {isOwner && m.id !== me?.userId ? (
                      <select
                        aria-label={`Role for ${m.full_name ?? m.email}`}
                        value={m.role}
                        onChange={(e) => updateMember.mutate({ id: m.id, patch: { role: e.target.value as Role } })}
                        className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : (
                      <Badge kind={ROLE_TONE[m.role] ?? "muted"}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                    )}
                  </td>
                  {isOwner && (
                    <td className="p-3">
                      <select
                        aria-label={`Who ${m.full_name ?? m.email ?? "this member"} reports to`}
                        value={m.manager_id ?? ""}
                        onChange={(e) => updateMember.mutate({ id: m.id, patch: { manager_id: e.target.value || null } })}
                        className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                      >
                        {/* Empty is a real answer, not a missing one — somebody has to be at
                            the top of the tree, and "Nobody" is what that looks like. */}
                        <option value="">— Nobody (top of tree) —</option>
                        {eligibleManagers({ id: m.id, role: m.role, managerId: m.manager_id }, tree).map((u) => (
                          <option key={u.id} value={u.id}>{nameOf(u.id)}</option>
                        ))}
                      </select>
                    </td>
                  )}
                  {isOwner && (
                    <td className="p-3">
                      {m.role === "sales" ? (
                        <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(m.can_view_deals)}
                            onChange={(e) => updateMember.mutate({ id: m.id, patch: { can_view_deals: e.target.checked } })}
                            className="rounded border-hairline"
                          />
                          Can view deals
                        </label>
                      ) : (m.role === "owner" || m.role === "sales_senior") ? (
                        <span className="text-2xs text-emerald">Full access</span>
                      ) : (
                        <span className="text-2xs text-ink-3">—</span>
                      )}
                    </td>
                  )}
                  {isOwner && (
                    <td className="p-3">
                      <NewLeadsToggle member={m} onChange={(on) => updateMember.mutate({ id: m.id, patch: { gets_new_leads: on } })} />
                    </td>
                  )}
                  <td className="p-3"><Badge kind={m.is_active === false ? "muted" : "success"} dot>{m.is_active === false ? "Inactive" : "Active"}</Badge></td>
                  {/* Owner-side recovery. "Send reset link" is a PUBLIC Supabase call and grants
                      nothing new. "Set temporary password" (R-391) does let the owner know a
                      password for a moment, so it is offered only where the server allows it
                      (not another owner, not yourself), and the member must pick their own at
                      the next sign-in. The server re-checks all of it. */}
                  {isOwner && (
                    <td className="p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <SendResetLinkButton email={m.email} />
                        {canSetTempPassword(m, me?.userId) && (
                          <SetTempPasswordButton memberId={m.id} name={m.full_name ?? m.email ?? "this teammate"} />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}

              {/* Pending invites (owner only). Stale ones last, and labelled —
                  an invite for somebody already in the list is not "pending",
                  it is leftover, and the fix is to delete it. */}
              {[...openInvites, ...staleInvites].map((inv) => (
                <tr key={inv.id} className="border-b border-hairline last:border-0 bg-amber-soft/20">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-paper-2 text-ink-3"><Icon name="mail" size={13} /></div>
                      <p className="text-ink-2 italic">
                        {memberEmails.has(inv.email.trim().toLowerCase()) ? "Already joined" : "Invited"}
                      </p>
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-ink-2">{inv.email}</td>
                  <td className="p-3"><Badge kind={ROLE_TONE[inv.role] ?? "muted"}>{ROLE_LABEL[inv.role] ?? inv.role}</Badge></td>
                  {isOwner && <td className="p-3 text-2xs text-ink-3">—</td>}
                  <td className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      {memberEmails.has(inv.email.trim().toLowerCase())
                        ? <Badge kind="muted" dot>Stale — safe to delete</Badge>
                        : <Badge kind="warning" dot>Pending</Badge>}
                      <IconButton icon="trash" variant="ghost" size="sm" aria-label="Remove invite"
                        onClick={() => removeInvite.mutate(inv.id)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
      </Card>

      {/* Mobile — member cards */}
      <ul className="md:hidden space-y-2.5">
        {members.map((m) => (
          <li key={m.id}>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <Avatar initials={m.initials ?? "?"} color={(m.color as never) ?? "slate"} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink leading-tight">
                    {m.full_name ?? "—"}
                    {m.id === me?.userId && <span className="text-ink-3 font-normal"> (you)</span>}
                  </p>
                  <p className="font-mono text-2xs text-ink-2 truncate">{m.email}</p>
                </div>
                <Badge kind={m.is_active === false ? "muted" : "success"} dot>
                  {m.is_active === false ? "Inactive" : "Active"}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                {isOwner && m.id !== me?.userId ? (
                  <select
                    aria-label={`Role for ${m.full_name ?? m.email}`}
                    value={m.role}
                    onChange={(e) => updateMember.mutate({ id: m.id, patch: { role: e.target.value as Role } })}
                    className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                ) : (
                  <Badge kind={ROLE_TONE[m.role] ?? "muted"}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                )}
                {isOwner && m.role === "sales" && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(m.can_view_deals)}
                      onChange={(e) => updateMember.mutate({ id: m.id, patch: { can_view_deals: e.target.checked } })}
                      className="rounded border-hairline"
                    />
                    Can view deals
                  </label>
                )}
                {isOwner && (m.role === "owner" || m.role === "sales_senior") && (
                  <span className="text-2xs text-emerald">Full deals access</span>
                )}
                {isOwner && (
                  <NewLeadsToggle member={m} onChange={(on) => updateMember.mutate({ id: m.id, patch: { gets_new_leads: on } })} />
                )}
              </div>
              {isOwner && (
                <label className="mt-3 flex items-center gap-2 text-xs text-ink-2">
                  Reports to
                  <select
                    value={m.manager_id ?? ""}
                    onChange={(e) => updateMember.mutate({ id: m.id, patch: { manager_id: e.target.value || null } })}
                    className="min-h-[36px] flex-1 rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value="">— Nobody (top of tree) —</option>
                    {eligibleManagers({ id: m.id, role: m.role, managerId: m.manager_id }, tree).map((u) => (
                      <option key={u.id} value={u.id}>{nameOf(u.id)}</option>
                    ))}
                  </select>
                </label>
              )}
              {isOwner && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <SendResetLinkButton email={m.email} />
                  {canSetTempPassword(m, me?.userId) && (
                    <SetTempPasswordButton memberId={m.id} name={m.full_name ?? m.email ?? "this teammate"} />
                  )}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {/* Mobile — pending invites (owner only), visually distinct from members */}
      {isOwner && invites.length > 0 && (
        <ul className="md:hidden mt-2.5 space-y-2.5">
          {[...openInvites, ...staleInvites].map((inv) => (
            <li key={inv.id}>
              <Card className="border-amber/40 bg-amber-soft/20 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                    <Icon name="mail" size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-2xs text-ink-2 truncate">{inv.email}</p>
                    <p className="text-2xs italic text-ink-3">
                      {memberEmails.has(inv.email.trim().toLowerCase())
                        ? "Already a member — this invite is leftover"
                        : "Invited · not joined yet"}
                    </p>
                  </div>
                  {memberEmails.has(inv.email.trim().toLowerCase())
                    ? <Badge kind="muted" dot>Stale</Badge>
                    : <Badge kind="warning" dot>Pending</Badge>}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <Badge kind={ROLE_TONE[inv.role] ?? "muted"}>{ROLE_LABEL[inv.role] ?? inv.role}</Badge>
                  <IconButton
                    icon="trash"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove invite"
                    onClick={() => removeInvite.mutate(inv.id)}
                  />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-2xs text-ink-3">
        <Icon name="info" size={11} />
        An invited email joins this workspace the first time they sign in with Google — no new tenant is created.
      </p>

      {isOwner && me && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={() => {
            qc.invalidateQueries({ queryKey: ["team", "invites"] });
            /* R-534: an invite with a temporary password adds the member straight away. */
            qc.invalidateQueries({ queryKey: ["team", "members"] });
          }}
        />
      )}

      {/* Mobile FAB — primary list action (owner only) */}
      {isOwner && (
        <FAB icon="plus" label="Invite member" onClick={() => setInviteOpen(true)} ariaLabel="Invite member" />
      )}
    </div>
  );
}

function InviteDialog({ open, onOpenChange, onInvited }: {
  open: boolean; onOpenChange: (v: boolean) => void; onInvited: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("sales");
  const [saving, setSaving] = React.useState(false);
  /* R-534: optional temporary password. `created` holds the one-time reveal; it lives only in
     this dialog's state and is wiped when the dialog closes. */
  const [tempPw, setTempPw] = React.useState("");
  const [created, setCreated] = React.useState<{ email: string; password: string } | null>(null);

  React.useEffect(() => {
    if (!open) { setEmail(""); setRole("sales"); setSaving(false); setTempPw(""); setCreated(null); }
  }, [open]);

  const tempPwProblem = tempPw ? checkTypedTempPassword(tempPw) : null;
  const ownerWithPw = role === "owner" && tempPw !== "";

  async function submit() {
    const clean = email.trim().toLowerCase();
    if (!clean.includes("@") || clean.length < 5) {
      toast.error("Enter a valid email.", { description: "Use the full address they sign in with, like name@company.com." });
      return;
    }
    setSaving(true);
    try {
      // Server route: creates the invite AND emails the invitee (best-effort).
      const res = await fetch("/api/team/invite", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(tempPw ? { email: clean, role, tempPassword: tempPw } : { email: clean, role }),
        cache:   "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError(json.error, { fallback: "Couldn't send the invite." });
        return;
      }
      if (json.memberCreated && typeof json.password === "string") {
        // Stay open: the password is shown once, here, with Copy.
        setTempPw("");
        setCreated({ email: clean, password: json.password });
        onInvited();
        return;
      }
      // Reflect whether the notification email actually went out.
      if (json.emailStatus === "sent") {
        toast.success(`Invited ${clean} — an email with sign-in instructions is on its way.`);
      } else {
        // stubbed (no Resend key) or failed → invite still works via Google sign-in
        toast.success(`Invited ${clean} — ask them to sign in with Google using this email.`);
        if (json.emailStatus === "failed") {
          setTimeout(() => toast.info("Invite email couldn't be sent (email not configured yet) — the invite still works."), 600);
        }
      }
      onInvited();
      onOpenChange(false);
    } catch (e) {
      toastError(e, { fallback: "Couldn't send the invite." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2"><Icon name="plus" size={18} className="text-amber" /> Invite a teammate</DialogTitle>
          <DialogDescription>
            {created
              ? `${created.email} can sign in now with this email and password.`
              : "They'll join this workspace the first time they sign in with Google using this email."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <TempPasswordReveal password={created.password} name={created.email} />
        ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="inv-email" className="block text-xs font-medium text-ink-2 mb-1">Email</label>
            <Input id="inv-email" type="email" placeholder="e.g. teammate@company.com" value={email}
              onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div>
            <label htmlFor="inv-role" className="block text-xs font-medium text-ink-2 mb-1">Role</label>
            <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber">
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <p className="mt-1 text-2xs text-ink-3">For the Google reseller-admin account, pick <b>Owner</b> so it can run the sync + add subscriptions.</p>
          </div>
          <TempPasswordField
            id="inv-temp-pw"
            label="Temporary password (optional)"
            value={tempPw}
            onChange={setTempPw}
            hint={ownerWithPw
              ? "Owners set their own password. Clear this, or pick another role."
              : "Lets them sign in today with email + password. They must choose their own at first sign-in."}
          />
        </div>
        )}

        <DialogFooter>
          {created ? (
            <Button type="button" variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button type="button" variant="primary" loading={saving} onClick={submit}
                disabled={saving || tempPwProblem !== null || ownerWithPw}>
                Send invite
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * R-111: is this person in the pool new unowned leads are dealt to, in turn?
 * The dealing itself is a database trigger (20261002120000_lead_auto_assign.sql), so every
 * intake path is covered. An inactive person is skipped there, so the tick is hidden here,
 * and so is it for roles that do not sell — an accountant dealt a website enquiry is a lead
 * nobody chases.
 */
const LEAD_ROLES: readonly string[] = ["owner", "manager", "sales", "sales_senior"];
function NewLeadsToggle({ member, onChange }: { member: Member; onChange: (on: boolean) => void }) {
  if (member.is_active === false || !LEAD_ROLES.includes(member.role)) {
    return <span className="text-2xs text-ink-3">—</span>;
  }
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer">
      <input
        type="checkbox"
        checked={Boolean(member.gets_new_leads)}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-hairline"
      />
      Gets new leads
    </label>
  );
}
