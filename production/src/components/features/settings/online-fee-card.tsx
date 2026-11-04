/**
 * R-2416 — Settings → Company → "Online payment fee": who pays Razorpay's fee by default
 * (Customer / Us), the rate (default 2%) with 18% GST on the fee, an optional "we absorb when the
 * bill is ₹X or more", and the line text. Owner-only, its own Save, like "What do you sell?".
 *
 * Exceptions live where they belong: the customer page ("We absorb for this customer") and the
 * quote / invoice ("Waive online fee for this bill"). Nothing is charged yet — R-2417 adds the fee
 * to online payments; until then this decides and shows who pays.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import {
  ONLINE_FEE_GST_PCT,
  ONLINE_FEE_MAX_RATE_PCT,
  onlineFeeAmounts,
  onlineFeeEffectivePct,
  type OnlineFeeBearer,
  type OnlineFeeSettings,
} from "@/lib/payments/online-fee";
import { ONLINE_FEE_NEEDS_DB, useOnlineFeeSettings, useSaveOnlineFeeSettings } from "@/lib/queries/online-fee";

const BEARERS: { id: OnlineFeeBearer; label: string }[] = [
  { id: "customer", label: "Customer pays" },
  { id: "business", label: "We pay" },
];
const EXAMPLE_BILL = 11800;

interface Draft { bearer: OnlineFeeBearer; rate: string; above: string; lineText: string }

const toDraft = (s: OnlineFeeSettings): Draft => ({
  bearer: s.bearer,
  rate: String(s.ratePct),
  above: s.waiveAbove === null ? "" : String(s.waiveAbove),
  lineText: s.lineText ?? "",
});

/** The draft → settings, or the first problem in words the owner can act on. */
export function parseOnlineFeeDraft(d: Draft): { ok: true; settings: OnlineFeeSettings } | { ok: false; error: string } {
  const rateText = d.rate.replace(/[%\s]/g, "");
  const rate = Number(rateText);
  if (!/^\d+(\.\d{1,2})?$/.test(rateText) || !(rate > 0) || rate > ONLINE_FEE_MAX_RATE_PCT) {
    return { ok: false, error: `Rate: a percent above 0 and up to ${ONLINE_FEE_MAX_RATE_PCT}, e.g. 2 or 2.15.` };
  }
  const aboveText = d.above.replace(/[,₹\s]/g, "");
  if (aboveText !== "" && !/^[1-9]\d*$/.test(aboveText)) {
    return { ok: false, error: "We absorb when the bill is: whole rupees, e.g. 100000 — or leave it empty." };
  }
  const lineText = d.lineText.trim();
  if (lineText.length > 80) return { ok: false, error: "Line text: 80 characters at most." };
  return {
    ok: true,
    settings: { bearer: d.bearer, ratePct: rate, waiveAbove: aboveText === "" ? null : Number(aboveText), lineText: lineText || null },
  };
}

export function OnlineFeeCard({ isOwner }: { isOwner: boolean }) {
  const { data, isLoading, isError } = useOnlineFeeSettings();
  const save = useSaveOnlineFeeSettings();
  const [draft, setDraft] = React.useState<Draft | null>(null);

  React.useEffect(() => {
    if (data && draft === null) setDraft(toDraft(data.settings));
  }, [data, draft]);

  const headingId = React.useId();
  const ready = data?.ready ?? false;
  const parsed = draft ? parseOnlineFeeDraft(draft) : null;
  const saved = data ? toDraft(data.settings) : null;
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
  const disabled = !isOwner || !ready || save.isPending || isLoading;
  const example = parsed?.ok ? onlineFeeAmounts(EXAMPLE_BILL, parsed.settings.ratePct) : null;
  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <Card id="online-fee" role="region" className="p-5 max-w-3xl scroll-mt-20" aria-labelledby={headingId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p id={headingId} className="text-sm font-semibold text-ink">Online payment fee</p>
        {data && !ready ? <Badge kind="muted">Coming soon</Badge>
          : !isOwner ? <Badge kind="muted">Owner-only · view</Badge>
          : dirty ? <Badge kind="warning" dot>Unsaved changes</Badge>
          : null}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Razorpay keeps a fee on every online payment (card, UPI, netbanking). Choose who pays it.
        Bank transfer stays free. Exceptions: on the customer page (&quot;We absorb for this customer&quot;)
        and on a quote or invoice (&quot;Waive online fee&quot;).
        {data && !ready && ` ${ONLINE_FEE_NEEDS_DB}`}
      </p>

      {isError ? (
        <p className="text-xs text-rose">Could not load this setting. Refresh to try again.</p>
      ) : draft && (
        <div className="space-y-4">
          <div role="group" aria-label="Who pays the online fee" className="flex flex-wrap gap-1.5">
            {BEARERS.map((o) => {
              const on = draft.bearer === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => set({ bearer: o.id })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                    on ? "bg-amber text-white border-amber" : "bg-paper border-hairline text-ink-2 hover:border-hairline-strong"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="online-fee-rate" className="mb-1 block text-xs font-medium text-ink-3">Fee rate (%)</label>
              <Input id="online-fee-rate" inputMode="decimal" className="font-mono" value={draft.rate}
                disabled={disabled} onChange={(e) => set({ rate: e.target.value })} />
              <p className="mt-1 text-3xs text-ink-3">
                {parsed?.ok
                  ? `≈${onlineFeeEffectivePct(parsed.settings.ratePct)}% of the bill — covers Razorpay's fee on the fee too. GST ${ONLINE_FEE_GST_PCT}% is added on it.`
                  : `Razorpay's rate. GST ${ONLINE_FEE_GST_PCT}% is added on the fee.`}
              </p>
            </div>
            <div>
              <label htmlFor="online-fee-above" className="mb-1 block text-xs font-medium text-ink-3">We pay when the bill is ₹ or more</label>
              <Input id="online-fee-above" inputMode="numeric" className="font-mono" placeholder="Optional" value={draft.above}
                disabled={disabled} onChange={(e) => set({ above: e.target.value })} />
              <p className="mt-1 text-3xs text-ink-3">Empty = the rule above for every bill.</p>
            </div>
            <div>
              <label htmlFor="online-fee-text" className="mb-1 block text-xs font-medium text-ink-3">Line text</label>
              <Input id="online-fee-text" placeholder="Online payment fee" maxLength={80} value={draft.lineText}
                disabled={disabled} onChange={(e) => set({ lineText: e.target.value })} />
              <p className="mt-1 text-3xs text-ink-3">How the fee is named to the customer.</p>
            </div>
          </div>

          {parsed && !parsed.ok && <p className="text-xs text-rose" role="alert">{parsed.error}</p>}
          {example && (
            <p className="text-xs text-ink-2">
              On a {rupee(EXAMPLE_BILL)} bill: fee {rupee(example.fee)} + GST {rupee(example.gst)} = <b>{rupee(example.total)}</b>
              {draft.bearer === "customer"
                ? <> — the customer pays <b>{rupee(example.payable)}</b> online.</>
                : " — we pay it."}
              {" "}Charging it on the payment comes next; today this decides and shows who pays.
            </p>
          )}

          {isOwner && ready && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="primary" icon="check"
                loading={save.isPending} disabled={!dirty || !parsed?.ok || save.isPending}
                onClick={() => { if (parsed?.ok) save.mutate(parsed.settings); }}>
                Save
              </Button>
              {dirty && saved && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(saved)}>Discard</Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
