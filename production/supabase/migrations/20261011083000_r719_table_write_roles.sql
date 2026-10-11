-- deploy-key: r719writes
-- deploy-peek: (exists(select 1 from pg_policy where polname = 'customer_credits_insert_money_roles' and polrelid = to_regclass('public.customer_credits')) and not exists(select 1 from pg_policy where polname = 'customer_credits_insert_own_tenant' and polrelid = to_regclass('public.customer_credits')) and exists(select 1 from pg_policy where polname = 'referral_partners_insert_roles' and polrelid = to_regclass('public.referral_partners')) and exists(select 1 from pg_trigger where tgname = 'a00_r719_customers_column_guard' and tgrelid = to_regclass('public.customers')))
-- 20261011083000_r719_table_write_roles.sql
--
-- R-719 (P1 SECURITY, audit 10 Oct 2026): direct writes to twelve tables asked only "which
-- company?", never "which role?".
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--
--   Every policy below was `tenant_id = current_tenant_id()` and nothing else. The app menu
--   hides these screens from sales / support / delivery, but PostgREST does not read the menu:
--   one direct REST call from ANY member could
--     customer_credits      insert an "open" credit — mint money the customer can then spend
--     credit_notes /
--     debit_notes           insert a note outside issue_credit_note / issue_debit_note — the
--                           same CGST Rule 46 numbering bypass R-042 closed for invoices
--     items, coupons        change catalogue prices / create a 100% coupon
--     customers             rewrite a customer's GSTIN, name, address, credit fields
--     payments              insert a payment / change an amount
--     invoices              change any column the freeze trigger leaves open
--     vendor_bills          book or edit a payable
--     bank_aa_connections   repoint the bank-feed consent
--     employee_loans        change a staff loan
--     referral_partners     add a partner who then earns commission
--
-- ══ WHO WRITES EACH TABLE TODAY — mapped from production/src before changing anything ═
--
--   SECURITY DEFINER functions (record_payment, redeem_customer_credits, issue_credit_note,
--   issue_debit_note, generate_invoice, pay_vendor_bill, give_loan…) run as the table owner
--   and are NOT touched by any policy here. The server's admin client (service_role:
--   webhooks, receipts, GSTIN verify) is not touched either. What is left is the browser /
--   user-session client:
--
--   customer_credits   record-payment dialog puts redeemed credit back when record_payment
--                      fails (owner/manager/billing record payments from Invoices, Payments,
--                      Subscriptions; sales from a Quote).
--   credit/debit_notes nothing — only the two issue_* functions.
--   items              Products page (owner, manager) + its catalogue sync; the quote's
--                      support-plan "add to catalogue" is shown only to roles that open /items.
--   coupons            Coupons page (owner, manager).
--   customers          Companies pages (owner, manager, billing), Add-subscription / imports
--                      (owner, manager, billing), Google bill check (accountant included),
--                      AI Entry (sales), Project quote dialog (sales, delivery), and the
--                      record-payment dialog's follow-ups (state, domain, TAN / TDS defaults —
--                      sales included). AI Help's "set state" fix.
--   payments           Edit payment (Payments page), bank reconcile (money roles), and the
--                      record-payment dialog tagging date + bank account (sales included).
--   invoices           record-payment dialog moves paid_date to the receipt date (sales included).
--   vendor_bills       Bills / Purchase orders (owner, manager, billing, accountant) and AI Entry
--                      (owner, manager, sales, billing) — insert only for sales.
--   bank_aa_connections Banking → connect bank feed; the button sits behind canWriteMoney
--                      (owner, manager, accountant).
--   employee_loans     Loans page "edit purpose" (owner, manager, billing; accountant opens
--                      /accounting/* by prefix).
--   referral_partners  Referrals page (owner, manager) + Customer profile "Add referral"
--                      (owner, manager, billing — hidden for the read-only accountant).
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--
--   Tenant check kept on every policy; a role check added. Roles that write only a few
--   columns from the app (sales tagging a payment it just recorded) keep the table but a
--   BEFORE trigger refuses any other column — RLS cannot say "only these columns".
--   The trigger fires only for statements run AS a request role (`authenticated` locally /
--   PostgREST, `app_runtime` on staging); definers run as the owner and pass.
--
--   table                insert                         update                          delete
--   customer_credits     O M A B                        O M A B                         O M A B
--   credit_notes         nobody (issue_credit_note)     O M A B                         O M A B
--   debit_notes          nobody (issue_debit_note)      O M A B                         O M A B
--   items                O M                            O M                             O M
--   coupons              O M                            O M                             O M
--   customers            O M B A S SS D                 O M B full; A S SS D only       O M B; A S SS D only
--                                                       state/domain/TAN/TDS columns    a row <15 min old (undo)
--   payments             O M A B                        O M A B full; S SS only         (no policy, as before)
--                                                       received_at / bank_account_id
--   invoices             (no policy, as before)         O M A B full; S SS paid_date    (no policy, as before)
--   vendor_bills         O M A B S SS                   O M A B                         O M A B
--   bank_aa_connections  O M A                          O M A                           O M A
--   employee_loans       O M A B                        O M A B                         O M A B
--   referral_partners    O M B                          O M B                           O M B
--   (O owner, M manager, A accountant, B billing, S sales, SS sales_senior, D delivery.)
--   support and partner_agent write none of these tables directly any more.
--
--   READS are unchanged everywhere.
--
-- Re-runnable: drop policy if exists / create or replace / drop trigger if exists.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161);
-- nothing here calls auth.role().
-- Test: supabase/tests/r719_table_write_roles.test.sql (rolled back).

begin;

-- ── The column guard: "this role may change only these columns" ─────────────────────
-- tg_argv[0] = comma list of roles that may change ANY column; tg_argv[1..] = the columns
-- everyone else (who got past RLS) may change. Fires only for request roles, so SECURITY
-- DEFINER functions (current_user = owner) and the service-role client pass untouched.
create or replace function public.role_column_write_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_full text[] := string_to_array(tg_argv[0], ',');
  v_cols text[] := coalesce(tg_argv[1:tg_nargs - 1], '{}'::text[]);
begin
  if current_user::text not in ('authenticated', 'app_runtime') then
    return new;
  end if;
  if public.current_user_has_role(variadic v_full) then
    return new;
  end if;
  if (to_jsonb(new) - v_cols) is distinct from (to_jsonb(old) - v_cols) then
    raise exception 'Your role can change only % on %. Ask an owner or manager to change the rest.',
      array_to_string(v_cols, ', '), tg_table_name
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.role_column_write_guard() from public, anon, authenticated;

-- ── customer_credits: money roles ────────────────────────────────────────────────────
drop policy if exists customer_credits_insert_own_tenant on public.customer_credits;
drop policy if exists customer_credits_update_own_tenant on public.customer_credits;
drop policy if exists customer_credits_delete_own_tenant on public.customer_credits;
drop policy if exists customer_credits_insert_money_roles on public.customer_credits;
drop policy if exists customer_credits_update_money_roles on public.customer_credits;
drop policy if exists customer_credits_delete_money_roles on public.customer_credits;

create policy customer_credits_insert_money_roles on public.customer_credits for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy customer_credits_update_money_roles on public.customer_credits for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy customer_credits_delete_money_roles on public.customer_credits for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

-- ── credit_notes / debit_notes: no direct insert (numbering path only), money roles edit ─
drop policy if exists credit_notes_insert_own_tenant on public.credit_notes;
drop policy if exists credit_notes_update_own_tenant on public.credit_notes;
drop policy if exists credit_notes_delete_own_tenant on public.credit_notes;
drop policy if exists credit_notes_update_money_roles on public.credit_notes;
drop policy if exists credit_notes_delete_money_roles on public.credit_notes;

create policy credit_notes_update_money_roles on public.credit_notes for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy credit_notes_delete_money_roles on public.credit_notes for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

drop policy if exists debit_notes_insert_own_tenant on public.debit_notes;
drop policy if exists debit_notes_update_own_tenant on public.debit_notes;
drop policy if exists debit_notes_delete_own_tenant on public.debit_notes;
drop policy if exists debit_notes_update_money_roles on public.debit_notes;
drop policy if exists debit_notes_delete_money_roles on public.debit_notes;

create policy debit_notes_update_money_roles on public.debit_notes for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy debit_notes_delete_money_roles on public.debit_notes for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

-- ── items, coupons: owner / manager (the Products and Coupons pages) ─────────────────
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
drop policy if exists items_delete on public.items;
drop policy if exists items_insert_om on public.items;
drop policy if exists items_update_om on public.items;
drop policy if exists items_delete_om on public.items;

create policy items_insert_om on public.items for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy items_update_om on public.items for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy items_delete_om on public.items for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));

drop policy if exists coupons_insert on public.coupons;
drop policy if exists coupons_update on public.coupons;
drop policy if exists coupons_delete on public.coupons;
drop policy if exists coupons_insert_om on public.coupons;
drop policy if exists coupons_update_om on public.coupons;
drop policy if exists coupons_delete_om on public.coupons;

create policy coupons_insert_om on public.coupons for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy coupons_update_om on public.coupons for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));
create policy coupons_delete_om on public.coupons for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager'));

-- ── customers: staff who create customers; narrow updates for the non-admin roles ────
-- The restrictive customers_hierarchy_* policies (account-manager visibility) stay as they are.
drop policy if exists customers_insert on public.customers;
drop policy if exists customers_update on public.customers;
drop policy if exists customers_delete on public.customers;
drop policy if exists customers_insert_staff on public.customers;
drop policy if exists customers_update_staff on public.customers;
drop policy if exists customers_delete_staff on public.customers;

create policy customers_insert_staff on public.customers for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing', 'accountant',
                                               'sales', 'sales_senior', 'delivery'));
create policy customers_update_staff on public.customers for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing', 'accountant',
                                               'sales', 'sales_senior', 'delivery'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing', 'accountant',
                                               'sales', 'sales_senior', 'delivery'));
/* Delete: owner / manager / billing any row; the others only a row created in the last 15
   minutes — the "contact could not be attached, take the new customer back" undo in
   useCreateCustomer. Money history is ON DELETE RESTRICT regardless. */
create policy customers_delete_staff on public.customers for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and (public.current_user_has_role('owner', 'manager', 'billing')
                   or (public.current_user_has_role('accountant', 'sales', 'sales_senior', 'delivery')
                       and created_at > now() - interval '15 minutes')));

