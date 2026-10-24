/**
 * R-1848 — Balance Sheet → Partners' capital accounts, per partner (Partnership / LLP).
 *
 * Sits inside R-1845's equity section (equity-section.ts gives the section and its total; this
 * box only breaks that total down by partner — it never changes it). One fluctuating account
 * per partner (Pardeep's decision): Opening + Capital introduced + Share of profit − Drawings =
 * Closing. Profit share = ratio × profit, marked as an estimate until the year-end split
 * (R-1849) is posted. Click a partner for the dated statement + CSV. Older entries with a
 * typed name show under that name with "Link to partner". Whatever the partners' accounts do
 * not cover (the CA's lump opening, hand-entered lines) shows as "Not yet split".
 * Stacked rows, no wide table — fits 375px.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { downloadCSV } from "@/lib/csv";
import { formatDate } from "@/lib/utils";
import {
  partnerCapitalAccounts, partnerStatement, partnerCapitalCsv,
  type PartnerCapitalRow, type Range, type PostedSplit,
} from "@/lib/accounting/partner-capital";
import type { FirmPartner } from "@/lib/accounting/partners";
import type { OwnerEquityMovement } from "@/lib/accounting/owner-equity";
import { useLinkOwnerEquityPartner } from "@/lib/queries/partners";
import { PARTNERS_HREF } from "@/components/features/partners/partner-picker";
import { fmtBS } from "./format";

const NO_SPLITS: readonly PostedSplit[] = [];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "partner";

/** R-1849: the year-end split screen. */
export const PROFIT_SPLIT_HREF = "/accounting/balance-sheet/profit-split";

