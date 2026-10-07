/**
 * ApiKeysCard — owner-facing management for the public integration API keys
 * (used by the DSP support platform). Lists keys, mints new ones (plaintext
 * shown ONCE), changes a key's scopes, and revokes. All calls go through
 * /api/settings/api-keys.
 *
 * R-327: every key carries scopes (`read`, `telecalling`) — the names requireScope()
 * checks in /api/v1 (R-050). Pick them when creating; the owner can change them on an
 * existing key. Scope editing is owner-only (UI hides it; the API returns 403).
 * The secret is shown once on creation and never again.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { API_SCOPES, DEFAULT_SCOPES, SCOPE_LABEL } from "@/lib/api-keys/scopes";
import type { ApiScope } from "@/lib/api/v1-response";

interface ApiKey {
  id:           string;
  label:        string;
  key_prefix:   string;
  scopes:       string[];
  last_used_at: string | null;
  revoked_at:   string | null;
  created_at:   string;
}

/** Known scopes of a key, in canonical order (unknown names dropped). */
const asScopes = (raw: string[] | null | undefined): ApiScope[] =>
  API_SCOPES.filter((s) => (raw ?? []).includes(s));

/** One checkbox per scope, each tied to its label (a11y ratchet R-271). */
function ScopePicker({
  idPrefix, value, onChange, disabled,
}: {
  idPrefix: string;
  value: ApiScope[];
  onChange: (next: ApiScope[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-wrap gap-x-5 gap-y-2" disabled={disabled}>
      <legend className="sr-only">Scopes</legend>
      {API_SCOPES.map((s) => {
        const id = `${idPrefix}-${s}`;
        return (
          <div key={s} className="flex items-start gap-2">
            <Checkbox
              id={id}
              checked={value.includes(s)}
              disabled={disabled}
              onCheckedChange={(on) =>
                onChange(on === true
                  ? API_SCOPES.filter((x) => x === s || value.includes(x))
                  : value.filter((x) => x !== s))
              }
            />
            <label htmlFor={id} className="-mt-0.5 cursor-pointer text-sm text-ink">
              {SCOPE_LABEL[s].name}
              <span className="block text-xs text-ink-3">{SCOPE_LABEL[s].hint}</span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

export default function ApiKeysCard() {
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const [label, setLabel] = React.useState("");
  const [newScopes, setNewScopes] = React.useState<ApiScope[]>(DEFAULT_SCOPES);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; scopes: ApiScope[] } | null>(null);

  const { data: keys, isLoading, error } = useQuery({
    queryKey: ["api-keys"],
    queryFn: async (): Promise<ApiKey[]> => {
      const res = await fetch("/api/settings/api-keys");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load keys");
      return res.json();
    },
  });

  const createKey = useMutation({
    mutationFn: async (v: { label: string; scopes: ApiScope[] }): Promise<{ key: string }> => {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not create key");
      return body;
    },
    onSuccess: (body) => {
      setRevealed(body.key);
      setLabel("");
      setNewScopes(DEFAULT_SCOPES);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("API key created — copy it now, it won't be shown again");
    },
    onError: (e) => toastError(e, { fallback: "Could not create the API key.", description: "No key was made. Try again." }),
  });

  const saveScopes = useMutation({
    mutationFn: async (v: { id: string; scopes: ApiScope[] }) => {
      const res = await fetch(`/api/settings/api-keys/${v.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: v.scopes }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not change scopes");
    },
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("Scopes saved");
    },
    onError: (e) => toastError(e, { fallback: "Could not change the scopes.", description: "The key keeps its old scopes. Try again." }),
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
        Give your support app access to customers, subscriptions, invoices, quotes and payments
        (Read), and to AI phone calls (Telecalling).
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

      {/* Create — owner only (the API refuses anyone else) */}
      {isOwner && (
        <div className="mb-4 space-y-3">
          <div className="flex items-end gap-2">
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
              disabled={newScopes.length === 0}
              onClick={() => createKey.mutate({ label, scopes: newScopes })}
            >
              Create key
            </Button>
          </div>
          <ScopePicker idPrefix="api-key-new-scope" value={newScopes} onChange={setNewScopes} />
          {newScopes.length === 0 && <p className="text-xs text-rose">Pick at least one scope.</p>}
        </div>
      )}

      {/* List */}
      {isLoading && <p className="text-sm text-ink-3">Loading…</p>}
      {error && <p className="text-sm text-rose">{(error as Error).message}</p>}
      {!isLoading && !error && active.length === 0 && (
        <p className="text-sm text-ink-3">No API keys yet. Create one to connect your support platform.</p>
      )}
      {active.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {active.map((k) => {
            const scopes = asScopes(k.scopes);
            const isEditing = editing?.id === k.id;
            return (
              <li key={k.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{k.label}</p>
                    <p className="font-mono text-xs text-ink-3">
                      {k.key_prefix}…{"  "}
                      <span className="font-sans">· created {formatDate(k.created_at)}</span>
                      {k.last_used_at ? <span className="font-sans"> · last used {formatDate(k.last_used_at, "relative")}</span> : <span className="font-sans"> · never used</span>}
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-1" aria-label={`Scopes of ${k.label}`}>
                      {scopes.map((s) => (
                        <li key={s}><Badge kind="info" size="sm">{SCOPE_LABEL[s].name}</Badge></li>
                      ))}
                      {scopes.length === 0 && <li><Badge kind="warning" size="sm">No scopes</Badge></li>}
                    </ul>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge kind="success" dot>Active</Badge>
                    {isOwner && !isEditing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="edit"
                        aria-label={`Change scopes of ${k.label}`}
                        onClick={() => setEditing({ id: k.id, scopes })}
                      >
                        Scopes
                      </Button>
                    )}
                    {isOwner && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        loading={revokeKey.isPending && revokeKey.variables === k.id}
                        onClick={() => revokeKey.mutate(k.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
                {isEditing && editing && (
                  <div className="mt-3 space-y-2 rounded-lg border border-hairline p-3">
                    <ScopePicker
                      idPrefix={`api-key-${k.id}-scope`}
                      value={editing.scopes}
                      onChange={(next) => setEditing({ id: k.id, scopes: next })}
                      disabled={saveScopes.isPending}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={saveScopes.isPending}
                        disabled={editing.scopes.length === 0}
                        onClick={() => saveScopes.mutate(editing)}
                      >
                        Save scopes
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      {editing.scopes.length === 0 && <span className="text-xs text-rose">Pick at least one scope.</span>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
