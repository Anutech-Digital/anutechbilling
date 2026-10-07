/**
 * SandboxConfigureDialog — owner-only form to save Sandbox.co.in API
 * credentials. The full secret is NEVER shown back after save — only a
 * masked preview ("sk-1234••••AB12") to confirm it landed.
 *
 * Save → server upserts into tenant_secrets (RLS owner-only).
 * Test → calls /api/gstin/verify with a known-valid GSTIN to confirm
 *        the credentials work end-to-end.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { toastError } from "@/lib/errors/toast-error";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { formatDate, isValidGstin } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface SandboxStatus {
  ok:               boolean;
  configured:       boolean;
  api_key_mask:     string | null;
  api_secret_mask:  string | null;
  api_base:         string;
  updated_at:       string | null;
}

function useSandboxStatus() {
  return useQuery({
    queryKey: ["integrations", "sandbox"],
    queryFn: async (): Promise<SandboxStatus> => {
      const res = await fetch("/api/integrations/sandbox");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not load Sandbox status");
      return json as SandboxStatus;
    },
  });
}

export default function SandboxConfigureDialog({ open, onOpenChange }: Props) {
  const { data: status, isLoading } = useSandboxStatus();
  const { data: me }                 = useCurrentUser();
  const qc = useQueryClient();
  const router = useRouter();

  const [apiKey,    setApiKey]    = React.useState("");
  const [apiSecret, setApiSecret] = React.useState("");
  const [apiBase,   setApiBase]   = React.useState("https://api.sandbox.co.in");
  const [showKey,    setShowKey]    = React.useState(false);
  const [showSecret, setShowSecret] = React.useState(false);
  const [testing,   setTesting]   = React.useState(false);

  // Initialise the base URL from status; key/secret stay blank because we
  // never want to read them back to the client.
  React.useEffect(() => {
    if (status?.api_base) setApiBase(status.api_base);
  }, [status?.api_base]);

  const save = useMutation({
    mutationFn: async () => {
      if (!apiKey.trim() || !apiSecret.trim()) {
        throw new Error("Both API key and secret are required");
      }
      const res = await fetch("/api/integrations/sandbox", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          api_key:    apiKey.trim(),
          api_secret: apiSecret.trim(),
          api_base:   apiBase.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Save failed");
    },
    onSuccess: () => {
      toast.success("Sandbox credentials saved");
      qc.invalidateQueries({ queryKey: ["integrations", "sandbox"] });
      setApiKey(""); setApiSecret("");  // wipe inputs from memory
    },
    onError: (err) => toastError(err, {
      fallback: "Couldn't save the Sandbox keys.",
      description: "Nothing changed. Copy the API key and secret again from your Sandbox dashboard and click Save.",
    }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/sandbox", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Disconnect failed");
    },
    onSuccess: () => {
      toast.success("Sandbox credentials cleared");
      qc.invalidateQueries({ queryKey: ["integrations", "sandbox"] });
    },
    onError: (err) => toastError(err, {
      fallback: "Couldn't clear the Sandbox keys.",
      description: "The saved keys are still in place. Refresh the page and try again.",
    }),
  });

  async function testConnection() {
    // Use the workspace's own GSTIN — it's guaranteed checksum-valid
    // (we save through the same validator) and Sandbox will return real
    // data for it. Visitor sees their own company info as confirmation.
    const testGstin = me?.tenantGstin?.trim().toUpperCase() ?? "";
    if (!testGstin || !isValidGstin(testGstin)) {
      toast.error("Your company GSTIN is missing or invalid.", {
        description: "The test checks your own GSTIN. Add it in Settings → Company, then come back and test.",
        action: { label: "Open Settings", onClick: () => { onOpenChange(false); router.push("/settings"); } },
      });
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/gstin/verify", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ gstin: testGstin, save: false }),
      });
      const json = await res.json();
      if (json.ok && !json.mock) {
        toast.success(`Connected ✓ — ${json.verification?.legal_name ?? "verification"} · ${json.verification?.status ?? "Unknown"}`);
      } else if (json.ok && json.mock) {
        toast.error("Still in test mode.", {
          description: "No Sandbox keys are saved yet. Enter the API key and secret above, click Save, then Test.",
        });
      } else {
        toastError(json.error, {
          fallback: "Sandbox test failed.",
          description: "Check the API key and secret match your Sandbox dashboard, save again, then Test.",
        });
      }
    } catch (e) {
      toastError(e, {
        fallback: "Couldn't reach the server.",
        description: "Check your internet connection and click Test again.",
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1 inline-flex items-center gap-1.5">
            <Icon name="settings" size={11} /> Integration · Sandbox.co.in
          </p>
          <h2 className="font-serif text-2xl text-ink">GSTIN verification</h2>
          <p className="text-xs text-ink-3 mt-1">
            Add your Sandbox API credentials so GSTIN verification hits the real GSTN portal instead of mock data.
          </p>
        </header>

        {isLoading ? (
          <p className="text-xs text-ink-3">Loading current status…</p>
        ) : (
          <div className="space-y-4">
            {/* Current status */}
            <div className="flex items-center justify-between rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-ink">Current state</p>
                <p className="text-2xs text-ink-3">
                  {status?.configured
                    ? <>Configured · API key {status.api_key_mask} · saved {status.updated_at ? formatDate(status.updated_at) : "—"}</>
                    : "Not configured — verifications return mock data right now"}
                </p>
              </div>
              {status?.configured
                ? <Badge kind="success" dot>Live</Badge>
                : <Badge kind="warning" dot>Mock</Badge>
              }
            </div>

            {/* API key + secret inputs */}
            <div>
              <Label htmlFor="sbx-api-key">API Key *</Label>
              <div className="flex gap-2">
                <Input id="sbx-api-key"
                  type={showKey ? "text" : "password"}
                  className="font-mono"
                  placeholder="key_test_..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey}>
                  <Icon name={showKey ? "eye_off" : "eye"} size={14} />
                </Button>
              </div>
              <p className="text-3xs text-ink-3 mt-1">
                Find at sandbox.co.in dashboard · API Keys section · uses `x-api-key` header
              </p>
            </div>

            <div>
              <Label htmlFor="sbx-api-secret">API Secret *</Label>
              <div className="flex gap-2">
                <Input id="sbx-api-secret"
                  type={showSecret ? "text" : "password"}
                  className="font-mono"
                  placeholder="secret_..."
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  autoComplete="off"
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowSecret((v) => !v)} aria-label={showSecret ? "Hide API secret" : "Show API secret"} aria-pressed={showSecret}>
                  <Icon name={showSecret ? "eye_off" : "eye"} size={14} />
                </Button>
              </div>
              <p className="text-3xs text-ink-3 mt-1">
                The secret is stored server-side only — never shown back after save.
              </p>
            </div>

            <div>
              <Label htmlFor="sbx-api-base-url">API base URL</Label>
              <Input id="sbx-api-base-url"
                type="text"
                className="font-mono"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://api.sandbox.co.in"
              />
              <p className="text-3xs text-ink-3 mt-1">
                Default is fine. Override only for staging / on-prem deployments.
              </p>
            </div>

            <div className="rounded-md bg-paper-2 p-3 text-xs text-ink-3 leading-relaxed">
              <p className="font-medium text-ink-2 mb-1 inline-flex items-center gap-1.5">
                <Icon name="lock" size={11} /> Security
              </p>
              Credentials are stored in <span className="font-mono">tenant_secrets</span>, RLS-locked to your workspace owner role. They override any environment-variable fallback set on the server.
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
            disabled={!apiKey.trim() || !apiSecret.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
