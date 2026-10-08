/**
 * R-262 — Settings → Company → "Compliance profile": business type + GST filing mode.
 *
 * The Compliance Calendar used to treat every tenant as a Pvt Ltd filing GST monthly, so
 * a proprietor saw AOC-4 / MGT-7 and a QRMP filer saw GSTR-1 on the 11th every month.
 * These two answers narrow it (lib/compliance/obligations.ts → obligationsFor).
 *
 * Its own Save, separate from the company form, because the two columns arrive in their
 * own migration: until that is applied the card says so and stays read-only, and the
 * company form keeps saving exactly as before.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  BUSINESS_TYPE_LABEL, GST_FILING_LABEL,
  type BusinessType, type GstFiling,
} from "@/lib/compliance/obligations";
import { useComplianceProfile, useSaveComplianceProfile } from "@/lib/compliance/profile";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isMissingUdyamColumn, normalizeUdyam, udyamInputOk } from "@/lib/compliance/udyam";

/* R-368: the company's own Udyam number. Its own read + save: the column comes in its own
   migration (20261007123000), and the business-type/GST read above must not break before it. */
const untyped = () => createClient() as unknown as SupabaseClient;

function useTenantUdyam() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["tenant_udyam", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<{ value: string | null; columnMissing: boolean }> => {
      const { data, error } = await untyped().from("tenants").select("udyam_number").eq("id", tenantId as string).maybeSingle();
      if (isMissingUdyamColumn(error)) return { value: null, columnMissing: true };
      if (error) throw new Error(error.message);
      const v = (data as { udyam_number?: unknown } | null)?.udyam_number;
      return { value: typeof v === "string" ? v : null, columnMissing: false };
    },
  });
}

function useSaveTenantUdyam() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (value: string | null) => {
      if (!tenantId) throw new Error("Not signed in to a workspace");
      const { data, error } = await untyped().from("tenants").update({ udyam_number: value }).eq("id", tenantId).select("id");
      if (isMissingUdyamColumn(error)) throw new Error("This needs a database update first.");
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error("Only the workspace owner can change this.");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tenant_udyam"] });
      toast.success("Udyam number saved");
    },
    onError: (err) => toast.error(`Could not save: ${(err as Error).message}`),
  });
}

function UdyamField({ isOwner }: { isOwner: boolean }) {
  const { data, isLoading } = useTenantUdyam();
  const save = useSaveTenantUdyam();
  const [value, setValue] = React.useState("");
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    setValue(data.value ?? "");
  }, [data]);

  const missing = Boolean(data?.columnMissing);
  const ok = udyamInputOk(value);
  const dirty = !!data && normalizeUdyam(value) !== normalizeUdyam(data.value);
  return (
    <div>
      <Label htmlFor="tenant-udyam">Udyam number (MSME)</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="tenant-udyam" value={value} onChange={(e) => setValue(e.target.value.toUpperCase())}
          placeholder="UDYAM-DL-01-0012345" maxLength={19} className="font-mono uppercase max-w-[16rem]"
          disabled={!isOwner || missing || isLoading || save.isPending} aria-invalid={!ok}
        />
        {isOwner && !missing && (
          <Button type="button" size="sm" variant="primary" icon="check"
            loading={save.isPending} disabled={!dirty || !ok || save.isPending}
            onClick={() => save.mutate(normalizeUdyam(value))}>
            Save
          </Button>
        )}
      </div>
      <p className={`mt-1.5 text-3xs ${ok ? "text-ink-3" : "text-rose"}`}>
        {!ok ? "Format: UDYAM-SS-00-0000000."
          : missing ? "Needs a database update before it can be saved."
          : "Printed on quotes and invoices when set. Leave empty if not registered."}
      </p>
    </div>
  );
}

const BUSINESS_TYPES: BusinessType[] = ["proprietor", "partnership", "llp", "pvt_ltd"];
const GST_MODES: GstFiling[] = ["monthly", "qrmp"];

