-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'fee_bearer') and to_regprocedure('public.online_fee_exception_guard()') is not null
-- deploy-key: r2416onlinefeepolicy
-- 20261103112829_r2416_online_fee_policy.sql
--
-- R-2416 (3 Nov 2026, p1): the online payment fee POLICY — who pays Razorpay's fee on a bill.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   Pardeep: "Razorpay fee customer ko deni chahiye, par kai cases me hum dete hai — isko manage
--   karne ka system." Today nothing charges the customer (the business absorbs 100%), there is no
--   setting, no per-customer / per-bill exception, and no record of who bore the fee on a payment.
--   Razorpay's own Customer Fee Bearer is account-wide and breaks UPI payment links, so the app
--   holds the policy (Anutech-HQ/drafts/RAZORPAY-FEE/plan.md).
--
-- ─── THE FIX (columns only — no money moves; R-2417 charges the fee) ─────────────────────────
--   tenants   online_fee_bearer ('customer' default | 'business'), online_fee_rate_pct (2),
--             online_fee_waive_above (₹, null = never), online_fee_line_text.
--             Owner-only, like every tenants column (RLS tenants_self_update).
--   customers online_fee_override (null = Default | 'absorb') + online_fee_override_reason.
--             Owner / manager / accountant (guard trigger below).
--   quotes, invoices  online_fee_waived + online_fee_waive_reason. Owner / manager (guard).
--   payments  fee_bearer ('customer' | 'business'), fee_charged (₹ the customer paid extra).
--             Nullable: rows before R-2416 stay NULL = "not known". The Razorpay webhook writes
--             fee_bearer on capture from the policy in force; fee_charged = 0 until R-2417.
--   An exception needs a reason (3+ characters) — CHECK constraints, so no path can skip it.
--   Every table keeps its existing tenant-scoped RLS; the new columns ride on it.
--
-- Test: supabase/tests/r2416_online_fee.test.sql (one transaction, rolled back).

begin;

-- ── tenants: the company policy ────────────────────────────────────────────────────────────────
alter table public.tenants add column if not exists online_fee_bearer text not null default 'customer';
alter table public.tenants add column if not exists online_fee_rate_pct numeric(5,2) not null default 2;
alter table public.tenants add column if not exists online_fee_waive_above integer;
alter table public.tenants add column if not exists online_fee_line_text text;

alter table public.tenants drop constraint if exists tenants_online_fee_bearer_check;
alter table public.tenants add constraint tenants_online_fee_bearer_check
  check (online_fee_bearer in ('customer', 'business'));
alter table public.tenants drop constraint if exists tenants_online_fee_rate_check;
alter table public.tenants add constraint tenants_online_fee_rate_check
  check (online_fee_rate_pct > 0 and online_fee_rate_pct <= 10);
alter table public.tenants drop constraint if exists tenants_online_fee_waive_above_check;
alter table public.tenants add constraint tenants_online_fee_waive_above_check
  check (online_fee_waive_above is null or online_fee_waive_above > 0);
alter table public.tenants drop constraint if exists tenants_online_fee_line_text_check;
alter table public.tenants add constraint tenants_online_fee_line_text_check
  check (online_fee_line_text is null or length(online_fee_line_text) <= 80);

comment on column public.tenants.online_fee_bearer is
  'R-2416: who pays the online (Razorpay) fee by default — customer | business.';
comment on column public.tenants.online_fee_rate_pct is
  'R-2416: online fee rate, percent of the bill total incl. GST (default 2). GST 18% is added on the fee.';
comment on column public.tenants.online_fee_waive_above is
  'R-2416: we absorb the fee when the bill total is this many rupees or more; null = never.';
comment on column public.tenants.online_fee_line_text is
  'R-2416: optional wording of the fee line (R-2417); null = "Online payment fee".';

-- ── customers: "We absorb for this customer" ─────────────────────────────────────────────────────
alter table public.customers add column if not exists online_fee_override text;
alter table public.customers add column if not exists online_fee_override_reason text;
alter table public.customers drop constraint if exists customers_online_fee_override_check;
alter table public.customers add constraint customers_online_fee_override_check
  check (online_fee_override is null
         or (online_fee_override = 'absorb' and length(btrim(coalesce(online_fee_override_reason, ''))) >= 3));
