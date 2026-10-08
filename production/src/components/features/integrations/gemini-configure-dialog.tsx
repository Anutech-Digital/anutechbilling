/**
 * GeminiConfigureDialog — per-tenant Google Gemini (AI) key editor.
 *
 * Turns on real AI (lead/customer follow-up drafts, inbound-email→lead,
 * campaign copy) without touching Cloud Run. The key is stored server-side in
 * tenant_secrets and never round-trips back to the browser — masked preview only.
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

/* EVERY ONE OF THESE WAS CALLED AND RETURNED 200 on 23 Aug 2026. The previous list was
   copied from documentation and had gemini-2.5-flash at the top, which 404s for keys created
   now ("no longer available to new users") — while ListModels cheerfully still reports it.
   A dropdown of models that do not work is worse than no dropdown: the operator picks one,
   it fails, and the key looks broken.

   gemini-pro-latest is deliberately absent: it answered 429 (quota), not 200. That is a
   different problem from unavailability and does not belong in a list of safe choices. */
const MODEL_OPTIONS = [
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
];
const RECOMMENDED_MODEL = "gemini-flash-latest";

interface GeminiStatus {
  ok:           boolean;
  configured:   boolean;
  env_fallback: boolean;
  key_mask:     string | null;
  model:        string;
  updated_at:   string | null;
}

function useGeminiStatus() {
  return useQuery({
    queryKey: ["integrations", "gemini"],
    queryFn: async (): Promise<GeminiStatus> => {
      const res = await fetch("/api/integrations/gemini");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not load AI status");
      return json as GeminiStatus;
    },
  });
}

export default function GeminiConfigureDialog({ open, onOpenChange }: Props) {
  const { data: status, isLoading } = useGeminiStatus();
  const qc = useQueryClient();

  const [apiKey, setApiKey]   = React.useState("");
  const [model, setModel]     = React.useState("");
  const [show, setShow]       = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  React.useEffect(() => {
    if (status?.model) setModel(status.model);
  }, [status?.model]);

  const save = useMutation({
    mutationFn: async () => {
      const hasKey = apiKey.trim().length >= 20;
      if (!hasKey && !status?.configured) throw new Error("Enter a valid Gemini API key");
      const payload: { api_key?: string; model?: string } = {};
      if (hasKey) payload.api_key = apiKey.trim();
      if (model.trim()) payload.model = model.trim();
      const res = await fetch("/api/integrations/gemini", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Save failed");
    },
    onSuccess: () => {
      toast.success("Gemini key saved — AI is now live for your workspace");
      qc.invalidateQueries({ queryKey: ["integrations", "gemini"] });
      setApiKey("");
    },
    onError: (err) => toastError(err, {
      fallback: "Gemini key not saved.",
      description: "Check the key was copied in full from Google AI Studio, then press Save again.",
    }),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/gemini", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Disconnect failed");
    },
    onSuccess: () => {
      toast.success("Gemini key cleared");
      qc.invalidateQueries({ queryKey: ["integrations", "gemini"] });
      setApiKey("");
    },
    onError: (err) => toastError(err, {
      fallback: "Gemini key not cleared.",
      description: "The saved key is still in use. Refresh the page and try again.",
    }),
  });

  /**
   * Tests the SAVED key, never what is typed above.
   *
   * The route takes no body and resolves the key through resolveGeminiConfig, so a key pasted
   * into the field and not saved is NOT what gets tested. That caught Pardeep on 24 Aug 2026:
   * he pasted a new paid-tier key, hit Test, saw green, and closed the dialog — while the row
   * still held yesterday's free-tier key, whose daily quota had merely reset. The
   * toast now says which key it tested, because "Connected" next to an unsaved field reads as
   * confirmation of the thing you just typed.
   */
  async function testConnection() {
    setTesting(true);
    try {
      const res = await fetch("/api/integrations/gemini/test", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        toast.success(
          `Connected ✓ — model ${json.model} responded`,
          { description: apiKey.trim().length >= 20
              ? "This tested the SAVED key, not the one you just typed. Press Save to store it."
              : "This tested the key already saved for this workspace." },
        );
      }
      else toast.error(typeof json.error === "string" && json.error ? json.error : "Test failed", {
        description: "The saved key did not answer. Paste a fresh key from Google AI Studio, press Save, then Test again.",
      });
    } catch (e) {
      toastError(e, {
        fallback: "Could not reach the test.",
        description: "Check your internet connection and press Test again.",
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1 inline-flex items-center gap-1.5">
            <Icon name="sparkles" size={11} /> Integration · AI (Google Gemini)
          </p>
          <h2 className="font-serif text-2xl text-ink">AI assistant</h2>
          <p className="text-xs text-ink-3 mt-1">
            Powers follow-up drafts, payment-reminder drafts, inbound-email → lead, and campaign copy. Without a key these run on plain templates.
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
                    ? <>Configured · key {status.key_mask} · model {status.model} · saved {status.updated_at ? formatDate(status.updated_at) : "—"}</>
                    : status?.env_fallback
                      ? "Using the shared server key (env). Add your own to override."
                      : "Not configured — AI features run on plain templates (stub)."}
                </p>
              </div>
              {status?.configured
                ? <Badge kind="success" dot>Live</Badge>
                : status?.env_fallback
                  ? <Badge kind="info" dot>Shared</Badge>
                  : <Badge kind="muted" dot>Stub</Badge>}
            </div>

            <div className="min-w-0">
              <Label htmlFor="gemini-api-key">Gemini API key *</Label>
              <div className="flex gap-2 min-w-0">
                <Input
                  id="gemini-api-key"
                  type={show ? "text" : "password"}
                  className="font-mono min-w-0 flex-1"
                  placeholder="AIza…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-label={show ? "Hide API key" : "Show API key"} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                  {show ? "Hide" : "Show"}
                </Button>
              </div>
              <p className="text-3xs text-ink-3 mt-1 break-words">
                Get it free at <span className="font-mono">aistudio.google.com</span> → Get API key. Paid tier recommended (privacy). Never shown back after save.
              </p>
            </div>

            <div className="min-w-0">
              <Label htmlFor="gemini-model">Model</Label>
              <select
                id="gemini-model"
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm font-mono text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                value={model || RECOMMENDED_MODEL}
                onChange={(e) => setModel(e.target.value)}
              >
                {model && !MODEL_OPTIONS.includes(model) && (
                  <option value={model}>{model} (current · unsupported)</option>
                )}
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}{m === RECOMMENDED_MODEL ? " — recommended" : ""}</option>
                ))}
              </select>
              <p className="text-3xs text-ink-3 mt-1"><span className="font-mono">gemini-flash-latest</span> — a rolling alias, so it will not go stale the way a pinned version does. If a model fails, hit Test — but note the list it shows comes from Google and is not always accurate about what will actually work.</p>
            </div>

            <div className="rounded-md bg-paper-2 p-3 text-xs text-ink-3 leading-relaxed break-words">
              <p className="font-medium text-ink-2 mb-1 inline-flex items-center gap-1.5">
                <Icon name="lock" size={11} /> Security
              </p>
              Stored in <span className="font-mono">tenant_secrets</span>, RLS-locked to your workspace owner role. The key never round-trips back to the browser. Money-safe: AI never invents a ₹ amount — it only uses figures the app passes it.
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
            disabled={!status?.configured && !status?.env_fallback}
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
            disabled={apiKey.trim().length < 20 && !status?.configured}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
