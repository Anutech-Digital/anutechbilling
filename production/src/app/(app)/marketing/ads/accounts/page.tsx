"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TabBar } from "@/components/ui/tabs";
import { LoadError } from "@/components/shared/load-error";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/marketing/ad-platforms";
import { useAdsStatus, useRemoveAdAccount, useToggleAdAccount, type AdsStatus } from "@/lib/queries/ads";
import { formatDate } from "@/lib/utils";

type PlatformFilter = "all" | AdPlatform;
type Account = AdsStatus["accounts"][number];
const PLATFORMS = ["google-ads", "meta-ads", "linkedin-ads"] as const;
const CONNECT_URL: Record<AdPlatform, string> = {
  "google-ads": "/api/integrations/google-ads/connect",
  "meta-ads": "/api/integrations/meta-ads/connect",
  "linkedin-ads": "/api/integrations/linkedin-ads/connect",
};
const RESULT: Record<string, string> = {
  connected: "Connected. Your accounts are listed below.",
  connected_syncfailed: "Connected, but the first sync failed. Check the account status below.",
  connected_scopelost: "Connected, but an earlier Google permission was removed. Reconnect and allow Google Ads.",
  denied: "Permission was denied. Try connecting again.",
  noscope: "Google Ads permission was not selected. Connect again and allow it.",
  noaccounts: "This login has no ad accounts. Use the login that manages the ads.",
  badstate: "The sign-in expired. Try connecting again.",
  notconfigured: "App keys are missing. Complete setup first.",
  role: "Only an owner or manager can connect ad accounts.",
  error: "Could not connect. Try again.",
};

