/**
 * Deals — the rows the dashboard strip, /today and the Reports Deals card read (30 Sep 2026).
 *
 * Two paged reads (lib/ops/fetch-all.ts, so nothing is cut at PostgREST's 1000 rows):
 *   • every open deal (demo / trial / quote), all time — pipeline has no date;
 *   • won / lost deals whose stage changed in the last 100 IST days — covers both "this
 *     month" (≤ 31 days) and the reports' 90-day window. A lost deal whose lost_at predates
 *     its last stage change is still in, since stage_changed_at ≥ lost_at.
 * Junk is excluded, as on every pipeline figure. Read under the caller's RLS.
 *
 * R-375: each WON row also gets `paid` — whether a payment is recorded against it (a part/
 * fully-paid quote or a project receipt, lib/payments/won-paid.ts). accept_quote marks a lead
 * won before any money arrives, so the won ₹ figures sum only rows with paid = true.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn, idsKey } from "@/lib/ops/fetch-all";
import { istToday, addDaysISO, istDayStartUtc } from "@/lib/dates/ist";
import { OPEN_DEAL_STAGES, type DealRow } from "@/lib/deals/pipeline-summary";
import { latestFollowUps, dealTodayItems } from "@/lib/today/deals";
import { fetchPaidLeadIds } from "@/lib/payments/won-paid";

const DEAL_COLUMNS = "id, company, stage, value, expected_close_date, stage_changed_at, created_at, owner_id, lost_at, project_id";
export const CLOSED_LOOKBACK_DAYS = 100;

export function useDealRows(enabled = true) {
  const today = istToday();
  return useQuery({
    queryKey: ["leads", "deal-rows", today],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<DealRow[]> => {
      const supabase = createClient();
      const since = istDayStartUtc(addDaysISO(today, -CLOSED_LOOKBACK_DAYS)).toISOString();
      const [open, closed] = await Promise.all([
        fetchAllRows((from, to) => supabase
          .from("leads").select(DEAL_COLUMNS)
          .eq("is_junk", false).in("stage", [...OPEN_DEAL_STAGES])
          .order("id", { ascending: true })
          .range(from, to)),
        fetchAllRows((from, to) => supabase
          .from("leads").select(DEAL_COLUMNS)
          .eq("is_junk", false).in("stage", ["won", "lost"])
          .gte("stage_changed_at", since)
          .order("id", { ascending: true })
          .range(from, to)),
      ]);
      const won = closed.filter((d) => d.stage === "won");
      const paidIds = await fetchPaidLeadIds(supabase, won);
      /* project_id rides along (it is how a project deal's receipts are found); harmless extra. */
      return [
        ...open,
        ...closed.map((d) => (d.stage === "won" ? { ...d, paid: paidIds.has(d.id) } : d)),
      ] as DealRow[];
    },
  });
}

/**
 * lead id → latest follow-up instant (non-'stage' lead_activities), for the quote-stage
 * deals /today checks. Only activities since the oldest quote's stage change are read.
 */
export function useQuoteFollowUps(quotes: readonly Pick<DealRow, "id" | "stage_changed_at">[], enabled = true) {
  const ids = idsKey(quotes.map((q) => q.id));
  const oldest = quotes.reduce<string | null>(
    (m, q) => (q.stage_changed_at && (!m || q.stage_changed_at < m) ? q.stage_changed_at : m), null);
  return useQuery({
    queryKey: ["lead-activities", "quote-follow-ups", ids, oldest],
    enabled: enabled && ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const supabase = createClient();
      const rows = await fetchAllRowsIn(ids, (run, from, to) => {
        let q = supabase.from("lead_activities").select("lead_id, created_at, kind").in("lead_id", run);
        if (oldest) q = q.gt("created_at", oldest);
        return q.order("id", { ascending: true }).range(from, to);
      });
      return latestFollowUps(rows);
    },
  });
}

/**
 * /today's deal rows (lib/today/deals.ts) — the open deals plus, for quote-stage ones, their
 * latest follow-up. When the activity read fails the rows still come, judged by quote age.
 */
export function useTodayDealItems(enabled = true) {
  const rows = useDealRows(enabled);
  const quotes = React.useMemo(() => (rows.data ?? []).filter((d) => d.stage === "quote"), [rows.data]);
  const follow = useQuoteFollowUps(quotes, enabled && !!rows.data);
  const items = React.useMemo(
    () => (rows.data && !follow.isLoading ? dealTodayItems(rows.data, follow.data ?? null) : []),
    [rows.data, follow.isLoading, follow.data],
  );
  return { items, isLoading: rows.isLoading || follow.isLoading, error: rows.error, refetch: rows.refetch };
}
