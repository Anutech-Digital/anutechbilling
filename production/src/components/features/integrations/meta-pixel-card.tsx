/**
 * R-1979 (26 Oct 2026, G-ADS): Settings → Integrations → Meta (Pixel + Conversions API).
 * A tile in "Connected services" and its dialog: Pixel ID, Conversions API token (sealed on the
 * server, never shown back — masked only), optional Test events code. Owner-only save / remove.
 * With no Pixel ID the website loads no Meta script and the server sends no event.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";

interface MetaStatus {
  ok: boolean; pixel_id: string | null; capi_token_set: boolean; capi_token_mask: string | null;
  test_event_code: string | null; can_manage: boolean;
}

const KEY = ["integrations", "meta-pixel"] as const;

function useMetaStatus() {
  return useQuery<MetaStatus | null>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch("/api/integrations/meta-pixel");
      return res.ok ? res.json() : null;
    },
  });
}

export function MetaPixelIntegrationCard() {
  const [open, setOpen] = React.useState(false);
  const { data: status } = useMetaStatus();
  const on = Boolean(status?.pixel_id);
  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
            <Icon name="chart" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
              Meta Pixel
              {on && <Badge size="sm" kind={status?.capi_token_set ? "success" : "warning"}>{status?.capi_token_set ? "PIXEL + API" : "PIXEL ONLY"}</Badge>}
            </p>
            <p className="text-xs text-ink-3 truncate">
              {on ? `Pixel ${status?.pixel_id}${status?.test_event_code ? " · test events on" : ""}` : "Facebook / Instagram ads don't see your sales yet"}
            </p>
          </div>
        </div>
        <Button variant={on ? "ghost" : "primary"} size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          {on ? "Manage" : "Setup"}
        </Button>
      </div>
      {open && <MetaPixelDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function MetaPixelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useMetaStatus();
  const [pixelId, setPixelId] = React.useState("");
  const [token, setToken] = React.useState("");
  const [testCode, setTestCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (status) { setPixelId(status.pixel_id ?? ""); setTestCode(status.test_event_code ?? ""); }
  }, [status]);
  const canManage = status?.can_manage !== false;

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/meta-pixel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pixel_id: pixelId.trim(), ...(token.trim() ? { capi_token: token.trim() } : {}), test_event_code: testCode.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Save failed");
    },
    onSuccess: () => {
      toast.success("Meta Pixel saved — the website now reports page views and purchases to Meta");
      qc.invalidateQueries({ queryKey: KEY });
      setToken("");
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Save failed");
      toastError(err, { fallback: "Meta Pixel not saved.", description: "Check the Pixel ID and token from Events Manager, then press Save again." });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/meta-pixel", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Remove failed");
    },
    onSuccess: () => {
      toast.success("Meta Pixel removed — no Meta script or event any more");
      qc.invalidateQueries({ queryKey: KEY });
      setPixelId(""); setToken(""); setTestCode("");
    },
    onError: (err) => toastError(err, { fallback: "Meta Pixel not removed.", description: "Refresh the page and try again." }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">Integration · Ads (Meta)</p>
          <h2 className="font-serif text-2xl text-ink">Meta Pixel and Conversions API</h2>
          <p className="text-xs text-ink-3 mt-1">
            Tells Facebook and Instagram ads which visits became purchases, so they can optimise for buyers. Only for visitors who accept analytics cookies.
          </p>
        </header>
        {isLoading ? (
          <p className="text-xs text-ink-3">Loading current status…</p>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canManage) save.mutate(); }}>
            <div>
              <Label htmlFor="meta-pixel-id">Pixel ID *</Label>
              <Input id="meta-pixel-id" inputMode="numeric" className="font-mono" placeholder="1234567890123456" value={pixelId}
                onChange={(e) => setPixelId(e.target.value.replace(/\D/g, ""))} disabled={!canManage} />
              <p className="text-3xs text-ink-3 mt-1">Events Manager → your dataset → Settings → Dataset ID.</p>
            </div>
            <div>
              <Label htmlFor="meta-capi-token">Conversions API token</Label>
              <Input id="meta-capi-token" type="password" className="font-mono" autoComplete="off" value={token}
                placeholder={status?.capi_token_set ? `Saved (${status.capi_token_mask ?? "hidden"}) — leave blank to keep` : "EAA…"}
                onChange={(e) => setToken(e.target.value)} disabled={!canManage} />
              <p className="text-3xs text-ink-3 mt-1">Settings → Conversions API → Generate access token. Stored encrypted, never shown back.</p>
            </div>
            <div>
              <Label htmlFor="meta-test-code">Test events code <span className="font-normal text-ink-3">(optional)</span></Label>
              <Input id="meta-test-code" className="font-mono" placeholder="TEST12345" value={testCode}
                onChange={(e) => setTestCode(e.target.value.trim())} disabled={!canManage} />
              <p className="text-3xs text-ink-3 mt-1">While set, purchases show under Test events. Clear it after testing.</p>
            </div>
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            {!canManage && <p className="text-xs text-ink-3">Only the workspace owner can change this.</p>}
            <DialogFooter>
              {status?.pixel_id && canManage && (
                <Button type="button" variant="ghost" onClick={() => remove.mutate()} aria-busy={remove.isPending}>Remove</Button>
              )}
              <Button type="submit" variant="primary" disabled={!canManage || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
