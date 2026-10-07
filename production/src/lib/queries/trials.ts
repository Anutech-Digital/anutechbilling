/**
 * Trials — TanStack Query hooks.
 *
 * "Trial" = lead at stage='trial' with trial_started_at + trial_expires_at set.
 * Lifecycle:
 *   - Created via /api/public/trial/workspace (trial form on /buy/workspace)
 *   - 14-day window (TRIAL_DAYS) by default
 *   - Cron at /api/cron/trial-expiry stamps trial_expired_at after expiry
 *   - record_payment stamps trial_converted_at when first payment lands
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { Lead } from "@/lib/supabase/database.types";
import { trialDaysLeft } from "@/lib/trials/days-left";

export type TrialBucket = "in_flight" | "expiring_soon" | "expired_unconverted" | "converted";

export interface TrialWithBucket extends Lead {
  bucket:        TrialBucket;
  days_remaining: number | null;
  days_past_expiry: number | null;
}

/**
 * Exported for tests. Days are IST calendar days via trialDaysLeft (R-319) — the same count
 * the quote page shows. It used to round raw milliseconds, so one trial read "14 days left" on
 * the quote and "15d left" here.
 */
export function bucketize(lead: Lead, today: Date): TrialWithBucket {
  let bucket: TrialBucket = "in_flight";
  let daysRemaining: number | null = null;
  let daysPast:      number | null = null;

  if (lead.trial_converted_at) {
    bucket = "converted";
  } else if (lead.trial_expires_at) {
    const diff = trialDaysLeft(lead.trial_expires_at, today);
    if (diff < 0) {
      bucket = "expired_unconverted";
      daysPast = Math.abs(diff);
    } else if (diff <= 7) {
      bucket = "expiring_soon";
      daysRemaining = diff;
    } else {
      bucket = "in_flight";
      daysRemaining = diff;
    }
  }

  return {
    ...lead,
    bucket,
    days_remaining:   daysRemaining,
    days_past_expiry: daysPast,
  };
}

/**
 * All trial leads (current + historical). Bucketized + sorted by urgency
 * (expiring soon first, then in-flight, then expired, then converted).
 */
export function useTrials() {
  return useQuery({
    queryKey: ["trials"],
    queryFn: async (): Promise<TrialWithBucket[]> => {
      const supabase = createClient();
      const data = await fetchAllRows((from, to) => supabase
        .from("leads")
        .select("*")
        .not("trial_started_at", "is", null)
        .order("trial_expires_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));

      const today = new Date();
      const rows = data.map((l) => bucketize(l as Lead, today));

      // Urgency-sorted: expiring_soon < in_flight < expired_unconverted < converted
      const orderOf = (b: TrialBucket) =>
        b === "expiring_soon"       ? 0 :
        b === "in_flight"           ? 1 :
        b === "expired_unconverted" ? 2 :
                                      3;
      rows.sort((a, b) => orderOf(a.bucket) - orderOf(b.bucket));
      return rows;
    },
  });
}

/**
 * Active trials — currently in flight (not converted, not expired).
 * Used on Subscriptions page to show alongside paid subs (operationally
 * trial seats ARE deployed in Google CSP, just not billed).
 */
export function useActiveTrials() {
  return useQuery({
    queryKey: ["trials", "active"],
    queryFn: async (): Promise<TrialWithBucket[]> => {
      const supabase = createClient();
      const data = await fetchAllRows((from, to) => supabase
        .from("leads")
        .select("*")
        .eq("stage", "trial")
        .is("trial_converted_at", null)
        .is("trial_expired_at", null)
        .not("trial_started_at", "is", null)
        .order("trial_expires_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));
      const today = new Date();
      return data.map((l) => bucketize(l as Lead, today));
    },
  });
}

/** Just the trials expiring in the next 7 days — for Dashboard widget. */
export function useTrialsExpiringSoon() {
  return useQuery({
    queryKey: ["trials", "expiring_soon"],
    queryFn: async (): Promise<TrialWithBucket[]> => {
      const supabase = createClient();
      const now    = new Date();
      const in7    = new Date(now.getTime() + 7 * 86400000);
      const data = await fetchAllRows((from, to) => supabase
        .from("leads")
        .select("*")
        .eq("stage", "trial")
        .is("trial_converted_at", null)
        .is("trial_expired_at", null)
        .gte("trial_expires_at", now.toISOString())
        .lte("trial_expires_at", in7.toISOString())
        .order("trial_expires_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));
      return data.map((l) => bucketize(l as Lead, now));
    },
  });
}
