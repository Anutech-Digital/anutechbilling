/**
 * R-2444 — Settings → Company → LUT: the company's Letter of Undertaking (Form RFD-11) for each
 * financial year. An LUT is filed per FY, and a 0% export needs the LUT of its own date's FY
 * (tax memo 3 Nov §1): without one the app refuses to bill the export at 0% (bill it with IGST, or
 * add the LUT here). The invoice PDF prints the ARN of the invoice's FY.
 *
 * Owner or accountant edits (save_tenant_lut / delete_tenant_lut check it again); others view.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { lutFyEnd, lutFyLabel, lutFyStart, type TenantLut } from "@/lib/gst/export-lut";
import { useDeleteTenantLut, useSaveTenantLut, useTenantLuts } from "@/lib/queries/tenant-luts";
import { useConfirm } from "@/components/providers/confirm-provider";

/** The FYs offered when adding: this one and the three before it (the Zoho backlog), newest first. */
export function lutFyChoices(today: string): string[] {
  const y = Number(lutFyStart(today).slice(0, 4));
  return [0, 1, 2, 3].map((k) => `${y - k}-04-01`);
}

interface Draft { fyStart: string; arn: string; validFrom: string; validUpto: string }

function draftFor(fyStart: string, row?: TenantLut | null): Draft {
  return {
    fyStart,
    arn: row?.arn ?? "",
    validFrom: (row?.validFrom ?? fyStart).slice(0, 10),
    validUpto: (row?.validUpto ?? lutFyEnd(fyStart)).slice(0, 10),
  };
}

export function LutListCard({ canEdit }: { canEdit: boolean }) {
  const luts = useTenantLuts();
  const save = useSaveTenantLut();
  const remove = useDeleteTenantLut();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const rows = luts.data ?? [];
  const today = istToday();
  const missing = lutFyChoices(today).filter((fy) => !rows.some((r) => r.fyStart.slice(0, 10) === fy));

  const submit = () => {
    if (!draft) return;
    save.mutate(
      { fyStart: draft.fyStart, arn: draft.arn, validFrom: draft.validFrom || null, validUpto: draft.validUpto || null },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <Card className="p-5 max-w-3xl" id="lut">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">LUT for exports (one per financial year)</p>
        {!canEdit && <Badge kind="muted">Owner / accountant · view</Badge>}
      </div>
      <p className="mb-3 text-xs text-ink-3">
        A sale to a customer outside India is billed at 0% GST only under a Letter of Undertaking for that
        sale&apos;s financial year (Form GST RFD-11 on gst.gov.in). Without one, the app asks you to add it
        here or bill the sale with IGST. The invoice prints the ARN of its own year.
      </p>

      {luts.isError ? (
        <p className="text-xs text-rose">Could not load the LUTs — reload the page.</p>
      ) : luts.isLoading ? (
        <p className="text-xs text-ink-3">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-3">
              <th className="py-1 font-medium">Financial year</th>
              <th className="py-1 font-medium">ARN</th>
              <th className="py-1 font-medium">Valid</th>
              <th className="py-1 font-medium text-right"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="py-2 text-xs text-ink-3">No LUT saved yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.fyStart} className="border-t border-hairline">
                <td className="py-2">FY {lutFyLabel(r.fyStart)}</td>
                <td className="py-2 font-mono">{r.arn}</td>
                <td className="py-2 text-ink-2">{formatDate(r.validFrom)} – {formatDate(r.validUpto)}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  {canEdit && (
                    <>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(draftFor(r.fyStart.slice(0, 10), r))}>Edit</Button>
                      <Button type="button" size="sm" variant="ghost" loading={remove.isPending && remove.variables === r.fyStart}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Remove the LUT for FY ${lutFyLabel(r.fyStart)}?`,
                            body: "Exports of that year can be billed at 0% GST again only after you add it back.",
                            danger: true,
                            confirmLabel: "Remove LUT",
                          });
                          if (ok) remove.mutate(r.fyStart.slice(0, 10));
                        }}>Remove</Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && !draft && missing.length > 0 && !luts.isLoading && !luts.isError && (
        <div className="mt-3">
          <Button type="button" size="sm" icon="plus" onClick={() => setDraft(draftFor(missing[0]))}>Add LUT</Button>
        </div>
      )}

      {canEdit && draft && (
        <div className="mt-4 rounded-md border border-hairline p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr_150px_150px]">
            <div>
              <label htmlFor="lut-fy" className="mb-1 block text-xs font-medium text-ink-3">Financial year</label>
              <select id="lut-fy" value={draft.fyStart}
                className="h-9 w-full rounded-md border border-hairline bg-paper px-2 text-sm text-ink"
                onChange={(e) => setDraft(draftFor(e.target.value, rows.find((r) => r.fyStart.slice(0, 10) === e.target.value)))}>
                {Array.from(new Set([draft.fyStart, ...lutFyChoices(today)])).sort().reverse().map((fy) => (
                  <option key={fy} value={fy}>FY {lutFyLabel(fy)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="lut-arn" className="mb-1 block text-xs font-medium text-ink-3">ARN</label>
              <Input id="lut-arn" className="font-mono" placeholder="e.g. AD070426000123X" maxLength={40}
                value={draft.arn} onChange={(e) => setDraft({ ...draft, arn: e.target.value })} />
            </div>
            <div>
              <label htmlFor="lut-from" className="mb-1 block text-xs font-medium text-ink-3">Valid from</label>
              <Input id="lut-from" type="date" min={draft.fyStart} max={lutFyEnd(draft.fyStart)}
                value={draft.validFrom} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} />
            </div>
            <div>
              <label htmlFor="lut-upto" className="mb-1 block text-xs font-medium text-ink-3">Valid up to</label>
              <Input id="lut-upto" type="date" min={draft.fyStart} max={lutFyEnd(draft.fyStart)}
                value={draft.validUpto} onChange={(e) => setDraft({ ...draft, validUpto: e.target.value })} />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" variant="primary" loading={save.isPending}
              disabled={draft.arn.trim() === ""} onClick={submit}>Save LUT</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