export function PartnerCapitalBox({ partners, movements, profit, posted = NO_SPLITS, range, sectionTotal }: {
  partners: readonly FirmPartner[];
  movements: readonly OwnerEquityMovement[];
  /** The Balance Sheet's profit for the range; null while it loads. */
  profit: number | null;
  /** R-1849: posted year-end splits — they replace the estimate for their year. */
  posted?: readonly PostedSplit[];
  range: Range;
  /** The equity section's total (equitySectionTotal) — the partners' closings add up to it with "Not yet split". */
  sectionTotal: number | null;
}) {
  const link = useLinkOwnerEquityPartner();
  const [open, setOpen] = React.useState<string | null>(null);
  const acc = React.useMemo(
    () => partnerCapitalAccounts({ partners, movements, profit, posted, range, sectionTotal }),
    [partners, movements, profit, posted, range, sectionTotal],
  );
  const linkChoices = [...partners].sort((a, b) => a.name.localeCompare(b.name));

  if (acc.rows.length === 0) {
    return (
      <div className="rounded-md bg-paper-2/40 px-2 py-1.5 my-1 text-xs text-ink-3">
        Each partner&apos;s capital account shows here once the partners are in the register.{" "}
        <Link href={PARTNERS_HREF as never} className="text-indigo underline">Add partners</Link>
      </div>
    );
  }

  function linkGroup(row: PartnerCapitalRow, partnerId: string) {
    if (!partnerId) return;
    const name = row.key.slice(5);
    for (const m of movements) {
      if (!m.partner_id && (m.partner_name?.trim().toLowerCase() ?? "") === name) link.mutate({ movementId: m.id, partnerId });
    }
  }

  function exportCsv(row: PartnerCapitalRow) {
    const { header, rows } = partnerCapitalCsv(row, movements, range);
    downloadCSV(`capital-account-${slug(row.name)}.csv`, header, rows);
  }

  return (
    <div className="rounded-md bg-paper-2/40 px-2 py-1.5 my-1">
      <p className="text-xs font-medium text-ink-2">Each partner&apos;s capital account</p>
      <p className="text-3xs text-ink-3">Opening + capital introduced + share of profit − drawings = closing. Tap a partner for the statement.</p>
      <ul className="mt-1 divide-y divide-hairline">
        {acc.rows.map((r) => {
          const isOpen = open === r.key;
          return (
            <li key={r.key} className="py-1">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.key)}
                className="w-full text-left rounded px-1 py-0.5 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo/40">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words text-ink">
                    {r.name}
                    {r.linked && r.sharePct > 0 && <span className="text-xs text-ink-3"> · {r.sharePct}%</span>}
                    {r.left && <span className="text-xs text-ink-3"> · left</span>}
                  </span>
                  <span className="tabular-nums font-medium shrink-0">{fmtBS(r.closing)}</span>
                </span>
                <span className="block text-xs text-ink-3 tabular-nums">
                  {fmtBS(r.opening)} + {fmtBS(r.capitalIntroduced)} in
                  {r.interest !== 0 && <> + {fmtBS(r.interest)} interest</>}
                  {r.remuneration !== 0 && <> + {fmtBS(r.remuneration)} remuneration</>}
                  {" "}+ {fmtBS(r.profitShare)} profit
                  {r.tds !== 0 && <> − {fmtBS(r.tds)} TDS</>}
                  {" "}− {fmtBS(r.drawings)} drawings
                </span>
              </button>
              {!r.linked && r.partnerId === null && r.key !== "name:no partner named" && linkChoices.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-1 mt-1 text-xs text-amber-ink">
                  <span>Typed name, not linked to the register.</span>
                  <select aria-label={`Link ${r.name} to a partner`} defaultValue="" disabled={link.isPending}
                    onChange={(e) => linkGroup(r, e.target.value)}
                    className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink">
                    <option value="">Link to partner…</option>
                    {linkChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              {isOpen && (
                <div className="mt-1 px-1">
                  <table aria-label={`Capital account of ${r.name}`} className="w-full text-xs">
                    <tbody>
                      {partnerStatement(r, movements, range).map((l, i) => (
                        <tr key={i} className={l.total ? "border-t border-hairline font-semibold" : ""}>
                          <td className="py-0.5 pr-2 text-ink-3 whitespace-nowrap align-top">{l.date ? formatDate(l.date) : ""}</td>
                          <td className="py-0.5 pr-2 text-ink-2 align-top">{l.label}{l.note ? <span className="text-ink-3"> · {l.note}</span> : null}</td>
                          <td className="py-0.5 text-right tabular-nums align-top">{fmtBS(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Button size="sm" variant="ghost" icon="download" className="mt-1" aria-label={`CSV for ${r.name}`} onClick={() => exportCsv(r)}>CSV</Button>
                </div>
              )}
            </li>
          );
        })}
        {acc.notSplit !== null && acc.notSplit !== 0 && (
          <li className="py-1 px-1">
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink-2">Not yet split between partners</span>
              <span className="tabular-nums shrink-0">{fmtBS(acc.notSplit)}</span>
            </span>
            {acc.notSplit > 0 ? (
              <span className="block text-xs text-ink-3">The CA&apos;s opening figure, hand-entered lines or profit not covered by the ratios. Set each partner&apos;s capital contribution in <Link href={PARTNERS_HREF as never} className="underline">the register</Link>.</span>
            ) : (
              <span className="block text-xs text-ink-3">The partner accounts add up to more than the equity on this Balance Sheet — usually the opening equity is lower than the capital contributions in <Link href={PARTNERS_HREF as never} className="underline">the register</Link>. Check the opening balance with your CA.</span>
            )}
          </li>
        )}
      </ul>
      {!acc.profitLoading && acc.rows.some((r) => r.estimatedShare !== 0) && (
        <p className="text-3xs text-ink-3 mt-0.5">Share of profit for a year not yet split is an estimate by profit-sharing ratio.</p>
      )}
      <Link href={PROFIT_SPLIT_HREF as never} className="mt-1 inline-block text-xs font-medium text-indigo underline">
        Split the year&apos;s profit — interest, remuneration, shares
      </Link>
    </div>
  );
}
