/**
 * RazorpayConfigureDialog — Razorpay credentials editor.
 *
 * Mode (test/live) is inferred from the Key ID prefix:
 *   rzp_test_*  → test mode
 *   rzp_live_*  → live mode
 *
 * Key Secret + Webhook Secret never leave the server after save —
 * masked previews only.
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
import { formatDate } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface RazorpayStatus {
  ok:                   boolean;
  configured:           boolean;
  mode:                 "test" | "live";
  key_id:               string | null;
  key_secret_mask:      string | null;
  webhook_secret_mask:  string | null;
  webhook_url:          string;
  updated_at:           string | null;
}

function useRazorpayStatus() {
  return useQuery({
    queryKey: ["integrations", "razorpay"],
    queryFn: async (): Promise<RazorpayStatus> => {
      const res = await fetch("/api/integrations/razorpay");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not load Razorpay status");
      return json as RazorpayStatus;
    },
  });
}

export default function RazorpayConfigureDialog({ open, onOpenChange }: Props) {
  const { data: status, isLoading } = useRazorpayStatus();
  const qc = useQueryClient();

  const [keyId,         setKeyId]         = React.useState("");
  const [keySecret,     setKeySecret]     = React.useState("");
  const [webhookSecret, setWebhookSecret] = React.useState("");
  const [showSecret,    setShowSecret]    = React.useState(false);
  const [showWebhook,   setShowWebhook]   = React.useState(false);
  const [testing,       setTesting]       = React.useState(false);

  React.useEffect(() => {
    if (status?.key_id) setKeyId(status.key_id);
  }, [status?.key_id]);

  const inferredMode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : null;

  const save = useMutation({
    mutationFn: async () => {
      if (!keyId.trim()) throw new Error("Key ID is required");
      // A secret is only required the FIRST time. After that a blank box means
      // "I did not retype it" and the server keeps what is stored — which is the
      // whole point of the fix, since this dialog never prefills a secret.
      if (!status?.configured && !keySecret.trim()) {
        throw new Error("Key Secret is required the first time you connect Razorpay");
      }
      const res = await fetch("/api/integrations/razorpay", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          key_id:     keyId.trim(),
          // Omitted entirely when blank. Sending "" would be a request to store an
          // empty secret; sending nothing is a request to leave it alone.
          key_secret:     keySecret.trim() || undefined,
          webhook_secret: webhookSecret.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Save failed");
      return json as { mode: "test" | "live" };
    },
    onSuccess: (data) => {
      toast.success(`Razorpay credentials saved · ${data.mode.toUpperCase()} mode`);
      qc.invalidateQueries({ queryKey: ["integrations", "razorpay"] });
      setKeySecret(""); setWebhookSecret("");
    },
    onError: (err) => toastError(err, {
      fallback: "Razorpay keys were not saved.",
      description: "Copy the Key ID and Key Secret again from Razorpay Dashboard → Account & Settings → API Keys, then press Save.",
    }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/razorpay", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Disconnect failed");
    },
    onSuccess: () => {
      toast.success("Razorpay credentials cleared");
      qc.invalidateQueries({ queryKey: ["integrations", "razorpay"] });
      setKeyId(""); setKeySecret(""); setWebhookSecret("");
    },
    onError: (err) => toastError(err, {
      fallback: "Razorpay was not disconnected.",
      description: "Your saved keys are unchanged. Try again in a moment.",
    }),
  });

  async function testConnection() {
    setTesting(true);
    try {
      const res = await fetch("/api/integrations/razorpay/test", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        toast.success(`Connected ✓ — ${json.mode.toUpperCase()} mode · ${json.payments_seen} payment${json.payments_seen === 1 ? "" : "s"} in your account`);
      } else {
        toastError(json.error, {
          fallback: "Razorpay test failed.",
          description: "Check that the Key ID and Secret are from the same mode (test or live), save them again, then press Test.",
        });
      }
    } catch (e) {
      toastError(e, {
        fallback: "Could not reach the server.",
        description: "Check your internet connection and press Test again.",
      });
    } finally {
      setTesting(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Clipboard blocked", {
        description: "Your browser did not allow copying. Select the text and press Ctrl + C instead.",
      }),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1 inline-flex items-center gap-1.5">
            <Icon name="rupee" size={11} /> Integration · Razorpay
          </p>
          <h2 className="font-serif text-2xl text-ink">Payments</h2>
          <p className="text-xs text-ink-3 mt-1">
            Accept payments on the public buy page. Test mode accepts simulated cards/UPI; live mode takes real money.
          </p>
        </header>

        {isLoading ? (
          <p className="text-xs text-ink-3">Loading current status…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">Current state</p>
                <p className="text-2xs text-ink-3 truncate">
                  {status?.configured
                    ? <>Configured · {status.mode === "live" ? "LIVE" : "TEST"} mode · secret {status.key_secret_mask} · saved {status.updated_at ? formatDate(status.updated_at) : "—"}</>
                    : "Not configured — Buy page is in simulation mode"}
                </p>
              </div>
              {status?.configured
                ? <Badge kind={status.mode === "live" ? "success" : "warning"} dot>
                    {status.mode === "live" ? "Live" : "Test"}
                  </Badge>
                : <Badge kind="muted" dot>Off</Badge>
              }
            </div>

            <div className="min-w-0">
              <Label htmlFor="rzp-key-id">Key ID *</Label>
              <Input id="rzp-key-id"
                className="font-mono"
                placeholder="rzp_test_ABCDEF1234 or rzp_live_..."
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                autoComplete="off"
              />
              <p className="text-3xs text-ink-3 mt-1 break-words">
                Razorpay Dashboard · Settings · API Keys · "Key Id". {inferredMode && (
                  <span className={inferredMode === "live" ? "text-emerald font-medium" : "text-amber-ink font-medium"}>
                    Detected: {inferredMode.toUpperCase()} mode
                  </span>
                )}
              </p>
            </div>

            <div className="min-w-0">
              <Label htmlFor="rzp-key-secret">{status?.configured ? "Key Secret" : "Key Secret *"}</Label>
              <div className="flex gap-2 min-w-0">
                <Input id="rzp-key-secret"
                  type={showSecret ? "text" : "password"}
                  className="font-mono min-w-0 flex-1"
                  placeholder={status?.configured ? "leave blank to keep the saved secret" : "server-only secret"}
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  autoComplete="off"
                />
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setShowSecret((v) => !v)} aria-label={showSecret ? "Hide key secret" : "Show key secret"} aria-pressed={showSecret}>
                  <Icon name={showSecret ? "eye_off" : "eye"} size={14} />
                </Button>
              </div>
              <p className="text-3xs text-ink-3 mt-1">
                Generated alongside the Key ID. Never shown back after save.
              </p>
            </div>

            <div className="border-t border-hairline pt-4">
              <p className="text-xs font-semibold text-ink mb-2 inline-flex items-center gap-1.5">
                <Icon name="link" size={12} /> Webhook
              </p>

              <div className="rounded-md bg-paper-2 p-3 space-y-2 min-w-0">
                <div className="min-w-0">
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                    Webhook URL — paste this in Razorpay dashboard
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

                <div className="min-w-0 pt-1">
                  <Label htmlFor="rzp-webhook-secret">Webhook Secret — optional</Label>
                  <div className="flex gap-2 min-w-0">
                    <Input id="rzp-webhook-secret"
                      type={showWebhook ? "text" : "password"}
                      className="font-mono min-w-0 flex-1"
                      placeholder={status?.webhook_secret_mask ? "leave blank to keep the saved secret" : "webhook signing secret"}
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      autoComplete="off"
                    />
                    <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setShowWebhook((v) => !v)} aria-label={showWebhook ? "Hide webhook secret" : "Show webhook secret"} aria-pressed={showWebhook}>
                      <Icon name={showWebhook ? "eye_off" : "eye"} size={14} />
                    </Button>
                  </div>
                  <p className="text-3xs text-ink-3 mt-1">
                    Required for verifying <span className="font-mono">x-razorpay-signature</span> on payment captured / failed events. Set in Razorpay Dashboard · Settings · Webhooks.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-md bg-paper-2 p-3 text-xs text-ink-3 leading-relaxed break-words">
              <p className="font-medium text-ink-2 mb-1 inline-flex items-center gap-1.5">
                <Icon name="lock" size={11} /> Security
              </p>
              Stored in <span className="font-mono">tenant_secrets</span>, RLS-locked to your workspace owner role. Key Secret + Webhook Secret never round-trip back to the browser.
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
            /* Key Secret is required ONLY when connecting the first time. Once
               configured, blank means "keep the saved secret" (as the field's own
               hint says), so an owner can update JUST the webhook secret — this
               matched the save mutation's own rule but the button disabled it. */
            disabled={!keyId.trim() || (!status?.configured && !keySecret.trim())}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