export default function ManageAdAccountsPage() {
  const status = useAdsStatus();
  const toggle = useToggleAdAccount();
  const remove = useRemoveAdAccount();
  const [platform, setPlatform] = React.useState<PlatformFilter>("all");
  const [search, setSearch] = React.useState("");
  const [removeTarget, setRemoveTarget] = React.useState<Account | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("platform");
    if (requested && PLATFORMS.some((item) => item === requested)) setPlatform(requested as AdPlatform);
    for (const key of ["google", "meta", "linkedin"]) {
      const result = params.get(key);
      if (result && RESULT[result]) (result === "connected" ? toast.success : toast.error)(`${key === "google" ? "Google Ads" : key === "meta" ? "Meta Ads" : "LinkedIn Ads"}: ${RESULT[result]}`);
    }
    if (params.get("why")) toast.error(params.get("why")!);
    if (["google", "meta", "linkedin", "why"].some((key) => params.has(key))) {
      const next = new URLSearchParams();
      if (requested && PLATFORMS.some((item) => item === requested)) next.set("platform", requested);
      window.history.replaceState({}, "", `${window.location.pathname}${next.toString() ? `?${next}` : ""}`);
    }
  }, []);

  const accounts = status.data?.accounts ?? [];
  const visible = accounts
    .filter((account) => (platform === "all" || account.platform === platform) && `${account.name} ${account.account_id} ${account.currency} ${PLATFORM_LABEL[account.platform]}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => {
      const priority = (account: Account) => !account.enabled ? 2 : account.last_error ? 0 : 1;
      return priority(a) - priority(b) || a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name);
    });
  const syncing = accounts.filter((account) => account.enabled).length;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <Link href={"/marketing/ads" as Route} className="text-sm text-amber-ink hover:underline">← Paid ads performance</Link>
        <h1 className="mt-2 font-serif text-3xl md:text-4xl text-ink">Manage ad accounts</h1>
        <p className="mt-1 text-sm text-ink-3">Connect accounts, control sync, and open each account’s results.</p>
      </header>

      {status.isLoading ? <Skeleton className="h-48 rounded-lg" /> : status.isError ? (
        <LoadError what="Ad accounts" error={status.error} onRetry={() => void status.refetch()} />
      ) : <>
        <div className="grid gap-3 md:grid-cols-3">
          {PLATFORMS.map((item) => {
            const count = accounts.filter((account) => account.platform === item).length;
            const configured = item === "google-ads" ? status.data?.google.configured : item === "meta-ads" ? status.data?.meta.configured : status.data?.linkedin.configured;
            return <Card key={item} className="p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-ink">{PLATFORM_LABEL[item]}</h2>
                <Badge kind={count ? "success" : configured ? "warning" : "muted"} size="sm">{count ? `${count} ${count === 1 ? "account" : "accounts"}` : configured ? "Ready to connect" : "Setup needed"}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-3">{item === "google-ads" ? "Connect the Google login that manages the ad accounts." : item === "meta-ads" ? "Connect the Meta login that manages the ad accounts." : "Connect the LinkedIn login with ad account access."}</p>
              {configured ? <Button asChild size="sm" variant="outline" className="mt-3"><a href={CONNECT_URL[item]}>{count ? "Add another login" : "Connect account"}</a></Button> : item === "linkedin-ads" ? (
                <Button asChild size="sm" variant="outline" className="mt-3"><Link href={"/marketing/linkedin-ads?setup=1" as Route}>Set up LinkedIn</Link></Button>
              ) : <SetupHint platform={item} />}
            </Card>;
          })}
        </div>

        <Card className="overflow-hidden p-0">
          <div className="space-y-3 border-b border-hairline p-4">
            <div>
              <h2 className="text-base font-semibold text-ink">Accounts</h2>
              <p className="text-xs text-ink-3">{accounts.length} connected · {syncing} syncing · {accounts.length - syncing} paused</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabBar value={platform} onChange={(value) => setPlatform(value as PlatformFilter)} items={[
                { id: "all", label: `All (${accounts.length})` },
                { id: "google-ads", label: `Google (${accounts.filter((account) => account.platform === "google-ads").length})` },
                { id: "meta-ads", label: `Meta (${accounts.filter((account) => account.platform === "meta-ads").length})` },
                { id: "linkedin-ads", label: `LinkedIn (${accounts.filter((account) => account.platform === "linkedin-ads").length})` },
              ]} />
              <Input type="search" aria-label="Search ad accounts" placeholder="Search accounts" value={search} onChange={(event) => setSearch(event.target.value)} wrapperClassName="w-full sm:w-64" />
            </div>
          </div>
          {visible.length === 0 ? <p className="p-5 text-sm text-ink-3">{accounts.length ? "No accounts match this filter." : "No ad accounts connected yet. Connect a platform above."}</p> : (
            <div className="divide-y divide-hairline">
              {visible.map((account) => <div key={account.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{account.name}</p>
                    <Badge size="sm" kind="muted">{account.platform === "google-ads" ? "Google" : account.platform === "meta-ads" ? "Meta" : "LinkedIn"}</Badge>
                    {!account.enabled && <Badge size="sm" kind="muted">Paused</Badge>}
                    {account.enabled && account.last_error && <Badge size="sm" kind="danger">Needs attention</Badge>}
                  </div>
                  <p className="mt-0.5 break-all text-xs text-ink-3">{account.account_id} · {account.currency} · {account.last_synced_at ? `Synced ${formatDate(account.last_synced_at)}` : "Not synced yet"}</p>
                  {account.last_error && <p className="mt-1 text-xs text-rose-ink">{account.last_error}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  <Button asChild size="sm" variant="outline"><Link href={`/marketing/ads?platform=${account.platform}&account=${account.id}#ad-results` as Route}>View results</Link></Button>
                  <label className="flex items-center gap-2 text-xs text-ink-3"><Switch checked={account.enabled} disabled={toggle.isPending || remove.isPending} onCheckedChange={(enabled) => toggle.mutate({ accountId: account.id, enabled })} aria-label={`Sync ${account.name}`} /> Sync</label>
                  <Button size="sm" variant="ghost" className="text-rose-ink" onClick={() => setRemoveTarget(account)}>Remove</Button>
                </div>
              </div>)}
            </div>
          )}
        </Card>
      </>}

      <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open && !remove.isPending) setRemoveTarget(null); }}>
        <DialogContent className="sm:!max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>Sync will stop and this account will leave the list. Past spend and campaign reports stay in ResellerOS. You can connect it again later.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => { if (removeTarget) void remove.mutateAsync(removeTarget.id).then(() => setRemoveTarget(null)).catch(() => {}); }}>Remove account</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SetupHint({ platform }: { platform: "google-ads" | "meta-ads" }) {
  const google = platform === "google-ads";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3001";
  return <p className="mt-3 text-xs text-ink-3">
    Add {google ? "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET" : "META_APP_ID and META_APP_SECRET"} to the server settings, then restart the app. Redirect URL: <code className="break-all">{appUrl}/api/integrations/{platform}/callback</code>.
  </p>;
}
