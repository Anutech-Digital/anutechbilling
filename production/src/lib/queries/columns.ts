/**
 * R-1005 (12 Oct 2026): explicit column lists for the three tables a low role may not read
 * with `select=*` through the data gateway (src/server/postgrest/gateway-limits.ts) —
 * customers, contacts and payments.
 *
 * Naming the columns means a column added later (a secret, an internal note) does not reach
 * the browser until someone puts it here on purpose. Each list is every column the screens
 * read today (checked against the database on 12 Oct 2026); keep it in step with the Row types
 * in lib/supabase/database.types.ts.
 */

export const CUSTOMER_COLUMNS =
  "id, tenant_id, name, domain, gstin, state, state_code, health, contact_name, contact_title, contact_email, contact_phone, account_manager_id, since, notes, created_at, updated_at, tan, tds_default_section, tds_default_rate_pct, address, pin_code, gstin_verified_at, gstin_verification, linked_tenant_id, customer_number, country, contact_salutation, contact_first_name, contact_last_name, contact_mobile, contact_persons, payment_terms_days, shipping_address, customer_type, display_name, city, group_id, is_active, allow_pay_later, credit_limit, gst_treatment, pan";

export const CONTACT_COLUMNS =
  "id, tenant_id, full_name, email, phone, company, title, source, external_id, status, promoted_to_lead_id, promoted_at, notes, tags, imported_by, created_at, updated_at, whatsapp, linkedin, instagram, facebook, twitter, website, address, city, customer_id, emails, phones, google_etag, google_synced_at, relationship, birthday, anniversary, nickname, family, role, is_primary";

export const PAYMENT_COLUMNS =
  "id, tenant_id, quote_id, customer_id, amount, method, reference, notes, status, received_at, refunded_at, refund_reason, recorded_by, created_at, receipt_voucher_no, bank_account_id, receipt_file_path, refund_voucher_no, gateway_fee, gateway_fee_gst, gateway_refund_ids, credit_applied, invoice_id";
