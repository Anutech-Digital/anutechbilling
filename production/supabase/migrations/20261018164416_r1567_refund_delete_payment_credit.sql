-- deploy-peek: to_regclass('public.cancelled_vouchers') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.refund_payment(uuid,text)') and prosrc like '%R-1567%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_payment(uuid)') and prosrc like '%R-1568%')
-- deploy-key: r1567refunddelete
-- 20261018164416_r1567_refund_delete_payment_credit.sql
--
-- R-1567 + R-1568 (P1 money, audit 18 Oct 2026): refunding or deleting a payment ignored the
-- advance credit around it, left its TDS receivable open, and (delete) erased its receipt
-- voucher number.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   Quote A ₹6,000 paid ₹10,000 → record_payment opens a ₹4,000 customer_credits row
--   (source_payment_id = A). Quote B is paid ₹2,000 cash + that ₹4,000 credit
--   (record_desk_payment → redeem_customer_credits: status 'used', or for part of a row the
--   row's amount is cut and a 'redeemed_split' row is written WITHOUT source_payment_id —
--   20261011120000_r718_money_roles.sql:2003-2008).
--   R-1567 refund_payment (20260930176000_invoice_insert_policy_and_refund_role.sql:44-166)
--     · refund A: closes only status='open' credit (:133-135) — the ₹4,000 already spent on B
--       is not looked at → RFV for ₹10,000 while B stays paid by that ₹4,000: paid out twice.
--     · refund B: the ₹4,000 credit B used is never given back → customer loses it.
--     · tds_receivable (payment_id) is untouched → a refunded payment's TDS stays a claimable
--       asset (trial balance / balance sheet count pending_cert, cert_received, verified_26as).
--   R-1568 delete_payment (r718:469-586) deletes the payments row and nothing else:
--     · A's ₹4,000 open credit stays open — credit with no money behind it;
--     · the credit B applied is not given back;
--     · tds_receivable.payment_id is only set null by the FK (ON DELETE SET NULL) — still open;
--     · the receipt voucher number (CGST 31(3)(d) series) vanishes with the row.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   (1) customer_credits.applied_payment_id + used_at: which payment consumed a 'used' row.
--       redeem_customer_credits stamps used_at = now() and copies source_payment_id /
--       source_quote_id onto a split row (so a part-spent credit is still traceable to the
--       payment that created it); record_desk_payment then stamps applied_payment_id on the
--       rows consumed in THIS call (used_at = now(), applied_payment_id null) and checks they
--       add up to the credit it applied (fail-closed).
--   (2) refund_payment (R-1567)
--       · credit CREATED by this payment that is already used → REFUSED, naming the quote(s)
--         that used it: refund / delete that payment first (it gives the credit back), then
--         this one. Its still-open credit is closed 'refunded' as before.
--       · credit this payment APPLIED is given back (the used rows re-open); the RFV is for the
--         cash part only — result 'amount' = amount − credit_applied, plus 'credit_restored'.
--       · its tds_receivable rows still on the books (pending_cert / cert_received /
--         verified_26as / disputed) → status 'reversed'. Claimed / written-off rows are left as
--         they are (already off the books; a filed ITR is the CA's to revise).
--   (3) delete_payment (R-1568)
--       · credit CREATED by this payment that is already used → REFUSED ("pehle … hatao");
--         its open credit is removed with the payment (no money behind it).
--       · credit it APPLIED is given back; TDS rows → 'reversed' (as refund).
--       · its receipt voucher number is kept in public.cancelled_vouchers (doc type, number,
--         payment, amount, who/when) — the number is never deleted from the record and never
--         re-issued (next_document_number only moves forward).
--   Older rows (before this migration) have no applied_payment_id: giving credit back falls
--   back to re-opening that customer's unlinked 'used' rows that fit, then a new 'restored'
--   credit row for any remainder. A legacy part-spent credit (split row with no source) cannot
--   be traced — refund/delete of its source then closes only what is open, as before.
--
-- Test: supabase/tests/r1567_refund_delete_payment_credit.test.sql (rolled back).

begin;

-- ── (1) credit consumption is traceable ─────────────────────────────────────────────
alter table public.customer_credits add column if not exists applied_payment_id uuid;
alter table public.customer_credits add column if not exists used_at timestamptz;

comment on column public.customer_credits.applied_payment_id is
  'R-1567: for a used row, the payment that consumed it (record_desk_payment). Refund/delete of that payment re-opens the row.';
comment on column public.customer_credits.used_at is
  'R-1567: when redeem_customer_credits consumed the row (transaction time).';

create index if not exists customer_credits_applied_payment_idx
  on public.customer_credits (applied_payment_id) where applied_payment_id is not null;
create index if not exists customer_credits_source_payment_idx
  on public.customer_credits (source_payment_id) where source_payment_id is not null;

-- ── cancelled voucher numbers (R-1568) ─────────────────────────────────────────────
create table if not exists public.cancelled_vouchers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  doc_type       text not null check (doc_type in ('receipt_voucher')),
  doc_no         text not null,
  payment_id     uuid,
  quote_id       text,
  customer_id    uuid,
  amount         integer not null,
  credit_applied integer not null default 0,
  received_at    timestamptz,
  reason         text not null,
  cancelled_at   timestamptz not null default now(),
  cancelled_by   uuid,
  constraint cancelled_vouchers_doc_unique unique (tenant_id, doc_type, doc_no)
);

