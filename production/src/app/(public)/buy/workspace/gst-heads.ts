/**
 * R-1109 (23 Oct 2026) — the GST row label in the Workspace Buy dialog.
 *
 * It always read "+ GST 18% (CGST 9% + SGST 9%)", but the invoice for a buyer outside Delhi
 * says IGST. The head follows the place of supply (lib/gst/place-of-supply#supplyHead): the
 * buyer's state (or their GSTIN's first two digits) against ours (COMPANY.gstin). Before a
 * state is known the label is a neutral "GST 18%". The amount never changes — only its heads.
 */
import { supplyHead } from "@/lib/gst/place-of-supply";
import { resolveStateCode, stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { COMPANY } from "@/site/lib/config";

export function workspaceGstLabel(buyer: { stateCode?: string | null; gstin?: string | null }, ratePct = 18): string {
  const head = supplyHead({
    isExport: false,
    buyerStateCode: resolveStateCode({ stateCode: buyer.stateCode, gstin: buyer.gstin }),
    sellerStateCode: stateCodeFromGstin(COMPANY.gstin),
  });
  if (!head.known) return `GST ${ratePct}%`;
  const half = ratePct / 2;
  return head.interState ? `IGST ${ratePct}%` : `GST ${ratePct}% (CGST ${half}% + SGST ${half}%)`;
}