drop trigger if exists a00_r719_customers_column_guard on public.customers;
create trigger a00_r719_customers_column_guard
  before update on public.customers
  for each row execute function public.role_column_write_guard(
    'owner,manager,billing',
    'state_code', 'state', 'domain', 'tan', 'tds_default_section', 'tds_default_rate_pct', 'updated_at');

-- ── payments: money roles insert; sales may only tag the payment it recorded ─────────
drop policy if exists payments_insert on public.payments;
drop policy if exists payments_update on public.payments;
drop policy if exists payments_insert_money_roles on public.payments;
drop policy if exists payments_update_staff on public.payments;

create policy payments_insert_money_roles on public.payments for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy payments_update_staff on public.payments for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing', 'sales', 'sales_senior'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing', 'sales', 'sales_senior'));

drop trigger if exists a00_r719_payments_column_guard on public.payments;
create trigger a00_r719_payments_column_guard
  before update on public.payments
  for each row execute function public.role_column_write_guard(
    'owner,manager,accountant,billing',
    'received_at', 'bank_account_id');

-- ── invoices: money roles update; sales may only move paid_date ─────────────────────
drop policy if exists invoices_update on public.invoices;
drop policy if exists invoices_update_staff on public.invoices;

create policy invoices_update_staff on public.invoices for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing', 'sales', 'sales_senior'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing', 'sales', 'sales_senior'));