comment on column public.customers.online_fee_override is
  'R-2416: null = Default (company setting); absorb = we pay the online fee for this customer (reason required).';

-- ── quotes / invoices: "Waive online fee for this bill" ──────────────────────────────────────────
alter table public.quotes add column if not exists online_fee_waived boolean not null default false;
alter table public.quotes add column if not exists online_fee_waive_reason text;
alter table public.quotes drop constraint if exists quotes_online_fee_waive_check;
alter table public.quotes add constraint quotes_online_fee_waive_check
  check (not online_fee_waived or length(btrim(coalesce(online_fee_waive_reason, ''))) >= 3);

alter table public.invoices add column if not exists online_fee_waived boolean not null default false;
alter table public.invoices add column if not exists online_fee_waive_reason text;
alter table public.invoices drop constraint if exists invoices_online_fee_waive_check;
alter table public.invoices add constraint invoices_online_fee_waive_check
  check (not online_fee_waived or length(btrim(coalesce(online_fee_waive_reason, ''))) >= 3);

comment on column public.quotes.online_fee_waived is 'R-2416: we absorb the online fee on this bill (reason required; owner/manager).';
comment on column public.invoices.online_fee_waived is 'R-2416: we absorb the online fee on this bill (reason required; owner/manager).';

-- ── payments: who bore the fee ────────────────────────────────────────────────────────────────────
alter table public.payments add column if not exists fee_bearer text;
alter table public.payments add column if not exists fee_charged integer;
alter table public.payments drop constraint if exists payments_fee_bearer_check;
alter table public.payments add constraint payments_fee_bearer_check
  check (fee_bearer is null or fee_bearer in ('customer', 'business'));
alter table public.payments drop constraint if exists payments_fee_charged_check;
alter table public.payments add constraint payments_fee_charged_check
  check (fee_charged is null or fee_charged >= 0);
comment on column public.payments.fee_bearer is
  'R-2416: who bore the online fee on this payment (policy in force at capture); null = before R-2416 / not online.';
comment on column public.payments.fee_charged is
  'R-2416: rupees the customer paid on top of the bill as the online fee; 0 until R-2417 charges it.';

-- ── Who may set an exception ──────────────────────────────────────────────────────────────────────
-- Customers: owner / manager / accountant. Quotes & invoices: owner / manager. RLS already lets
-- more roles update these rows (sales edits quotes, billing edits customers), so the fee columns get
-- their own check. A trusted server call (service_role / a direct DB session) passes.
create or replace function public.online_fee_exception_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_changed boolean;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_trusted then return new; end if;

  if tg_table_name = 'customers' then
    if tg_op = 'INSERT' then
      v_changed := new.online_fee_override is not null;
    else
      v_changed := new.online_fee_override is distinct from old.online_fee_override
                   or new.online_fee_override_reason is distinct from old.online_fee_override_reason;
    end if;
    if v_changed and not public.current_user_has_role('owner', 'manager', 'accountant') then
      raise exception 'Only an owner, manager or accountant can change who pays the online fee for a customer — ask one of them.'
        using errcode = '42501';
    end if;
  else
    if tg_op = 'INSERT' then
      v_changed := coalesce(new.online_fee_waived, false);
    else
      v_changed := new.online_fee_waived is distinct from old.online_fee_waived
                   or new.online_fee_waive_reason is distinct from old.online_fee_waive_reason;
    end if;
    if v_changed and not public.current_user_has_role('owner', 'manager') then
      raise exception 'Only an owner or manager can waive the online fee on a bill — ask one of them.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.online_fee_exception_guard() from public, anon, authenticated;

drop trigger if exists customers_online_fee_guard on public.customers;
create trigger customers_online_fee_guard
  before insert or update of online_fee_override, online_fee_override_reason on public.customers
  for each row execute function public.online_fee_exception_guard();

drop trigger if exists quotes_online_fee_guard on public.quotes;
create trigger quotes_online_fee_guard
  before insert or update of online_fee_waived, online_fee_waive_reason on public.quotes
  for each row execute function public.online_fee_exception_guard();

drop trigger if exists invoices_online_fee_guard on public.invoices;
create trigger invoices_online_fee_guard
  before insert or update of online_fee_waived, online_fee_waive_reason on public.invoices
  for each row execute function public.online_fee_exception_guard();

commit;
