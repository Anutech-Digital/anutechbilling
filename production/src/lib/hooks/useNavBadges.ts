/**
 * useNavBadges — fetches live counts for sidebar badges.
 *
 * Returns a map of nav item id → badge string (or undefined if zero).
 * Only shows a badge when count > 0 so the sidebar stays clean.
 *
 * ─── ONE CALL, NOT TEN (S16, 28 Sep 2026) ───────────────────────────────────
 * This used to run auth.getUser + a users read + seven parallel COUNTs + one approvals
 * COUNT — about ten requests per open tab every 60 seconds, and the getUser/users pair
 * duplicated what useCurrentUser had already fetched for the same page. Now:
 *
 *   - who is asking comes from useCurrentUser (cached, shared with Sidebar/TopBar);
 *   - every count comes from ONE rpc, nav_badges() (migration 20260928130000), which is
 *     SECURITY INVOKER — it counts exactly the rows the caller's RLS shows, the same as
 *     the PostgREST counts it replaces. The filters there mirror the ones that were here,
 *     and supabase/tests/nav_badges.test.sql holds the two to each other.
 *
 * Badge ↔ page consistency (CRITICAL, Pardeep dogfood 2026-05-29): a badge must mirror
 * what the destination page renders, otherwise "Leads 14" opens an empty page. R-1475
 * (17 Oct 2026): leads and deals equal the "All leads" / "All deals" view each page opens
 * on — the page's stages (lib/leads/page-scope.ts), no junk — so "Deals 4" no longer opens
 * "All deals 7". lib/leads/nav-badge-page-match.test.ts holds the SQL to that rule.
 *
 * ─── Quotes waiting on YOUR approval ────────────────────────────────────────
 * The only count addressed to a person rather than to the tenant. Which tiers this role
 * may clear still comes from the shared `tiersApprovableBy`, passed in as p_approval_tiers,
 * so the badge, the /quotes filter and `awaitsMyApproval` cannot drift. The SQL adds the
 * other two parts: pending, and not raised by me (auth.uid(); a NULL requester is
 * dropped, as PostgREST's `neq` did). No tiers → no approvals badge.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { tiersApprovableBy } from "@/lib/quotes/awaiting-approval";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { badgesFromCounts, type NavBadges } from "@/lib/hooks/nav-badge-counts";

async function fetchNavBadges(tiers: string[]): Promise<NavBadges> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("nav_badges", { p_approval_tiers: tiers });
  if (error) throw error;
  return badgesFromCounts(data);
}

export function useNavBadges(): NavBadges {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const tiers = tiersApprovableBy(me?.role ?? null);

  const { data } = useQuery({
    /* Prefix stays ["nav-badges"] so every existing invalidateQueries(["nav-badges"])
       still refreshes it. */
    queryKey: ["nav-badges", tiers.join(",")],
    queryFn:  () => fetchNavBadges(tiers),
    /* Wait for identity so the first call already carries the right tiers, instead of
       one call without them and a second one a moment later. */
    enabled:  !meLoading,
    refetchInterval: 60_000,   // refresh every 60 seconds
    refetchIntervalInBackground: false,   // a hidden tab does not poll
    staleTime:       30_000,
  });
  return data ?? {};
}
