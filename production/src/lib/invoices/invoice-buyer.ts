/**
 * R-2540 (fixes R-2536 review) — the BUYER an issued invoice names: GSTIN, address, state.
 *
 * One rule for every reader that prints or judges an invoice — the server PDF (lib/pdf/build-props),
 * the invoice page (its tax-invoice dialog, receipt voucher and e-invoice/IRN notice) and the
 * invoices list's IRN ageing banner — so none of them can disagree with the GSTR-1 builder
 * (frozenParty, lib/gst/place-of-supply).
 *
 * An invoice that carries its snapshot (R-043: seller_state_code / pos_state_code / billing_address
 * set by trg_invoice_snapshot_parties; R-2536: party_from_source = a Zoho FY sale kept AS FILED) is
 * read from the invoice itself: a NULL GSTIN there means "unregistered at issue" (a B2C supply) and
 * is NEVER filled from today's customer — or a B2C sale filed in Zoho's GSTR-1 would print the
 * customer's GSTIN and show "B2B without IRN". The address is the invoice's own; on a Zoho sale with
 * none (a branch invoice from a scan read before R-2536) nothing is printed rather than another
 * branch's address. Only a legacy row with no snapshot at all reads the live customer, as before.
 */
import { GST_STATE_BY_CODE } from "@/lib/utils";

/** The invoice columns this reads (party_from_source is not in the generated types yet). */
export interface BuyerSnapshot {
  customer_gstin?: string | null;
  billing_address?: string | null;
  customer_country?: string | null;
  pos_state_code?: string | null;
  seller_state_code?: string | null;
  party_from_source?: boolean | null;
}

/** Today's customer row — only the fields read here. */
export interface LiveBuyer {
  gstin?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  country?: string | null;
}

export interface InvoiceBuyer {
  gstin: string | null;
  address: string | null;
  state: string | null;
  /** The place of supply's code ("96" = export) — the live customer's only for a legacy row. */
  stateCode: string | null;
  country: string | null;
}

/** True when the invoice carries its own buyer facts (frozenParty's test + the R-2536 stamp). */
export function hasBuyerSnapshot(inv: BuyerSnapshot | null | undefined): boolean {
  if (!inv) return false;
  return inv.party_from_source === true
    || inv.seller_state_code != null || inv.pos_state_code != null || inv.billing_address != null;
}

const liveAddress = (c: LiveBuyer | null | undefined) =>
  [c?.address, c?.city].filter(Boolean).join(", ") || null;

export function invoiceBuyer(inv: BuyerSnapshot | null | undefined, live: LiveBuyer | null | undefined): InvoiceBuyer {
  if (!hasBuyerSnapshot(inv) || !inv) {
    return {
      gstin: live?.gstin ?? null,
      address: liveAddress(live),
      state: live?.state ?? null,
      stateCode: live?.state_code ?? null,
      country: live?.country ?? null,
    };
  }
  const asFiled = inv.party_from_source === true;
  const pos = inv.pos_state_code?.trim() || null;
  /* State: the place of supply frozen at issue. A snapshot without one (backfill left it unknown) keeps
     today's state — except an as-filed Zoho sale, which may belong to another branch. */
  const state = pos === "96" ? null
    : pos ? (GST_STATE_BY_CODE[pos] ?? (asFiled ? null : live?.state ?? null))
    : (asFiled ? null : live?.state ?? null);
  return {
    gstin: inv.customer_gstin ?? null,
    address: inv.billing_address ?? (asFiled ? null : liveAddress(live)),
    state,
    stateCode: pos ?? (asFiled ? null : live?.state_code ?? null),
    country: inv.customer_country ?? live?.country ?? null,
  };
}

/** The GSTIN the e-invoice (IRN) rule reads: the invoice's own once it has a snapshot. */
export function invoiceIrnGstin(inv: BuyerSnapshot, liveGstin: string | null | undefined): string | null {
  return hasBuyerSnapshot(inv) ? (inv.customer_gstin ?? null) : (inv.customer_gstin ?? liveGstin ?? null);
}
