-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_advance_applications' and column_name = 'tds_credit') and exists(select 1 from pg_proc where oid = to_regprocedure('public.vendor_advance_apply_core(uuid,text,integer,date,uuid)') and prosrc like '%R-2588%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.undo_vendor_advance(text)') and prosrc like '%R-2588%')
-- deploy-key: r2588vendoradvancetdscredit
--
-- R-2588 (8 Nov 2026, p0 — R-1916 slice 2): applying a vendor advance that carries TDS to the
-- bill credits the TDS already deducted.
--
-- ─── THE BUG ─────────────────────────────────────────────────────────────────────────────────
--   R-1916: ₹90,000 paid + ₹10,000 194J withheld = advance ₹1,00,000 (TDS payable +₹10,000).
--   The ₹1,00,000 bill is recorded on Expenses WITH TDS ₹10,000 → Apply advance took only
--   ₹90,000 (bill − bill TDS): TDS payable / 26Q showed ₹20,000 for ONE deduction and ₹10,000
--   stayed stuck in prepaid.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   vendor_advance_applications.tds_credit — the part of the advance's TDS (its payment row,
--   kind 'advance') that this application carries onto the bill, pro-rata to the gross applied:
--   credit = advance TDS × applied ÷ advance gross, at most the bill's TDS still on it.
--   vendor_advance_apply_core (from its LATEST body, R-1915 20261025174159): the bill's own
--   tds_amount goes DOWN by the credit (that TDS was already deducted on the advance), so the
--   bill's "still owed" (amount − TDS − advance − bank parts) takes the whole advance:
--   ₹1,00,000 bill, TDS ₹10,000 → advance ₹1,00,000 applied, credit ₹10,000, bill TDS ₹0, paid.
--   TDS payable / 26Q: the advance's ₹10,000 row only. A plain advance (no TDS), a bill with
--   no TDS, or a bill a bank part already paid (its TDS went with that part): credit 0 — as before.
--   undo_vendor_advance (from its LATEST body, R-1914 20261026032214): gives the credit back to
--   the bill's TDS. COGS bills (vendor_bills) carry no TDS of their own (TDS is taken when paid)
--   — that branch is unchanged.
--
-- Atomic (§17b): one RPC call, one transaction. Stored data is not changed (tds_credit 0 = today).
-- Test: supabase/tests/r2588_vendor_advance_tds_credit.test.sql

begin;

alter table public.vendor_advance_applications add column if not exists tds_credit integer not null default 0;
alter table public.vendor_advance_applications drop constraint if exists vendor_advance_applications_tds_credit_check;
alter table public.vendor_advance_applications add constraint vendor_advance_applications_tds_credit_check check (tds_credit >= 0);
comment on column public.vendor_advance_applications.tds_credit is
  'R-2588: TDS already deducted on the advance (its bank_vendor_payment_lines row) carried onto the expense bill by this application — the bill''s tds_amount was reduced by it; undo_vendor_advance adds it back.';

-- ── One advance's share on one bill (pure arithmetic, internal) ──────────────────────────────
--   p_avail advance left, p_due bill still owed (net of its TDS), p_btds bill TDS still on it,
--   p_tds / p_gross the advance's TDS and gross, p_want most gross to take (null = no limit).
--   Returns the gross taken and the TDS credit; taken − credit never exceeds p_due.
create or replace function public.vendor_advance_tds_take(p_avail integer, p_due integer, p_btds integer, p_tds integer, p_gross integer, p_want integer,
                                                          out take integer, out credit integer)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_lim integer := greatest(0, least(p_avail, coalesce(p_want, p_avail)));
  v_add integer;
begin
  /* R-2588 */
  credit := 0;
  if p_due <= 0 or v_lim <= 0 then take := 0; return; end if;
  if coalesce(p_tds, 0) <= 0 or coalesce(p_btds, 0) <= 0 or coalesce(p_gross, 0) <= p_tds then
    take := least(v_lim, p_due);
    return;
  end if;
  take := least(v_lim, p_due + p_btds, floor(p_due::numeric * p_gross / (p_gross - p_tds))::integer);
  credit := least(p_btds, round(p_tds::numeric * take / p_gross)::integer);
  if take - credit > p_due then
    take := p_due + credit;
    credit := least(p_btds, round(p_tds::numeric * take / p_gross)::integer);
    if take - credit > p_due then take := p_due + credit; end if;
  end if;
  if take - credit < p_due and take < v_lim then
    v_add := least(v_lim - take, p_due - (take - credit));
    take := take + v_add;
  end if;
