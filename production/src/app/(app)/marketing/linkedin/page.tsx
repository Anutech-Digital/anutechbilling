/** Connect a LinkedIn Company Page and publish text posts from ResellerOS. */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type Status = {
  configured: boolean; connected: boolean; expired: boolean; canManage: boolean;
  organizationUrn: string | null; organizationName: string | null; message?: string;
};

const resultMessages: Record<string, string> = {
  connected: "LinkedIn is connected. Add your Company Page URN, then publish a post.",
  denied: "LinkedIn permission was denied.", badstate: "The LinkedIn sign-in expired. Please connect again.",
  notconfigured: "LinkedIn app keys are not set on this server.", novault: "The server encryption key is not set.",
  role: "Only an owner or manager can connect LinkedIn.", error: "LinkedIn could not be connected. Try again.",
};

export default function LinkedInMarketingPage() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [urn, setUrn] = React.useState("");
  const [pageName, setPageName] = React.useState("");
  const [text, setText] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/integrations/linkedin", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load LinkedIn.");
    const next = await res.json() as Status;
    setStatus(next); setUrn(next.organizationUrn ?? ""); setPageName(next.organizationName ?? "");
  }, []);

  React.useEffect(() => { void load().catch((e) => toast.error(e.message)); }, [load]);
  React.useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("linkedin");
    if (!result) return;
    const message = resultMessages[result];
    if (message) result === "connected" ? toast.success(message) : toast.error(message);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  async function publish() {
    setPosting(true);
    try {
      const res = await fetch("/api/integrations/linkedin/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, organizationUrn: urn, organizationName: pageName }) });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not publish the post.");
      setText(""); toast.success("Posted on LinkedIn.");
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not publish the post."); }
    finally { setPosting(false); }
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/linkedin", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not disconnect LinkedIn.");
      toast.success("LinkedIn disconnected."); await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not disconnect LinkedIn."); }
    finally { setDisconnecting(false); }
  }

  if (!status) return <div className="mx-auto max-w-3xl p-4 md:p-6 lg:p-8"><Skeleton className="h-64 rounded-lg" /></div>;

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing Hub</p>
        <h1 className="font-serif text-3xl md:text-4xl">LinkedIn Company Page</h1>
        <p className="text-sm text-ink-3 mt-1">Connect the Company Page once, then publish project updates directly from ResellerOS.</p>
      </header>

      {!status.configured || !status.connected ? (
        <Card className="p-5 space-y-3">
          <h2 className="text-lg font-semibold">{status.expired ? "Reconnect LinkedIn" : "Connect LinkedIn"}</h2>
          <p className="text-sm text-ink-2">Use a LinkedIn account that is an administrator or content admin of the Company Page.</p>
          {status.message && <p className="text-sm text-amber-ink">{status.message}</p>}
          <p className="text-xs text-ink-3">The LinkedIn app needs approved Community Management access with the <code>w_organization_social</code> permission.</p>
          {status.configured && status.canManage ? <Button asChild variant="primary"><a href="/api/integrations/linkedin/connect">Connect LinkedIn</a></Button> : <Button variant="primary" disabled>{status.canManage ? "Connect LinkedIn" : "Owner or manager required"}</Button>}
        </Card>
      ) : (
        <Card className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div><h2 className="text-lg font-semibold">Publish to LinkedIn</h2><p className="text-sm text-ink-3 mt-1">Posts are published immediately to the selected Company Page.</p></div>
            {status.canManage && <Button variant="ghost" size="sm" onClick={() => void disconnect()} loading={disconnecting}>Disconnect</Button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Company Page URN" htmlFor="linkedin-urn">
              <Input id="linkedin-urn" value={urn} onChange={(e) => setUrn(e.target.value)} placeholder="urn:li:organization:12345" disabled={!status.canManage} />
            </FormField>
            <FormField label="Company Page name (optional)" htmlFor="linkedin-name">
              <Input id="linkedin-name" value={pageName} onChange={(e) => setPageName(e.target.value)} placeholder="Anutech Digital" disabled={!status.canManage} />
            </FormField>
          </div>
          <p className="-mt-2 text-xs text-ink-3">Find the numeric page ID in LinkedIn Page admin tools. It is saved after the first successful post.</p>
          <FormField label="Post" htmlFor="linkedin-post">
            <Textarea id="linkedin-post" value={text} onChange={(e) => setText(e.target.value)} rows={7} maxLength={3000} placeholder="We have completed a new customer project…" disabled={!status.canManage} />
          </FormField>
          <div className="flex justify-between items-center gap-3"><span className="text-xs text-ink-3">{text.length}/3000</span><Button variant="primary" icon="send" onClick={() => void publish()} loading={posting} disabled={!status.canManage || !text.trim() || !urn.trim()}>Publish now</Button></div>
        </Card>
      )}
    </div>
  );
}
