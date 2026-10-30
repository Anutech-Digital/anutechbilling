/**
 * R-2108 — what /buy/support fills in for a support-desk customer we already know.
 *
 * The desk's Upgrade link carries only the email; the page used to leave name, company, phone
 * and state empty, so a Free customer typed again what we already hold. Only used when the
 * link names an attachable customer (same company, active, same email — R-2102's rule), so a
 * visitor never sees someone else's details.
 */
import { resolveStateCode, stateCodeFromName } from "@/lib/gst/gstin-state";

export interface SupportBuyPrefill {
  name: string;
  company: string;
  phone: string;
  stateCode: string;
}

export interface PrefillCustomerRow {
  name: string | null;
  contact_name: string | null;
  contact_mobile: string | null;
  contact_phone: string | null;
  state: string | null;
  state_code: string | null;
  gstin: string | null;
}

const clean = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  /* A masked number (R-1009, "••••3210") is not a number to send. */
  return s.includes("•") ? "" : s;
};

/** The primary contact (lib/contacts/primary.ts) wins for the person; the record is the floor. */
export function supportBuyPrefill(
  row: PrefillCustomerRow,
  primary: { name: string | null; phone: string | null } | null,
): SupportBuyPrefill {
  const code = resolveStateCode({ stateCode: row.state_code, gstin: row.gstin }) ?? stateCodeFromName(row.state) ?? "";
  return {
    name: clean(primary?.name) || clean(row.contact_name),
    company: clean(row.name),
    phone: clean(primary?.phone) || clean(row.contact_mobile) || clean(row.contact_phone),
    stateCode: /^\d{2}$/.test(code) ? code : "",
  };
}
