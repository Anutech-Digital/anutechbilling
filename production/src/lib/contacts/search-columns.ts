/**
 * R-1821 (24 Oct 2026, security audit) — search boxes for a role that sees masked contacts.
 *
 * The data gateway refuses a filter on a phone / email column from a role without
 * can_view_contact_details (server/postgrest/contact-mask.ts#maskedQueryRefusal): searching the
 * real value would tell that role the number it is not allowed to see. So the browser's search
 * boxes (Ctrl+K, Customers, Online Orders) leave those columns out for such a role — the search
 * still finds by name, company, domain — instead of asking and getting a 400. Owner and manager
 * keep the full search.
 */
import { can } from "@/lib/auth/roles";

/** A column holding a phone / email — same rule as the gateway's column scan (R-1820). */
export const CONTACT_COLUMN_NAME = /phone|email|mobile|whatsapp/;

/** True when this role's searches must skip phone / email columns. Role still loading → true (fail closed). */
export function contactSearchHidden(role: string | null | undefined): boolean {
  return !can(role, "can_view_contact_details");
}

/** The search columns, without the phone / email ones when `hide`. */
export function searchableColumns<T extends string>(columns: readonly T[], hide: boolean): T[] {
  return hide ? columns.filter((c) => !CONTACT_COLUMN_NAME.test(c)) : [...columns];
}