drop trigger if exists a00_r719_invoices_column_guard on public.invoices;
create trigger a00_r719_invoices_column_guard
  before update on public.invoices
  for each row execute function public.role_column_write_guard(
    'owner,manager,accountant,billing',
    'paid_date', 'updated_at');

-- ── vendor_bills: purchase roles; AI Entry lets sales file one (insert only) ─────────
drop policy if exists vendor_bills_insert_own_tenant on public.vendor_bills;
drop policy if exists vendor_bills_update_own_tenant on public.vendor_bills;
drop policy if exists vendor_bills_delete_own_tenant on public.vendor_bills;
drop policy if exists vendor_bills_insert_roles on public.vendor_bills;
drop policy if exists vendor_bills_update_roles on public.vendor_bills;
drop policy if exists vendor_bills_delete_roles on public.vendor_bills;

create policy vendor_bills_insert_roles on public.vendor_bills for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing', 'sales', 'sales_senior'));
create policy vendor_bills_update_roles on public.vendor_bills for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy vendor_bills_delete_roles on public.vendor_bills for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

-- ── bank_aa_connections: MONEY_WRITE_ROLES (same as bank_accounts / bank_transactions) ─
drop policy if exists "tenant insert bank_aa_connections" on public.bank_aa_connections;
drop policy if exists "tenant update bank_aa_connections" on public.bank_aa_connections;
drop policy if exists "tenant delete bank_aa_connections" on public.bank_aa_connections;
drop policy if exists bank_aa_connections_insert_money_roles on public.bank_aa_connections;
drop policy if exists bank_aa_connections_update_money_roles on public.bank_aa_connections;
drop policy if exists bank_aa_connections_delete_money_roles on public.bank_aa_connections;

create policy bank_aa_connections_insert_money_roles on public.bank_aa_connections for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy bank_aa_connections_update_money_roles on public.bank_aa_connections for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy bank_aa_connections_delete_money_roles on public.bank_aa_connections for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));

-- ── employee_loans: the Loans page roles ─────────────────────────────────────────────
drop policy if exists "tenant isolation write"  on public.employee_loans;
drop policy if exists "tenant isolation update" on public.employee_loans;
drop policy if exists "tenant isolation delete" on public.employee_loans;
drop policy if exists employee_loans_insert_roles on public.employee_loans;
drop policy if exists employee_loans_update_roles on public.employee_loans;
drop policy if exists employee_loans_delete_roles on public.employee_loans;

create policy employee_loans_insert_roles on public.employee_loans for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy employee_loans_update_roles on public.employee_loans for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
create policy employee_loans_delete_roles on public.employee_loans for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

-- ── referral_partners: Referrals page + Customer profile "Add referral" ─────────────
drop policy if exists referral_partners_insert_own_tenant on public.referral_partners;
drop policy if exists referral_partners_update_own_tenant on public.referral_partners;
drop policy if exists referral_partners_delete_own_tenant on public.referral_partners;
drop policy if exists referral_partners_insert_roles on public.referral_partners;
drop policy if exists referral_partners_update_roles on public.referral_partners;
drop policy if exists referral_partners_delete_roles on public.referral_partners;

create policy referral_partners_insert_roles on public.referral_partners for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing'));
create policy referral_partners_update_roles on public.referral_partners for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing'));
create policy referral_partners_delete_roles on public.referral_partners for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'billing'));

commit;
