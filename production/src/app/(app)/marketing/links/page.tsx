/**
 * Tracking links — /marketing/links
 *
 * Make one link per ad / post / listing; a lead who fills the form from it arrives with its
 * channel and campaign, so nobody types a source and ROAS & CAC pairs the lead with that
 * channel's spend. The URL rules (channel key as utm_source, form pages only) are in
 * lib/marketing/tracking-link.ts, where a round-trip test proves each link comes back as
 * its own channel.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { toast } from "sonner";
import { cn, formatDate } from "@/lib/utils";
import { LEAD_SOURCES, sourceLabel } from "@/lib/leads/lead-sources";
import { DESTINATIONS, buildTrackingUrl, defaultMedium, slugCampaign } from "@/lib/marketing/tracking-link";
import { useTrackingLinks, useCreateTrackingLink, useDeleteTrackingLink } from "@/lib/queries/marketing-hub";
import { useCampaignOptions } from "@/lib/queries/marketing-campaigns";

/* A link is for a real channel — not for "Added manually" or "CSV import". */
const LINK_CHANNELS = LEAD_SOURCES.filter((s) => !["manual", "csv", "tele-calling", "walk-in", "email-inbound", "buy-workspace-v2", "enquiry-form"].includes(s.value));

function siteOrigin(): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, "");
  return typeof window !== "undefined" ? window.location.origin : "";
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast.success("Link copied"); }
  catch { toast.error("Couldn't copy — select the link and copy it"); }
}