comment on table public.cancelled_vouchers is
  'R-1568: a numbered voucher whose payment was deleted keeps its number here, marked cancelled (CGST 31(3)(d) series stays whole; the number is never re-issued). Written only by delete_payment.';

alter table public.cancelled_vouchers enable row level security;
drop policy if exists cancelled_vouchers_select_own_tenant on public.cancelled_vouchers;
create policy cancelled_vouchers_select_own_tenant on public.cancelled_vouchers
  for select using (tenant_id = public.current_tenant_id());
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy (R-450).
drop policy if exists zzz_service_role_all on public.cancelled_vouchers;
create policy zzz_service_role_all on public.cancelled_vouchers
  as permissive for all to service_role using (true) with check (true);
revoke all on table public.cancelled_vouchers from public, anon, authenticated;
grant select on table public.cancelled_vouchers to authenticated;
grant all on table public.cancelled_vouchers to service_role;

-- ── redeem_customer_credits (R-718 body + used_at, split row keeps its source) ───────
CREATE OR REPLACE FUNCTION public.redeem_customer_credits(p_customer_id uuid, p_amount integer, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-1567: a consumed row carries used_at = now(); a split row keeps the source payment/quote of
   the credit it came from, so a part-spent credit is still traceable to the payment that
   created it. record_desk_payment stamps applied_payment_id on the rows used in its call. */
declare
  v_tenant    uuid    := public.current_tenant_id();
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_consumed  integer := 0;
  v_take      integer;
  v_row       record;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can use a customer''s credit' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if v_remaining <= 0 then return 0; end if;

  for v_row in
    select id, amount, source_payment_id, source_quote_id from public.customer_credits
     where tenant_id = v_tenant and customer_id = p_customer_id and status = 'open'
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.amount, v_remaining);
    if v_take >= v_row.amount then
      update public.customer_credits set status = 'used', used_at = now() where id = v_row.id;
    else
      update public.customer_credits set amount = amount - v_take where id = v_row.id;
      insert into public.customer_credits
        (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status, used_at)
      values (v_tenant, p_customer_id, v_take, 'redeemed_split', v_row.source_payment_id, v_row.source_quote_id,
              coalesce(nullif(trim(p_note), ''), 'Partial advance credit applied'), 'used', now());
    end if;
    v_consumed  := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  return v_consumed;
end; $function$
;

revoke all on function public.redeem_customer_credits(uuid, integer, text) from public, anon;
grant execute on function public.redeem_customer_credits(uuid, integer, text) to authenticated, service_role;

