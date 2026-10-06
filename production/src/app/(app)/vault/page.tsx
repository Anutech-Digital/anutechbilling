/**
 * /vault — customer console credentials.
 *
 * The passwords for the Google Workspace, M365, DNS and cPanel accounts this
 * reseller administers on behalf of its customers. Today those live in somebody's
 * WhatsApp history and a spreadsheet, which is the actual thing this page is
 * competing with.
 *
 * ─── WHAT THIS PAGE DELIBERATELY CANNOT DO ───────────────────────────────────
 * It never holds a secret it was not just asked for. The list comes back with no
 * ciphertext at all, and revealing one password is a POST to /api/vault/[id]/reveal
 * that is written to an access log before the value is returned. So there is no
 * "decrypt everything and filter in the browser" path, by construction.
 *
 * A revealed password is held in React state for one entry at a time and cleared
 * on a timer. That is not security theatre about memory — it is about the screen:
 * a password left visible is one shoulder, one screen-share, or one screenshot
 * away from being somewhere else, and this project has already burned two secrets
 * exactly that way.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  generatePassword, assessStrength, DEFAULT_LENGTH, type HealthFinding,
} from "@/lib/vault/passwords";

interface VaultEntry {
  id: string;
  customerId: string | null;
  title: string;
  category: string;
  url: string | null;
  hasPassword: boolean;
  lastRotatedAt: string | null;
  createdAt: string;
}

interface VaultResponse {
  ok: boolean;
  configured?: boolean;
  entries?: VaultEntry[];
  health?: HealthFinding[];
  setupRequired?: boolean;
  error?: string;
}

/** How long a revealed password stays on screen. */
const REVEAL_SECONDS = 30;

const CATEGORY_LABEL: Record<string, string> = {
  google_admin:  "Google Admin",
  m365_admin:    "Microsoft 365",
  dns_registrar: "DNS / Registrar",
  cpanel:        "cPanel",
  distributor:   "Distributor",
  other:         "Other",
};

function useVault() {
  return useQuery({
    queryKey: ["vault"],
    queryFn: async (): Promise<VaultResponse> => {
      const res = await fetch("/api/vault");
      return (await res.json()) as VaultResponse;
    },
    // Never cache credential metadata across a logout.
    gcTime: 0,
  });
}

