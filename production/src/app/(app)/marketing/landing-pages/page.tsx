/**
 * Ads landing pages — every ad page in one place: the URL to paste into Google Ads, a phone
 * preview, and how many leads each page brought (Pardeep, 4 Oct 2026). The list itself is
 * lib/marketing/landing-pages.ts; leads are counted from leads.landing_page_url.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { loadErrorBody } from "@/components/shared/load-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils";
import { AD_LANDING_PAGES, adFinalUrl, type AdLandingPage } from "@/lib/marketing/landing-pages";

const DAYS = 30;

interface PageStats { leads: number; fromAdClick: number; callbacks: number }

function usePageStats(path: string) {
  return useQuery({
    queryKey: ["ad-landing-page-stats", path, DAYS],
    queryFn: async (): Promise<PageStats> => {
      const supabase = createClient();
      const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
      /* landing_page_url is "path?utm…" — match the path itself or the path + query. */
      const base = () => supabase.from("leads").select("id", { count: "exact", head: true })
        .gte("created_at", since)
        .or(`landing_page_url.eq.${path},landing_page_url.like.${path}?*`);
      const [all, ad, cb] = await Promise.all([
        base(),
        base().not("gclid", "is", null),
        base().eq("source", "ads-callback"),
      ]);
      const err = all.error ?? ad.error ?? cb.error;
      if (err) throw new Error(err.message);
      return { leads: all.count ?? 0, fromAdClick: ad.count ?? 0, callbacks: cb.count ?? 0 };
    },
  });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied", { description: text });
  } catch {
    toast.error("Could not copy", { description: text });
  }
}

export default function AdLandingPagesPage() {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing · Ads &amp; tracking</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Ads landing pages</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-2xl">
          The pages your Google Ads point to. Paste the final URL into the ad — Google adds the click id
          on its own, and every lead from the page keeps it.
        </p>
      </div>

      <div className="space-y-5">
        {AD_LANDING_PAGES.map((p) => <LandingPageCard key={p.path} page={p} />)}
      </div>

      <p className="text-xs text-ink-3">
        One page per Google Workspace plan. New variants (Landing Page 2, 3…) appear here as they are added.
      </p>
    </div>
  );
}

function LandingPageCard({ page }: { page: AdLandingPage }) {
  const url = adFinalUrl(page);
  const stats = usePageStats(page.path);

  return (
    <Card className="p-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4 min-w-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="font-serif text-xl text-ink">{page.title}</h2>
              <p className="text-xs text-ink-3 mt-0.5">{page.product} · added {formatDate(page.addedOn, "short")}</p>
            </div>
            <Badge kind="success" size="sm" dot>Ready for ads</Badge>
          </div>

          <div>
            <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Final URL for Google Ads</p>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="font-mono text-sm bg-paper-2 border border-hairline rounded-md px-2.5 py-1.5 break-all">{url}</code>
              <Button size="sm" variant="outline" icon="copy" onClick={() => copy(url)}>Copy</Button>
              <a href={page.path} target="_blank" rel="noopener" className="text-sm font-semibold text-amber-ink hover:underline">Open page ↗</a>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Offer on the page</dt>
              <dd className="text-ink mt-0.5">{page.offer}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">What a visitor can send</dt>
              <dd className="text-ink mt-0.5">{page.captures}</dd>
            </div>
          </dl>

          <div className="grid grid-cols-3 gap-3 bg-paper-2/50 border border-hairline rounded-lg p-3">
            {stats.isLoading ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)
            ) : stats.error ? (
              <p className="col-span-3 text-sm text-red-ink">Could not count leads. {loadErrorBody(stats.error)}</p>
            ) : (
              <>
                <Stat label={`Leads, last ${DAYS} days`} value={stats.data!.leads} />
                <Stat label="From an ad click" value={stats.data!.fromAdClick} hint="Has a Google click id" />
                <Stat label="Call-back requests" value={stats.data!.callbacks} hint="Call them first" />
              </>
            )}
          </div>
        </div>

        <div className="justify-self-center lg:justify-self-end">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2 text-center">Phone preview</p>
          {/* 375×700 page scaled to 0.8 — what an ad visitor on a phone sees first. */}
          <div className="rounded-[28px] border-[6px] border-ink/80 overflow-hidden bg-white" style={{ width: 312, height: 572 }}>
            <iframe
              src={page.path}
              title={`${page.title} — phone preview`}
              loading="lazy"
              style={{ width: 375, height: 700, border: 0, transform: "scale(0.8)", transformOrigin: "0 0" }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className="font-serif text-2xl text-ink tabular-nums">{value}</p>
      {hint && <p className="text-3xs text-ink-3">{hint}</p>}
    </div>
  );
}