-- ── record_desk_payment (R-1565 body + applied_payment_id stamp) ────────────────────
create or replace function public.record_desk_payment(
  p_quote_id           text,
  p_amount             integer,
  p_method             text,
  p_reference          text,
  p_notes              text    default null,
  p_credit_customer_id uuid    default null,
  p_credit_amount      integer default 0,
  p_received_on        date    default null,
  p_bank_account_id    uuid    default null,
  p_tds_amount         integer default 0,
  p_tds_gross          integer default 0,
  p_tds_net_paid       integer default 0,
  p_tds_section        text    default null,
  p_tds_rate_pct       numeric default null,
  p_customer_tan       text    default null,
  p_invoice_id         text    default null,
  p_fiscal_year        text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-895: one transaction for the record-payment sheet — credit + payment + date/bank tag.
   R-1565: the credit part is written to payments.credit_applied — it is not money received.
   R-1567: the credit rows consumed here get applied_payment_id = this payment, so a refund or
   delete of it can give exactly that credit back. */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_credit   integer := 0;
  v_notes    text;
  v_result   jsonb;
  v_replay   boolean := false;
  v_pay_id   uuid;
  v_inv_id   text;
  v_tagged   boolean := false;
  v_linked   integer := 0;
begin
  /* R-718 role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_credit_amount, 0) < 0 then raise exception 'Credit to apply cannot be negative'; end if;

  if p_bank_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'That bank account is not in your company' using errcode = '42501';
  end if;

  /* Inner block = a savepoint. A replay raises R0895 after the work; the handler undoes
     the redemption (and anything record_payment touched) while v_result survives. */
  begin
    if coalesce(p_credit_amount, 0) > 0 and p_credit_customer_id is not null then
      v_credit := coalesce(public.redeem_customer_credits(
                    p_credit_customer_id, p_credit_amount, 'Applied to quote ' || p_quote_id), 0);
    end if;

    v_notes := nullif(concat_ws(' · ',
                 nullif(trim(coalesce(p_notes, '')), ''),
                 case when v_credit > 0 then 'Advance credit applied ₹' || v_credit end), '');

    if coalesce(p_tds_amount, 0) > 0 then
      v_result := public.record_payment_with_tds(
        p_quote_id, coalesce(p_amount, 0) + v_credit, p_method, p_reference, v_notes,
        p_tds_amount, p_tds_gross, p_tds_net_paid, p_tds_section, p_tds_rate_pct,
        p_customer_tan, p_invoice_id, p_fiscal_year);
    else
      v_result := public.record_payment(
        p_quote_id, coalesce(p_amount, 0) + v_credit, p_method, p_reference, v_notes);
    end if;

    v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
             or coalesce((v_result->>'idempotent_replay')::boolean, false);
    if v_replay then
      raise exception 'R-895 replay' using errcode = 'R0895';
    end if;
  exception when sqlstate 'R0895' then
    v_credit := 0;
  end;

  if v_replay then
    return v_result || jsonb_build_object('credit_applied', 0, 'tagged', false);
  end if;

  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  /* R-1565: amount stays what the payment settles (cash + credit); credit_applied says how
     much of it was the customer's advance credit — money already received on the payment that
     created that credit. Collected, GSTR-1 11A, receipt voucher, day book, Tally and bank
     matching read amount − credit_applied. */
  if v_pay_id is not null and v_credit > 0 then
    update public.payments set credit_applied = v_credit
     where id = v_pay_id and tenant_id = v_tenant;
    if not found then
      raise exception 'R-1565: the new payment % was not found to mark its advance credit', v_pay_id;
    end if;

    /* R-1567: the rows redeem_customer_credits consumed in THIS call (used_at = now(), not yet
       linked) belong to this payment. They must add up to the credit applied — fail closed. */
    with s as (
      update public.customer_credits
         set applied_payment_id = v_pay_id
       where tenant_id = v_tenant and customer_id = p_credit_customer_id
         and status = 'used' and applied_payment_id is null and used_at = now()
      returning amount)
    select coalesce(sum(amount), 0)::int into v_linked from s;
    if v_linked <> v_credit then
      raise exception 'R-1567: linked ₹% of ₹% advance credit to payment % — nothing was recorded.', v_linked, v_credit, v_pay_id;
    end if;
  end if;

  /* R-1118: the receipt date + bank account, in the same transaction. received_at keeps the
     sheet's old value (the date at 00:00 UTC) so reports read it exactly as before. */
  if v_pay_id is not null and (p_received_on is not null or p_bank_account_id is not null) then
    update public.payments
       set received_at     = coalesce((p_received_on::timestamp at time zone 'UTC'), received_at),
           bank_account_id = coalesce(p_bank_account_id, bank_account_id)
     where id = v_pay_id and tenant_id = v_tenant;
    v_tagged := found;
  end if;

  if p_received_on is not null then
    /* R-015: the invoice this payment settled is paid on the receipt date, not today. */
    if coalesce((v_result->>'invoice_paid')::boolean, false) then
      select invoice_id into v_inv_id from public.quotes where id = p_quote_id and tenant_id = v_tenant;
      if v_inv_id is not null then
        update public.invoices set paid_date = p_received_on
         where id = v_inv_id and tenant_id = v_tenant;
      end if;
    end if;
    /* R-025: the TDS receivable carries the date the money came in. */
    if coalesce((v_result->>'tds_saved')::boolean, false) and v_pay_id is not null then
      update public.tds_receivable set payment_received_date = p_received_on
       where payment_id = v_pay_id and tenant_id = v_tenant;
    end if;
  end if;

  return v_result || jsonb_build_object('credit_applied', v_credit, 'tagged', v_tagged);
end;
$function$;

comment on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) is
  'R-895: record-payment sheet in ONE transaction — redeem advance credit, record_payment(_with_tds) for amount + credit, tag received date + bank account, move paid_date. R-1565: the credit part is saved as payments.credit_applied. R-1567: the credit rows used are linked to the payment (customer_credits.applied_payment_id). Owner/manager/accountant/billing.';

