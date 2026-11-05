"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { MarketingPageHeader } from "@/components/features/marketing-hub/workspace-links";
import { ArrowUpRight, Facebook, Instagram, Link2 } from "lucide-react";

type PageChoice = { id: string; name: string; tasks?: string[] };
type Status = {
  configured: boolean; connected: boolean; canManage: boolean;
  pageId: string | null; pageName: string | null;
  instagram?: { username: string | null } | null;
  choosing: boolean; pages: PageChoice[];
};

const messages: Record<string, string> = {
  denied: "Facebook access was declined.",
  badstate: "The Facebook sign-in expired. Please try again.",
  notconfigured: "Meta app keys are missing on this server.",
  novault: "The server encryption key is missing.",
  role: "Only an owner or manager can connect a Facebook Page.",
  error: "Facebook could not be connected. Please try again.",
};

export default function FacebookPage() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = React.useState("/api/integrations/facebook-page/callback");

  const load = React.useCallback(async () => {
    const response = await fetch("/api/integrations/facebook-page", { cache: "no-store" });
    const data = await response.json() as Status & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load Facebook Pages.");
    setStatus(data);
    setError(null);
  }, []);

  React.useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);
  React.useEffect(() => { setRedirectUrl(`${window.location.origin}/api/integrations/facebook-page/callback`); }, []);
  React.useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("facebook");
    if (!result) return;
    if (messages[result]) toast.error(messages[result], { description: "Press Connect Facebook Page to try again." });
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  async function choose(pageId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/facebook-page", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not connect this Page.");
      toast.success("Facebook Page connected.");
      await load();
    } catch (e) { toastError(e, { fallback: "Could not connect this Page.", description: "Choose the Page again, or press Connect Facebook Page to sign in again." }); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/facebook-page", { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not disconnect the Page.");
      toast.success("Facebook Page disconnected.");
      setConfirmDisconnect(false);
      await load();
    } catch (e) { toastError(e, { fallback: "Could not disconnect the Page.", description: "Nothing changed. Refresh the page and try again." }); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Facebook Page" description="Manage the Facebook Page connected to your workspace." />
      {error && <Card><div role="alert" className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-rose-ink">{error}</p><Button size="sm" onClick={() => void load()}>Try again</Button></div></Card>}
      {!status && !error && <Skeleton className="h-64 rounded-lg" />}
      {status?.choosing && (
        <Card>
          <div className="space-y-5 p-1 md:p-2">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#e8f1ff] text-[#1877f2]"><Facebook size={22} aria-hidden="true" /></div>
              <div><h2 className="text-lg font-semibold text-ink">Choose a Page</h2><p className="mt-1 text-sm text-ink-3">Select the Facebook Page to connect to this workspace.</p></div>
            </div>
            {status.pages.length === 0 ? (
              <div className="rounded-lg border border-hairline bg-paper-2 p-4 text-sm text-ink-2">No Pages were found for this Facebook account. Sign in with an account that manages a Page.</div>
            ) : (
              <div className="space-y-2">{status.pages.map((page) => (
                <div key={page.id} className="flex flex-col gap-3 rounded-lg border border-hairline p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="font-medium text-ink">{page.name}</p><p className="mt-0.5 text-xs text-ink-3">Page ID {page.id}</p></div>
                  <Button variant="primary" disabled={busy} onClick={() => void choose(page.id)}>Connect Page</Button>
                </div>
              ))}</div>
            )}
            <Button asChild variant="link"><a href="/api/integrations/facebook-page/connect">Use a different Facebook account</a></Button>
          </div>
        </Card>
      )}
      {status?.connected && !status.choosing && (
        <Card>
          <div className="space-y-6 p-1 md:p-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#e8f1ff] text-[#1877f2]"><Facebook size={24} aria-hidden="true" /></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Facebook Page</p><h2 className="mt-1 text-xl font-semibold text-ink">{status.pageName}</h2><p className="mt-1 text-xs text-ink-3">Page ID {status.pageId}</p></div>
              </div>
              <Badge kind="success" dot>Connected</Badge>
            </div>
            {status.instagram ? <div className="flex items-center gap-3 rounded-lg border border-hairline bg-paper-2 px-4 py-3 text-sm text-ink-2">
              <Instagram size={18} className="shrink-0 text-[#c13584]" aria-hidden="true" />
              <span>Instagram <strong className="text-ink">@{status.instagram.username ?? "linked"}</strong> is linked to this Page. Posts can go to Facebook and Instagram.</span>
            </div> : <div className="rounded-lg border border-hairline bg-paper-2 px-4 py-3 text-sm text-ink-2">
              Instagram is not linked. In Facebook, open this Page&apos;s Settings → Linked accounts → Instagram and connect a professional account, then press Reconnect here.
            </div>}
            <div className="flex flex-col gap-3 border-t border-hairline pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2"><Button asChild variant="primary"><a href="/marketing/social-content">Open content studio</a></Button><Button asChild variant="outline"><a href={`https://business.facebook.com/latest/home?asset_id=${status.pageId}`} target="_blank" rel="noopener noreferrer">Meta Business Suite <ArrowUpRight size={15} aria-hidden="true" /></a></Button></div>
              {status.canManage && <div className="flex flex-wrap items-center gap-2"><Button asChild variant="outline"><a href="/api/integrations/facebook-page/connect">Reconnect / change Page</a></Button><Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button></div>}
            </div>
            {confirmDisconnect && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose/30 bg-rose-soft p-4">
                <p className="text-sm text-rose-ink">Disconnect {status.pageName} from this workspace?</p>
                <div className="flex gap-2"><Button size="sm" onClick={() => setConfirmDisconnect(false)} disabled={busy}>Cancel</Button><Button size="sm" variant="danger" loading={busy} onClick={() => void disconnect()}>Disconnect Page</Button></div>
              </div>
            )}
          </div>
        </Card>
      )}
      {status && !status.connected && !status.choosing && (
        <Card>
          <div className="space-y-6 p-1 md:p-2">
            <div className="flex items-start gap-3"><div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#e8f1ff] text-[#1877f2]"><Facebook size={24} aria-hidden="true" /></div><div><Badge kind="muted">Not connected</Badge><h2 className="mt-2 text-xl font-semibold text-ink">Connect your Facebook Page</h2><p className="mt-1 text-sm text-ink-3">Choose a Page you manage and link it to this workspace.</p></div></div>
            <div className="grid gap-3 border-y border-hairline py-5 sm:grid-cols-2">
              <div className="flex gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-2 text-xs font-semibold text-ink">1</span><p className="text-sm text-ink-2">Sign in with the Facebook account that manages your Page.</p></div>
              <div className="flex gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-2 text-xs font-semibold text-ink">2</span><p className="text-sm text-ink-2">Choose which Page to connect to ResellerOS.</p></div>
            </div>
            {!status.configured && <p className="text-sm text-amber-ink">Meta app keys are not set on this server.</p>}
            {status.configured && status.canManage ? <Button asChild variant="primary"><a href="/api/integrations/facebook-page/connect"><Link2 size={16} aria-hidden="true" /> Connect Facebook Page</a></Button> : <Button variant="primary" disabled>{status.canManage ? "Connect Facebook Page" : "Owner or manager required"}</Button>}
            <details className="border-t border-hairline pt-4 text-xs text-ink-3"><summary className="cursor-pointer font-medium text-ink-2">Developer setup</summary><p className="mt-2">Add this URL to Valid OAuth Redirect URIs in Meta Developers:</p><code className="mt-1 block break-all rounded-md bg-paper-2 p-2">{redirectUrl}</code></details>
          </div>
        </Card>
      )}
    </div>
  );
}
