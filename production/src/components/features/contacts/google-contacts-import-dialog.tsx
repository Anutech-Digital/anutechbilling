/**
 * GoogleContactsImportDialog — direct OAuth-based contacts import.
 *
 * Flow:
 *   1. On open, hit /api/contacts/google-fetch
 *   2. If 403 with code 'needs_reauth' → show "Connect Google" button which
 *      triggers signInWithOAuth with contacts.readonly scope
 *   3. After consent, redirects back to /leads?google-import=1 — dialog
 *      auto-reopens, retries fetch
 *   4. On success → preview table with checkboxes (select-all + per-row)
 *   5. Submit → POST /api/leads/google-import (bulk insert as leads at
 *      stage='new', dedup by email)
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";

interface FetchedContact {
  resourceName: string;
  fullName:     string;
  email:        string | null;
  phone:        string | null;
  company:      string | null;
  title:        string | null;
  notes:        string | null;
}

type DialogState =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "needs-connect"; message: string }
  | { kind: "preview" }
  | { kind: "importing" }
  | { kind: "error"; message: string };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function GoogleContactsImportDialog({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [state,    setState]    = React.useState<DialogState>({ kind: "idle" });
  const [contacts, setContacts] = React.useState<FetchedContact[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Auto-fetch when dialog opens
  React.useEffect(() => {
    if (open && state.kind === "idle") {
      fetchContacts();
    }
    if (!open) {
      // Reset on close
      setState({ kind: "idle" });
      setContacts([]);
      setSelected(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function fetchContacts() {
    setState({ kind: "fetching" });
    try {
      const res = await fetch("/api/contacts/google-fetch");
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "needs_reauth") {
          setState({ kind: "needs-connect", message: json.error ?? "Connect Google to import" });
          return;
        }
        setState({ kind: "error", message: json.error ?? "Could not fetch contacts" });
        return;
      }
      setContacts(json.contacts ?? []);
      // Pre-select rows with email (best lead candidates)
      setSelected(new Set(
        (json.contacts ?? [])
          .filter((c: FetchedContact) => c.email)
          .map((c: FetchedContact) => c.resourceName)
      ));
      setState({ kind: "preview" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
    }
  }

  async function connectGoogle() {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes:      "https://www.googleapis.com/auth/contacts.readonly",
        queryParams: { access_type: "offline", prompt: "consent" },
        redirectTo:  `${window.location.origin}/callback?next=${encodeURIComponent("/leads?google-import=1")}`,
      },
    });
    if (error) {
      toastError(error, {
        fallback: "Couldn't open Google sign-in.",
        description: "Try again, or export a Google CSV and use Import CSV instead.",
      });
    }
  }

  function toggle(rn: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(rn)) next.delete(rn); else next.add(rn);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === contacts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(contacts.map((c) => c.resourceName)));
    }
  }

  async function onSubmit() {
    if (selected.size === 0) {
      toast.error("Select at least one contact", {
        description: "Tick the contacts you want in the list below, then import.",
      });
      return;
    }
    setState({ kind: "importing" });
    try {
      const rows = contacts
        .filter((c) => selected.has(c.resourceName))
        .map((c) => ({
          fullName: c.fullName,
          email:    c.email,
          phone:    c.phone,
          company:  c.company,
          title:    c.title,
          notes:    c.notes,
        }));

      const res = await fetch("/api/leads/google-import", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ rows, source: "google-oauth" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, {
          fallback: "Import failed.",
          description: "Nothing was imported. Try again — if it keeps failing, report it from Help.",
        });
        setState({ kind: "preview" });
        return;
      }
      toast.success(
        `Imported ${json.imported} lead${json.imported === 1 ? "" : "s"}` +
        (json.duplicates > 0 ? ` · ${json.duplicates} duplicates skipped` : "") +
        (json.skipped > 0    ? ` · ${json.skipped} skipped` : "")
      );
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      onOpenChange(false);
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't reach the server.",
        description: "Nothing was imported. Check your internet connection and try again.",
      });
      setState({ kind: "preview" });
    }
  }

  const allSelected = state.kind === "preview" && selected.size === contacts.length && contacts.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import contacts from Google</DialogTitle>
          <DialogDescription>
            Pull contacts directly from your signed-in Google account · selected ones become leads at stage <code className="text-amber-ink">new</code>
          </DialogDescription>
        </DialogHeader>

        {/* IDLE / FETCHING */}
        {(state.kind === "idle" || state.kind === "fetching") && (
          <div className="py-12 text-center">
            <Icon name="refresh" size={32} className="text-amber-ink mx-auto mb-3 animate-spin" />
            <p className="text-sm text-ink-2">Fetching contacts from Google…</p>
            <p className="text-2xs text-ink-3 mt-1">First time can take 5-10 seconds for large contact lists</p>
          </div>
        )}

        {/* NEEDS CONNECT */}
        {state.kind === "needs-connect" && (
          <div className="py-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-soft grid place-items-center">
              <Icon name="lock" size={28} className="text-amber-ink" />
            </div>
            <h3 className="font-serif text-xl text-ink mb-2">Connect your Google Contacts</h3>
            <p className="text-sm text-ink-3 mb-6 max-w-md mx-auto">
              Sign in again with Google to grant ResellerOS read-only access to your contacts. You'll be redirected back here automatically.
            </p>
            <Button variant="primary" icon="external" onClick={connectGoogle}>
              Connect Google
            </Button>
            <p className="text-2xs text-ink-3 mt-4">
              ResellerOS only reads — never writes or deletes anything in your Google Contacts.
            </p>
          </div>
        )}

        {/* ERROR */}
        {state.kind === "error" && (
          <div className="py-8 text-center">
            <Icon name="alert" size={32} className="text-rose mx-auto mb-3" />
            <h3 className="font-serif text-xl text-ink mb-2">Couldn't fetch contacts</h3>
            <p className="text-sm text-ink-3 mb-4">{state.message}</p>
            <Button icon="refresh" onClick={fetchContacts}>Try again</Button>
          </div>
        )}

        {/* PREVIEW */}
        {state.kind === "preview" && contacts.length > 0 && (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Icon name="check_circle" size={14} className="text-emerald" />
                <Badge kind="info" size="sm">{contacts.length} contacts fetched</Badge>
                <Badge kind="muted" size="sm">
                  {contacts.filter((c) => c.email).length} with email
                </Badge>
              </div>
              <p className="text-2xs text-ink-3">
                Selected → becomes a <b className="text-ink-2">lead</b> at stage <code>new</code>
              </p>
            </div>

            <div className="border border-hairline rounded-md overflow-hidden max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-paper-2 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all contacts"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="accent-amber"
                      />
                    </th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Name</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Email</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Phone</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Company</th>
                    <th className="text-left px-2 py-2 font-semibold text-ink-3 uppercase tracking-wider">Title</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const isSel = selected.has(c.resourceName);
                    return (
                      <tr
                        key={c.resourceName}
                        onClick={() => toggle(c.resourceName)}
                        className={`border-t border-hairline cursor-pointer ${isSel ? "bg-amber-soft/40" : "hover:bg-paper-2/40"}`}
                      >
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.fullName}`}
                            checked={isSel}
                            onChange={() => toggle(c.resourceName)}
                            onClick={(e) => e.stopPropagation()}
                            className="accent-amber"
                          />
                        </td>
                        <td className="px-2 py-1.5 font-medium text-ink truncate max-w-[180px]">{c.fullName}</td>
                        <td className="px-2 py-1.5 text-ink-2 font-mono text-2xs truncate max-w-[200px]">{c.email ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-2 truncate max-w-[140px]">{c.phone ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-2 truncate max-w-[160px]">{c.company ?? "—"}</td>
                        <td className="px-2 py-1.5 text-ink-3 truncate max-w-[160px]">{c.title ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="bg-paper-2 rounded-md p-3 text-2xs text-ink-3 flex items-start gap-2">
              <Icon name="info" size={12} className="text-amber-ink shrink-0 mt-0.5" />
              <p>
                Pro tip: Selected contacts land in your <b className="text-ink-2">Deal Pipeline → Leads tab</b> at stage <code>new</code>.
                Duplicates (same email already in leads) are silently skipped.
              </p>
            </div>
          </>
        )}

        {/* IMPORTING */}
        {state.kind === "importing" && (
          <div className="py-12 text-center">
            <Icon name="refresh" size={32} className="text-amber-ink mx-auto mb-3 animate-spin" />
            <p className="text-sm text-ink-2">Importing {selected.size} contacts as leads…</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {state.kind === "preview" && (
            <Button variant="primary" icon="upload" onClick={onSubmit} disabled={selected.size === 0}>
              Import {selected.size} as lead{selected.size === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
