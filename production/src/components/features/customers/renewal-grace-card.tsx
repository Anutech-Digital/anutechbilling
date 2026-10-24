/**
 * R-1621 — "Renewal grace" for one customer: a trusted customer can get more days after a
 * renewal date than the company's grace before the owner is asked to stop the service.
 * Empty = the company grace (Settings). Only the owner or a manager may change it — the
 * database refuses anyone else (trg_customers_trusted_grace_guard), so this card only mirrors
 * that. Before the migration the column is absent and the card renders nothing.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { isMissingColumn } from "@/lib/renewals/grace-overrides";

/** "" → null (company grace); a whole number 1..60; anything else undefined (invalid). */
export function parseTrustedGrace(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,2}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 60 ? n : undefined;
}

/* trusted_grace_days is newer than the generated types (database.types.ts is shared). */
type Loose = {
  from: (t: "customers") => {
    select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: { trusted_grace_days: number | null } | null; error: unknown }> } };
    update: (v: { trusted_grace_days: number | null }) => { eq: (c: string, v: string) => PromiseLike<{ error: unknown }> };
  };
};

interface Props {
  customerId: string;
  /** Owner or manager — the only roles the database lets change it. */
  canEdit: boolean;
  /** The company's grace (Settings), shown as the default. */
  companyGraceDays: number | null | undefined;
}

export function RenewalGraceCard({ customerId, canEdit, companyGraceDays }: Props) {
  const qc = useQueryClient();
  const key = ["customers", customerId, "trusted-grace"] as const;
  const { data } = useQuery({
    queryKey: key,
    queryFn: async (): Promise<{ ready: boolean; days: number | null }> => {
      const db = createClient() as unknown as Loose;
      const { data: row, error } = await db.from("customers").select("trusted_grace_days").eq("id", customerId).maybeSingle();
      if (error) {
        if (isMissingColumn(error)) return { ready: false, days: null };
        throw error;
      }
      return { ready: true, days: row?.trusted_grace_days ?? null };
    },
  });
  const saved = data?.days ?? null;
  const [text, setText] = React.useState("");
  React.useEffect(() => { setText(saved === null ? "" : String(saved)); }, [saved]);

  const save = useMutation({
    mutationFn: async (days: number | null) => {
      const db = createClient() as unknown as Loose;
      const { error } = await db.from("customers").update({ trusted_grace_days: days }).eq("id", customerId);
      if (error) throw error;
    },
    onSuccess: (_v, days) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.success(days === null ? "Back to the company grace" : `Renewal grace set to ${days} days`);
    },
    onError: (err) => toastError(err, {
      fallback: "Could not save the renewal grace.",
      description: "Only the owner or a manager can change it. Ask one of them, or refresh and try again.",
    }),
  });

  if (!data?.ready) return null;

  const parsed = parseTrustedGrace(text);
  const ok = parsed !== undefined;
  const dirty = ok && parsed !== saved;
  const company = companyGraceDays ?? 0;

  return (
    <Card title="Renewal grace" sub={saved === null ? `Company grace · ${company} days` : `Trusted · ${saved} days`}>
      <div className="space-y-2 text-sm">
        <Label htmlFor={`trusted-grace-${customerId}`}>Days after the renewal date before you are asked to stop the service</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`trusted-grace-${customerId}`} inputMode="numeric" className="w-24 font-mono"
            placeholder={`${company} (company)`}
            value={text} onChange={(e) => setText(e.target.value)}
            disabled={!canEdit || save.isPending}
            aria-invalid={!ok}
          />
          {canEdit && dirty && (
            <Button size="sm" variant="primary" onClick={() => save.mutate(parsed ?? null)} loading={save.isPending}>Save</Button>
          )}
        </div>
        {!ok && <p className="text-xs text-rose">1 to 60 days, or leave empty for the company grace ({company} days).</p>}
        <p className="text-xs text-ink-3">
          {canEdit
            ? "For a customer you trust to pay late. Leave empty to use the company grace from Settings."
            : "Only the owner or a manager can change this."}
        </p>
      </div>
    </Card>
  );
}
