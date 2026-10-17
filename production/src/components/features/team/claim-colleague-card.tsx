"use client";

/**
 * "Claim a colleague" — the repair half of the accidental-tenant fix.
 *
 * ─── WHY A REPAIR TOOL IS NOT OPTIONAL ───────────────────────────────────────
 * Prevention is never perfect, so what actually makes a class of mistake stop
 * mattering is that fixing it is cheap. Before this, moving a person between
 * workspaces was not merely hard — there was no supported way to do it at all,
 * which is why a two-day-old mistake was still unfixed on 14 Aug 2026 with real
 * money sitting inside it.
 *
 * ─── IT IS ALLOWED TO REFUSE, AND THE REFUSAL IS THE FEATURE ─────────────────
 * R-721: the list and the claim cover only people with a pending join request (or an
 * invite they signed in after) to THIS workspace — never the rest of the platform.
 *
 * The RPC behind this will not touch a workspace that holds business data — not
 * even to move the person out, because moving the last member out of a workspace
 * full of customers leaves that data with nobody who can sign in and see it. The
 * refusal arrives with counts and a next step, and this component prints it
 * verbatim rather than flattening it into "something went wrong". A blocked
 * action that explains itself is worth more than a button that always succeeds.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { INVITABLE_ROLES, ROLE_LABEL } from "@/lib/auth/roles";
import {
  describeMergeOutcome,
  mergeChangedSomething,
  type MergeResult,
} from "@/lib/auth/merge-outcome";

interface StrandedUser {
  email: string;
  full_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

type ClaimResult = MergeResult;

export function ClaimColleagueCard({ isOwner }: { isOwner: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [role, setRole]   = React.useState<string>("support");
  const [blocked, setBlocked] = React.useState<string | null>(null);

  const stranded = useQuery({
    queryKey: ["team", "stranded"],
    enabled:  isOwner,
    queryFn: async (): Promise<StrandedUser[]> => {
      const res  = await fetch("/api/team/claim");
      const json = await res.json() as { users?: StrandedUser[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load");
      return json.users ?? [];
    },
  });

  const claim = useMutation({
    mutationFn: async (vars: { email: string; role: string }) => {
      const res  = await fetch("/api/team/claim", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(vars),
      });
      const json = await res.json() as { ok?: boolean; error?: string; result?: ClaimResult };
      if (!res.ok || json.error) throw new Error(json.error ?? "Could not claim that person.");
      return json.result as ClaimResult;
    },
    onSuccess: (r) => {
      setBlocked(null);
      setEmail("");
      toast.success(describeMergeOutcome(r));
      if (mergeChangedSomething(r)) {
        void qc.invalidateQueries({ queryKey: ["team"] });
        void qc.invalidateQueries({ queryKey: ["join-requests"] });
        void qc.invalidateQueries({ queryKey: ["team", "stranded"] });
      }
    },
    onError: (e: Error) => {
      // Keep the message on screen. These are multi-sentence explanations with a
      // next step in them; a toast that vanishes in four seconds cannot carry one.
      setBlocked(e.message);
    },
  });

  if (!isOwner) return null;

  const list = stranded.data ?? [];

  return (
    <Card className="mb-6 max-w-3xl">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-soft">
          <Icon name="user" size={16} className="text-indigo-ink" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-ink">Claim a colleague</h3>
          <p className="text-xs text-ink-3 leading-relaxed">
            Someone who signed in before you invited them ends up outside this workspace —
            either with nowhere to go, or in an empty company of their own. Put them back here.
            Only people who asked to join, or signed in after your invite, can be claimed.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <FormField label="Their email" required htmlFor="claim-email">
          <Input
            id="claim-email"
            type="email"
            placeholder="e.g. deepak@anutech.in"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setBlocked(null); }}
            aria-describedby="claim-email-helper"
          />
        </FormField>

        <div>
          <label htmlFor="claim-role" className="mb-1.5 block text-xs font-medium text-ink-2">Role</label>
          <select
            id="claim-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-10 rounded-md border border-hairline bg-paper px-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>

        <Button
          variant="primary"
          className="h-10"
          loading={claim.isPending}
          onClick={() => {
            // R-1421: never send an empty box to the server (that was the bare 400).
            const e = email.trim();
            if (!e) { setBlocked("Type their email address first — the one they sign in with."); return; }
            claim.mutate({ email: e, role });
          }}
        >
          Claim &amp; merge
        </Button>
      </div>
      {/* R-1408: the helper sits under the row, not inside it — inside, the bottom-aligned
          row lined the Role select and the button up with this text, not with the box. */}
      <p id="claim-email-helper" className="mt-1 text-xs text-ink-3">The exact address they sign in with.</p>

      {blocked && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/40 p-3">
          <Icon name="alert" size={15} className="mt-0.5 flex-shrink-0 text-amber-ink" />
          <p className="text-xs leading-relaxed text-amber-ink">{blocked}</p>
        </div>
      )}

      {stranded.isSuccess && list.length === 0 && (
        <p className="mt-3 text-xs text-ink-3">
          Nobody is waiting to be claimed right now. People show up here only after they ask
          to join this workspace, or sign in after your invite.
        </p>
      )}

      {list.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3">
          <p className="mb-2 text-xs text-ink-3">
            {list.length} {list.length === 1 ? "person" : "people"} asked to join or {list.length === 1 ? "was" : "were"} invited
            here but {list.length === 1 ? "has" : "have"} no workspace yet. Until claimed, they land in an app with nothing in it.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {list.map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  onClick={() => { setEmail(u.email); setBlocked(null); }}
                  className="rounded-full border border-hairline px-2.5 py-1 font-mono text-2xs text-ink-2 hover:border-amber hover:text-ink"
                  title={u.last_sign_in_at ? `Last signed in ${new Date(u.last_sign_in_at).toLocaleDateString("en-IN")}` : "Never signed in"}
                >
                  {u.email}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
