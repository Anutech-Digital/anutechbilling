-- R-161 follow-up (6 Oct 2026): the Payment Runs functions (20261005110000_payment_runs, R-163)
-- came AFTER 20261005120000_tenant_context was generated, so they still read auth.uid(). On the
-- Prisma path (session_user app_runtime) auth.uid() is NULL — only app.user_id is set — so
-- creating, approving, paying or cancelling a run would act as nobody. Same rewrite as
-- tenant_context: ONLY the tokens auth.uid() → public.current_user_id() and
-- auth.role() → public.current_request_role(); bodies otherwise copied verbatim from git.
-- `create or replace` keeps the existing grants. On the PostgREST path both helpers fall back
-- to auth.uid()/auth.role(), so nothing changes there.
begin;

create or replace function public.payment_run_role()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select role::text from public.users where id = public.current_user_id();
$$;

create or replace function public.create_payment_run(p_items jsonb, p_bank_account_id uuid, p_pay_on date default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  v_run    uuid;
  v_no     text;
  v_total  bigint := 0;
  it       jsonb;
  v_src    text; v_doc text; v_amt integer; v_owed integer;
  v_vid uuid; v_vname text; v_ref text;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can create a payment run' using errcode = 'insufficient_privilege';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pick at least one bill to pay';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'At most 200 bills in one run'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'Pay-from bank account not found';
  end if;

  -- Run number: PR-YYYYMM-NNN, per tenant. The advisory lock makes two creates in the same
  -- instant take turns instead of colliding on the unique (tenant_id, run_no).
  perform pg_advisory_xact_lock(hashtext('payment_run_no:' || v_tenant::text));
  select 'PR-' || to_char(coalesce(p_pay_on, current_date), 'YYYYMM') || '-' ||
         lpad((count(*) + 1)::text, 3, '0')
    into v_no
    from public.payment_runs
   where tenant_id = v_tenant and run_no like 'PR-' || to_char(coalesce(p_pay_on, current_date), 'YYYYMM') || '-%';

  insert into public.payment_runs (tenant_id, run_no, bank_account_id, pay_on, note, created_by)
  values (v_tenant, v_no, p_bank_account_id, coalesce(p_pay_on, current_date), nullif(trim(p_note), ''), public.current_user_id())
  returning id into v_run;

  for it in select * from jsonb_array_elements(p_items) loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := (it->>'amount')::integer;
    if v_src not in ('vendor_bill','expense') or v_doc is null then raise exception 'Bad item in the run'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Amount must be more than zero (%)', v_doc; end if;

    v_owed := public.payment_run_outstanding(v_tenant, v_src, v_doc);
    if v_owed is null or v_owed = 0 then raise exception '% is already paid or not found', v_doc; end if;
    if v_amt > v_owed then raise exception '% — ₹% is more than the ₹% still owed', v_doc, v_amt, v_owed; end if;

    if exists (select 1 from public.payment_run_items i join public.payment_runs r on r.id = i.run_id
                where i.tenant_id = v_tenant and i.source = v_src and i.doc_id = v_doc
                  and r.status in ('draft','approved') and r.id <> v_run) then
      raise exception '% is already in another open payment run', v_doc;
    end if;

    if v_src = 'vendor_bill' then
      select b.vendor_id, b.vendor_name, b.bill_no into v_vid, v_vname, v_ref from public.vendor_bills b where b.id = v_doc;
    else
      select e.vendor_id, coalesce(e.vendor_name, e.category), e.bill_no into v_vid, v_vname, v_ref from public.expenses e where e.id = v_doc;
    end if;

    insert into public.payment_run_items (run_id, tenant_id, source, doc_id, doc_ref, vendor_id, vendor_name, amount)
    values (v_run, v_tenant, v_src, v_doc, v_ref, v_vid, coalesce(v_vname, 'Vendor'), v_amt);
    v_total := v_total + v_amt;
  end loop;

  update public.payment_runs set total = v_total where id = v_run;
  return v_run;
end $$;

create or replace function public.approve_payment_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if v_role is null or v_role not in ('owner','manager') then
    raise exception 'Only the owner or a manager can approve a payment run' using errcode = 'insufficient_privilege';
  end if;
  if v_role = 'manager' and r.created_by = public.current_user_id() then
    raise exception 'A manager cannot approve a run they created — ask the owner or another manager' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'draft' then raise exception 'Only a draft run can be approved (this one is %)', r.status; end if;

  -- Re-check: a bill may have been paid by hand since the draft was made.
  for it in select * from public.payment_run_items where run_id = r.id loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    if v_owed is null or v_owed < it.amount then
      raise exception '% (%) is no longer owed in full — cancel this run and make a new one', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;
  end loop;

  update public.payment_runs set status = 'approved', approved_by = public.current_user_id(), approved_at = now(), updated_at = now() where id = r.id;
end $$;

create or replace function public.mark_payment_run_paid(p_run_id uuid, p_paid_on date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
  v_on     date := coalesce(p_paid_on, current_date);
  v_txn    uuid;
  v_bill   public.vendor_bills;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can mark a run paid' using errcode = 'insufficient_privilege';
  end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved run can be marked paid (this one is %)', r.status; end if;

  for it in select * from public.payment_run_items where run_id = r.id order by vendor_name loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    if v_owed is null or v_owed < it.amount then
      raise exception '% (%) was paid elsewhere after approval — nothing was marked; check it and try again', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;

    if it.source = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = it.doc_id and tenant_id = v_tenant for update;
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount,0) + it.amount,
             status = case when coalesce(paid_amount,0) + it.amount >= total then 'paid' else 'partial' end,
             updated_at = now()
       where id = it.doc_id and tenant_id = v_tenant;
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Bill payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'vendor_bill', it.doc_id, 'manual', r.run_no);
    else
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Expense payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'expense', it.doc_id, 'manual', r.run_no)
      returning id into v_txn;
      update public.expenses
         set paid = true, paid_date = v_on, payment_method = 'bank_transfer',
             bank_account_id = r.bank_account_id, reconciled_txn_id = v_txn
       where id = it.doc_id and tenant_id = v_tenant;
    end if;
  end loop;

  update public.payment_runs set status = 'paid', paid_by = public.current_user_id(), paid_at = now(), paid_on = v_on, updated_at = now() where id = r.id;
end $$;

create or replace function public.cancel_payment_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status not in ('draft','approved') then raise exception 'A % run cannot be cancelled', r.status; end if;
  -- An approved run is the owner's decision: only owner/manager undo it. A draft, its maker too.
  if not (v_role in ('owner','manager') or (r.status = 'draft' and r.created_by = public.current_user_id() and v_role in ('billing','accountant'))) then
    raise exception 'You cannot cancel this payment run' using errcode = 'insufficient_privilege';
  end if;
  update public.payment_runs set status = 'cancelled', cancelled_by = public.current_user_id(), cancelled_at = now(), updated_at = now() where id = r.id;
end $$;

commit;
