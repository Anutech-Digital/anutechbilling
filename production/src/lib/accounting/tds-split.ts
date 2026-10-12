/**
 * From what reached the bank back to the invoice, when the customer withheld TDS.
 *
 * TDS is deducted on the value BEFORE GST (CBDT Circular 23/2017, when GST is shown
 * separately), so a receipt of `net` is:
 *
 *     net = taxable × (1 + gst%) − taxable × tds%   →   taxable = net ÷ (1 + gst% − tds%)
 *
 * Demo Co: ₹5,40,000 ÷ (1 + 0.18 − 0.10) = ₹5,00,000 taxable → ₹5,90,000 invoice,
 * ₹50,000 TDS. TDS is taken as gross − net, so the three always add up to the rupee.
 */

export interface TdsSection { key: string; section: string; ratePct: number; label: string }

/** The sections a software / services business meets most. */
export const TDS_SECTIONS: readonly TdsSection[] = [
  { key: "194J-10", section: "194J", ratePct: 10, label: "194J · 10% — professional / software development" },
  { key: "194J-2",  section: "194J", ratePct: 2,  label: "194J · 2% — technical services" },
  { key: "194C-2",  section: "194C", ratePct: 2,  label: "194C · 2% — contract (company)" },
  { key: "194C-1",  section: "194C", ratePct: 1,  label: "194C · 1% — contract (individual / HUF)" },
];

export interface TdsSplit {
  /** Pre-GST value — what the TDS is computed on. */
  taxable: number;
  gst: number;
  /** Invoice value, GST-inclusive — what the receipt settles. */
  gross: number;
  tds: number;
  net: number;
}

export function tdsSplitFromNet(net: number, gstRatePct: number, tdsRatePct: number): TdsSplit {
  const taxable = Math.round(net / (1 + gstRatePct / 100 - tdsRatePct / 100));
  const gst = Math.round((taxable * gstRatePct) / 100);
  const gross = taxable + gst;
  return { taxable, gst, gross, tds: gross - net, net };
}
