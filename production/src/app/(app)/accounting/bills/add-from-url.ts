/**
 * R-1511 — "Record a bill" from a vendor opens THIS page with the Add Bill dialog already
 * open and that vendor filled in: /accounting/bills?add=1&vendor=<id>.
 *
 * Pardeep (staging, Net2Secure): the Vendors Master popup only offered "Buy Products"
 * (→ purchase orders) and "Edit vendor" — no way to record the vendor's bill from there.
 *
 * The page reads the two params ONCE after mount (from `window`, like useUrlState — never
 * useSearchParams, which breaks prerendering), clears them with replaceState so a reload
 * or Back does not re-open the dialog, and seeds the dialog's existing `prefill` with the
 * vendor's name + GSTIN + default category. On save the dialog's find-or-create
 * (ensureVendor: GSTIN first, then name) links the bill to this same vendor.
 */
import * as React from "react";
import type { Route } from "next";
import type { VendorBillPrefill } from "@/components/features/accounting/add-vendor-bill-dialog";

export const ADD_PARAM = "add";
export const VENDOR_PARAM = "vendor";

/** Link that opens Bills with Add Bill open for this vendor. */
export function recordBillHref(vendorId: string): Route {
  const qs = new URLSearchParams({ [ADD_PARAM]: "1", [VENDOR_PARAM]: vendorId });
  return `/accounting/bills?${qs.toString()}` as Route;
}

/** What the URL asks for: open Add Bill (add=1), optionally for one vendor. */
export function readAddBillParams(search: string): { open: boolean; vendorId: string | null } {
  const p = new URLSearchParams(search);
  const open = p.get(ADD_PARAM) === "1";
  const vendorId = p.get(VENDOR_PARAM)?.trim() || null;
  return { open, vendorId: open ? vendorId : null };
}

/** The same query string without add/vendor ("" when nothing else is left). */
export function withoutAddBillParams(search: string): string {
  const p = new URLSearchParams(search);
  p.delete(ADD_PARAM);
  p.delete(VENDOR_PARAM);
  const s = p.toString();
  return s ? `?${s}` : "";
}

type VendorLike = { id: string; name: string; gstin: string | null; default_category: string | null };

/** Dialog prefill for one vendor — only what the vendor master actually has. */
export function vendorBillPrefill(v: VendorLike): VendorBillPrefill {
  return {
    vendor_name: v.name,
    vendor_gstin: v.gstin || null,
    category_guess: v.default_category || null,
  };
}

/**
 * Reads ?add=1&vendor=<id> once, clears it from the address bar, and — when the vendor
 * list has loaded — calls `open(prefill | undefined)`. An unknown vendor id still opens an
 * empty Add Bill (the person asked to record a bill; the name is typed by hand).
 */
export function useAddBillFromUrl(
  vendors: VendorLike[] | undefined,
  vendorsLoading: boolean,
  open: (prefill: VendorBillPrefill | undefined) => void,
): void {
  const [pending, setPending] = React.useState<{ vendorId: string | null } | null>(null);

  React.useEffect(() => {
    const { open: wantsOpen, vendorId } = readAddBillParams(window.location.search);
    if (!wantsOpen) return;
    setPending({ vendorId });
    const qs = withoutAddBillParams(window.location.search);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs}${window.location.hash}`);
  }, []);

  React.useEffect(() => {
    if (!pending) return;
    if (pending.vendorId && vendorsLoading) return; // wait for the list, then prefill once
    const v = pending.vendorId ? (vendors ?? []).find((x) => x.id === pending.vendorId) : undefined;
    setPending(null);
    open(v ? vendorBillPrefill(v) : undefined);
  }, [pending, vendors, vendorsLoading, open]);
}