end;
$$;
revoke all on function public.vendor_advance_tds_take(integer, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.vendor_advance_tds_take(integer, integer, integer, integer, integer, integer) to authenticated, service_role;  -- pure arithmetic, no data

-- ── Apply: the bill takes the advance gross, its TDS credited (from R-1915's body) ───────────
create or replace function public.vendor_advance_apply_core(p_tenant uuid, p_expense_id text, p_amount integer, p_date date, p_uid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exp    public.expenses;
  v_vendor public.vendors;
  v_name   text;
  v_due    integer;
  v_avail  integer;
  v_max    integer := 0;
  v_want   integer;
  v_left   integer;
  v_dleft  integer;
  v_bleft  integer;
  v_atds   integer;
  v_cred   integer := 0;
  v_take   integer;
  v_c      integer;
  v_adv    record;
  v_prev   jsonb;
  v_settle boolean;
  v_parts  jsonb := '[]'::jsonb;
  v_btds   integer;
  v_dep    record;
begin
  /* R-1913. R-1915: the advance applies to what is left after the bank parts.
     R-2588: an advance that carries TDS (R-1916) credits it on the bill — the bill's own TDS
     goes down by the advance's share (pro-rata), so TDS is counted once and the advance is used
     in full. */
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if not found or v_exp.tenant_id is distinct from p_tenant then
    raise exception 'Expense bill % not found in your company', p_expense_id using errcode = '42501';
  end if;
  if v_exp.paid or v_exp.reconciled_txn_id is not null then
    raise exception 'Bill % is already paid — an advance can only be applied to a bill still to pay.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.category = 'Salaries'
     or coalesce(v_exp.payment_method, '') in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
     or v_exp.prepaid_advance_id is not null then
    raise exception 'Expense % is not a vendor bill an advance can be applied to.', coalesce(v_exp.bill_no, v_exp.id) using errcode = '22023';
  end if;
  if v_exp.vendor_id is not null then
    select * into v_vendor from public.vendors where id = v_exp.vendor_id and tenant_id = p_tenant;
  end if;
  v_name := coalesce(v_vendor.name, nullif(trim(coalesce(v_exp.vendor_name, '')), ''));
  if v_name is null then
    raise exception 'Bill % has no vendor — pick the vendor on the bill first.', coalesce(v_exp.bill_no, v_exp.id) using errcode = '22023';
  end if;

  v_due := v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0);
  if v_due <= 0 then
    raise exception 'Nothing is left to pay on bill %.', coalesce(v_exp.bill_no, v_exp.id) using errcode = 'check_violation';
  end if;

  /* The vendor's open advances: by vendor id, or by name for an advance that has no vendor yet. */
  perform 1 from public.prepaid_advances pa
   where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
     and pa.total_amount > pa.consumed_amount
     and (pa.vendor_id = v_vendor.id
          or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)))
   for update;
  select coalesce(sum(pa.total_amount - pa.consumed_amount), 0) into v_avail
    from public.prepaid_advances pa
   where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
     and pa.total_amount > pa.consumed_amount
     and (pa.vendor_id = v_vendor.id
          or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)));
  if v_avail <= 0 then
    raise exception 'No advance is left with %. Record the advance first (Banking → the payment line → Advance to vendor).', v_name
      using errcode = 'check_violation';
  end if;

  /* R-2588: the bill's TDS that may be credited — none after a bank part (R-1915: that part withheld
     the bill's whole TDS) and none when the bill's TDS month is already deposited by challan (R-1920:
     moving TDS out of a deposited month would change a paid / filed return). */
  v_btds := case when coalesce(v_exp.paid_amount, 0) > 0 then 0 else coalesce(v_exp.tds_amount, 0) end;
  if v_btds > 0 then
    select * into v_dep from public.vendor_tds_deposit_for_month(p_tenant, v_exp.expense_date);
    if v_dep.o_msg is not null then v_btds := 0; end if;
  end if;

  /* R-2588: the most advance (gross) this bill can take — the bill's due plus the TDS the
     advances already deducted (dry run of the loop below, oldest advance first). No credit once a
     bank part paid some of the bill (R-1915): that part already withheld the bill's whole TDS. */
  v_dleft := v_due;
  v_bleft := v_btds;
  for v_adv in
    select pa.* from public.prepaid_advances pa
     where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
       and pa.total_amount > pa.consumed_amount
       and (pa.vendor_id = v_vendor.id
            or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)))
     order by pa.paid_date, pa.created_at, pa.id
  loop
    exit when v_dleft <= 0;
    select coalesce(sum(l.tds_amount), 0) into v_atds from public.bank_vendor_payment_lines l
     where l.prepaid_advance_id = v_adv.id and l.kind = 'advance';
    select t.take, t.credit into v_take, v_c
      from public.vendor_advance_tds_take(v_adv.total_amount - v_adv.consumed_amount, v_dleft, v_bleft, v_atds, v_adv.total_amount, null) t;
    v_max := v_max + v_take;
    v_dleft := v_dleft - (v_take - v_c);
    v_bleft := v_bleft - v_c;
  end loop;

  if p_amount is not null then
    if p_amount <= 0 then raise exception 'The advance to apply must be more than zero.' using errcode = '22023'; end if;
    if p_amount > v_max and v_max < v_avail then
      raise exception 'Only ₹% of the advance can go on bill % % — apply at most that.', v_max, coalesce(v_exp.bill_no, v_exp.id),
        case when v_max > v_due then ' (₹' || v_due || ' still to pay + the TDS already deducted on the advance)' else '' end using errcode = '22023';
    end if;
    if p_amount > v_avail then
      raise exception 'Only ₹% of advance is left with % — apply at most that.', v_avail, v_name using errcode = '22023';
    end if;
  end if;
  v_want := coalesce(p_amount, v_max);

  v_left := v_want;
  v_dleft := v_due;
  v_bleft := v_btds;
  for v_adv in
    select pa.* from public.prepaid_advances pa
     where pa.tenant_id = p_tenant and pa.closed_at is null and pa.category <> 'Employee advance'
       and pa.total_amount > pa.consumed_amount
       and (pa.vendor_id = v_vendor.id
            or ((pa.vendor_id is null or v_vendor.id is null) and upper(trim(pa.vendor_name)) = upper(v_name)))
     order by pa.paid_date, pa.created_at, pa.id
  loop
    exit when v_left <= 0 or v_dleft <= 0;
    select coalesce(sum(l.tds_amount), 0) into v_atds from public.bank_vendor_payment_lines l
     where l.prepaid_advance_id = v_adv.id and l.kind = 'advance';
    select t.take, t.credit into v_take, v_c
      from public.vendor_advance_tds_take(v_adv.total_amount - v_adv.consumed_amount, v_dleft, v_bleft, v_atds, v_adv.total_amount, v_left) t;
    continue when v_take <= 0;
    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, vendor_id = coalesce(vendor_id, v_vendor.id), updated_at = now()
     where id = v_adv.id;
    v_left := v_left - v_take;
    v_dleft := v_dleft - (v_take - v_c);
    v_bleft := v_bleft - v_c;
    v_cred := v_cred + v_c;
    if v_dleft <= 0 and v_prev is null then
      v_prev := jsonb_build_object('paid_date', v_exp.paid_date, 'payment_method', v_exp.payment_method);
    end if;
    insert into public.vendor_advance_applications (tenant_id, prepaid_advance_id, expense_id, amount, applied_on, prev, created_by, tds_credit)
    values (p_tenant, v_adv.id, v_exp.id, v_take, p_date, case when v_dleft <= 0 then v_prev end, p_uid, v_c);
    v_parts := v_parts || jsonb_build_object('advance_id', v_adv.id, 'paid_date', v_adv.paid_date, 'amount', v_take, 'tds_credit', v_c);
  end loop;
  v_want := v_want - v_left;   -- what was really taken
  v_settle := v_dleft <= 0;

  update public.expenses
     set advance_applied = coalesce(advance_applied, 0) + v_want,
         tds_amount = coalesce(tds_amount, 0) - v_cred,
         paid = case when v_settle then true else paid end,
         paid_date = case when v_settle then p_date else paid_date end,
         payment_method = case when v_settle then 'advance' else payment_method end,
         vendor_id = coalesce(vendor_id, v_vendor.id)
   where id = v_exp.id;

  return jsonb_build_object('expense_id', v_exp.id, 'bill_no', v_exp.bill_no, 'vendor_name', v_name,
    'applied', v_want, 'still_due', greatest(v_dleft, 0), 'settled', v_settle, 'tds_credit', v_cred,
    'advance_left', v_avail - v_want, 'parts', v_parts);
