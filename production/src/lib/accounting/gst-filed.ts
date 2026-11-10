/**
 * R-2621 (9 Nov 2026, G-FY2526 D2 + D7) — "GST returns filed up to": the last month whose GSTR-1 / 3B
 * the company has filed. The owner sets it on Accounting → Overview (set_gst_filed_through, stored as the
 * month's last day). The database's ONE rule gst_month_filed() also counts the books lock and GSTR-1
 * marked filed on the Compliance Calendar / Month close; Reconcile from Zoho never books a NEW sale on a
 * filed day (it pays the imported Zoho invoice instead). Pure helpers for the card.
 */

/** "2026-09" (a month input) → "2026-09-30", the day the database stores; "" → null. */
export function monthEndOf(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
}

/** The stored day → the month input's value ("2026-09-30" → "2026-09"); null → "". */
export function monthOf(day: string | null | undefined): string {
  return day && /^\d{4}-\d{2}/.test(day) ? day.slice(0, 7) : "";
}

/** The latest month that can be filed today: the month before today's (IST) month — "2026-10" on 9 Nov 2026. */
export function latestFilableMonth(todayIst: string): string {
  const y = Number(todayIst.slice(0, 4)), m = Number(todayIst.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-30" → "September 2026". */
export function monthName(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}
