/**
 * ApiKeysCard — owner-facing management for the public integration API keys
 * (used by the DSP support platform). Lists keys, mints new ones (plaintext
 * shown ONCE), and revokes. All calls go through /api/settings/api-keys.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

interface ApiKey {
  id:           string;
  label:        string;
  key_prefix:   string;
  scopes:       string[];
  last_used_at: string | null;
  revoked_at:   string | null;
  created_at:   string;
}

export default function ApiKeysCard() {
  const qc = useQueryClient();
  const [label, setLabel] = React.useState("");
  const [revealed, setRevealed] = React.useState<string | null>(null);

  const { data: keys, isLoading, error } = useQuery({
    queryKey: ["api-keys"],
    queryFn: async (): Promise<ApiKey[]> => {
      const res = await fetch("/api/settings/api-keys");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load keys");
      return res.json();
    },
  });

  const createKey = useMutation({
    mutationFn: async (lbl: string): Promise<{ key: string }> => {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: lbl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not create key");
      return body;
    },
    onSuccess: (body) => {
      setRevealed(body.key);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key created — copy it now, it won't be shown again");
    },
    onError: (e) => toastError(e, { fallback: "Could not create the API key.", description: "No key was made. Try again." }),
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/settings/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not revoke");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("Key revoked");
    },
    onError: (e) => toastError(e, { fallback: "Could not revoke the key.", description: "The key still works. Refresh and try again." }),
  });

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success("Copied");
  };

  const active = (keys ?? []).filter((k) => !k.revoked_at);

  return (
    <Card className="mt-4 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="link" size={16} className="text-ink-2" />
        <p className="text-sm font-semibold text-ink">Support platform API (DSP)</p>
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Give your support app read-access to customers, subscriptions, invoices, quotes and payments.
        Base URL: <span className="font-mono text-ink-2">/api/v1</span> · send the key as{" "}
        <span className="font-mono text-ink-2">Authorization: Bearer &lt;key&gt;</span>.
      </p>

      {/* Reveal-once box */}
      {revealed && (
        <div className="mb-4 rounded-lg border border-amber bg-amber-soft p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-ink">
            <Icon name="alert" size={13} /> Copy this key now — it will NOT be shown again
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-paper px-2 py-1 font-mono text-xs text-ink">{revealed}</code>
            <Button size="sm" icon="copy" onClick={() => copy(revealed)}>Copy</Button>
            <Button size="sm" variant="ghost" icon="x" aria-label="Dismiss" onClick={() => setRevealed(null)} />
          </div>
        </div>
      )}

      {/* Create */}
      <div className="mb-4 flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="api-key-new-label" className="mb-1 block text-xs font-medium text-ink-3">New key label</label>
          <Input
            id="api-key-new-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. DSP support platform"
            maxLength={60}
          />
        </div>
        <Button
          variant="primary"
          icon="plus"
          loading={createKey.isPending}
          onClick={() => createKey.mutate(label)}
        >
          Create key
        </Button>
      </div>

      {/* List */}
      {isLoading && <p className="text-sm text-ink-3">Loading…</p>}
      {error && <p className="text-sm text-rose">{(error as Error).message}</p>}
      {!isLoading && !error && active.length === 0 && (
        <p className="text-sm text-ink-3">No API keys yet. Create one to connect your support platform.</p>
      )}
      {active.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {active.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{k.label}</p>
                <p className="font-mono text-xs text-ink-3">
                  {k.key_prefix}…{"  "}
                  <span className="font-sans">· created {formatDate(k.created_at)}</span>
                  {k.last_used_at ? <span className="font-sans"> · last used {formatDate(k.last_used_at, "relative")}</span> : <span className="font-sans"> · never used</span>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge kind="success" dot>Active</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  loading={revokeKey.isPending}
                  onClick={() => revokeKey.mutate(k.id)}
                >
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