end;
$$;
revoke all on function public.vendor_advance_apply_core(uuid, text, integer, date, uuid) from public, anon, authenticated;

-- ── Undo: the bill gets its TDS credit back (from R-1914's body) ─────────────────────────────
create or replace function public.undo_vendor_advance(p_expense_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_exp     public.expenses;
  v_bill    public.vendor_bills;
  v_total   integer;
  v_cred    integer;
  v_prev    jsonb;
  v_paid    integer;
begin
  /* R-1913: §17c fail-closed + R-718 money roles.
     R-1914: p_expense_id may also be a COGS bill id (vendor_bills).
     R-2588: the TDS credited from the advance goes back onto the expense bill. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can undo a vendor advance' using errcode = '42501';
  end if;
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if not found then
    /* R-1914: a COGS bill — the advance comes back and leaves the bill's paid amount. */
    select * into v_bill from public.vendor_bills where id = p_expense_id for update;
    if not found or (v_caller is not null and v_bill.tenant_id is distinct from v_caller) then
      raise exception 'Bill % not found in your company', p_expense_id using errcode = '42501';
    end if;
    select coalesce(sum(amount), 0) into v_total from public.vendor_advance_applications where vendor_bill_id = v_bill.id;
    if v_total <= 0 then
      raise exception 'No advance is applied to bill %.', coalesce(v_bill.bill_no, v_bill.id) using errcode = 'check_violation';
    end if;
    update public.prepaid_advances pa
       set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
      from (select prepaid_advance_id, sum(amount) as amount from public.vendor_advance_applications
             where vendor_bill_id = v_bill.id group by prepaid_advance_id) a
     where pa.id = a.prepaid_advance_id;
    delete from public.vendor_advance_applications where vendor_bill_id = v_bill.id;
    v_paid := greatest(0, coalesce(v_bill.paid_amount, 0) - v_total);
    update public.vendor_bills
       set paid_amount = v_paid,
           advance_applied = 0,
           status = case when v_paid <= 0 then 'unpaid' when v_paid < coalesce(total, 0) then 'partial' else 'paid' end,
           updated_at = now()
     where id = v_bill.id;
    return jsonb_build_object('source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no, 'given_back', v_total,
                              'still_due', coalesce(v_bill.total, 0) - v_paid);
  end if;
  if v_caller is not null and v_exp.tenant_id is distinct from v_caller then
    raise exception 'Expense bill % not found in your company', p_expense_id using errcode = '42501';
  end if;
  select coalesce(sum(amount), 0), coalesce(sum(tds_credit), 0) into v_total, v_cred
    from public.vendor_advance_applications where expense_id = v_exp.id;
  if v_total <= 0 then
    raise exception 'No advance is applied to bill %.', coalesce(v_exp.bill_no, v_exp.id) using errcode = 'check_violation';
  end if;
  if v_exp.reconciled_txn_id is not null
     or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = v_exp.id) then
    raise exception 'The rest of bill % was paid from a bank line — un-reconcile that line first (Banking), then undo the advance.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  if v_exp.paid and coalesce(v_exp.payment_method, '') <> 'advance' then
    raise exception 'Bill % was marked paid after the advance — mark it unpaid first, then undo the advance.', coalesce(v_exp.bill_no, v_exp.id)
      using errcode = 'check_violation';
  end if;
  if v_cred > 0 then
    declare d record;
    begin
      select * into d from public.vendor_tds_deposit_for_month(v_exp.tenant_id, v_exp.expense_date);
      if d.o_msg is not null then
        raise exception 'Bill %: % — undoing the advance would put TDS ₹% back into that deposited month. Talk to your CA before changing it.',
          coalesce(v_exp.bill_no, v_exp.id), d.o_msg, v_cred using errcode = 'check_violation';
      end if;
    end;
  end if;
  select a.prev into v_prev from public.vendor_advance_applications a
   where a.expense_id = v_exp.id and a.prev is not null order by a.created_at desc, a.id limit 1;

  update public.prepaid_advances pa
     set consumed_amount = greatest(0, pa.consumed_amount - a.amount), updated_at = now()
    from (select prepaid_advance_id, sum(amount) as amount from public.vendor_advance_applications
           where expense_id = v_exp.id group by prepaid_advance_id) a
   where pa.id = a.prepaid_advance_id;
  delete from public.vendor_advance_applications where expense_id = v_exp.id;
  update public.expenses
     set advance_applied = 0,
         tds_amount = coalesce(tds_amount, 0) + v_cred,
         paid = false,
         paid_date = case when v_exp.paid then (v_prev->>'paid_date')::date else paid_date end,
         payment_method = case when v_exp.paid then v_prev->>'payment_method' else payment_method end
   where id = v_exp.id;
  return jsonb_build_object('expense_id', v_exp.id, 'bill_no', v_exp.bill_no, 'given_back', v_total, 'tds_back', v_cred,
                            'still_due', v_exp.amount - (coalesce(v_exp.tds_amount, 0) + v_cred));
end;
$$;
revoke all on function public.undo_vendor_advance(text) from public, anon;
grant execute on function public.undo_vendor_advance(text) to authenticated, service_role;

commit;
