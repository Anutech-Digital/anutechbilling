/**
 * Google Business Profile — reads for /marketing/google-business.
 * Tables from migration 20260927250000 are server-written; the browser only reads them and
 * calls the sync / reply routes. Arithmetic lives in lib/marketing/gbp.ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toastError } from "@/lib/errors/toast-error";
import type { MetricRow } from "@/lib/marketing/gbp";

export const GBP_KEY = ["gbp"] as const;

export interface GbpStatus {
  configured: boolean;
  connected: boolean;
  connectedByMe: boolean;
  email: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  reason: string;
}

export function useGbpStatus() {
  return useQuery({
    queryKey: [...GBP_KEY, "status"],
    queryFn: async (): Promise<GbpStatus> => {
      const res = await fetch("/api/integrations/google-business");
      if (!res.ok) throw new Error("Could not load status");
      return res.json();
    },
  });
}

export interface GbpLocation {
  id: string; title: string; primary_category: string | null; address: string | null; phone: string | null;
  website_uri: string | null; maps_uri: string | null; new_review_uri: string | null; average_rating: number | null;
  total_reviews: number; is_verified: boolean | null; last_synced_at: string | null; last_error: string | null;
}

export function useGbpLocations() {
  return useQuery({
    queryKey: [...GBP_KEY, "locations"],
    queryFn: async (): Promise<GbpLocation[]> => {
      const { data, error } = await createClient().from("gbp_locations")
        .select("id, title, primary_category, address, phone, website_uri, maps_uri, new_review_uri, average_rating, total_reviews, is_verified, last_synced_at, last_error")
        .order("title");
      if (error) throw error;
      return (data ?? []) as GbpLocation[];
    },
  });
}

export interface GbpReview {
  id: string; location_id: string; reviewer_name: string | null; reviewer_photo_uri: string | null; is_anonymous: boolean;
  star_rating: number; comment: string | null; reply_comment: string | null; replied_at: string | null; reviewed_at: string;
}

export function useGbpReviews(locationId?: string | null) {
  return useQuery({
    queryKey: [...GBP_KEY, "reviews", locationId ?? "all"],
    queryFn: async (): Promise<GbpReview[]> => {
      let q = createClient().from("gbp_reviews")
        .select("id, location_id, reviewer_name, reviewer_photo_uri, is_anonymous, star_rating, comment, reply_comment, replied_at, reviewed_at")
        .order("reviewed_at", { ascending: false }).limit(1000);
      if (locationId) q = q.eq("location_id", locationId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as GbpReview[];
    },
  });
}

/** All stored daily metric rows for one listing (or every listing), oldest first. */
export function useGbpMetrics(locationId?: string | null, fromDay?: string) {
  return useQuery({
    queryKey: [...GBP_KEY, "metrics", locationId ?? "all", fromDay ?? "all"],
    queryFn: () => fetchGbpMetrics(createClient(), locationId, fromDay),
    staleTime: 60_000,
  });
}

/**
 * R-1588: every stored metric row. The old `.limit(20000)` came back as 1000 rows (the
 * gateway caps every answer) — a few listings x ~10 metrics x 90 days is past that, so the
 * charts stopped early. Paged; the primary key (location_id, day, metric) after `day` makes
 * the order total.
 */
export async function fetchGbpMetrics(supabase: SupabaseClient<Database>, locationId?: string | null, fromDay?: string): Promise<MetricRow[]> {
  const data = await fetchAllRows((from, to) => {
    let q = supabase.from("gbp_metrics_daily").select("day, metric, value");
    if (locationId) q = q.eq("location_id", locationId);
    if (fromDay) q = q.gte("day", fromDay);
    return q.order("day", { ascending: true }).order("location_id", { ascending: true }).order("metric", { ascending: true })
      .range(from, to);
  });
  return data as MetricRow[];
}

export interface GbpSyncRun { id: string; started_at: string; finished_at: string | null; trigger: string; locations: number; reviews: number; metric_rows: number; ok: boolean | null; error: string | null }
export function useGbpSyncRuns() {
  return useQuery({
    queryKey: [...GBP_KEY, "runs"],
    queryFn: async (): Promise<GbpSyncRun[]> => {
      const { data, error } = await createClient().from("gbp_sync_runs").select("*").order("started_at", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as GbpSyncRun[];
    },
  });
}

export function useGbpSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/marketing/gbp/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Sync failed");
      return body as { ok: boolean; locations: number; reviews: number; metricRows: number; errors: string[] };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: GBP_KEY });
      if (r.errors?.length) toast.warning(`Synced, but: ${r.errors[0]}`);
      else toast.success(`Synced — ${r.locations} listing, ${r.reviews} reviews, ${r.metricRows} metric rows`);
    },
    onError: (e) => { qc.invalidateQueries({ queryKey: GBP_KEY }); toastError(e); },
  });
}

export function useGbpReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { reviewId: string; comment: string }) => {
      const res = await fetch("/api/marketing/gbp/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Reply failed");
      return body;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [...GBP_KEY, "reviews"] }); toast.success("Reply posted on Google"); },
    onError: (e) => toastError(e),
  });
}