revoke all on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) from public, anon;
grant execute on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) to authenticated, service_role;

-- ── (2) refund_payment — R-042 body + R-1567 credit / TDS handling ─────────────────
CREATE OR REPLACE FUNCTION public.refund_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_pay        record;
  v_quote      record;
  v_remaining  integer;
  v_expected   integer;
  v_new_status public.payment_status;
  v_rfv        text;
  v_bank_cnt   integer;
  v_credits    integer := 0;
  v_spent      integer := 0;
  v_spent_on   text;
  v_customer   uuid;
  v_restored   integer := 0;
  v_gap        integer := 0;
  v_row        record;
  v_tds        integer := 0;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-042: owner / manager / accountant only (see 20260930176000). A session with no JWT
     (psql, a migration, the SQL tests) is left alone, as the tenant check above does. */
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception
      'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series and reopens the balance on that customer, so it is not a staff-level action. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = 'invalid_parameter_value';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, customer_id, customer_name
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'Is quote par GST invoice jaari hai — pehle us invoice ka CREDIT NOTE banaiye (invoice ke page se), phir refund book kariye. Tax-invoice ke against seedha refund GSTR ka milaan tod deta hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then refund.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'Ye add-seats ki payment hai — pehle subscription par seats ghataiye, phir refund; warna seats mile hue aur paisa wapas dono ho jate.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1567: advance credit this payment CREATED that is already spent ─────────────
     A full refund would pay that money out a second time (it already settled another
     quote). Refund / delete the payment that used it first — that gives the credit back. */
  select coalesce(sum(cc.amount), 0)::int,
         string_agg(distinct coalesce(p.quote_id, 'kisi purani payment'), ', ')
    into v_spent, v_spent_on
    from public.customer_credits cc
    left join public.payments p on p.id = cc.applied_payment_id and p.tenant_id = cc.tenant_id
   where cc.tenant_id = v_pay.tenant_id and cc.source_payment_id = v_pay.id and cc.status = 'used';
  if v_spent > 0 then
    raise exception 'Ye refund nahi ho sakta: is payment se bana ₹% advance credit pehle hi quote % ki payment me lag chuka hai — poora refund karne se ye ₹% customer ko do baar milega. Pehle Payments me quote % wali payment ko refund ya delete kariye (credit wapas khul jayega), phir ye refund kariye.',
      v_spent, v_spent_on, v_spent, v_spent_on
      using errcode = 'invalid_parameter_value';
  end if;

  v_rfv := public.next_document_number('refund_voucher', v_pay.tenant_id);

  update public.payments
     set status = 'refunded',
         refunded_at = now(),
         refund_reason = trim(p_reason),
         refund_voucher_no = v_rfv
   where id = p_payment_id;

  /* Isi payment ki tairti overpayment-credit band — paisa wapas ja raha hai,
     credit ke roop me dobara kharch nahi ho sakta. */
  update public.customer_credits
     set status = 'refunded'
   where source_payment_id = p_payment_id and status = 'open' and tenant_id = v_pay.tenant_id;
  get diagnostics v_credits = row_count;

  /* ── R-1567: credit this payment APPLIED goes back to the customer ────────────────
     Only the cash part (amount − credit_applied) is refunded; the credit was never cash
     on this payment. Linked rows re-open; an older payment (before applied_payment_id)
     re-opens that customer's unlinked used rows that fit, then a new row for the rest. */
  if coalesce(v_pay.credit_applied, 0) > 0 then
    with r as (
      update public.customer_credits
         set status = 'open', applied_payment_id = null, used_at = null
       where tenant_id = v_pay.tenant_id and applied_payment_id = v_pay.id and status = 'used'
      returning amount)
    select coalesce(sum(amount), 0)::int into v_restored from r;

    v_gap := v_pay.credit_applied - v_restored;
    if v_gap > 0 then
      v_customer := coalesce(v_pay.customer_id, v_quote.customer_id);
      if v_customer is null then
        raise exception 'Is payment me ₹% advance credit laga tha, par payment par customer nahi hai — credit kise wapas jaye ye tay nahi. Pehle quote % par customer jodiye, phir refund kariye.',
          v_gap, v_pay.quote_id using errcode = 'invalid_parameter_value';
      end if;
      for v_row in
        select id, amount from public.customer_credits
         where tenant_id = v_pay.tenant_id and customer_id = v_customer
           and status = 'used' and applied_payment_id is null and used_at is null
         order by created_at desc
         for update
      loop
        exit when v_gap <= 0;
        if v_row.amount <= v_gap then
          update public.customer_credits set status = 'open' where id = v_row.id;
          v_gap := v_gap - v_row.amount;
          v_restored := v_restored + v_row.amount;
        end if;
      end loop;
      if v_gap > 0 then
        insert into public.customer_credits (tenant_id, customer_id, amount, source, source_quote_id, note, status)
        values (v_pay.tenant_id, v_customer, v_gap, 'restored', v_pay.quote_id,
                'Credit given back — payment on ' || v_pay.quote_id || ' refunded (' || v_rfv || ')', 'open');
        v_restored := v_restored + v_gap;
      end if;
    end if;
    if v_restored <> v_pay.credit_applied then
      raise exception 'R-1567: gave back ₹% of ₹% credit applied on payment % — nothing was refunded.', v_restored, v_pay.credit_applied, v_pay.id;
    end if;
  end if;

  /* ── R-1567: the TDS on a refunded payment is no longer receivable ────────────────
     Rows still on the books are reversed; claimed / written-off rows are already off them. */
  update public.tds_receivable
     set status = 'reversed',
         notes  = concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''), 'Reversed: payment refunded (' || v_rfv || ')')
   where tenant_id = v_pay.tenant_id and payment_id = v_pay.id
     and status in ('pending_cert', 'cert_received', 'verified_26as', 'disputed');
  get diagnostics v_tds = row_count;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);
  v_new_status := case
    when v_remaining <= 0          then 'none'
    when v_remaining >= v_expected then 'received'
    else                                'partial' end::public.payment_status;

  update public.quotes
     set payment_status = v_new_status,
         payment_amount = v_remaining
   where id = v_pay.quote_id;

  update public.subscriptions
     set outstanding_amount = greatest(0, v_expected - v_remaining)
   where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;

  return jsonb_build_object(
    'refund_voucher_no', v_rfv,
    'payment_id', p_payment_id,
    'amount', v_pay.amount - coalesce(v_pay.credit_applied, 0),
    'settled_amount', v_pay.amount,
    'credit_restored', v_restored,
    'tds_reversed', v_tds,
    'quote_id', v_pay.quote_id,
    'new_payment_status', v_new_status,
    'credits_closed', v_credits,
    'gateway_refunded', false
  );
