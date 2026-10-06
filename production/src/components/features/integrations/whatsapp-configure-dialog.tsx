/**
 * WhatsAppConfigureDialog — Meta Cloud API credential editor.
 *
 * Fields:
 *   - Phone Number ID  (visible — identifier, not secret)
 *   - Access Token     (Bearer; never shown back after save)
 *   - WABA ID          (optional — useful for template management later)
 *   - App Secret       (used to verify inbound webhook HMAC signatures)
 *   - Verify Token     (random string Pardeep also sets in Meta dashboard
 *                       so the GET webhook ping handshake succeeds)
 *
 * Shows the derived webhook URL Pardeep needs to paste into Meta's
 * webhook subscription form.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface WhatsAppStatus {
  ok:                   boolean;
  configured:           boolean;
  provider:             string;
  phone_number_id:      string | null;
  access_token_mask:    string | null;
  business_account_id:  string | null;
  app_secret_mask:      string | null;
  verify_token:         string | null;
  webhook_url:          string;
  updated_at:           string | null;
}

function useWhatsAppStatus() {
  return useQuery({
    queryKey: ["integrations", "whatsapp"],
    queryFn: async (): Promise<WhatsAppStatus> => {
      const res = await fetch("/api/integrations/whatsapp");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not load WhatsApp status");
      return json as WhatsAppStatus;
    },
  });
}

function randomVerifyToken(): string {
  // Crypto-safe enough for a webhook handshake. Not a session secret.
  const a = (globalThis.crypto?.getRandomValues?.(new Uint8Array(12))) ?? null;
  const bytes = a ?? new Uint8Array(12).map(() => Math.floor(Math.random() * 256));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function WhatsAppConfigureDialog({ open, onOpenChange }: Props) {
  const { data: status, isLoading } = useWhatsAppStatus();
  const qc = useQueryClient();

  const [phoneNumberId,      setPhoneNumberId]      = React.useState("");
  const [accessToken,        setAccessToken]        = React.useState("");
  const [businessAccountId,  setBusinessAccountId]  = React.useState("");
  const [appSecret,          setAppSecret]          = React.useState("");
  const [verifyToken,        setVerifyToken]        = React.useState("");
  const [showToken,    setShowToken]    = React.useState(false);
  const [showSecret,   setShowSecret]   = React.useState(false);
  const [testing,      setTesting]      = React.useState(false);

  // Initialise non-secret fields from status when it lands.
  // Depend on the whole `status` object — TanStack Query gives us a stable
  // reference when nothing changed, so this won't loop.
  React.useEffect(() => {
    if (!status) return;
    if (status.phone_number_id)     setPhoneNumberId(status.phone_number_id);
    if (status.business_account_id) setBusinessAccountId(status.business_account_id);
    if (status.verify_token)        setVerifyToken(status.verify_token);
  }, [status]);

  const save = useMutation({
    mutationFn: async () => {
      if (!phoneNumberId.trim() || !accessToken.trim()) {
        throw new Error("Phone Number ID and Access Token are required");
      }
      const res = await fetch("/api/integrations/whatsapp", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          provider:            "meta",
          phone_number_id:     phoneNumberId.trim(),
          access_token:        accessToken.trim(),
          business_account_id: businessAccountId.trim() || undefined,
          app_secret:          appSecret.trim()         || undefined,
          verify_token:        verifyToken.trim()       || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Save failed");
    },
    onSuccess: () => {
      toast.success("WhatsApp credentials saved");
      qc.invalidateQueries({ queryKey: ["integrations", "whatsapp"] });
      // Wipe the secret-bearing inputs from memory (they're persisted server-side)
      setAccessToken(""); setAppSecret("");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/whatsapp", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Disconnect failed");
    },
    onSuccess: () => {
      toast.success("WhatsApp credentials cleared");
      qc.invalidateQueries({ queryKey: ["integrations", "whatsapp"] });
      setPhoneNumberId(""); setAccessToken(""); setBusinessAccountId("");
      setAppSecret(""); setVerifyToken("");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  async function testConnection() {
    setTesting(true);
    try {
      const res = await fetch("/api/integrations/whatsapp/test", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        toast.success(
          `Connected ✓ — ${json.verified_name ?? "unverified"} · ${json.display_number ?? ""} · quality ${json.quality_rating ?? "?"}`,
        );
      } else {
        toast.error(json.error ?? "Test failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    } finally {
      setTesting(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Clipboard blocked"),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-emerald mb-1 inline-flex items-center gap-1.5">
            <Icon name="whatsapp" size={11} /> Integration · Meta WhatsApp Cloud API
          </p>
          <h2 className="font-serif text-2xl text-ink">WhatsApp Business</h2>
          <p className="text-xs text-ink-3 mt-1">
            Add Meta Cloud API credentials so quotes, invoices, and renewal nudges can go out over WhatsApp.
          </p>
        </header>

        {isLoading ? (
          <p className="text-xs text-ink-3">Loading current status…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-ink">Current state</p>
                <p className="text-2xs text-ink-3">
                  {status?.configured
                    ? <>Configured · token {status.access_token_mask} · saved {status.updated_at ? formatDate(status.updated_at) : "—"}</>
                    : "Not configured — no WhatsApp sends will happen until you set up credentials"}
                </p>
              </div>
              {status?.configured
                ? <Badge kind="success" dot>Live</Badge>
                : <Badge kind="muted" dot>Off</Badge>
              }
            </div>

            <div>
              <Label htmlFor="wa-phone-number-id">Phone Number ID *</Label>
              <Input id="wa-phone-number-id"
                className="font-mono"
                placeholder="123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                autoComplete="off"
              />
              <p className="text-3xs text-ink-3 mt-1">
                Meta dashboard · WhatsApp · API Setup · "Phone number ID" (not the phone number itself)
              </p>
            </div>

            <div className="min-w-0">
              <Label htmlFor="wa-access-token">Access Token *</Label>
              <div className="flex gap-2 min-w-0">
                <Input id="wa-access-token"
                  type={showToken ? "text" : "password"}
                  className="font-mono min-w-0 flex-1"
                  placeholder="EAA..."
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  autoComplete="off"
                />
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setShowToken((v) => !v)} aria-label={showToken ? "Hide access token" : "Show access token"} aria-pressed={showToken}>
                  <Icon name={showToken ? "eye_off" : "eye"} size={14} />
                </Button>
              </div>
              <p className="text-3xs text-ink-3 mt-1 break-words">
                Prefer a <b>System User token</b> — those never expire. Temporary user tokens last 24 hrs only.
              </p>
            </div>

            <div>
              <Label htmlFor="wa-waba-id">Business Account ID (WABA) — optional</Label>
              <Input id="wa-waba-id"
                className="font-mono"
                placeholder="987654321098765"
                value={businessAccountId}
                onChange={(e) => setBusinessAccountId(e.target.value)}
                autoComplete="off"
              />
              <p className="text-3xs text-ink-3 mt-1">
                Needed when we add template management. Safe to leave blank for first send.
              </p>
            </div>

            <div className="border-t border-hairline pt-4">
              <p className="text-xs font-semibold text-ink mb-2 inline-flex items-center gap-1.5">
                <Icon name="link" size={12} /> Inbound webhook (for receiving messages)
              </p>

              <div className="rounded-md bg-paper-2 p-3 space-y-2 min-w-0">
                <div className="min-w-0">
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                    Callback URL — paste this in Meta dashboard
                  </p>
                  <div className="flex items-center gap-2 min-w-0">
                    <code
                      className="font-mono text-2xs text-ink-2 bg-paper px-2 py-1 rounded flex-1 min-w-0 truncate"
                      title={status?.webhook_url}
                    >
                      {status?.webhook_url ?? "loading…"}
                    </code>
                    <Button
                      type="button" variant="ghost" size="sm"
                      className="shrink-0"
                      onClick={() => status?.webhook_url && copyToClipboard(status.webhook_url, "Webhook URL")}
                    >
                      <Icon name="copy" size={12} />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 min-w-0">
                  <div className="min-w-0">
                    <Label htmlFor="wa-verify-token">Verify Token</Label>
                    <div className="flex gap-2 min-w-0">
                      <Input id="wa-verify-token"
                        className="font-mono min-w-0 flex-1"
                        placeholder="auto-generated"
                        value={verifyToken}
                        onChange={(e) => setVerifyToken(e.target.value)}
                      />
                      <Button
                        type="button" variant="ghost" size="sm"
                        className="shrink-0"
                        onClick={() => setVerifyToken(randomVerifyToken())}
                        title="Generate fresh"
                      >
                        <Icon name="refresh" size={13} />
                      </Button>
                    </div>
                    <p className="text-3xs text-ink-3 mt-1 break-words">
                      Set the same value in Meta&apos;s webhook subscription form.
                    </p>
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor="wa-app-secret">App Secret — optional</Label>
                    <div className="flex gap-2 min-w-0">
                      <Input id="wa-app-secret"
                        type={showSecret ? "text" : "password"}
                        className="font-mono min-w-0 flex-1"
                        placeholder="x-hub-signature key"
                        value={appSecret}
                        onChange={(e) => setAppSecret(e.target.value)}
                        autoComplete="off"
                      />
                      <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setShowSecret((v) => !v)} aria-label={showSecret ? "Hide app secret" : "Show app secret"} aria-pressed={showSecret}>
                        <Icon name={showSecret ? "eye_off" : "eye"} size={14} />
                      </Button>
                    </div>
                    <p className="text-3xs text-ink-3 mt-1 break-words">
                      Used to validate HMAC on inbound webhooks. Recommended.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-md bg-paper-2 p-3 text-xs text-ink-3 leading-relaxed break-words">
              <p className="font-medium text-ink-2 mb-1 inline-flex items-center gap-1.5">
                <Icon name="lock" size={11} /> Security
              </p>
              Token + secret are stored in <span className="font-mono">tenant_secrets</span>, RLS-locked to your workspace owner role. They never leave the server after save.
            </div>
          </div>
        )}

        <DialogFooter>
          {status?.configured && (
            <Button
              type="button"
              variant="ghost"
              icon="trash"
              onClick={() => disconnect.mutate()}
              loading={disconnect.isPending}
              className="text-rose hover:text-rose"
            >
              Disconnect
            </Button>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            onClick={testConnection}
            loading={testing}
            disabled={!status?.configured}
          >
            <Icon name="zap" size={14} /> Test
          </Button>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            icon="check"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!phoneNumberId.trim() || !accessToken.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