const BUSINESS_TYPE_HINT: Record<BusinessType, string> = {
  proprietor: "No ROC filings. ITR-3 on the owner's PAN.",
  partnership: "No ROC filings. ITR-5 for the firm.",
  llp: "LLP Form 11 + Form 8, DIR-3 KYC, ITR-5.",
  pvt_ltd: "AOC-4, MGT-7, AGM, DIR-3 KYC, ITR-6.",
};
const GST_MODE_HINT: Record<GstFiling, string> = {
  monthly: "GSTR-1 by the 11th, GSTR-3B by the 20th, every month.",
  qrmp: "GSTR-1 by the 13th and GSTR-3B by the 22nd/24th after each quarter; PMT-06 by the 25th in months 1–2.",
};

function Segmented<T extends string>({
  label, options, labels, value, onChange, disabled,
}: {
  label: string;
  options: T[];
  labels: Record<T, string>;
  value: T | null;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
              on ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
            }`}
          >
            {labels[o]}
          </button>
        );
      })}
    </div>
  );
}

export function ComplianceProfileCard({ isOwner }: { isOwner: boolean }) {
  const { data: saved, isLoading, isError } = useComplianceProfile();
  const save = useSaveComplianceProfile();
  const [type, setType] = React.useState<BusinessType | null>(null);
  const [gst, setGst] = React.useState<GstFiling | null>(null);

  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!saved || loaded.current) return;
    loaded.current = true;
    setType(saved.businessType);
    setGst(saved.gstFiling);
  }, [saved]);

  const missing = Boolean(saved?.columnsMissing);
  const dirty = !!saved && (type !== saved.businessType || gst !== saved.gstFiling);
  const disabled = !isOwner || missing || save.isPending || isLoading;
  const canSave = isOwner && !missing && dirty && !save.isPending;

  const onSave = () => {
    save.mutate({
      ...(type ? { business_type: type } : {}),
      ...(gst ? { gst_filing: gst } : {}),
    });
  };

  return (
    <Card className="p-5 max-w-3xl">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Compliance profile</p>
        {missing ? <Badge kind="muted">Coming soon</Badge>
          : !isOwner ? <Badge kind="muted">Owner-only · view</Badge>
          : dirty ? <Badge kind="warning" dot>Unsaved changes</Badge>
          : null}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Decides which filings the Compliance Calendar shows.
        {saved && !missing && (!saved.businessType || !saved.gstFiling) &&
          " Not set yet — the calendar assumes a Pvt Ltd filing GST monthly."}
        {missing && " Needs a database update before it can be saved — the calendar assumes a Pvt Ltd filing GST monthly till then."}
      </p>

      {isError ? (
        <p className="text-xs text-rose">Could not load the compliance profile. Refresh to try again.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">Business type</p>
            <Segmented label="Business type" options={BUSINESS_TYPES} labels={BUSINESS_TYPE_LABEL}
              value={type} onChange={setType} disabled={disabled} />
            {type && <p className="mt-1.5 text-3xs text-ink-3">{BUSINESS_TYPE_HINT[type]}</p>}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">GST filing</p>
            <Segmented label="GST filing" options={GST_MODES} labels={GST_FILING_LABEL}
              value={gst} onChange={setGst} disabled={disabled} />
            {gst && <p className="mt-1.5 text-3xs text-ink-3">{GST_MODE_HINT[gst]}</p>}
          </div>
          {isOwner && !missing && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="primary" icon="check"
                loading={save.isPending} disabled={!canSave} onClick={onSave}>
                Save profile
              </Button>
              {dirty && saved && (
                <Button type="button" variant="ghost" size="sm"
                  onClick={() => { setType(saved.businessType); setGst(saved.gstFiling); }}>
                  Discard
                </Button>
              )}
            </div>
          )}
          <div className="border-t border-hairline pt-4">
            <UdyamField isOwner={isOwner} />
          </div>
        </div>
      )}
    </Card>
  );
}
