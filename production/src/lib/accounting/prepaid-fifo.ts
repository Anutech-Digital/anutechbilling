/**
 * Preview of how one vendor invoice will be drawn from that vendor's prepaid top-ups —
 * oldest first, GST split pro rata with the remainder on the last slice.
 *
 * It mirrors the consume_prepaid_fifo RPC (migration 20260925160000) so the dialog can
 * show the split BEFORE booking. The RPC is the authority: it re-reads and locks the
 * advances, so a preview that went stale is refused there, never booked wrongly.
 */

import { rupee } from "@/lib/utils";

export type OpenAdvance = {
  id: string;
  vendor_name: string;
  paid_date: string;
  created_at: string;
  total_amount: number;
  consumed_amount: number;
};

export type FifoSlice = { advanceId: string; paidDate: string; amount: number; gst: number };

export type FifoPlan =
  | { ok: true; slices: FifoSlice[]; leftAfter: number }
  | { ok: false; available: number; reason: string };

const sameVendor = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function planFifo(advances: OpenAdvance[], vendor: string, amount: number, gst: number): FifoPlan {
  const open = advances
    .filter((a) => sameVendor(a.vendor_name, vendor) && a.total_amount > a.consumed_amount)
    .sort((a, b) => a.paid_date.localeCompare(b.paid_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const available = open.reduce((s, a) => s + a.total_amount - a.consumed_amount, 0);

  if (!(amount > 0)) return { ok: false, available, reason: "Enter the invoice total." };
  if (gst < 0 || gst > amount) return { ok: false, available, reason: "GST must be between 0 and the invoice total." };
  if (available < amount) {
    return {
      ok: false, available,
      reason: `Only ${rupee(available)} is left in ${vendor.trim()} advances — record the missing top-up first (reconcile its bank line as an advance).`,
    };
  }

  const slices: FifoSlice[] = [];
  let left = amount;
  let gstLeft = gst;
  for (const a of open) {
    if (left <= 0) break;
    const take = Math.min(left, a.total_amount - a.consumed_amount);
    const gstTake = take === left ? gstLeft : Math.min(gstLeft, Math.round((gst * take) / amount));
    slices.push({ advanceId: a.id, paidDate: a.paid_date, amount: take, gst: gstTake });
    left -= take;
    gstLeft -= gstTake;
  }
  return { ok: true, slices, leftAfter: available - amount };
}

/** Vendors that still have money in advances, with how much — for the invoice dialog. */
export function openBalancesByVendor(advances: OpenAdvance[]): Array<{ vendor: string; balance: number; count: number }> {
  const m = new Map<string, { vendor: string; balance: number; count: number }>();
  for (const a of advances) {
    const bal = a.total_amount - a.consumed_amount;
    if (bal <= 0) continue;
    const key = a.vendor_name.trim().toUpperCase();
    const g = m.get(key) ?? { vendor: a.vendor_name.trim(), balance: 0, count: 0 };
    g.balance += bal;
    g.count += 1;
    m.set(key, g);
  }
  return [...m.values()].sort((x, y) => y.balance - x.balance);
}