export default function TrackingLinksPage() {
  const links = useTrackingLinks();
  const create = useCreateTrackingLink();
  const del = useDeleteTrackingLink();
  const confirm = useConfirm();

  const [label, setLabel] = React.useState("");
  const [channel, setChannel] = React.useState("meta-ads");
  const [path, setPath] = React.useState(DESTINATIONS[0].path);
  const [campaign, setCampaign] = React.useState("");
  const [content, setContent] = React.useState("");
  const [medium, setMedium] = React.useState("");
  const campaigns = useCampaignOptions();
  /* Arriving from a campaign card (?campaign=<code>) fills its code, so the link's leads
     count against that campaign. Read from location, not useSearchParams, to keep the page
     statically renderable. */
  React.useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("campaign");
    if (c) setCampaign(c);
  }, []);
  const linkedCampaign = (campaigns.data ?? []).find((c) => c.code === slugCampaign(campaign));

  const origin = siteOrigin();
  const url = origin ? buildTrackingUrl({ origin, path, channel, campaign, content, medium }) : "";
  const isLocal = /localhost|127\.0\.0\.1/.test(origin);

  async function save() {
    if (!label.trim()) { toast.error("Name the link — e.g. \"FB ad — Diwali\""); return; }
    const u = new URL(url);
    await create.mutateAsync({
      label: label.trim(), channel,
      utm_medium: u.searchParams.get("utm_medium") ?? defaultMedium(channel),
      utm_campaign: u.searchParams.get("utm_campaign") ?? "general",
      utm_content: u.searchParams.get("utm_content"),
      destination_path: path, full_url: url,
    });
    setLabel(""); setContent("");
  }

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Tracking links</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          Make a separate link for each ad, post or listing. A lead who fills the form through it gets the source and campaign
          automatically — ROAS &amp; CAC then matches it with that channel's spend.
        </p>
      </header>

      <Card className="p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">New link</p>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Name (only for you)" required htmlFor="tl_label">
            <Input id="tl_label" placeholder="e.g. FB ad — Diwali Workspace offer" value={label} onChange={(e) => setLabel(e.target.value)} />
          </FormField>
          <FormField label="Where it goes (channel)" htmlFor="tl_channel">
            <Select value={channel} onValueChange={(v) => { setChannel(v); setMedium(""); }}>
              <SelectTrigger id="tl_channel"><SelectValue /></SelectTrigger>
              <SelectContent>{LINK_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label="Page the link opens" htmlFor="tl_path">
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger id="tl_path"><SelectValue /></SelectTrigger>
              <SelectContent>{DESTINATIONS.map((d) => <SelectItem key={d.path} value={d.path}>{d.label}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label="Campaign" htmlFor="tl_campaign">
            {(campaigns.data ?? []).length > 0 && (
              <Select value={linkedCampaign?.code ?? "free"} onValueChange={(v) => setCampaign(v === "free" ? "" : v)}>
                <SelectTrigger className="mb-1.5" aria-label="Choose campaign"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Type your own name…</SelectItem>
                  {(campaigns.data ?? []).filter((c) => !c.cancelled).map((c) => <SelectItem key={c.id} value={c.code}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Input id="tl_campaign" placeholder="e.g. Diwali 2026" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
            {linkedCampaign && <p className="mt-1 text-xs text-emerald">Leads from this link count towards the &ldquo;{linkedCampaign.name}&rdquo; campaign.</p>}
            <p className="mt-1 text-xs text-ink-3">Use the same name in every ad of a campaign so all its leads count together. In the link: <code>{slugCampaign(campaign) || "general"}</code></p>
          </FormField>
          <FormField label="Which ad / post (optional)" htmlFor="tl_content">
            <Input id="tl_content" placeholder="e.g. video-1, carousel" value={content} onChange={(e) => setContent(e.target.value)} />
          </FormField>
          <FormField label="Medium" htmlFor="tl_medium">
            <Input id="tl_medium" placeholder={defaultMedium(channel)} value={medium} onChange={(e) => setMedium(e.target.value)} />
            <p className="mt-1 text-xs text-ink-3">Leave blank to use &ldquo;{defaultMedium(channel)}&rdquo;.</p>
          </FormField>
        </div>

        <div className="rounded-lg border border-hairline bg-paper-2/50 p-3">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Your link</p>
          <p className="font-mono text-xs text-ink break-all">{url || "—"}</p>
          {isLocal && (
            <p className="mt-1.5 text-xs text-amber-ink">
              This is a localhost link — a real ad needs the live site link. It appears once NEXT_PUBLIC_APP_URL is set.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon="copy" onClick={() => copy(url)} disabled={!url}>Copy</Button>
          <Button onClick={save} disabled={!url || create.isPending}>{create.isPending ? "Saving…" : "Save link"}</Button>
        </div>
        <p className="text-xs text-ink-3">
          The link goes straight to a page with the form. Linking to the home page loses the source before the visitor reaches a form.
        </p>
      </Card>

      <Card flush>
        <div className="px-4 pt-4 pb-2">
          <p className="text-sm font-semibold text-ink">Saved links</p>
          <p className="text-xs text-ink-3 mt-0.5">Leads = leads that came in through this link's channel + campaign.</p>
        </div>
        {links.isLoading ? (
          <div className="p-4 space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : links.error ? (
          <p className="p-4 text-sm text-red-600">{(links.error as Error).message}</p>
        ) : (links.data ?? []).length === 0 ? (
          <EmptyState icon="globe" title="No links yet" body="Create your first link above — for example, for your Facebook ad." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="bg-paper-2 border-y border-hairline-strong">
                <tr>
                  {["Name", "Channel", "Campaign", "Leads", "Won", "Created", ""].map((h, i) => (
                    <th key={h + i} className={cn("px-3 py-2 text-2xs font-semibold text-ink-3 uppercase tracking-wider", i >= 3 && i <= 4 ? "text-right" : "text-left")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(links.data ?? []).map((l) => (
                  <tr key={l.id} className="border-b border-hairline last:border-0 align-top">
                    <td className="px-3 py-2 text-sm">
                      <div className="font-medium text-ink">{l.label}</div>
                      <div className="font-mono text-xs text-ink-3 break-all max-w-[26rem]">{l.full_url}</div>
                    </td>
                    <td className="px-3 py-2 text-sm text-ink-2">{sourceLabel(l.channel)}</td>
                    <td className="px-3 py-2 text-sm text-ink-2">{l.utm_campaign}{l.utm_content ? <span className="text-ink-3"> · {l.utm_content}</span> : null}</td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums">{l.leads}</td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums">{l.won}</td>
                    <td className="px-3 py-2 text-xs text-ink-3 whitespace-nowrap">{formatDate(l.created_at)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => copy(l.full_url)}>Copy</Button>
                      <Button variant="ghost" size="sm" onClick={async () => {
                        const ok = await confirm({
                          title: "Remove link?",
                          body: "Removes it from this list only. Any ad using this link keeps working, and leads that came in keep their source.",
                          confirmLabel: COPY.yesRemove, cancelLabel: COPY.cancel,
                        });
                        if (ok) del.mutate(l.id);
                      }}>{COPY.remove}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
