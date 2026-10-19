/**
 * R-1531 — revised Tax Invoices after GST registration (CGST Section 31(3)(a), Rule 53(2)).
 *
 * A business that gets registered with an effective date in the past has been issuing Bills
 * of Supply (no GST) for supplies the law now treats as made by a registered person — from
 * the effective date until its registration certificate (REG-06) was issued. Section
 * 31(3)(a) lets it issue a REVISED Tax Invoice against each, within ONE MONTH of the
 * certificate date. The app only REMINDS (owner decision q4 on R-1529): nothing is converted,
 * renumbered or re-taxed automatically.
 *
 * Which bills: issued (pending / paid / overdue — composition-return.ts `isIssuedStatus`)
 * Bills of Supply frozen at issue as supplier_gst_status = 'unregistered' (R-1529's trigger),
 * dated from tenants.gst_registered_from to tenants.gst_rc_date (or today when the certificate
 * date is not entered yet). Composition bills are not in it — a composition dealer is already
 * registered.
 *
 * Deadline: the certificate date + one calendar month, the same day next month (General
 * Clauses Act s.9 excludes the first day) and the month's last day when it is shorter
 * (31 Jan → 28/29 Feb). Without a certificate date there is no deadline to show — the
 * reminder still shows (fail-closed, §17c) and asks for the date. After the deadline the
 * reminder stays for REVISED_INVOICE_GRACE_DAYS as overdue ("talk to your CA"), then goes.
 *
 * Pure: no React, no client. Loader: revised-invoice-query.ts.
 */
import { daysBetweenISO, formatIstDate } from "@/lib/dates/ist";
import { isBillOfSupply, supplierGstStatusOf, type DocumentKindFields } from "@/lib/invoices/document-kind";
import type { TodayItem } from "@/lib/today/inbox";

import { billOfSupplyValue, isIssuedStatus } from "./composition-return";
import type { GstRegistration } from "./gst-registration";

export interface RevisedInvoiceBill extends DocumentKindFields {
  id: string;
  invoice_date: string;
  amount: number | null;
  taxable_value: number | null;
  status: string | null;
  customer_name: string | null;
}

export interface RevisedInvoiceSettings {
  /** tenants.gst_registration as saved. */
  saved: GstRegistration | null;
  /** tenants.gst_registered_from — registration effective date. */
  registeredFrom: string | null;
  /** tenants.gst_rc_date — date the registration certificate was issued. */
  rcDate: string | null;
}

export type RevisedInvoiceState = "open" | "overdue" | "no_rc_date";

export interface RevisedInvoiceReminder {
  from: string;
  to: string;
  bills: RevisedInvoiceBill[];
  count: number;
  /** Value of the bills (₹, paise-rounded). */
  total: number;
  rcDate: string | null;
  deadline: string | null;
  /** deadline − today in IST days; negative once late; null without a certificate date. */
  daysLeft: number | null;
  state: RevisedInvoiceState;
}

/** How long a missed deadline stays on screen before the reminder goes. */
export const REVISED_INVOICE_GRACE_DAYS = 30;

/** Where the reminder lives — /today links here. */
export const REVISED_INVOICE_ANCHOR = "revised-invoices";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Certificate date + one calendar month (clamped to the month's last day). */
export function revisedInvoiceDeadline(rcDate: string): string {
  const y = Number(rcDate.slice(0, 4));
  const m = Number(rcDate.slice(5, 7)); // 1-12
  const d = Number(rcDate.slice(8, 10));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The dates whose Bills of Supply need a revised invoice, or null when none can. */
export function revisedInvoiceWindow(s: RevisedInvoiceSettings, today: string): { from: string; to: string } | null {
  if (s.saved !== "registered") return null;
  if (!s.registeredFrom || !ISO.test(s.registeredFrom)) return null;
  const to = s.rcDate && ISO.test(s.rcDate) ? s.rcDate : today;
  if (to < s.registeredFrom) return null;
  return { from: s.registeredFrom, to };
}

function needsRevision(b: RevisedInvoiceBill, w: { from: string; to: string }): boolean {
  return isBillOfSupply(b)
    && supplierGstStatusOf(b) === "unregistered"
    && isIssuedStatus(b.status)
    && b.invoice_date >= w.from && b.invoice_date <= w.to;
}

export function revisedInvoiceReminder(args: {
  settings: RevisedInvoiceSettings;
  bills: readonly RevisedInvoiceBill[];
  today: string;
}): RevisedInvoiceReminder | null {
  const w = revisedInvoiceWindow(args.settings, args.today);
  if (!w) return null;
  const bills = args.bills.filter((b) => needsRevision(b, w))
    .sort((a, b) => (a.invoice_date === b.invoice_date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.invoice_date < b.invoice_date ? -1 : 1));
  if (bills.length === 0) return null;

  const rcDate = args.settings.rcDate && ISO.test(args.settings.rcDate) ? args.settings.rcDate : null;
  const deadline = rcDate ? revisedInvoiceDeadline(rcDate) : null;
  const daysLeft = deadline ? daysBetweenISO(args.today, deadline) : null;
  if (daysLeft !== null && daysLeft < -REVISED_INVOICE_GRACE_DAYS) return null;

  const total = Math.round(bills.reduce((s, b) => s + billOfSupplyValue(b), 0) * 100) / 100;
  return {
    ...w,
    bills,
    count: bills.length,
    total,
    rcDate,
    deadline,
    daysLeft,
    state: deadline === null ? "no_rc_date" : daysLeft! < 0 ? "overdue" : "open",
  };
}

/** "Issue revised tax invoices for 2 Bills of Supply" — the reminder's headline. */
export function revisedInvoiceHeadline(r: Pick<RevisedInvoiceReminder, "count">): string {
  return r.count === 1
    ? "Issue a revised tax invoice for 1 Bill of Supply"
    : `Issue revised tax invoices for ${r.count} Bills of Supply`;
}

/** The /today row (kind "compliance" — the GST / TDS chip), linking to the list on /compliance. */
export function revisedInvoiceTodayItem(r: RevisedInvoiceReminder | null): TodayItem | null {
  if (!r) return null;
  const head = revisedInvoiceHeadline(r);
  const when = r.deadline === null
    ? "add your GST certificate date"
    : r.state === "overdue" ? `deadline was ${formatIstDate(r.deadline)}` : `by ${formatIstDate(r.deadline)}`;
  return {
    kind: "compliance",
    id: `revised-invoices|${r.from}`,
    title: `${head} · ${when}`,
    due_at: r.deadline ? new Date(`${r.deadline}T00:00:00+05:30`).toISOString() : null,
    /* Same scale as complianceTodayItems: late 88, ≤ 7 days (or no date to plan by) 78, else 62. */
    priority: r.state === "overdue" ? 88 : r.daysLeft === null || r.daysLeft <= 7 ? 78 : 62,
    href: `/compliance#${REVISED_INVOICE_ANCHOR}`,
  };
}
