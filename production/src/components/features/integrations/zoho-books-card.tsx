"use client";
/**
 * R-1749 — Settings → Integrations → Zoho Books.
 *
 * Each company connects ITS OWN Zoho Books (read-only). States, one primary button each:
 *   not set up on this server → "Connect Zoho Books" only says so (nothing starts)
 *   not connected             → Connect Zoho Books (full-page redirect to Zoho's consent screen)
 *   connected, no organization → choose one organization → Use this organization
 *   connected                 → "Connected: <org>" · Preview from Zoho · Disconnect
 * Preview shows COUNTS only; importing is a separate step (follow-up card).
 * The token never reaches this page — the server keeps it.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useConfirm } from "@/components/providers/confirm-provider";

const STATUS_URL = "/api/integrations/zoho-books";
const CONNECT_URL = "/api/integrations/zoho-books/connect";
const NOT_SET_UP = "Zoho Books is not set up on this server";

interface ZohoStatus {
  configured: boolean;
  connected: boolean;
  needs_org: boolean;
  org_name: string | null;
  can_manage: boolean;
}
interface Preview {
  contacts: number; invoices: number; openInvoices: number;
  withSubsPeriod: number; withServiceExpiry: number; capped: boolean;
}

/** What Zoho's redirect (?zoho=…) means, said once as a toast. */
export const ZOHO_RETURN_MESSAGES: Record<string, { tone: "ok" | "calm" | "error"; text: string }> = {
  connected: { tone: "ok", text: "Zoho Books connected. Now choose your organization." },
  denied: { tone: "calm", text: "Zoho Books was not connected — access was not allowed on the Zoho screen." },
  badstate: { tone: "error", text: "The Zoho sign-in could not be verified. Press Connect Zoho Books again." },
  error: { tone: "error", text: "Zoho Books could not be connected. Press Connect Zoho Books again." },
  notconfigured: { tone: "calm", text: NOT_SET_UP },
  role: { tone: "error", text: "Only an owner, manager or accountant can connect Zoho Books." },
  novault: { tone: "error", text: "This server cannot store the Zoho sign-in safely yet. The ResellerOS admin needs to turn on secret storage." },
};

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

const fmt = (n: number) => n.toLocaleString("en-IN");

