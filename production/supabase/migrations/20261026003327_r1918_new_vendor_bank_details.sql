-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') and prosrc like '%R-1918%')
-- deploy-key: r1918newvendorbank
-- 20261026003327_r1918_new_vendor_bank_details.sql
--
-- R-1918 (26 Oct 2026, p2 — R-1906 audit case 6 / F3): "＋ New vendor" on a money-out bank line
-- (Banking → Reconcile → "Paying a vendor?") saved only name / GSTIN / PAN / TDS section. The
-- account no, IFSC and UPI id the narration shows were never saved, so the NEXT line from the same
-- vendor was still not guessed (bank_debit_vendor_guess / guessVendor match on upi_id and
-- bank_account_no).
-- Fix: reconcile_bank_debit_to_vendor reads bank_account_no / bank_ifsc / upi_id from p_new_vendor,
-- checks them with the same rules and words as lib/banking/bank-details.ts (R-1905) and saves them
-- on the new vendor. When the name / GSTIN is already a vendor, only its EMPTY bank fields are
-- filled — saved details are never overwritten.
-- Body otherwise unchanged from its latest definition (20261025174159_r1915_expense_part_payment.sql).
begin;

create or replace function public.reconcile_bank_debit_to_vendor(
  p_txn_id           uuid,
  p_vendor_id        uuid    default null,
  p_new_vendor       jsonb   default null,
  p_items            jsonb   default '[]'::jsonb,
  p_new_bill         jsonb   default null,
  p_advance          integer default 0,
  p_advance_category text    default null,
  p_bank_charge      integer default 0,
  p_note             text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted   boolean;
  v_caller    uuid;
  v_txn       public.bank_transactions;
  v_vendor    public.vendors;
  v_own_state text;
  v_v_state   text;
  v_cash      bigint := 0;
  it          jsonb;
  v_src       text; v_doc text; v_amt integer; v_tds integer; v_sec text;
  v_bill      public.vendor_bills;
  v_exp       public.expenses;
  v_out       integer;
  v_status    text;
  v_paid      jsonb := '[]'::jsonb;
  v_seen      text[] := '{}';
  v_run       text;
  v_new       jsonb := null;
  v_kind      text; v_cat text; v_taxable integer; v_gst integer; v_total integer; v_pay integer;
  v_itc       boolean; v_igst integer; v_cgst integer; v_sgst integer; v_id text; v_bdate date;
  v_adv_id    uuid;
  v_adv       jsonb := null;
  v_charge    jsonb := null;
  v_tds_total integer := 0;
  v_tds_sec   text := null;
  v_uid       uuid := public.current_user_id();
  v_name      text; v_gstin text; v_pan text;
  v_acc       text; v_ifsc text; v_upi text;   -- R-1918: the new vendor's bank details (from the bank line)
  v_q         record;   -- R-1891: vendor_bill_194q_calc of the bill
  v_qbase     integer := 0;
  v_syn       public.bank_transactions;   -- R-1911: the manual (Bills page / payment run) line being matched
  v_prev      jsonb;
  v_rec_paid  date;
  v_rec_where text;
  v_first     boolean;  -- R-1915: no bank part on the expense bill yet (its TDS goes with this one)
  v_gross_due integer;  -- R-1915: what this payment may settle on the expense bill (cash + TDS)
  v_new_paid  integer;
  v_new_tds   integer;
  v_left_due  integer;
begin
  /* §17c fail-closed + R-718 money roles. R-1915: an expense bill can be paid in parts. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pay a vendor from the bank' using errcode = '42501';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) bank line can pay a vendor.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  if coalesce(p_advance, 0) < 0 or coalesce(p_bank_charge, 0) < 0 then
    raise exception 'Advance and bank charge cannot be negative.' using errcode = '22023';
  end if;
  if (p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0)
     and p_new_bill is null and coalesce(p_advance, 0) = 0 then
    raise exception 'Pick the bill(s) this payment is for, a new bill, or an advance.' using errcode = '22023';
  end if;

  /* ── Vendor ── */
  if p_vendor_id is not null then
    select * into v_vendor from public.vendors where id = p_vendor_id for update;
    if not found or v_vendor.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Vendor not found in your company' using errcode = '42501';
    end if;
  else
    v_name  := nullif(trim(coalesce(p_new_vendor->>'name', '')), '');
    v_gstin := nullif(upper(trim(coalesce(p_new_vendor->>'gstin', ''))), '');
    v_pan   := nullif(upper(trim(coalesce(p_new_vendor->>'pan', ''))), '');
    if v_name is null then raise exception 'Pick the vendor, or type the new vendor''s name.' using errcode = '22023'; end if;
    if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      raise exception 'GSTIN % does not look right (15 characters, e.g. 07AAACT1234F1Z5).', v_gstin using errcode = '22023';
    end if;
    if v_pan is null and v_gstin is not null then v_pan := substr(v_gstin, 3, 10); end if;
    /* R-1918: account no / IFSC / UPI id, pre-filled from the bank narration, are saved on the
       vendor so the next line from it is guessed (bank_debit_vendor_guess reads upi_id and
       bank_account_no). Same rules and words as lib/banking/bank-details.ts (R-1905). */
    v_acc  := nullif(regexp_replace(coalesce(p_new_vendor->>'bank_account_no', ''), '[[:space:]-]', '', 'g'), '');
    v_ifsc := nullif(upper(trim(coalesce(p_new_vendor->>'bank_ifsc', ''))), '');
    v_upi  := nullif(lower(trim(coalesce(p_new_vendor->>'upi_id', ''))), '');
    if v_acc is not null and v_acc !~ '^[0-9]{6,18}$' then
      raise exception 'The account number has digits only — 6 to 18 of them (got %).', v_acc using errcode = '22023';
    end if;
    if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
      raise exception 'IFSC % does not look right — it needs 11 characters (4 letters, 0, then 6 letters/digits), e.g. HDFC0001234.', v_ifsc using errcode = '22023';
    end if;
    if v_ifsc is not null and v_acc is null then
      raise exception 'Add the account number that goes with this IFSC.' using errcode = '22023';
    end if;
    if v_upi is not null and v_upi !~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,64}$' then
      raise exception 'This UPI ID looks wrong — it is like name@okhdfcbank. Leave it empty if there is none.' using errcode = '22023';
    end if;
    select * into v_vendor from public.vendors
     where tenant_id = v_txn.tenant_id
       and ((v_gstin is not null and upper(gstin) = v_gstin) or upper(trim(name)) = upper(v_name))
     order by (v_gstin is not null and upper(gstin) = v_gstin) desc, created_at
     limit 1 for update;
    if not found then
      insert into public.vendors (tenant_id, name, gstin, pan, default_tds_section, bank_account_no, bank_ifsc, upi_id)
      values (v_txn.tenant_id, v_name, v_gstin, v_pan, nullif(upper(trim(coalesce(p_new_vendor->>'tds_section', ''))), ''),
              v_acc, v_ifsc, v_upi)
      returning * into v_vendor;
    elsif v_acc is not null or v_upi is not null then
      /* R-1918: the name / GSTIN is already a vendor — fill only what it has empty, never
         overwrite saved bank details. Account no and IFSC are one pair. */
      update public.vendors
         set bank_ifsc       = case when bank_account_no is null and v_acc is not null then v_ifsc else bank_ifsc end,
             bank_account_no = coalesce(bank_account_no, v_acc),
             upi_id          = coalesce(nullif(trim(upi_id), ''), v_upi)
       where id = v_vendor.id
      returning * into v_vendor;
    end if;
  end if;

  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_txn.tenant_id;
  v_v_state := case when coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}' then left(v_vendor.gstin, 2) end;

  /* ── (a) Open bills — R-1911: payments recorded outside the bank are matched FIRST, so a bill
         whose Bills-page payment this line replaces can then take the rest of the line ── */
  for it in select e.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as e(value, n)
             order by (e.value->>'source' = 'recorded_payment') desc, e.n loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := round(coalesce((it->>'amount')::numeric, 0))::integer;
    v_tds := round(coalesce((it->>'tds_amount')::numeric, 0))::integer;
    v_sec := nullif(upper(trim(coalesce(it->>'tds_section', ''))), '');
    if v_src not in ('vendor_bill', 'expense', 'recorded_payment') or v_doc is null then raise exception 'Bad bill in the list' using errcode = '22023'; end if;
    if v_src || ':' || v_doc = any (v_seen) then raise exception '% is in the list twice', v_doc using errcode = '22023'; end if;
    v_seen := v_seen || (v_src || ':' || v_doc);
    if v_amt <= 0 then raise exception 'Amount for % must be more than zero', v_doc using errcode = '22023'; end if;
    if v_tds < 0 then raise exception 'TDS cannot be negative' using errcode = '22023'; end if;

    /* ── R-1911: MATCH a payment already recorded (Bills page / payment run / Mark paid) — this
           bank line takes its place; nothing is paid again. ── */
    if v_src = 'recorded_payment' then
      if v_tds <> 0 then
        raise exception 'A payment already recorded keeps its own TDS — match it without TDS.' using errcode = '22023';
      end if;
      v_syn := null;
      if v_doc ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select * into v_syn from public.bank_transactions where id = v_doc::uuid for update;
      end if;
      if v_syn.id is not null then
        -- (1) A manual bank line (Bills page Pay / payment run) — deleted, this line stands for it.
        if v_syn.tenant_id is distinct from v_txn.tenant_id or v_syn.source <> 'manual'
           or v_syn.matched_to_type not in ('vendor_bill', 'expense') or coalesce(v_syn.debit, 0) <= 0 then
          raise exception 'That recorded payment is not a Bills-page payment of your company — refresh and pick again.' using errcode = '42501';
        end if;
        if v_syn.matched_to_type = 'vendor_bill' then
          select * into v_bill from public.vendor_bills where id = v_syn.matched_to_id for update;
          if not found or v_bill.tenant_id is distinct from v_txn.tenant_id then
            raise exception 'The bill of that recorded payment was not found' using errcode = '42501';
          end if;
          if not coalesce(v_bill.vendor_id = v_vendor.id or (v_bill.vendor_id is null and upper(trim(v_bill.vendor_name)) = upper(trim(v_vendor.name))), false) then
            raise exception 'The payment recorded on % is for bill % of %, not %', v_syn.txn_date, coalesce(v_bill.bill_no, v_bill.id), v_bill.vendor_name, v_vendor.name using errcode = '22023';
          end if;
          if coalesce(v_bill.paid_amount, 0) > coalesce(v_bill.total, 0) then
            raise exception 'Bill % shows ₹% paid on a ₹% bill — fix the bill before matching.', coalesce(v_bill.bill_no, v_bill.id), v_bill.paid_amount, v_bill.total using errcode = 'check_violation';
          end if;
        else
          select * into v_exp from public.expenses where id = v_syn.matched_to_id for update;
          if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
            raise exception 'The expense of that recorded payment was not found' using errcode = '42501';
          end if;
          if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
            raise exception 'The payment recorded on % is for % of %, not %', v_syn.txn_date, coalesce(v_exp.bill_no, v_exp.id), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
          end if;
        end if;
        if v_amt <> v_syn.debit then
          raise exception 'The payment recorded on % was ₹% — match all of it (not ₹%), and put the rest of this line elsewhere.', v_syn.txn_date, v_syn.debit, v_amt
            using errcode = '22023';
        end if;
        v_prev := jsonb_build_object('synthetic', to_jsonb(v_syn),
                    'expense', case when v_syn.matched_to_type = 'expense' then jsonb_build_object(
                                 'reconciled_txn_id', v_exp.reconciled_txn_id, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id) end);
        delete from public.bank_transactions where id = v_syn.id;
        if v_syn.matched_to_type = 'vendor_bill' then
          insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash, prev, created_by)
          values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_bill.id, v_amt, v_prev, v_uid);
          v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no,
                     'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', v_bill.status,
                     'still_due', greatest(0, coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0)), 'paid_on', v_syn.txn_date);
        else
          update public.expenses
             set reconciled_txn_id = p_txn_id, bank_account_id = v_txn.bank_account_id, paid_date = v_txn.txn_date
           where id = v_exp.id;
          insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, prev, created_by)
          values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_exp.id, v_amt, v_prev, v_uid);
          v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'expense', 'doc_id', v_exp.id, 'bill_no', v_exp.bill_no,
                     'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', 'paid', 'still_due', 0, 'paid_on', v_syn.txn_date);
        end if;
      else
        -- (2) An expense marked paid with no bank line (Expenses → Mark paid) — now banked by this line.
        select * into v_exp from public.expenses where id = v_doc for update;
        if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
          raise exception 'That recorded payment was not found in your company — refresh and pick again.' using errcode = '42501';
        end if;
        if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
          raise exception 'Expense % is from %, not %', coalesce(v_exp.bill_no, v_doc), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
        end if;
        if not v_exp.paid or v_exp.reconciled_txn_id is not null
           or exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = v_exp.id and l.kind = 'recorded_payment') then
          raise exception 'Expense % is not a payment waiting for its bank line (unpaid, or already matched).', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
        end if;
        if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or v_exp.prepaid_advance_id is not null or v_exp.category = 'Salaries'
           or lower(coalesce(v_exp.payment_method, '')) in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance') then
          raise exception 'Expense % was not paid from a bank — it cannot be matched to a bank line.', coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
        end if;
        -- R-1913: the part settled from the vendor's advance never went through a bank.
        -- R-1915: nor did the bank parts already reconciled on it — the Mark paid recorded the rest.
        if v_amt <> v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0) then
          raise exception 'Expense % was paid ₹% outside the bank feed (₹% less TDS ₹%, advance applied ₹% and bank parts ₹%) — match all of it, not ₹%.', coalesce(v_exp.bill_no, v_doc),
            v_exp.amount - coalesce(v_exp.tds_amount, 0) - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0), v_exp.amount, coalesce(v_exp.tds_amount, 0),
            coalesce(v_exp.advance_applied, 0), coalesce(v_exp.paid_amount, 0), v_amt using errcode = '22023';
        end if;
        v_prev := jsonb_build_object('synthetic', null, 'expense', jsonb_build_object(
                    'reconciled_txn_id', null, 'paid_date', v_exp.paid_date,
                    'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id));
        update public.expenses
           set reconciled_txn_id = p_txn_id, bank_account_id = v_txn.bank_account_id, paid_date = v_txn.txn_date,
               payment_method = 'bank'
         where id = v_exp.id;
        insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, prev, created_by)
        values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'recorded_payment', v_exp.id, v_amt, v_prev, v_uid);
        v_paid := v_paid || jsonb_build_object('source', 'recorded_payment', 'pays_source', 'expense', 'doc_id', v_exp.id, 'bill_no', v_exp.bill_no,
                   'settled', v_amt, 'cash', v_amt, 'tds', 0, 'tds_section', null, 'status', 'paid', 'still_due', 0,
                   'paid_on', coalesce(v_exp.paid_date, v_exp.expense_date));
      end if;
      v_cash := v_cash + v_amt;
      continue;
    end if;

    select pr.run_no into v_run from public.payment_run_items pi join public.payment_runs pr on pr.id = pi.run_id
     where pi.tenant_id = v_txn.tenant_id and pi.source = v_src and pi.doc_id = v_doc and pr.status in ('draft', 'approved') limit 1;
    if v_run is not null then
      raise exception '% is in payment run % — mark that run paid, or cancel it, instead.', v_doc, v_run using errcode = 'check_violation';
    end if;

    if v_src = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = v_doc for update;
      if not found or v_bill.tenant_id is distinct from v_txn.tenant_id then
        raise exception 'Bill % not found in your company', v_doc using errcode = '42501';
      end if;
      if not coalesce(v_bill.vendor_id = v_vendor.id or (v_bill.vendor_id is null and upper(trim(v_bill.vendor_name)) = upper(trim(v_vendor.name))), false) then
        raise exception 'Bill % is from %, not %', coalesce(v_bill.bill_no, v_doc), v_bill.vendor_name, v_vendor.name using errcode = '22023';
      end if;
      if upper(coalesce(v_bill.currency, 'INR')) <> 'INR' then
        raise exception 'Bill % is in %, pay it from the Bills page', coalesce(v_bill.bill_no, v_doc), v_bill.currency using errcode = '22023';
      end if;
      /* R-1911: a payment of this amount already recorded on this bill with no real bank line
         (Bills page Pay / payment run) IS this money — paying the bill again pays the vendor twice. */
      select t.txn_date into v_rec_paid from public.bank_transactions t
       where t.tenant_id = v_txn.tenant_id and t.source = 'manual' and t.matched_to_type = 'vendor_bill'
         and t.matched_to_id = v_doc and t.debit in (v_amt, v_amt - v_tds, v_txn.debit)
       order by abs(t.txn_date - v_txn.txn_date) limit 1;
      if found then
        raise exception 'Bill % already has this payment recorded on % from the Bills page, with no bank line yet — match this bank line to that payment (it would pay the vendor twice).',
          coalesce(v_bill.bill_no, v_doc), to_char(v_rec_paid, 'DD Mon YYYY') using errcode = 'check_violation';
      end if;
      /* R-1891: TDS on a goods bill is 194Q only, only for a buyer above ₹10 crore, and exactly
         the TDS still due on it (vendor_bill_194q_calc — the number the screen shows). */
      v_qbase := 0;
      if v_tds > 0 then
        if coalesce(v_sec, '194Q') <> '194Q' then
          raise exception 'TDS on a COGS (goods) bill is 194Q only — % is for services. Record that bill as an expense bill to deduct %.', v_sec, v_sec
            using errcode = '22023';
        end if;
        v_sec := '194Q';
        if not coalesce((select t.tds_194q_buyer from public.tenants t where t.id = v_txn.tenant_id), false) then
          raise exception '194Q TDS applies only when your business turnover last financial year was above ₹10 crore — answer that question first.'
            using errcode = '22023';
        end if;
        select * into v_q from public.vendor_bill_194q_calc(v_doc);
        if coalesce(v_q.tds_due, 0) = 0 then
          raise exception 'No 194Q TDS is due on bill %: % this year before it, so nothing of it is above ₹50 lakh — or its TDS was already deducted (₹%).',
            coalesce(v_bill.bill_no, v_doc), '₹' || coalesce(v_q.fy_before, 0), coalesce(v_q.tds_already, 0)
            using errcode = '22023';
        end if;
        if v_tds <> v_q.tds_due then
          raise exception '194Q TDS on bill % is ₹% (% of ₹% above ₹50 lakh), not ₹%.',
            coalesce(v_bill.bill_no, v_doc), v_q.tds_due, v_q.rate_pct || '%', v_q.base, v_tds
            using errcode = '22023';
        end if;
        if v_tds >= v_amt then
          raise exception 'Bill %: the TDS ₹% must be less than the amount settled ₹%.', coalesce(v_bill.bill_no, v_doc), v_tds, v_amt using errcode = '22023';
        end if;
        v_qbase := v_q.base;
      end if;
      v_out := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
      if v_bill.status = 'paid' or v_out <= 0 then raise exception 'Bill % is already paid', coalesce(v_bill.bill_no, v_doc) using errcode = 'check_violation'; end if;
      if v_amt > v_out then
        raise exception 'Bill %: ₹% is more than the ₹% still owed — put the extra as an advance.', coalesce(v_bill.bill_no, v_doc), v_amt, v_out using errcode = '22023';
      end if;
      -- Same settlement as pay_vendor_bill / mark_payment_run_paid; the TDS is part of paying the bill.
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount, 0) + v_amt,
             status = case when coalesce(paid_amount, 0) + v_amt >= coalesce(total, 0) then 'paid' else 'partial' end,
             updated_at = now()
       where id = v_doc
       returning status into v_status;
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash,
                                                    tds_amount, tds_section, tds_base, tds_on, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bill', v_doc, v_amt - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, v_qbase,
              case when v_tds > 0 then v_txn.txn_date end, v_uid);
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_paid := v_paid || jsonb_build_object('source', 'vendor_bill', 'doc_id', v_doc, 'bill_no', v_bill.bill_no,
                 'settled', v_amt, 'cash', v_amt - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', v_status, 'still_due', v_out - v_amt);
    else
      select * into v_exp from public.expenses where id = v_doc for update;
      if not found or v_exp.tenant_id is distinct from v_txn.tenant_id then
        raise exception 'Expense bill % not found in your company', v_doc using errcode = '42501';
      end if;
      if not coalesce(v_exp.vendor_id = v_vendor.id or (v_exp.vendor_id is null and upper(trim(coalesce(v_exp.vendor_name, ''))) = upper(trim(v_vendor.name))), false) then
        raise exception 'Expense bill % is from %, not %', coalesce(v_exp.bill_no, v_doc), coalesce(v_exp.vendor_name, 'another vendor'), v_vendor.name using errcode = '22023';
      end if;
      if v_exp.paid or v_exp.reconciled_txn_id is not null then
        raise exception 'Expense bill % is already paid', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
      end if;
      if upper(coalesce(v_exp.currency, 'INR')) <> 'INR' or coalesce(v_exp.payment_method, '') in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
         or v_exp.prepaid_advance_id is not null or v_exp.category = 'Salaries' then
        raise exception 'Expense % is not a vendor bill that can be paid here', v_doc using errcode = '22023';
      end if;
      /* R-1913: the vendor's advance applied to it is not paid again.
         R-1915: part payments. The bill's whole TDS is withheld with its FIRST bank part (TDS is
         due at credit or payment, whichever is earlier); later parts carry none. */
      v_first := coalesce(v_exp.paid_amount, 0) = 0;
      v_gross_due := v_exp.amount - coalesce(v_exp.advance_applied, 0) - coalesce(v_exp.paid_amount, 0)
                     - case when v_first then 0 else coalesce(v_exp.tds_amount, 0) end;
      if v_gross_due <= 0 then
        raise exception 'Nothing is left to pay on expense bill %.', coalesce(v_exp.bill_no, v_doc) using errcode = 'check_violation';
      end if;
      if not v_first and v_tds > 0 then
        raise exception 'TDS on bill % was taken with its first payment (₹%) — pay the rest (₹%) without TDS.', coalesce(v_exp.bill_no, v_doc),
          coalesce(v_exp.tds_amount, 0), v_gross_due using errcode = '22023';
      end if;
      if v_amt > v_gross_due then
        if coalesce(v_exp.advance_applied, 0) > 0 then
          raise exception 'Expense bill % has ₹% left to pay after the advance applied (₹%) — ₹% is more than that; put the extra as an advance.', coalesce(v_exp.bill_no, v_doc),
            v_gross_due, v_exp.advance_applied, v_amt using errcode = '22023';
        end if;
        raise exception 'Expense bill %: ₹% is more than the ₹% still to pay — put the extra as an advance.', coalesce(v_exp.bill_no, v_doc), v_amt, v_gross_due
          using errcode = '22023';
      end if;
      if v_tds > v_amt or (v_tds > 0 and v_tds >= v_amt and v_amt < v_gross_due) then
        raise exception 'TDS ₹% must be less than the ₹% this payment settles on bill %.', v_tds, v_amt, coalesce(v_exp.bill_no, v_doc) using errcode = '22023';
      end if;
      if v_first and coalesce(v_exp.tds_amount, 0) > 0 and v_tds <> v_exp.tds_amount then
        raise exception 'Expense bill % already has ₹% TDS recorded — the payment must use the same TDS.', coalesce(v_exp.bill_no, v_doc), v_exp.tds_amount
          using errcode = '22023';
      end if;
      if v_tds > greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) then
        raise exception 'TDS ₹% cannot be more than the value before GST (₹%).', v_tds, greatest(0, v_exp.amount - coalesce(v_exp.gst_paid, 0)) using errcode = '22023';
      end if;
      v_sec := case when v_tds > 0 then coalesce(v_sec, nullif(upper(trim(coalesce(v_exp.tds_section, ''))), '')) end;
      if v_tds > 0 and v_sec is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;

      v_new_tds  := case when v_first then v_tds else coalesce(v_exp.tds_amount, 0) end;
      v_new_paid := coalesce(v_exp.paid_amount, 0) + (v_amt - v_tds);
      v_left_due := v_exp.amount - v_new_tds - coalesce(v_exp.advance_applied, 0) - v_new_paid;

      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, prev, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'expense', v_doc, v_amt - v_tds, v_tds, v_sec,
              jsonb_build_object('tds_amount', v_exp.tds_amount, 'tds_section', v_exp.tds_section, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id, 'vendor_id', v_exp.vendor_id,
                                 'paid_amount', coalesce(v_exp.paid_amount, 0)),
              v_uid);
      if v_left_due <= 0 then
        -- The last rupee: the bill is paid, and this line is its bank match.
        update public.expenses
           set paid = true, paid_date = v_txn.txn_date, payment_method = 'bank',
               bank_account_id = v_txn.bank_account_id, reconciled_txn_id = p_txn_id,
               vendor_id = coalesce(vendor_id, v_vendor.id), paid_amount = v_new_paid,
               tds_amount = v_new_tds, tds_section = case when v_tds > 0 then v_sec else tds_section end
         where id = v_doc;
        v_status := 'paid';
      else
        -- A part: the bill stays to pay (partial), with v_left_due still owed.
        update public.expenses
           set vendor_id = coalesce(vendor_id, v_vendor.id), paid_amount = v_new_paid,
               tds_amount = v_new_tds, tds_section = case when v_tds > 0 then v_sec else tds_section end
         where id = v_doc;
        v_status := 'partial';
      end if;
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_paid := v_paid || jsonb_build_object('source', 'expense', 'doc_id', v_doc, 'bill_no', v_exp.bill_no,
                 'settled', v_amt, 'cash', v_amt - v_tds, 'tds', v_tds, 'tds_section', v_sec, 'status', v_status,
                 'still_due', greatest(0, v_left_due));
    end if;
  end loop;

  /* ── (b) New bill on the spot ── */
  if p_new_bill is not null then
    v_kind    := p_new_bill->>'kind';
    v_cat     := nullif(trim(coalesce(p_new_bill->>'category', '')), '');
    v_taxable := round(coalesce((p_new_bill->>'taxable')::numeric, 0))::integer;
    v_gst     := round(coalesce((p_new_bill->>'gst')::numeric, 0))::integer;
    v_itc     := coalesce((p_new_bill->>'itc')::boolean, true);
    v_tds     := round(coalesce((p_new_bill->>'tds_amount')::numeric, 0))::integer;
    v_sec     := nullif(upper(trim(coalesce(p_new_bill->>'tds_section', ''))), '');
    v_bdate   := coalesce((p_new_bill->>'bill_date')::date, v_txn.txn_date);
    v_total   := v_taxable + v_gst;
    v_pay     := round(coalesce((p_new_bill->>'pay')::numeric, v_total))::integer;
    if v_kind not in ('cogs', 'expense') then raise exception 'New bill: pick COGS bill or expense' using errcode = '22023'; end if;
    if v_taxable <= 0 or v_gst < 0 then raise exception 'New bill: the value before GST must be more than zero.' using errcode = '22023'; end if;
    if v_tds < 0 or v_tds > v_taxable then raise exception 'New bill: TDS ₹% cannot be more than the value before GST (₹%).', v_tds, v_taxable using errcode = '22023'; end if;
    if v_tds > 0 and v_sec is null then raise exception 'New bill: pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;
    if v_pay <= 0 or v_pay > v_total then raise exception 'New bill: pay ₹% must be between ₹1 and the bill total ₹%.', v_pay, v_total using errcode = '22023'; end if;
    if v_own_state is not null and v_v_state is not null and v_own_state <> v_v_state then
      v_igst := v_gst; v_cgst := 0; v_sgst := 0;
    else
      v_igst := 0; v_cgst := v_gst / 2; v_sgst := v_gst - v_gst / 2;
    end if;

    if v_kind = 'cogs' then
      if v_cat is null or v_cat not like 'COGS-%' then raise exception 'New COGS bill: pick a COGS category.' using errcode = '22023'; end if;
      if v_tds > 0 then
        -- R-1891: 194Q is worked out on a saved bill (its place in the year's purchases).
        raise exception 'TDS on a COGS bill typed here cannot be taken — record the bill first (Bills → Record a bill), then pay it here: the 194Q TDS is worked out on the saved bill.' using errcode = '22023';
      end if;
      v_id := 'BILL-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
      insert into public.vendor_bills
        (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category,
         subtotal, cgst, sgst, igst, total, status, paid_amount, notes, document_type, currency, fx_rate)
      values
        (v_id, v_txn.tenant_id, v_vendor.id, v_vendor.name, v_vendor.gstin,
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), v_bdate,
         coalesce((p_new_bill->>'due_date')::date, v_bdate), v_cat,
         v_taxable, v_cgst, v_sgst, v_igst, v_total,
         case when v_pay >= v_total then 'paid' else 'partial' end, v_pay,
         coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Recorded from a bank payment'),
         case when v_itc and v_gst > 0 then 'tax_invoice' else 'other' end, 'INR', 1);
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_bill', v_id, v_pay, v_uid);
      v_cash := v_cash + v_pay;
      v_new := jsonb_build_object('source', 'vendor_bill', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay, 'tds', 0, 'status', case when v_pay >= v_total then 'paid' else 'partial' end,
                 'still_due', v_total - v_pay);
    else
      if v_cat is null or v_cat like 'COGS-%' or v_cat = 'Salaries' then
        raise exception 'New expense bill: pick an expense category (Salaries go through Payroll).' using errcode = '22023';
      end if;
      if v_pay <> v_total then
        raise exception 'A new expense bill is paid in full (₹%). For a part payment, record the bill first and book the money as an advance.', v_total
          using errcode = '22023';
      end if;
      v_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
      insert into public.expenses
        (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, igst, cgst, sgst,
         bill_type, bill_no, payment_method, description, paid, paid_date, bank_account_id, reconciled_txn_id,
         tds_section, tds_amount)
      values
        (v_id, v_txn.tenant_id, v_cat, v_vendor.name, v_vendor.id, v_bdate, coalesce((p_new_bill->>'due_date')::date, v_bdate),
         v_total, v_gst, v_igst, v_cgst, v_sgst,
         case when v_itc and v_gst > 0 then 'gst' else 'none' end,
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), 'bank',
         coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description),
         true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id,
         case when v_tds > 0 then v_sec end, v_tds);
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_expense', v_id, v_total - v_tds, v_tds, case when v_tds > 0 then v_sec end, v_uid);
      v_cash := v_cash + (v_total - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      v_new := jsonb_build_object('source', 'expense', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_total, 'cash', v_total - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', 'paid', 'still_due', 0);
    end if;
  end if;

  /* ── (c) Advance / extra ── */
  if coalesce(p_advance, 0) > 0 then
    /* R-1911: the whole line as an advance while this vendor has a payment of exactly this amount
       recorded outside the bank (±30 days) and not matched — that is the same money, not an advance. */
    if p_advance = v_txn.debit then
      select o.paid_on, case o.pays_source when 'expense' then 'on the Expenses page' else 'on the Bills page' end
        into v_rec_paid, v_rec_where
        from public.bank_debit_vendor_open_items(v_vendor.id) o
       where o.source = 'recorded_payment' and o.amount_due = v_txn.debit and abs(o.paid_on - v_txn.txn_date) <= 30
       order by abs(o.paid_on - v_txn.txn_date) limit 1;
      if found then
        raise exception '₹% to % is already recorded as paid on % %, with no bank line yet — match this bank line to that payment instead of keeping it as an advance (the money would go out twice).',
          v_txn.debit, v_vendor.name, to_char(v_rec_paid, 'DD Mon YYYY'), v_rec_where using errcode = 'check_violation';
      end if;
    end if;
    v_cat := coalesce(nullif(trim(coalesce(p_advance_category, '')), ''),
                      case when coalesce(v_vendor.default_category, '') not like 'COGS-%' then nullif(trim(v_vendor.default_category), '') end,
                      'Other');
    if v_cat = 'Salaries' or v_cat like 'COGS-%' then
      raise exception 'Pick the expense category the advance will be used for.' using errcode = '22023';
    end if;
    insert into public.prepaid_advances
      (tenant_id, vendor_name, vendor_id, category, total_amount, consumed_amount, paid_date, payment_method,
       bank_account_id, notes, created_by)
    values
      (v_txn.tenant_id, v_vendor.name, v_vendor.id, v_cat, p_advance, 0, v_txn.txn_date, 'bank_transfer',
       v_txn.bank_account_id, coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description), v_uid)
    returning id into v_adv_id;
    insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, prepaid_advance_id, cash, created_by)
    values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'advance', v_adv_id, p_advance, v_uid);
    v_cash := v_cash + p_advance;
    v_adv := jsonb_build_object('id', v_adv_id, 'amount', p_advance, 'category', v_cat);
  end if;

  /* ── Bank charge ── */
  if coalesce(p_bank_charge, 0) > 0 then
    v_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
       paid, paid_date, bank_account_id, reconciled_txn_id)
    values
      (v_id, v_txn.tenant_id, 'Bank Charges', null, v_txn.txn_date, p_bank_charge, 0, 'none', 'bank',
       'Bank charge on payment to ' || v_vendor.name, true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
    insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, created_by)
    values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bank_charge', v_id, p_bank_charge, v_uid);
    v_cash := v_cash + p_bank_charge;
    v_charge := jsonb_build_object('expense_id', v_id, 'amount', p_bank_charge);
  end if;

  /* ── The legs must be the bank debit, to the rupee ── */
  if v_cash <> v_txn.debit then
    raise exception 'The parts add up to ₹% but the bank line is ₹% — adjust the amounts (difference ₹%).', v_cash, v_txn.debit, v_txn.debit - v_cash
      using errcode = '22023';
  end if;

  /* Teach the vendor its TDS section, once. */
  if v_tds_sec is not null and v_vendor.default_tds_section is null then
    update public.vendors set default_tds_section = v_tds_sec, updated_at = now() where id = v_vendor.id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_payment', matched_to_id = v_vendor.id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = v_uid, updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object(
    'vendor_id', v_vendor.id, 'vendor_name', v_vendor.name, 'vendor_created', p_vendor_id is null,
    'bank_amount', v_txn.debit, 'paid', v_paid, 'new_bill', v_new, 'advance', v_adv, 'bank_charge', v_charge,
    'tds_total', v_tds_total, 'tds_section', v_tds_sec);
end;
$$;

revoke all on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) from public, anon;
grant execute on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) to authenticated, service_role;

commit;
