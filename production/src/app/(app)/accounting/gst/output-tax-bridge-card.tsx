/**
 * R-521 (9 Oct 2026): "Where the GSTR-3B output tax comes from" — the Output GST card
 * (invoices + notes = GSTR-1 document rows) bridged to GSTR-3B 3.1, with tax on advances
 * (GSTR-1 Table 11A / 11B) as its own named lines and the receipt vouchers behind them.
 * Numbers come from ./cash-to-pay outputTaxBridge; this file only draws them.
 */
import * as React from "react";

import { Card } from "@/components/ui/card";
import type { Gstr3b } from "@/lib/gst/gstr3b";
import { rupee, formatDate } from "@/lib/utils";
import type { OutputTaxBridge } from "./cash-to-pay";

export function OutputTaxBridgeCard({ bridge, g3b, advTax, rangeLabel }: { bridge: OutputTaxBridge; g3b: Gstr3b; advTax: number; rangeLabel: string }) {
  return (
    <Card id="output-tax-bridge" className="mb-6 p-4 md:p-5 scroll-mt-20">
      <div className="min-w-0 mb-3">
        <div className="font-medium text-ink">Where the GSTR-3B output tax comes from — {rangeLabel}</div>
        <p className="text-xs text-ink-2 mt-0.5 leading-relaxed max-w-3xl">
          The Output GST card counts invoices and notes (the GSTR-1 document rows). GSTR-3B 3.1 also includes tax on
          advances received before an invoice (GSTR-1 Table 11A) and takes back earlier advances once invoiced (Table 11B).
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
            <tr>
              <th className="text-left px-3 py-2">Part</th>
              <th className="text-left px-3 py-2">Reported in</th>
              <th className="text-right px-3 py-2">Count</th>
              <th className="text-right px-3 py-2">Taxable</th>
              <th className="text-right px-3 py-2">IGST</th>
              <th className="text-right px-3 py-2">CGST</th>
              <th className="text-right px-3 py-2">SGST</th>
              <th className="text-right px-3 py-2">Tax</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline font-mono">
            {bridge.lines.filter((l) => l.count > 0).map((l) => (
              <React.Fragment key={l.key}>
                <tr>
                  <td className="px-3 py-2 font-sans text-ink">{l.label}</td>
                  <td className="px-3 py-2 font-sans text-ink-3 text-xs">{l.source}</td>
                  <td className="px-3 py-2 text-right text-ink-3">{l.count}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{rupee(l.taxable)}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{rupee(l.heads.igst)}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{rupee(l.heads.cgst)}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{rupee(l.heads.sgst)}</td>
                  <td className="px-3 py-2 text-right text-ink font-semibold">{rupee(l.tax)}</td>
                </tr>
                {l.items && l.items.length > 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 pb-2 pt-0 font-sans">
                      <details className="text-xs text-ink-2">
                        <summary className="cursor-pointer text-ink-3 hover:text-ink">Receipt vouchers ({l.items.length})</summary>
                        <ul className="mt-1 space-y-0.5 tabular-nums">
                          {l.items.map((it) => (
                            <li key={it.ref + it.date} className="flex flex-wrap justify-between gap-x-4">
                              <span><b className="text-ink">{it.ref}</b> · {formatDate(it.date)}</span>
                              <span className="font-mono">received {rupee(it.gross)} → taxable {rupee(it.taxable)} + tax {rupee(it.tax)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            <tr className="bg-paper-2/30 font-semibold">
              <td className="px-3 py-2 font-sans text-ink" colSpan={3}>= GSTR-3B 3.1(a){g3b.zeroTaxable !== 0 || g3b.zeroIgst !== 0 ? " + 3.1(b)" : ""}</td>
              <td className="px-3 py-2 text-right text-ink">{rupee(bridge.gstr3b.taxable)}</td>
              <td className="px-3 py-2 text-right text-ink">{rupee(bridge.gstr3b.heads.igst)}</td>
              <td className="px-3 py-2 text-right text-ink">{rupee(bridge.gstr3b.heads.cgst)}</td>
              <td className="px-3 py-2 text-right text-ink">{rupee(bridge.gstr3b.heads.sgst)}</td>
              <td className="px-3 py-2 text-right text-ink">{rupee(bridge.gstr3b.tax)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className={`text-xs mt-2 ${bridge.difference === 0 ? "text-emerald" : "text-rose font-semibold"}`}>
        {bridge.difference === 0
          ? `Every rupee accounted for: ${rupee(bridge.card.tax)} on the Output GST card${advTax !== 0 ? ` ${advTax > 0 ? "+" : "−"} ${rupee(Math.abs(advTax))} tax on advances` : ""} = ${rupee(bridge.gstr3b.tax)} in GSTR-3B.`
          : `Unexplained difference of ${rupee(bridge.difference)} between these parts and GSTR-3B — do not file; report it.`}
      </p>
    </Card>
  );
}