end $function$;

comment on function public.refund_payment(uuid, text) is
  'Refund a payment in one transaction: RFV number, quote/subscription recompute, its open overpayment credit closed. R-1567: refused while credit it created is spent elsewhere; credit it applied is given back (RFV = cash part); its TDS receivable is reversed. Owner/manager/accountant.';

revoke all on function public.refund_payment(uuid, text) from public, anon;
grant execute on function public.refund_payment(uuid, text) to authenticated, service_role;

-- ── (3) delete_payment — R-718 body + R-1568 credit / TDS / voucher handling ───────
CREATE OR REPLACE FUNCTION public.delete_payment(p_payment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_pay      record;
  v_quote    record;
  v_remaining integer;
  v_expected  integer;
  v_new_status public.payment_status;
  v_subs_removed int := 0;
  v_pos_removed  int := 0;
  v_bank_cnt int;
  v_bad_po   int;
  v_spent      integer := 0;
  v_spent_on   text;
  v_removed    integer := 0;
  v_customer   uuid;
  v_restored   integer := 0;
  v_gap        integer := 0;
  v_row        record;
  v_tds        integer := 0;
  v_voided     boolean := false;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, customer_name, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'This is an add-seats payment — adjust it from the subscription (reduce seats), not by deleting here.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1568: advance credit this payment CREATED that is already spent ─────────────
     Deleting it would leave that other payment settled by money that never came in. */
  select coalesce(sum(cc.amount), 0)::int,
         string_agg(distinct coalesce(p.quote_id, 'kisi purani payment'), ', ')
    into v_spent, v_spent_on
    from public.customer_credits cc
    left join public.payments p on p.id = cc.applied_payment_id and p.tenant_id = cc.tenant_id
   where cc.tenant_id = v_pay.tenant_id and cc.source_payment_id = v_pay.id and cc.status = 'used';
  if v_spent > 0 then
    raise exception 'Ye payment delete nahi ho sakti: is payment se bana ₹% advance credit quote % ki payment me lag chuka hai — delete karne se wo payment bina paise ke chukta dikhegi. Pehle quote % wali payment hatao (delete ya refund — credit wapas khul jayega), phir ye payment hatao.',
      v_spent, v_spent_on, v_spent_on
      using errcode = 'invalid_parameter_value';
  end if;

  /* Its still-open credit has no money behind it once the payment is gone. */
  with d as (
    delete from public.customer_credits
     where tenant_id = v_pay.tenant_id and source_payment_id = v_pay.id and status = 'open'
    returning amount)
  select coalesce(sum(amount), 0)::int into v_removed from d;

  /* ── R-1568: credit this payment APPLIED goes back to the customer (as refund) ────── */
  if coalesce(v_pay.credit_applied, 0) > 0 then
    with r as (
      update public.customer_credits
         set status = 'open', applied_payment_id = null, used_at = null
       where tenant_id = v_pay.tenant_id and applied_payment_id = v_pay.id and status = 'used'
      returning amount)
    select coalesce(sum(amount), 0)::int into v_restored from r;

    v_gap := v_pay.credit_applied - v_restored;
    if v_gap > 0 then
      v_customer := coalesce(v_pay.customer_id, v_quote.customer_id);
      if v_customer is null then
        raise exception 'Is payment me ₹% advance credit laga tha, par payment par customer nahi hai — credit kise wapas jaye ye tay nahi. Pehle quote % par customer jodiye, phir delete kariye.',
          v_gap, v_pay.quote_id using errcode = 'invalid_parameter_value';
      end if;
      for v_row in
        select id, amount from public.customer_credits
         where tenant_id = v_pay.tenant_id and customer_id = v_customer
           and status = 'used' and applied_payment_id is null and used_at is null
         order by created_at desc
         for update
      loop
        exit when v_gap <= 0;
        if v_row.amount <= v_gap then
          update public.customer_credits set status = 'open' where id = v_row.id;
          v_gap := v_gap - v_row.amount;
          v_restored := v_restored + v_row.amount;
        end if;
      end loop;
      if v_gap > 0 then
        insert into public.customer_credits (tenant_id, customer_id, amount, source, source_quote_id, note, status)
        values (v_pay.tenant_id, v_customer, v_gap, 'restored', v_pay.quote_id,
                'Credit given back — payment on ' || v_pay.quote_id || ' deleted', 'open');
        v_restored := v_restored + v_gap;
      end if;
    end if;
    if v_restored <> v_pay.credit_applied then
      raise exception 'R-1568: gave back ₹% of ₹% credit applied on payment % — nothing was deleted.', v_restored, v_pay.credit_applied, v_pay.id;
    end if;
  end if;

  /* ── R-1568: TDS on a deleted payment is not receivable (before the FK nulls the link) */
  update public.tds_receivable
     set status = 'reversed',
         notes  = concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''),
                            'Reversed: payment deleted' || coalesce(' (' || v_pay.receipt_voucher_no || ')', ''))
   where tenant_id = v_pay.tenant_id and payment_id = v_pay.id
     and status in ('pending_cert', 'cert_received', 'verified_26as', 'disputed');
  get diagnostics v_tds = row_count;

  /* ── R-1568: the receipt voucher number stays in the record, marked cancelled ──────
     (CGST 31(3)(d) series — a number is never deleted or re-issued.) */
  if v_pay.receipt_voucher_no is not null then
    insert into public.cancelled_vouchers
      (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied,
       received_at, reason, cancelled_by)
    values
      (v_pay.tenant_id, 'receipt_voucher', v_pay.receipt_voucher_no, v_pay.id, v_pay.quote_id,
       coalesce(v_pay.customer_id, v_quote.customer_id), v_pay.amount, coalesce(v_pay.credit_applied, 0),
       v_pay.received_at, 'Payment deleted', auth.uid());
    v_voided := true;
  end if;

  delete from public.payments where id = p_payment_id;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);

  v_new_status := case
    when v_remaining <= 0            then 'none'
    when v_remaining >= v_expected   then 'received'
    else                                  'partial' end::public.payment_status;

  update public.quotes
     set payment_status      = v_new_status,
         payment_amount      = v_remaining,
         payment_method      = case when v_remaining <= 0 then null else payment_method end,
         payment_reference   = case when v_remaining <= 0 then null else payment_reference end,
         payment_received_at = case when v_remaining <= 0 then null else payment_received_at end,
         payment_notes       = case when v_remaining <= 0 then null else payment_notes end,
         status              = case when v_remaining <= 0 and status = 'accepted'
                                    then 'sent'::public.quote_status else status end
   where id = v_pay.quote_id and tenant_id = v_pay.tenant_id;

  if v_remaining <= 0 then
    select count(*) into v_bad_po
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_pay.tenant_id and s.quote_id = v_pay.quote_id and po.status <> 'draft';
    if v_bad_po > 0 then
      raise exception 'A purchase order from this sale is already processed — handle it manually before deleting the payment.'
        using errcode = 'invalid_parameter_value';
    end if;

    with subs as (
      select id from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id
    )
    delete from public.purchase_orders po using subs where po.subscription_id = subs.id;
    get diagnostics v_pos_removed = row_count;

    delete from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
    get diagnostics v_subs_removed = row_count;

    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true, 'quote_id', v_pay.quote_id, 'amount', v_pay.amount,
    'remaining', v_remaining, 'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed, 'purchase_orders_removed', v_pos_removed,
    'credit_removed', v_removed, 'credit_restored', v_restored, 'tds_reversed', v_tds,
    'voucher_cancelled', case when v_voided then v_pay.receipt_voucher_no end
  );
end;
$function$
;

comment on function public.delete_payment(uuid) is
  'Delete a wrongly entered payment in one transaction (quote/subscription/PO/lead reversed). R-1568: refused while credit it created is spent elsewhere; its open credit removed; credit it applied given back; its TDS receivable reversed; its receipt voucher number kept in cancelled_vouchers. Owner/accountant.';

revoke all on function public.delete_payment(uuid) from public, anon;
grant execute on function public.delete_payment(uuid) to authenticated, service_role;

commit;
