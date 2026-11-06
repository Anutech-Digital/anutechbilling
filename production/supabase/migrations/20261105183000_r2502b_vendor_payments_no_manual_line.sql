-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_vendor_payments(text,jsonb,boolean)') and prosrc like '%R-2502b%')
-- deploy-key: r2502bnomanualline
--
-- R-2502 follow-up (coordinator decision for Pardeep, 5 Nov 2026): the FY 2025-26 vendor-payment
-- import must NOT create manual bank lines. The FY 25-26 HDFC 4523 statement is imported later
-- (R-2495 / R-2497 done); a manual line made now would count the cash twice until a fragile match.
--
--   import_zoho_fy_vendor_payments — from its body in 20261105172700_r2502_zoho_fy_purchase_import.sql:
--     * an EXPENSE bill: unchanged — marked paid once Zoho's payments + TDS cover it, no bank line
--       (Expenses → Mark paid state); Reconcile's "recorded payment" path banks it on the 4523 debit.
--     * a COGS bill (vendor_bills): NOT booked any more (no pay_vendor_bill, no manual line). The app
--       has no "paid outside the bank" state for a COGS bill (the balance sheet's unbanked bucket is
--       expenses only), so it stays unpaid and is paid in Banking → Reconcile on its real 4523 debit
--       (source vendor_bill, with the bill's Zoho TDS on its first payment) — the existing path, cash
--       once. The result lists them under cogs_bills (amount, TDS, section) for the reconciler.
--     * bank_account_id in a pick is ignored.
--   remove_zoho_fy_purchase_import keeps undoing any earlier vendor_bill link (none made from now on).
--
-- Test: supabase/tests/r2502_zoho_fy_purchase_import.test.sql (no manual line; reconcile afterwards
-- counts the cash once). Rollback: re-run section 6 of 20261105172700.

begin;

-- ── 6. Vendor payments onto the imported bills ───────────────────────────────────────────────
create or replace function public.import_zoho_fy_vendor_payments(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502b: COGS bills are not paid here (no manual bank line) */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_a        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_reason   text;
  v_cogs     jsonb := '[]'::jsonb;
  v_bill     public.vendor_bills;
  v_bill_p   jsonb;
  v_tds      integer;
  v_tsec     text;
  v_before   uuid[];
  v_txn      uuid;
  v_amt      integer;
  v_owed     integer;
  v_paid_z   integer;
  v_exp_ids  text[];
  v_prev     jsonb;
  v_links    integer;
  v_seen     text[] := array[]::text[];
  v_skipped  jsonb := '[]'::jsonb;
  v_part     jsonb := '[]'::jsonb;
  v_adv      jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_amt  bigint := 0;
  v_sum_tds  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing payments needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY vendor payments from Zoho.' using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;
  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'vendorpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_reason := null; v_num := v_zid; v_scan := null;
    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.'; end if;
    end if;
    if v_reason is null then
      v_p := v_scan.payload;
      v_num := coalesce(nullif(btrim(v_p->>'number'), ''), v_zid);
      begin v_date := (v_p->>'date')::date; exception when others then v_reason := 'Its date could not be read.'; end;
    end if;
    if v_reason is null then
      if lower(coalesce(v_p->>'status', '')) = 'void' then v_reason := 'Void in Zoho.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then v_reason := v_p->'problems'->>0;
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif jsonb_typeof(v_p->'applied') <> 'array' or jsonb_array_length(v_p->'applied') = 0 then
        v_reason := 'An advance — not applied to any bill in Zoho; book it as an advance (Prepaid) by hand.';
      end if;
    end if;
    if v_reason is null and exists (select 1 from public.zoho_vendor_payment_links k where k.tenant_id = v_tenant and k.zoho_payment_id = v_zid) then
      v_already := v_already + 1;
      continue;
    end if;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_links := 0;
    begin
      for v_a in select value from jsonb_array_elements(v_p->'applied') loop
        v_amt := (v_a->>'amount')::integer;
        select * into v_bill from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = 'bills:' || (v_a->>'billZohoId') for update;
        if found then
          /* R-2502 follow-up (coordinator, 5 Nov): a COGS bill's Zoho payment is NOT booked here —
             no manual bank line (the FY 25-26 4523 statement comes in later; a manual line would
             count the cash twice until matched). It is paid in Banking → Reconcile on its real 4523
             debit (source vendor_bill: cash + the bill's Zoho TDS with its first payment), the
             existing path. Reported here so the owner knows what to reconcile. */
          select s.payload into v_bill_p from public.zoho_fy_scan s where s.tenant_id = v_tenant and s.kind = 'bills' and s.zoho_id = v_a->>'billZohoId';
          v_cogs := v_cogs || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'date', v_date, 'bill', coalesce(v_bill.bill_no, v_bill.id),
            'bill_id', v_bill.id, 'amount', v_amt,
            'tds', case when coalesce(v_bill.paid_amount, 0) = 0 and not exists (select 1 from jsonb_array_elements(v_cogs) c where c->>'bill_id' = v_bill.id) then coalesce((v_bill_p->>'tdsAmount')::integer, 0) else 0 end,
            'tds_section', v_bill_p->>'tdsSection');
          continue;
        else
          select array_agg(e.id order by e.zoho_leg), coalesce(sum(e.amount), 0), coalesce(sum(e.tds_amount), 0),
                 jsonb_object_agg(e.id, jsonb_build_object('paid', e.paid, 'paid_date', e.paid_date, 'payment_method', e.payment_method))
            into v_exp_ids, v_owed, v_tds, v_prev
            from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = 'bills:' || (v_a->>'billZohoId');
          if v_exp_ids is null then
            raise exception 'Bill % is not in the app yet — Import the bills first.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
          end if;
          if exists (select 1 from public.expenses e where e.id = any (v_exp_ids) and (e.paid or e.paid_amount > 0)) then
            raise exception 'Bill % is already paid in the app.', coalesce(nullif(v_a->>'billNumber', ''), v_a->>'billZohoId') using errcode = 'R2503';
          end if;
          select coalesce(sum(k.amount), 0) + v_amt into v_paid_z from public.zoho_vendor_payment_links k
           where k.tenant_id = v_tenant and k.zoho_bill_id = v_a->>'billZohoId';
          insert into public.zoho_vendor_payment_links (tenant_id, batch_id, zoho_payment_id, zoho_bill_id, target_type, target_ids, amount, settled, prev)
          values (v_tenant, v_batch, v_zid, v_a->>'billZohoId', 'expense', v_exp_ids, v_amt, v_paid_z + v_tds >= v_owed, v_prev);
          if v_paid_z + v_tds >= v_owed then
            update public.expenses set paid = true, paid_date = v_date, payment_method = nullif(left(coalesce(v_p->>'mode', ''), 60), '')
             where id = any (v_exp_ids);
          else
            v_part := v_part || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'bill', v_a->>'billNumber', 'paid', v_paid_z, 'owed', v_owed - v_tds);
          end if;
        end if;
        v_links := v_links + 1;
        v_sum_amt := v_sum_amt + v_amt;
      end loop;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;
    if v_links = 0 then
      continue;
    end if;
    if coalesce((v_p->>'unapplied')::integer, 0) > 0 then
      v_adv := v_adv || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'vendor', v_p->>'vendorName', 'amount', (v_p->>'unapplied')::integer);
    end if;
    v_n := v_n + 1;
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         tax_total = v_sum_tds, amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_vendor_payments.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho vendor payments (₹%s, TDS ₹%s); %s skipped', v_n, p_fy, v_sum_amt, v_sum_tds, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'skipped', jsonb_array_length(v_skipped),
                             'amount', v_sum_amt, 'tds', v_sum_tds, 'part_paid', v_part, 'advances', v_adv, 'cogs_bills', v_cogs));
  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already,
    'skipped', v_skipped, 'part_paid', v_part, 'advances', v_adv, 'cogs_bills', v_cogs, 'amount', v_sum_amt, 'tds', v_sum_tds);
end;
$function$;
comment on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) is
  'R-2502: FY Zoho vendor payments onto imported expense bills (marked paid once covered, no bank line — Reconcile banks them on the 4523 debit). COGS-bill payments are reported (cogs_bills), never booked here — they are paid in Reconcile on the real debit. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_vendor_payments(text, jsonb, boolean) to authenticated, service_role;

commit;
