/**
 * R-1621 — the "Grace over" list on Renewals: pure helpers (no I/O), tested in grace-over.test.ts.
 *
 * A row is on the list when the renewals cron has raised the owner's "Stop service" task for
 * its CURRENT term (grace_task_for = renewal_date) and the subscription is still active — the
 * owner has neither stopped it nor been paid. Paying rolls renewal_date on, so the row leaves
 * the list by itself.
 */
import { formatIstDate } from "@/lib/dates/ist";

export interface GraceOverRow {
  id:              string;
  customer_id:     string | null;
  customer_name:   string;
  plan:            string | null;
  vendor:          string | null;
  status:          string;
  renewal_state:   string | null;
  renewal_date:    string | null;
  grace_until:     string | null;
  grace_task_for:  string | null;
}

/** Owner and manager decide; everyone else sees the list and who to ask. */
export const GRACE_DECIDERS = ["owner", "manager"] as const;
export function canDecideGrace(role: string | null | undefined): boolean {
  return !!role && (GRACE_DECIDERS as readonly string[]).includes(role);
}

export function graceOverRows(rows: readonly GraceOverRow[]): GraceOverRow[] {
  return rows
    .filter((r) => r.status === "active" && r.renewal_state !== "renewed" && r.renewal_state !== "suspended"
      && !!r.renewal_date && r.grace_task_for === r.renewal_date)
    .sort((a, b) => (a.renewal_date! < b.renewal_date! ? -1 : a.renewal_date! > b.renewal_date! ? 1 : a.customer_name.localeCompare(b.customer_name)));
}

/** "+ days" box: a whole number 1..30, or null (the button waits). Same bounds as the server. */
export function parseExtraDays(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 30 ? n : null;
}

/** What the vendor-side stop looks like — the app has no vendor access (R-338). */
export function vendorStopSteps(vendor: string | null | undefined): string {
  switch (vendor) {
    case "google":    return "Google Admin → Billing → Subscriptions → suspend this subscription.";
    case "microsoft": return "Microsoft Partner Center → the customer → Subscriptions → suspend.";
    case "hosting":   return "Hosting panel → this account → Suspend.";
    case "domain":    return "Nothing at the registrar — an unpaid domain lapses by itself.";
    default:          return "Stop it in the vendor's admin panel by hand.";
  }
}

export function stopServiceConfirm(row: GraceOverRow): { title: string; body: string } {
  return {
    title: `Stop service for ${row.customer_name}?`,
    body:
      `${row.plan ?? "This subscription"} — renewal due ${row.renewal_date ? formatIstDate(row.renewal_date) : "—"} is not paid and the grace is over.\n` +
      `The app marks it suspended now. Then stop it at the vendor yourself: ${vendorStopSteps(row.vendor)}\n` +
      `When the customer pays the renewal it turns active again in the app — then turn the service back on at the vendor.`,
  };
}

export function stoppedToast(row: GraceOverRow): { title: string; description: string } {
  return {
    title: `${row.customer_name} marked suspended`,
    description: `Next: ${vendorStopSteps(row.vendor)}`,
  };
}

export function extendedToast(row: GraceOverRow, graceUntil: string | null | undefined, days: number): string {
  return graceUntil
    ? `${row.customer_name}: ${days} more day${days === 1 ? "" : "s"} — grace now ends ${formatIstDate(graceUntil)}. The task comes back the day after.`
    : `${row.customer_name}: ${days} more day${days === 1 ? "" : "s"} given.`;
}