export default function VaultPage() {
  const { data, isLoading } = useVault();
  const [addOpen, setAddOpen] = React.useState(false);

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      <div className="mb-6 flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Password Vault</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Admin console logins you hold on behalf of customers. Encrypted at rest;
            every time one is shown, it is recorded.
          </p>
        </div>
        {data?.ok && (
          <Button icon="plus" onClick={() => setAddOpen(true)} className="shrink-0">
            Add credential
          </Button>
        )}
      </div>

      {/* Setup states get a next step and a place to go — never a bare refusal (§24). */}
      {data?.setupRequired && (
        <Card className="p-5 mb-6">
          <EmptyState
            icon="lock"
            title="The vault tables do not exist yet"
            body={
              <>
                Apply <span className="font-mono text-xs">0234_vault_passwords.sql</span> in the
                Supabase SQL editor, then reload this page. Run the DDL on its own —
                a verification <span className="font-mono text-xs">SELECT</span> in the same
                run reports success for a change that then rolls back.
              </>
            }
          />
        </Card>
      )}

      {data?.ok && data.configured === false && (
        <Card className="p-4 mb-6 border-amber/40">
          <div className="flex gap-3">
            <Icon name="alert_triangle" className="w-4 h-4 text-amber-ink shrink-0 mt-0.5" />
            <div className="text-sm text-ink-2">
              <div className="font-medium text-ink">No encryption key on this deployment</div>
              <p className="text-ink-3 mt-1 leading-relaxed">
                <span className="font-mono text-xs">SECRETS_MASTER_KEY</span> is not set, so new
                credentials cannot be saved and existing ones cannot be shown. Adding is blocked
                rather than falling back to storing passwords in the clear.
              </p>
            </div>
          </div>
        </Card>
      )}

      {data && !data.ok && !data.setupRequired && (
        <Card className="p-4 mb-6">
          <div className="text-sm text-rose">{data.error ?? "Could not load the vault."}</div>
        </Card>
      )}

      {data?.health && data.health.length > 0 && <HealthCard findings={data.health} />}

      {data?.ok && (data.entries?.length ?? 0) === 0 && (
        <Card className="py-2">
          <EmptyState
            icon="lock"
            title="No credentials stored yet"
            body="Add the admin logins you manage for customers so they stop living in chat history."
            action={<Button icon="plus" onClick={() => setAddOpen(true)}>Add credential</Button>}
          />
        </Card>
      )}

      {(data?.entries?.length ?? 0) > 0 && (
        <div className="space-y-2">
          {data!.entries!.map((e) => <EntryRow key={e.id} entry={e} />)}
        </div>
      )}

      <AddDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function HealthCard({ findings }: { findings: HealthFinding[] }) {
  return (
    <Card className="p-5 mb-6">
      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">
        Needs attention
      </div>
      <ul className="space-y-2">
        {findings.map((f, i) => (
          <li key={i} className="flex gap-2.5 text-sm">
            <Icon name="alert_triangle" className="w-4 h-4 text-amber-ink shrink-0 mt-0.5" />
            <div>
              <span className="text-ink">{f.title}</span>
              <span className="text-ink-3"> — {f.message}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EntryRow({ entry }: { entry: VaultEntry }) {
  const [shown, setShown] = React.useState<{ password: string; username: string | null } | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState(0);

  // Auto-hide. The interval is cleared on unmount so navigating away does not
  // leave a timer holding the value alive.
  React.useEffect(() => {
    if (!shown) return;
    setSecondsLeft(REVEAL_SECONDS);
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { setShown(null); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [shown]);

  const reveal = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/vault/${entry.id}/reveal`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Could not reveal");
      return json as { password: string; username: string | null };
    },
    onSuccess: (d) => setShown({ password: d.password, username: d.username }),
    onError: (e: Error) => toastError(e, { fallback: "Could not reveal the password.", description: "Nothing changed. Try again in a moment." }),
  });

  return (
    <Card className="p-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-ink font-medium truncate">{entry.title}</span>
            <Badge kind="muted" size="sm">{CATEGORY_LABEL[entry.category] ?? entry.category}</Badge>
          </div>
          {entry.url && (
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-ink-3 hover:text-amber-ink truncate block mt-0.5"
            >
              {entry.url}
            </a>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {shown ? (
            <>
              <code className="font-mono text-sm bg-paper-2 px-2 py-1 rounded select-all">
                {shown.password}
              </code>
              <span className="text-3xs text-ink-3 tabular-nums w-8">{secondsLeft}s</span>
              <Button variant="ghost" size="sm" icon="eye_off" onClick={() => setShown(null)}>
                Hide
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              icon="eye"
              loading={reveal.isPending}
              onClick={() => reveal.mutate()}
            >
              Reveal
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");

  const strength = assessStrength(password);

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, url, username, password }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Could not save");
      return json;
    },
    onSuccess: () => {
      toast.success("Credential saved");
      qc.invalidateQueries({ queryKey: ["vault"] });
      setTitle(""); setUrl(""); setUsername(""); setPassword("");
      onOpenChange(false);
    },
    onError: (e: Error) => toastError(e, { fallback: "Could not save the credential.", description: "Nothing was saved. Check the fields and try again." }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            Encrypted before it leaves the server. It is never shown again without being logged.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="v-title">Title</Label>
            <Input id="v-title" value={title} onChange={(e) => setTitle(e.target.value)}
                   placeholder="Sharma Traders — Google Admin" />
          </div>
          <div>
            <Label htmlFor="v-url">Console URL</Label>
            <Input id="v-url" value={url} onChange={(e) => setUrl(e.target.value)}
                   placeholder="https://admin.google.com" />
          </div>
          <div>
            <Label htmlFor="v-user">Username</Label>
            <Input id="v-user" value={username} onChange={(e) => setUsername(e.target.value)}
                   autoComplete="off" />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="v-pass">Password</Label>
              <button
                type="button"
                className="text-xs text-amber-ink hover:underline"
                onClick={() => setPassword(generatePassword({ length: DEFAULT_LENGTH }))}
              >
                Generate
              </button>
            </div>
            {/* type=text on purpose: the person entering it needs to check it against
                the console, and a masked box they cannot verify is how a wrong
                password gets stored and only discovered during an outage. */}
            <Input id="v-pass" value={password} onChange={(e) => setPassword(e.target.value)}
                   autoComplete="off" spellCheck={false} className="font-mono" />
            {password && (
              <div className="text-2xs text-ink-3 mt-1">
                {strength.strength === "strong" ? "Strong" : strength.strength === "fair" ? "Fair" : "Weak"}
                {strength.problems.length > 0 && ` — ${strength.problems[0]}`}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!title.trim() || !password}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