export default function ZohoBooksCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<null | "org" | "preview" | "disconnect">(null);
  const [orgId, setOrgId] = React.useState("");
  const [preview, setPreview] = React.useState<Preview | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: ["integrations", "zoho-books"],
    queryFn: async (): Promise<ZohoStatus | null> => {
      const res = await fetch(STATUS_URL);
      return res.ok ? ((await res.json()) as ZohoStatus) : null;
    },
  });

  const needsOrg = Boolean(status?.connected && status.needs_org && status.can_manage);
  const { data: orgs, isLoading: orgsLoading, error: orgsError } = useQuery({
    queryKey: ["integrations", "zoho-books", "organizations"],
    enabled: needsOrg,
    queryFn: async () => {
      const res = await fetch(`${STATUS_URL}/organizations`);
      const body = await jsonOf(res);
      if (!res.ok) throw new Error(String(body.error ?? "Could not read your Zoho Books organizations."));
      return (body.organizations as Array<{ id: string; name: string }>) ?? [];
    },
  });
  /* One organization (the usual case) is pre-selected. */
  React.useEffect(() => {
    if (orgs && orgs.length && !orgId) setOrgId(orgs[0].id);
  }, [orgs, orgId]);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const p = url.searchParams.get("zoho");
    if (!p) return;
    const m = ZOHO_RETURN_MESSAGES[p];
    if (m) (m.tone === "ok" ? toast.success : m.tone === "calm" ? toast : toast.error)(m.text);
    url.searchParams.delete("zoho");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations", "zoho-books"] });

  async function chooseOrg() {
    if (!orgId) return;
    setBusy("org");
    try {
      const res = await fetch(`${STATUS_URL}/organizations`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organization_id: orgId }),
      });
      const body = await jsonOf(res);
      if (!res.ok) { toast.error(String(body.error ?? "Could not save the organization."), { description: "Nothing was changed. Try again." }); return; }
      toast.success(`Zoho Books organization set: ${String(body.org_name ?? "")}`);
      await refresh();
    } finally { setBusy(null); }
  }

  async function runPreview() {
    setBusy("preview");
    try {
      const res = await fetch(`${STATUS_URL}/preview`, { method: "POST" });
      const body = await jsonOf(res);
      if (!res.ok) { toast.error(String(body.error ?? "Could not read from Zoho Books."), { description: "Nothing was imported or changed." }); return; }
      setPreview(body.preview as Preview);
    } finally { setBusy(null); }
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect Zoho Books?",
      body: "ResellerOS stops reading from your Zoho Books and removes its access at Zoho. Nothing in Zoho Books is changed.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy("disconnect");
    try {
      const res = await fetch(STATUS_URL, { method: "DELETE" });
      const body = await jsonOf(res);
      if (!res.ok) { toast.error(String(body.error ?? "Could not disconnect."), { description: "Zoho Books is still connected. Refresh the page and try again." }); return; }
      if (body.revoked === false) {
        toast.success("Zoho Books disconnected here", { description: "Zoho could not be reached to remove access. You can remove ResellerOS under Connected Apps in your Zoho account." });
      } else {
        toast.success("Zoho Books disconnected");
      }
      setPreview(null);
      setOrgId("");
      await refresh();
    } finally { setBusy(null); }
  }

  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const canManage = status?.can_manage ?? false;

  const sub = isLoading ? "Checking…"
    : !configured ? NOT_SET_UP
      : connected && status?.org_name ? `Connected: ${status.org_name}`
        : connected ? "Connected · choose your Zoho Books organization"
          : canManage ? "Bring your customers and invoices over from your own Zoho Books (read-only)"
            : "Not connected · only an owner, manager or accountant can connect Zoho Books";

  return (
    <Card className="p-5 mb-4" data-testid="zoho-books-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
            <Icon name="book" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
              Zoho Books
              {!isLoading && (connected
                ? <Badge size="sm" kind="success">Connected</Badge>
                : configured ? <Badge size="sm" kind="warning">Not connected</Badge>
                  : <Badge size="sm" kind="muted">Not available</Badge>)}
            </p>
            <p className="text-xs text-ink-3">{sub}</p>
          </div>
        </div>

        {!isLoading && canManage && (
          <div className="flex items-center gap-1.5 shrink-0">
            {!configured ? (
              <Button variant="primary" size="sm" onClick={() => toast(NOT_SET_UP)}>
                Connect Zoho Books
              </Button>
            ) : !connected ? (
              /* Full-page redirect to Zoho's consent screen — not a fetch. */
              <Button asChild variant="primary" size="sm">
                <a href={CONNECT_URL}>Connect Zoho Books</a>
              </Button>
            ) : (
              <>
                {status?.org_name && (
                  <Button variant="primary" size="sm" onClick={runPreview} loading={busy === "preview"}>
                    {busy === "preview" ? "Reading Zoho…" : "Preview from Zoho"}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy !== null}>Disconnect</Button>
              </>
            )}
          </div>
        )}
      </div>

      {needsOrg && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1 max-w-sm">
            <label htmlFor="zoho-org" className="mb-1 block text-xs font-medium text-ink-3">Zoho Books organization</label>
            <select
              id="zoho-org"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              disabled={orgsLoading || !orgs?.length}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink"
            >
              {orgsLoading && <option value="">Loading organizations…</option>}
              {orgs?.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
              {!orgsLoading && orgs && orgs.length === 0 && <option value="">No organization found in this Zoho login</option>}
            </select>
          </div>
          <Button variant="primary" size="sm" onClick={chooseOrg} loading={busy === "org"} disabled={!orgId || busy !== null}>
            Use this organization
          </Button>
          {orgsError && <p className="w-full text-xs text-rose">{(orgsError as Error).message}</p>}
        </div>
      )}

      {preview && (
        <div className="mt-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Contacts", preview.contacts],
              ["Invoices", preview.invoices],
              ["Open invoices (balance due)", preview.openInvoices],
              ["Invoices with Subs Period", preview.withSubsPeriod],
              ["Invoices with Service Expiry", preview.withServiceExpiry],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-lg border border-hairline p-3">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd className="mt-0.5 text-lg font-semibold text-ink tabular-nums">{fmt(n as number)}{preview.capped ? "+" : ""}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-ink-3">
            Counts only, read from Zoho Books just now. Nothing has been imported and nothing in Zoho was changed.
          </p>
        </div>
      )}
    </Card>
  );
}
