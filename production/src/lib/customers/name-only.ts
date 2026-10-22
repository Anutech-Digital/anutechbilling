/**
 * R-1004 — customers a limited role may only see BY NAME.
 *
 * Since migration 20261012023458 the `customers` table gives sales / sales_senior only the
 * customers their team manages, and support / delivery only the customers linked to their
 * tickets, calls, tasks or projects. Every other customer comes from the SECURITY DEFINER
 * RPC `customers_name_only()`: id, name, number, state code, country, "has a GSTIN" — never
 * phone, email, GSTIN or address. For owner / manager / accountant / billing it is empty.
 *
 * `fetchAllCustomers` merges these rows into the list so pickers (quote builder, tasks,
 * projects) still find every company. A merged row has every contact / tax field null and
 * `isNameOnlyCustomer(row)` is true; the quote builder offers "Claim customer" for it.
 */
import type { Customer } from "@/lib/supabase/database.types";

export interface NameOnlyCustomerRow {
  id: string;
  name: string;
  display_name: string | null;
  customer_number: string | null;
  state_code: string | null;
  country: string | null;
  has_gstin: boolean | null;
  account_manager_id: string | null;
  is_active: boolean | null;
}

/** True for a row that came from customers_name_only() — its contact / tax fields are hidden. */
export function isNameOnlyCustomer(c: Customer | null | undefined): boolean {
  return Boolean(c && (c as Customer & { name_only?: unknown }).name_only === true);
}

/** A name-only row in the Customer shape: every hidden field null, flagged for the UI. */
export function nameOnlyToCustomer(r: NameOnlyCustomerRow, tenantId: string | null): Customer {
  const row: Customer = {
    id: r.id,
    tenant_id: tenantId ?? "",
    name: r.name,
    display_name: r.display_name,
    customer_number: r.customer_number,
    state_code: r.state_code,
    country: r.country ?? "India",
    account_manager_id: r.account_manager_id,
    is_active: r.is_active ?? true,
    address: null,
    allow_pay_later: false,
    city: null,
    contact_email: null,
    contact_first_name: null,
    contact_last_name: null,
    contact_mobile: null,
    contact_name: null,
    contact_persons: [],
    contact_phone: null,
    contact_salutation: null,
    contact_title: null,
    created_at: "",
    credit_limit: null,
    customer_type: "business",
    domain: null,
    group_id: null,
    gstin: null,
    /* R-1736: not returned by customers_name_only(); the invoice trigger still applies an SEZ
       treatment from the real row, so a hidden treatment never changes the issued tax head. */
    gst_treatment: null,
    pan: null,
    gstin_verification: null,
    gstin_verified_at: null,
    health: 0,
    linked_tenant_id: null,
    notes: null,
    payment_terms_days: null,
    pin_code: null,
    shipping_address: null,
    since: "",
    state: null,
    tan: null,
    tds_default_rate_pct: null,
    tds_default_section: null,
    updated_at: "",
  };
  /* A plain field (not a symbol): React Query's structural sharing copies own enumerable keys. */
  return Object.assign(row, { name_only: true as const });
}

/** Full rows first; a name-only row is added only for an id the full read did not return. */
export function mergeNameOnly(full: Customer[], nameOnly: NameOnlyCustomerRow[]): Customer[] {
  if (nameOnly.length === 0) return full;
  const seen = new Set(full.map((c) => c.id));
  const tenantId = full[0]?.tenant_id ?? null;
  const extra = nameOnly.filter((r) => !seen.has(r.id)).map((r) => nameOnlyToCustomer(r, tenantId));
  return [...full, ...extra].sort((a, b) =>
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
