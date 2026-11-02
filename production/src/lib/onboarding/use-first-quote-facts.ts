/**
 * R-1931 (G-ONBOARD OB-10) — gathers the facts the ONE "Get to your first quote" list judges
 * (components/features/dashboard/setup-checklist.ts), from the SAME reads the screens that do
 * each step use, so a save there ticks the row here without a reload:
 *
 *   state, GSTIN, address, bank/UPI → useCurrentUser (tenants row)
 *   GST registration               → useGstRegistration (Settings → Company, R-1529)
 *   price list                     → useItems (["items", …]) → productCount
 *   first quote / quote sent       → useQuotes (["quotes","all"], every row, past the 1000 cap)
 *   customer messages              → /api/automation/jobs (["automation-jobs"], the /automation switch)
 *   team                           → users (["team","members"]) + open team_invites (owner-only RLS)
 *
 * Used by the Dashboard card and the /setup Done screen. React Query shares each read with the
 * page that already makes it, so no extra request. A failed read becomes null (row stays open,
 * "Could not check"), never a tick; a read this role may not make is null too.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers } from "@/lib/queries/team";
import { useItems } from "@/lib/queries/items";
import { useQuotes } from "@/lib/queries/quotes";
import { useGstRegistration } from "@/lib/compliance/gst-registration-query";
import { productCount } from "@/lib/items/catalog-state";
import type { AutomationState } from "@/lib/automation/jobs";
import type { FirstQuoteFacts } from "@/components/features/dashboard/setup-checklist";

const JOBS_ROLES = new Set(["owner", "manager"]);

/** The part of GET /api/automation/jobs this list reads (same key + shape as /automation). */
interface JobsProbe { customerMessages?: { state?: AutomationState } }

export function useFirstQuoteFacts(): FirstQuoteFacts {
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;
  const canJobs = role !== null && JOBS_ROLES.has(role);
  const isOwner = role === "owner";

  const itemsQ = useItems();
  const quotesQ = useQuotes();
  const gstQ = useGstRegistration();
  const membersQ = useTeamMembers();
  const jobsQ = useQuery({
    queryKey: ["automation-jobs"],
    queryFn: async (): Promise<JobsProbe | null> => {
      const res = await fetch("/api/automation/jobs", { cache: "no-store" });
      if (res.status === 403) return null;
      if (!res.ok) throw new Error(`/api/automation/jobs → ${res.status}`);
      return res.json() as Promise<JobsProbe>;
    },
    enabled: canJobs,
    retry: 1,
  });
  const invitesQ = useQuery({
    queryKey: ["team", "invites", "open-count"],
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      // RLS scopes team_invites to the caller's tenant (owner-only).
      const { count, error } = await supabase
        .from("team_invites")
        .select("id", { count: "exact", head: true })
        .is("accepted_at", null);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: isOwner,
    staleTime: 60_000,
    retry: 1,
  });

  /** undefined while loading, null when it failed or this role does not read it. */
  function probe<T, R>(q: { isError: boolean; data: T | undefined }, pick: (d: T) => R, enabled = true): R | null | undefined {
    if (!me) return undefined;
    if (!enabled || q.isError) return null;
    return q.data === undefined ? undefined : pick(q.data);
  }

  const quotes = quotesQ.data;
  const firstDraft = quotes?.find((q) => q.status === "draft");
  const jobsState = probe(jobsQ, (d) => d?.customerMessages?.state ?? null, canJobs);

  return {
    address: me?.tenantAddress,
    stateCode: me?.tenantStateCode,
    gstin: me?.tenantGstin,
    gstRegistration: probe(gstQ, (d) => d.saved),
    productCount: probe(itemsQ, (d) => productCount(d)),
    quoteCount: probe(quotesQ, (d) => d.length),
    sentQuoteCount: probe(quotesQ, (d) => d.filter((q) => q.status !== "draft").length),
    draftQuoteId: quotesQ.isError ? null : (quotes ? (firstDraft?.id ?? null) : undefined),
    customerMessages: jobsState,
    upiVpa: me?.tenantUpiVpa,
    remitAccountNumber: me?.tenantRemitAccountNumber,
    remitIfsc: me?.tenantRemitIfsc,
    memberCount: probe(membersQ, (d) => d.length),
    pendingInvites: probe(invitesQ, (d) => d, isOwner),
  };
}
