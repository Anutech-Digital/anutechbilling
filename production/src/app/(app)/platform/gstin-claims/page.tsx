/**
 * Platform › GSTIN ownership — R-2445 (G-NETWORK). FOUNDER-ONLY.
 *
 * A company asks "Prove you own this GSTIN" in Settings → Network. Here the platform admin sees
 * the company, its GSTIN, the legal / trade name GSTN returned for it, the owner's note, and how
 * many OTHER companies saved the same GSTIN — then approves the real owner or rejects with a
 * reason the company sees. Never first come: approving one rejects every other open claim on
 * that GSTIN. A wrong approval is undone with Revoke (reason required); every connection made
 * on that GSTIN stops at once. The server (/api/platform/gstin-claims) re-checks the founder
 * allowlist before anything is read.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadErrorInline } from "@/components/shared/load-error";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

type Claim = {
  claim_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_email: string | null;
  gstin: string;
  gstn_legal_name: string | null;
  gstn_trade_name: string | null;
  /** lapsed = approved, but the company has since changed its GSTIN (it no longer holds it). */
  status: "pending" | "approved" | "rejected" | "withdrawn" | "revoked" | "lapsed";
  note: string | null;
  requested_at: string;
  requested_by_email: string | null;
  same_gstin_tenants: number;
  holder_tenant_id: string | null;
  holder_name: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
};

const TABS = [
  { id: "pending", label: "Waiting" },
  { id: "approved", label: "Approved" },
  { id: "all", label: "All" },
];

type Pending = { kind: "approve" | "reject" | "revoke"; claim: Claim } | null;

async function send(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/platform/gstin-claims", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error ?? "Nothing was changed. Refresh the page and try again.");
}

export default function PlatformGstinClaimsPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const [tab, setTab] = React.useState("pending");
  const [pending, setPending] = React.useState<Pending>(null);
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const q = useQuery({
    queryKey: ["platform-gstin-claims", tab],
    enabled: Boolean(me?.isPlatformAdmin),
    queryFn: async (): Promise<Claim[]> => {
      const res = await fetch(`/api/platform/gstin-claims?status=${tab}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load the claims.");
      return json.claims ?? [];
    },
  });

  const open = (kind: "approve" | "reject" | "revoke", claim: Claim) => { setNote(""); setPending({ kind, claim }); };

  async function confirmAction() {
    if (!pending) return;
    const { kind, claim } = pending;
    if (kind === "revoke" && !note.trim()) {
      toast.error("Write why the ownership is revoked.", { description: "The company sees this reason in Settings → Network." });
      return;
    }
    setSaving(true);
    try {
      await send(kind === "revoke"
        ? { action: "revoke", tenantId: claim.tenant_id, note: note.trim() }
        : { action: kind, claimId: claim.claim_id, note: note.trim() || undefined });
      toast.success(kind === "approve" ? `${claim.tenant_name} now owns GSTIN ${claim.gstin}.`
        : kind === "reject" ? "Claim rejected — the company sees your reason." : "Ownership revoked.");
      setPending(null);
      await q.refetch();
    } catch (e) {
      toastError(e, { fallback: "Nothing was changed", description: "Refresh the list and try again." });
    } finally {
      setSaving(false);
    }
  }

  if (meLoading) return null;
  if (!me?.isPlatformAdmin) {
    return (
      <EmptyState
        title="Platform admins only"
        body="This page is for the ResellerOS team. Your company's own GSTIN status is in Settings → Network."
        action={<Link href="/settings?tab=network"><Button>Open Settings → Network</Button></Link>}
      />
    );
  }

  const rows = q.data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl text-ink">GSTIN ownership</h1>
        <p className="mt-1 text-sm text-ink-3">
          Companies asking to be confirmed as the owner of their GSTIN before they can connect with other businesses.
          Check the GSTN legal name against the company, and the GST certificate (REG-06) or a call to the registered
          contact. Approving one company rejects every other open claim on the same GSTIN.{" "}
          <Link href="/platform" className="text-primary underline underline-offset-2">Back to Signups</Link>
        </p>
      </div>
      <TabBar items={TABS} value={tab} onChange={setTab} />

      {q.isError ? (
        <LoadErrorInline what="GSTIN ownership claims" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === "pending" ? "No claims waiting" : "No claims here"}
          body="When a company presses “Prove you own this GSTIN” in Settings → Network, it shows up here."
          action={<Button onClick={() => void q.refetch()}>Refresh</Button>}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <Card key={c.claim_id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{c.tenant_name}</p>
                    <span className="text-sm text-ink-2">GSTIN {c.gstin}</span>
                    <Badge size="sm" kind={c.status === "approved" ? "success" : c.status === "pending" ? "warning" : "muted"}>
                      {c.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-ink-3">
                    GSTN legal name: <span className="text-ink-2">{c.gstn_legal_name ?? "—"}</span>
                    {c.gstn_trade_name ? <> · trade name: <span className="text-ink-2">{c.gstn_trade_name}</span></> : null}
                  </p>
                  <p className="text-xs text-ink-3">
                    Asked {formatDate(c.requested_at)}{c.requested_by_email ? ` by ${c.requested_by_email}` : ""}
                    {c.tenant_email ? ` · company email ${c.tenant_email}` : ""}
                  </p>
                  {c.note && <p className="text-xs text-ink-2">Their note: {c.note}</p>}
                  {c.same_gstin_tenants > 1 && (
                    <p className="text-xs font-medium text-danger">
                      {c.same_gstin_tenants} companies on ResellerOS have saved this GSTIN — approve only the real owner.
                    </p>
                  )}
                  {c.holder_name && c.holder_tenant_id !== c.tenant_id && (
                    <p className="text-xs text-ink-2">Proved owner now: {c.holder_name}</p>
                  )}
                  {c.decided_at && (
                    <p className="text-xs text-ink-3">
                      {c.status} {formatDate(c.decided_at)}{c.decided_by ? ` by ${c.decided_by}` : ""}{c.decision_note ? ` — ${c.decision_note}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {c.status === "pending" && (
                    <>
                      <Button size="sm" variant="primary" onClick={() => open("approve", c)}>Approve</Button>
                      <Button size="sm" onClick={() => open("reject", c)}>Reject</Button>
                    </>
                  )}
                  {c.status === "approved" && c.holder_tenant_id === c.tenant_id && (
                    <Button size="sm" variant="ghost" onClick={() => open("revoke", c)}>Revoke ownership</Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "approve" ? `Approve ${pending.claim.tenant_name} as owner of ${pending.claim.gstin}?`
                : pending?.kind === "reject" ? `Reject ${pending?.claim.tenant_name}'s claim?`
                : `Revoke ${pending?.claim.tenant_name}'s ownership of ${pending?.claim.gstin}?`}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "approve"
                ? "They can then connect with other businesses on this GSTIN. Every other open claim on this GSTIN is rejected."
                : pending?.kind === "reject"
                  ? "They see your reason in Settings → Network and can ask again."
                  : "Every connection made on this GSTIN stops at once. They see your reason in Settings → Network."}
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="gstin-claim-note" className="mb-1 block text-xs font-medium text-ink-2">
            {pending?.kind === "approve" ? "What you checked (optional)" : "Reason (shown to the company)"}
          </label>
          <Textarea id="gstin-claim-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button onClick={() => setPending(null)} disabled={saving}>Cancel</Button>
            <Button variant={pending?.kind === "approve" ? "primary" : "danger"} onClick={() => void confirmAction()} disabled={saving}>
              {saving ? "Saving…" : pending?.kind === "approve" ? "Approve" : pending?.kind === "reject" ? "Reject" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
