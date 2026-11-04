-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_vendor_bill(text,integer,date,uuid,text,integer,text,text)') and prosrc like '%R-2335%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_vendor(uuid,uuid,jsonb,jsonb,jsonb,integer,text,integer,text)') and prosrc like '%R-2335%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_vendor_payment_line_unmatched()') and prosrc like '%R-2335%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.vendor_statement(uuid)') and prosrc like '%R-2335%')
-- deploy-key: r2335payvendorbilltds
-- 20261101071500_r2335_pay_vendor_bill_tds.sql
--
-- R-2335 (1 Nov 2026, p2, goal G-RECON): Bills page → Pay takes the vendor's TDS too.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   R-2320 lets Reconcile withhold 194C / 194J TDS on a COGS bill, but the Bills page Pay button
--   (pay_vendor_bill) took no TDS — paying a COGS bill there left its TDS as amount due.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   1. pay_vendor_bill gains an 8-argument form (p_tds_amount, p_tds_section,
--      p_tds_override_reason — all required, so a 5-argument call never becomes ambiguous). The
--      R-2320 / R-1891 rules, unchanged: services TDS with the bill's FIRST payment only, ≤ the
--      value before GST, < the amount settled; 194Q only for a buyer above ₹10 crore and exactly
--      the TDS due; the owner's below-threshold override (vendor_tds_override_reason) logged in
--      activity_log. The bill is settled by cash + TDS (due 0 when cash + TDS = what was owed),
--      the manual bank line carries the cash, and the TDS sits on a bank_vendor_payment_lines
--      row (kind bill, cash 0, tds_on = the payment date) on that manual line — the row Balance
--      Sheet "TDS payable", 26Q and the vendor statement already read. GL: bank −cash,
--      payables −(cash + TDS), TDS payable +TDS — balanced. The old 5-argument form now calls
--      the 8-argument one with no TDS (one body).
--   2. reconcile_bank_debit_to_vendor — from its LATEST body (R-2338, 20261101050022): matching a
--      real bank line to such a recorded payment (R-1911) deletes the manual line, so its TDS row
--      first moves to the real line, marked prev = {tds_from_txn}.
--   3. tg_vendor_payment_line_unmatched — from its LATEST body (R-2321, 20261031234709): on
--      un-reconcile that marked row is not undone; it goes back on the restored manual line.
--   4. vendor_statement — from its LATEST body (R-1921, 20261026171338): a bank line whose rows
--      carry no cash (only Bills-page TDS) is not listed as a ₹0 payment.
--
-- Atomic (§17b): one RPC call, one transaction. Stored data is not changed.
-- Test: supabase/tests/r2335_pay_vendor_bill_tds.sql

begin;

-- ── 1. pay_vendor_bill with TDS (8 arguments, all required — the 5-argument call stays its own) ──
create or replace function public.pay_vendor_bill(
  p_bill_id             text,
  p_amount              integer,
  p_paid_on             date,
  p_bank_account_id     uuid,
  p_method              text,
  p_tds_amount          integer,
  p_tds_section         text,
  p_tds_override_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_uid      uuid := public.current_user_id();
  v_bill     public.vendor_bills;
  v_out      integer;
  v_tds      integer := coalesce(p_tds_amount, 0);
  v_sec      text := nullif(upper(btrim(coalesce(p_tds_section, ''))), '');
  v_settled  integer;
  v_new_paid integer;
  v_on       date := coalesce(p_paid_on, public.ist_today());
  v_txn_id   uuid;
  v_base     integer := 0;
  v_ovr      text;
  v_paid_tds integer;
  v_q        record;
  v_line     uuid;
begin
  /* R-2335 (from R-718 / R-1828's body): Bills page → Pay records the payment from a bank account
     (a manual bank line, matched later in Reconcile — R-1911) and may withhold the vendor's TDS
     with it, by the same rules as Reconcile (R-2320 / R-1891):
       - p_amount is the money that leaves the bank; the bill is settled by p_amount + TDS;
       - services TDS (194C / 194J …): the bill's whole TDS goes with its FIRST payment, not more
         than the value before GST, less than the amount settled;
       - 194Q: only for a buyer above ₹10 crore, exactly the TDS still due (vendor_bill_194q_calc);
       - the owner may take TDS the app finds below the threshold, with a reason (logged).
     The TDS sits on a bank_vendor_payment_lines row (kind bill, cash 0) on the manual line — the
     row TDS payable, 26Q and the vendor statement already read. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pay a vendor bill' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context' using errcode = '28000'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0' using errcode = '22023'; end if;
  if v_tds < 0 then raise exception 'TDS cannot be negative' using errcode = '22023'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bill not found' using errcode = 'no_data_found'; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found' using errcode = 'no_data_found'; end if;

  if v_tds > 0 then
    if v_sec is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds using errcode = '22023'; end if;
    if upper(coalesce(v_bill.currency, 'INR')) <> 'INR' then
      raise exception 'Bill % is in % — TDS on it is not taken here.', coalesce(v_bill.bill_no, v_bill.id), v_bill.currency using errcode = '22023';
    end if;
    v_ovr := public.vendor_tds_override_reason(p_tds_override_reason, v_trusted);
    select coalesce(sum(l.tds_amount), 0) into v_paid_tds
      from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_bill.id and l.tds_amount > 0;
    if v_sec <> '194Q' then
      if v_paid_tds > 0 or coalesce(v_bill.paid_amount, 0) > 0 then
        raise exception 'TDS on bill % goes with its first payment (₹% TDS already, ₹% paid) — pay this part without TDS.',
          coalesce(v_bill.bill_no, v_bill.id), v_paid_tds, coalesce(v_bill.paid_amount, 0) using errcode = '22023';
      end if;
      if v_tds > coalesce(v_bill.subtotal, 0) then
        raise exception 'TDS ₹% cannot be more than the value before GST (₹%) of bill %.', v_tds, coalesce(v_bill.subtotal, 0), coalesce(v_bill.bill_no, v_bill.id)
          using errcode = '22023';
      end if;
      v_base := coalesce(v_bill.subtotal, 0);
    else
      if exists (select 1 from public.bank_vendor_payment_lines l
                  where l.vendor_bill_id = v_bill.id and l.tds_amount > 0 and coalesce(l.tds_section, '194Q') <> '194Q') then
        raise exception 'Bill % already had % TDS deducted — 194Q does not apply on top of it.', coalesce(v_bill.bill_no, v_bill.id),
          (select l.tds_section from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_bill.id and l.tds_amount > 0 limit 1)
          using errcode = '22023';
      end if;
      if not coalesce((select t.tds_194q_buyer from public.tenants t where t.id = v_tenant), false) then
        raise exception '194Q TDS applies only when your business turnover last financial year was above ₹10 crore — answer that question first.'
          using errcode = '22023';
      end if;
      select * into v_q from public.vendor_bill_194q_calc(v_bill.id);
      if coalesce(v_q.tds_due, 0) = 0 then
        raise exception 'No 194Q TDS is due on bill %: % this year before it, so nothing of it is above ₹50 lakh — or its TDS was already deducted (₹%).',
          coalesce(v_bill.bill_no, v_bill.id), '₹' || coalesce(v_q.fy_before, 0), coalesce(v_q.tds_already, 0)
          using errcode = '22023';
      end if;
      if v_tds <> v_q.tds_due then
        raise exception '194Q TDS on bill % is ₹% (% of ₹% above ₹50 lakh), not ₹%.',
          coalesce(v_bill.bill_no, v_bill.id), v_q.tds_due, v_q.rate_pct || '%', v_q.base, v_tds
          using errcode = '22023';
      end if;
      v_base := v_q.base;
    end if;
  end if;

  v_settled := p_amount + v_tds;
  v_out := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
  if v_settled > v_out then
    if v_tds > 0 then
      raise exception 'Payment ₹% + TDS ₹% = ₹% is more than the ₹% still owed on bill %.', p_amount, v_tds, v_settled, v_out, coalesce(v_bill.bill_no, v_bill.id)
        using errcode = '22023';
    end if;
    raise exception 'Payment (%) exceeds the outstanding (%)', p_amount, v_out using errcode = '22023';
  end if;

  v_new_paid := coalesce(v_bill.paid_amount, 0) + v_settled;
  update public.vendor_bills
     set paid_amount = v_new_paid,
         status      = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
         updated_at  = now()
   where id = v_bill.id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, v_on,
     'Bill payment: ' || v_bill.vendor_name, p_amount, 0, 'manual', 'vendor_bill', v_bill.id, 'manual',
     nullif(trim(coalesce(p_method, '')), ''))
  returning id into v_txn_id;

  if v_tds > 0 then
    -- Inserted without the vendor, then given it: the R-1919 alias trigger must not learn the
    -- manual line's "Bill payment: …" text as this vendor's bank narration.
    insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash,
                                                  tds_amount, tds_section, tds_base, tds_on, tds_override_reason, created_by)
    values (v_tenant, v_txn_id, null, 'bill', v_bill.id, 0, v_tds, v_sec, v_base, v_on, v_ovr, v_uid)
    returning id into v_line;
    update public.bank_vendor_payment_lines set vendor_id = v_bill.vendor_id where id = v_line;
    if v_ovr is not null then
      insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
      values (v_tenant, v_uid, 'tds_override', 'vendor_bill', v_bill.id,
              'TDS ₹' || v_tds || ' (' || v_sec || ') taken below the threshold on bill ' || coalesce(v_bill.bill_no, v_bill.id)
                || ' of ' || v_bill.vendor_name || ' — ' || v_ovr,
              jsonb_build_object('source', 'vendor_bill', 'doc_id', v_bill.id, 'bill_no', v_bill.bill_no, 'tds_amount', v_tds,
                                 'tds_section', v_sec, 'reason', v_ovr, 'bank_txn_id', v_txn_id, 'vendor_id', v_bill.vendor_id));
    end if;
  end if;
end;
$$;
revoke all on function public.pay_vendor_bill(text, integer, date, uuid, text, integer, text, text) from public, anon;
grant execute on function public.pay_vendor_bill(text, integer, date, uuid, text, integer, text, text) to authenticated, service_role;

-- ── 2. The 5-argument call (scripts, older screens): the same body, no TDS ──
create or replace function public.pay_vendor_bill(p_bill_id text, p_amount integer, p_paid_on date, p_bank_account_id uuid, p_method text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2335: one body — the 8-argument pay_vendor_bill (R-718 role gate, R-1828 IST date) with no TDS. */
  perform public.pay_vendor_bill(p_bill_id, p_amount, p_paid_on, p_bank_account_id, p_method, 0, null::text, null::text);
end;
$$;

-- ── 3. reconcile_bank_debit_to_vendor (from R-2338) — the Bills-page TDS row moves with a matched recorded payment ──
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
  v_ovr       text;     -- R-2320: the owner's reason for TDS below the threshold (null = none)
  v_ovr_log   jsonb := '[]'::jsonb;   -- R-2320: overrides to write to the activity log
  v_paid_tds  integer;  -- R-2320: TDS already on a COGS bill
  v_remember  boolean := false;  -- R-2338: the owner ticked "Remember for this vendor"
begin
  /* §17c fail-closed + R-718 money roles. R-1915: an expense bill can be paid in parts.
     R-1914: an advance may carry a COGS head (the vendor's own by default).
     R-2321: a NEW expense bill typed here can be part-paid too ("Paying now").
     R-2335: a Bills-page payment that withheld TDS can be matched here; its TDS row moves along.
     R-2320: a COGS bill (open or new) takes services TDS (194C / 194J …) like an expense bill;
     the owner may override the app's "below threshold" with a reason (logged).
     R-2338: the vendor's TDS section is saved only on the owner's "Remember for this vendor". */
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
    v_ovr := case when v_tds > 0 then public.vendor_tds_override_reason(it->>'tds_override_reason', v_trusted) end;

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
        /* R-2335: TDS withheld on the Bills page (pay_vendor_bill) sits on that manual line — it
           moves to this bank line, marked, so un-reconciling puts it back on the manual line. */
        update public.bank_vendor_payment_lines
           set bank_txn_id = p_txn_id, prev = jsonb_build_object('tds_from_txn', v_syn.id)
         where bank_txn_id = v_syn.id;
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
      select coalesce(sum(l.tds_amount), 0) into v_paid_tds
        from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_doc and l.tds_amount > 0;
      if v_tds > 0 and coalesce(v_sec, '194Q') <> '194Q' then
        /* R-2320: services TDS (194C / 194J …) on a COGS bill — the expense-bill rules (R-1915):
           the bill's whole TDS goes with its FIRST payment, less than the amount settled, not
           more than the value before GST. */
        if v_paid_tds > 0 or coalesce(v_bill.paid_amount, 0) > 0 then
          raise exception 'TDS on bill % goes with its first payment (₹% TDS already, ₹% paid) — pay this part without TDS.',
            coalesce(v_bill.bill_no, v_doc), v_paid_tds, coalesce(v_bill.paid_amount, 0) using errcode = '22023';
        end if;
        if v_tds > coalesce(v_bill.subtotal, 0) then
          raise exception 'TDS ₹% cannot be more than the value before GST (₹%) of bill %.', v_tds, coalesce(v_bill.subtotal, 0), coalesce(v_bill.bill_no, v_doc)
            using errcode = '22023';
        end if;
        if v_tds >= v_amt then
          raise exception 'Bill %: the TDS ₹% must be less than the amount settled ₹%.', coalesce(v_bill.bill_no, v_doc), v_tds, v_amt using errcode = '22023';
        end if;
        v_qbase := coalesce(v_bill.subtotal, 0);
      elsif v_tds > 0 then
        if exists (select 1 from public.bank_vendor_payment_lines l
                    where l.vendor_bill_id = v_doc and l.tds_amount > 0 and coalesce(l.tds_section, '194Q') <> '194Q') then
          raise exception 'Bill % already had % TDS deducted — 194Q does not apply on top of it.', coalesce(v_bill.bill_no, v_doc),
            (select l.tds_section from public.bank_vendor_payment_lines l where l.vendor_bill_id = v_doc and l.tds_amount > 0 limit 1)
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
                                                    tds_amount, tds_section, tds_base, tds_on, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'bill', v_doc, v_amt - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, v_qbase,
              case when v_tds > 0 then v_txn.txn_date end, v_ovr, v_uid);
      v_cash := v_cash + (v_amt - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((it->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      if v_ovr is not null then
        v_ovr_log := v_ovr_log || jsonb_build_object('source', 'vendor_bill', 'doc_id', v_doc, 'bill_no', v_bill.bill_no,
                       'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
      end if;
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

      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, prev, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'expense', v_doc, v_amt - v_tds, v_tds, v_sec,
              jsonb_build_object('tds_amount', v_exp.tds_amount, 'tds_section', v_exp.tds_section, 'paid_date', v_exp.paid_date,
                                 'payment_method', v_exp.payment_method, 'bank_account_id', v_exp.bank_account_id, 'vendor_id', v_exp.vendor_id,
                                 'paid_amount', coalesce(v_exp.paid_amount, 0)),
              v_ovr, v_uid);
      if v_ovr is not null then
        v_ovr_log := v_ovr_log || jsonb_build_object('source', 'expense', 'doc_id', v_doc, 'bill_no', v_exp.bill_no,
                       'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
      end if;
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
      if v_tds > 0 and coalesce((it->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
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
    v_ovr := case when v_tds > 0 then public.vendor_tds_override_reason(p_new_bill->>'tds_override_reason', v_trusted) end;
    if v_own_state is not null and v_v_state is not null and v_own_state <> v_v_state then
      v_igst := v_gst; v_cgst := 0; v_sgst := 0;
    else
      v_igst := 0; v_cgst := v_gst / 2; v_sgst := v_gst - v_gst / 2;
    end if;

    if v_kind = 'cogs' then
      if v_cat is null or v_cat not like 'COGS-%' then raise exception 'New COGS bill: pick a COGS category.' using errcode = '22023'; end if;
      if v_tds > 0 and v_sec = '194Q' then
        -- R-1891: 194Q is worked out on a saved bill (its place in the year's purchases).
        raise exception 'TDS on a COGS bill typed here cannot be taken — record the bill first (Bills → Record a bill), then pay it here: the 194Q TDS is worked out on the saved bill.' using errcode = '22023';
      end if;
      -- R-2320: services TDS (194C / 194J …) on a new COGS bill — its whole TDS goes with this payment.
      if v_tds > 0 and v_pay <= v_tds then
        raise exception 'New bill: paying now ₹% must be more than the TDS ₹% on it.', v_pay, v_tds using errcode = '22023';
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
      -- R-2320: the bill's paid_amount is cash + TDS (as R-1891); the leg carries the cash.
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, vendor_bill_id, cash,
                                                    tds_amount, tds_section, tds_base, tds_on, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_bill', v_id, v_pay - v_tds,
              v_tds, case when v_tds > 0 then v_sec end, case when v_tds > 0 then v_taxable else 0 end,
              case when v_tds > 0 then v_txn.txn_date end, v_ovr, v_uid);
      v_cash := v_cash + (v_pay - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((p_new_bill->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      v_new := jsonb_build_object('source', 'vendor_bill', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', case when v_pay >= v_total then 'paid' else 'partial' end,
                 'still_due', v_total - v_pay);
    else
      if v_cat is null or v_cat like 'COGS-%' or v_cat = 'Salaries' then
        raise exception 'New expense bill: pick an expense category (Salaries go through Payroll).' using errcode = '22023';
      end if;
      /* R-2321: "Paying now" may be less than the bill. The bill is saved with its full total and
         only this part (cash + TDS) is settled by the line — the rest stays due, exactly like an
         R-1915 part-paid bill (paid = false, paid_amount = the cash). Its whole TDS goes with this
         first part (R-1915 rule). Paid in full: as before (paid, linked to this line). */
      if v_pay <= v_tds then
        raise exception 'New bill: paying now ₹% must be more than the TDS ₹% on it.', v_pay, v_tds using errcode = '22023';
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
         nullif(trim(coalesce(p_new_bill->>'bill_no', '')), ''), case when v_pay >= v_total then 'bank' end,
         coalesce(nullif(trim(coalesce(p_note, '')), ''), v_txn.description),
         v_pay >= v_total, case when v_pay >= v_total then v_txn.txn_date end,
         case when v_pay >= v_total then v_txn.bank_account_id end, case when v_pay >= v_total then p_txn_id end,
         case when v_tds > 0 then v_sec end, v_tds);
      if v_pay < v_total then
        -- R-2321: a part — the cash is on the bill like an R-1915 bank part (open items, payables).
        update public.expenses set paid_amount = v_pay - v_tds where id = v_id;
      end if;
      insert into public.bank_vendor_payment_lines (tenant_id, bank_txn_id, vendor_id, kind, expense_id, cash, tds_amount, tds_section, tds_override_reason, created_by)
      values (v_txn.tenant_id, p_txn_id, v_vendor.id, 'new_expense', v_id, v_pay - v_tds, v_tds, case when v_tds > 0 then v_sec end, v_ovr, v_uid);
      v_cash := v_cash + (v_pay - v_tds);
      v_tds_total := v_tds_total + v_tds;
      if v_tds > 0 then v_tds_sec := coalesce(v_tds_sec, v_sec); end if;
      if v_tds > 0 and coalesce((p_new_bill->>'remember_tds_section')::boolean, false) then v_remember := true; end if;  -- R-2338
      v_new := jsonb_build_object('source', 'expense', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no', 'total', v_total,
                 'settled', v_pay, 'cash', v_pay - v_tds, 'tds', v_tds, 'tds_section', case when v_tds > 0 then v_sec end,
                 'status', case when v_pay >= v_total then 'paid' else 'partial' end, 'still_due', v_total - v_pay);
    end if;
    if v_ovr is not null then
      v_ovr_log := v_ovr_log || jsonb_build_object('source', v_new->>'source', 'doc_id', v_id, 'bill_no', p_new_bill->>'bill_no',
                     'tds_amount', v_tds, 'tds_section', v_sec, 'reason', v_ovr);
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
    /* R-1914: an advance to a goods (COGS) vendor keeps the vendor's COGS head — it is set off
       later against that vendor's COGS bill (Bills → Apply advance), never booked as opex. */
    v_cat := coalesce(nullif(trim(coalesce(p_advance_category, '')), ''),
                      nullif(trim(coalesce(v_vendor.default_category, '')), ''),
                      'Other');
    if v_cat = 'Salaries' then
      raise exception 'Pick the expense or COGS head the advance will be used for (Salaries go through Payroll).' using errcode = '22023';
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

  /* R-2338: the vendor's TDS section is saved ONLY when the owner ticked "Remember for this
     vendor" (it was taught by itself on the first TDS payment before — never auto-set now). */
  if v_remember and v_tds_sec is not null then
    update public.vendors set default_tds_section = v_tds_sec, updated_at = now() where id = v_vendor.id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_payment', matched_to_id = v_vendor.id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = v_uid, updated_at = now()
   where id = p_txn_id;

  /* R-2320: every owner override of the TDS threshold, in the activity log (who, what, why). */
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  select v_txn.tenant_id, v_uid, 'tds_override', case when o->>'source' = 'expense' then 'expense' else 'vendor_bill' end, o->>'doc_id',
         'TDS ₹' || (o->>'tds_amount') || ' (' || coalesce(o->>'tds_section', '—') || ') taken below the threshold on '
           || coalesce('bill ' || nullif(o->>'bill_no', ''), o->>'doc_id') || ' of ' || v_vendor.name || ' — ' || (o->>'reason'),
         o || jsonb_build_object('bank_txn_id', p_txn_id, 'vendor_id', v_vendor.id, 'tds_amount', (o->>'tds_amount')::int)
    from jsonb_array_elements(v_ovr_log) o;

  return jsonb_build_object(
    'vendor_id', v_vendor.id, 'vendor_name', v_vendor.name, 'vendor_created', p_vendor_id is null,
    'bank_amount', v_txn.debit, 'paid', v_paid, 'new_bill', v_new, 'advance', v_adv, 'bank_charge', v_charge,
    'tds_total', v_tds_total, 'tds_section', v_tds_sec);
end;
$$;

revoke all on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) from public, anon;
grant execute on function public.reconcile_bank_debit_to_vendor(uuid, uuid, jsonb, jsonb, jsonb, integer, text, integer, text) to authenticated, service_role;

-- ── 4. tg_vendor_payment_line_unmatched (from R-2321) — un-reconcile puts that TDS row back ──
create or replace function public.tg_vendor_payment_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r   public.bank_vendor_payment_lines;
  v_used integer;
  v_bill public.vendor_bills;
  v_left integer;
  v_keep boolean;
  b      record;
  v_e    public.expenses;
  v_href text;
  v_month date;
  v_doc  text;
begin
  /* R-1913. R-1915: an expense bill's bank part comes off its paid_amount; latest part first.
     R-1914: the advance-used sentence names the Bills page too (COGS bills take advances).
     R-1920: every refusal carries a HINT (the page to fix it on) for the Undo preview, and a
     leg whose TDS month is already deposited by challan is refused.
     R-2321: a NEW expense bill can now be part-paid by its line; undoing that line deletes the bill,
     so it is refused while anything else settled the rest (another bank line — the R-1912 check —
     or Mark paid).
     R-2335: TDS a Bills-page payment withheld moves back with its manual line, never undone here. */
  if old.matched_to_type = 'vendor_payment'
     and (new.matched_to_type is distinct from 'vendor_payment' or new.matched_to_id is distinct from old.matched_to_id) then
    for r in select * from public.bank_vendor_payment_lines where bank_txn_id = old.id order by created_at, id loop
      /* R-2335: Bills-page TDS that came here with a matched recorded payment — it goes back with
         the manual line (the recorded_payment row below), it is not undone. */
      if coalesce(r.prev ? 'tds_from_txn', false) then continue; end if;
      -- R-1920: TDS this leg withheld, already paid to the government — undoing would leave
      -- the challan with no deduction behind it.
      if r.tds_amount > 0 and r.kind in ('expense', 'new_expense', 'bill', 'new_bill') then
        if r.kind in ('expense', 'new_expense') then
          select coalesce(x.expense_date, old.txn_date), coalesce(x.bill_no, x.id) into v_month, v_doc
            from public.expenses x where x.id = r.expense_id;
        else
          select coalesce(r.tds_on, old.txn_date), coalesce(vb.bill_no, vb.id) into v_month, v_doc
            from public.vendor_bills vb where vb.id = r.vendor_bill_id;
        end if;
        select * into b from public.vendor_tds_deposit_for_month(old.tenant_id, coalesce(v_month, old.txn_date));
        if b.o_msg is not null then
          raise exception 'The ₹% TDS this payment withheld on bill % is already deposited (%). Undoing it would leave that challan with no TDS behind it. If this payment really was booked wrong, un-reconcile the challan line first (Banking), then this one.',
            r.tds_amount, coalesce(v_doc, '—'), b.o_msg
            using errcode = 'check_violation', hint = b.o_href;
        end if;
      end if;
      delete from public.bank_vendor_payment_lines where id = r.id;
      if r.kind = 'bill' then
        -- R-1891: the bill was settled by cash + TDS (194Q); both come off.
        update public.vendor_bills
           set paid_amount = greatest(0, coalesce(paid_amount, 0) - r.cash - r.tds_amount),
               status = case when coalesce(paid_amount, 0) - r.cash - r.tds_amount <= 0 then 'unpaid'
                             when coalesce(paid_amount, 0) - r.cash - r.tds_amount < coalesce(total, 0) then 'partial' else 'paid' end,
               updated_at = now()
         where id = r.vendor_bill_id;
      elsif r.kind = 'expense' then
        -- R-1915: a part comes off only while nothing later rests on it.
        select * into v_e from public.expenses where id = r.expense_id for update;
        if v_e.paid and v_e.reconciled_txn_id is distinct from old.id then
          if exists (select 1 from public.bank_vendor_payment_lines l2
                      where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id = v_e.reconciled_txn_id) then
            -- another bank part paid the last rupee
            select '/accounting/banking/' || t.bank_account_id::text into v_href
              from public.bank_transactions t where t.id = v_e.reconciled_txn_id;
            raise exception 'A later bank payment is also on expense bill % — un-reconcile that one first, then this one.',
              coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/banking');
          end if;
          -- the rest was settled after this part (Mark paid, or the vendor's advance)
          raise exception 'Expense bill % was settled after this payment (% on %) — mark it unpaid first (Expenses), or undo the advance on it, then un-reconcile.',
            coalesce(v_e.bill_no, v_e.id), coalesce(v_e.payment_method, 'marked paid'), coalesce(to_char(v_e.paid_date, 'DD Mon YYYY'), 'an earlier date')
            using errcode = 'check_violation', hint = '/accounting/expenses';
        end if;
        if r.tds_amount > 0 and exists (select 1 from public.bank_vendor_payment_lines l2
                      where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id <> old.id) then
          -- this part withheld the bill's TDS; the other parts were worked out after it
          select '/accounting/banking/' || t.bank_account_id::text into v_href
            from public.bank_vendor_payment_lines l2 join public.bank_transactions t on t.id = l2.bank_txn_id
           where l2.expense_id = r.expense_id and l2.kind = 'expense' and l2.bank_txn_id <> old.id
           order by l2.created_at desc limit 1;
          raise exception 'This payment withheld the TDS on expense bill %, and a later bank payment is also on it — un-reconcile that one first, then this one.',
            coalesce(v_e.bill_no, v_e.id) using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/banking');
        end if;
        update public.expenses
           set paid = false, reconciled_txn_id = null,
               paid_date = (r.prev->>'paid_date')::date,
               payment_method = r.prev->>'payment_method',
               bank_account_id = (r.prev->>'bank_account_id')::uuid,
               vendor_id = (r.prev->>'vendor_id')::uuid,
               paid_amount = greatest(0, coalesce(paid_amount, 0) - r.cash),
               tds_amount = coalesce((r.prev->>'tds_amount')::integer, 0),
               tds_section = r.prev->>'tds_section'
         where id = r.expense_id;
      elsif r.kind = 'new_bill' then
        -- R-1912: take off only THIS line's money. Delete the bill only when nothing else is on it
        -- (a Bills-page payment, a matched / R-1911 line, an open payment run, a PO allocation).
        select * into v_bill from public.vendor_bills where id = r.vendor_bill_id for update;
        if found then
          v_left := coalesce(v_bill.paid_amount, 0) - r.cash - r.tds_amount;
          v_keep := v_left > 0
                 or exists (select 1 from public.po_bill_allocations a where a.vendor_bill_id = v_bill.id);
          if not v_keep then
            select * into b from public.matched_bank_line_blocker(v_bill.tenant_id, 'vendor_bill', v_bill.id);
            v_keep := b.o_msg is not null;
          end if;
          if not v_keep then
            select * into b from public.vendor_bill_delete_blocker(v_bill.tenant_id, v_bill.id);
            v_keep := b.o_msg is not null;
          end if;
          if v_keep then
            update public.vendor_bills
               set paid_amount = greatest(0, v_left),
                   status = case when v_left <= 0 then 'unpaid'
                                 when v_left < coalesce(total, 0) then 'partial' else 'paid' end,
                   updated_at = now()
             where id = v_bill.id;
          else
            delete from public.vendor_bills where id = v_bill.id;
          end if;
        end if;
      elsif r.kind = 'new_expense' then
        -- R-1912: refuse up front (naming what to do) rather than orphan another bank line on it.
        select * into b from public.matched_bank_line_blocker(old.tenant_id, 'expense', r.expense_id);
        if b.o_msg is not null then
          raise exception 'This bank line recorded expense bill %, and another bank line is also matched to it. Un-reconcile that other line first (Banking), then undo this one — otherwise it would point at a deleted expense.', r.expense_id
            using errcode = 'check_violation', hint = b.o_href;
        end if;
        -- R-2321: a part-paid new bill whose rest was marked paid (Expenses → Mark paid).
        select * into v_e from public.expenses where id = r.expense_id for update;
        if found and v_e.paid and v_e.reconciled_txn_id is distinct from old.id then
          raise exception 'Expense bill % was settled after this payment (% on %) — mark it unpaid first (Expenses), then un-reconcile.',
            coalesce(v_e.bill_no, v_e.id), coalesce(v_e.payment_method, 'marked paid'), coalesce(to_char(v_e.paid_date, 'DD Mon YYYY'), 'an earlier date')
            using errcode = 'check_violation', hint = '/accounting/expenses';
        end if;
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'bank_charge' then
        delete from public.expenses where id = r.expense_id;
      elsif r.kind = 'advance' then
        select consumed_amount into v_used from public.prepaid_advances where id = r.prepaid_advance_id;
        if coalesce(v_used, 0) > 0 then
          -- R-1913: an advance is used either by a Prepaid invoice or by "Apply advance" on a bill.
          -- R-1920: the link goes where it was used (a COGS bill, an expense bill, else Prepaid).
          select case when a.vendor_bill_id is not null then '/accounting/bills' else '/accounting/expenses' end into v_href
            from public.vendor_advance_applications a
           where a.prepaid_advance_id = r.prepaid_advance_id
           order by a.created_at desc limit 1;
          raise exception 'This payment''s advance to the vendor has ₹% already used against bills. Undo it there first (Expenses or Bills → the bill → Undo advance, or delete the invoice on the Prepaid page), then un-reconcile.', v_used
            using errcode = 'check_violation', hint = coalesce(v_href, '/accounting/prepaid');
        end if;
        delete from public.prepaid_advances where id = r.prepaid_advance_id;
      elsif r.kind = 'recorded_payment' then
        -- R-1911: this line had replaced a payment recorded outside the bank. Put it back as it was:
        -- the Bills-page / payment-run manual line returns (paid_amount never moved), a Mark-paid
        -- expense is "paid, waiting for its bank line" again.
        if jsonb_typeof(r.prev->'synthetic') = 'object' then
          insert into public.bank_transactions
          select * from jsonb_populate_record(null::public.bank_transactions, r.prev->'synthetic');
          -- R-2335: the Bills-page TDS row goes back on the manual line it was withheld with.
          update public.bank_vendor_payment_lines
             set bank_txn_id = (r.prev->'synthetic'->>'id')::uuid, prev = null
           where bank_txn_id = old.id and prev->>'tds_from_txn' = r.prev->'synthetic'->>'id';
        end if;
        if r.expense_id is not null and jsonb_typeof(r.prev->'expense') = 'object' then
          update public.expenses
             set reconciled_txn_id = (r.prev->'expense'->>'reconciled_txn_id')::uuid,
                 paid_date = (r.prev->'expense'->>'paid_date')::date,
                 payment_method = r.prev->'expense'->>'payment_method',
                 bank_account_id = (r.prev->'expense'->>'bank_account_id')::uuid
           where id = r.expense_id;
        end if;
      end if;
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_vendor_payment_line_unmatched() from public, anon;

-- ── 5. vendor_statement (from R-1921) — no ₹0 payment row for a TDS-only bank line ──
create or replace function public.vendor_statement(p_vendor_id uuid)
returns table (
  entry_date      date,
  seq             integer,   -- order inside one day: bill 1, TDS 2, advance set-off 3, payment 4, advance 5, closed 6, adjustment 9
  kind            text,      -- bill | tds | set_off | payment | advance | advance_closed | adjustment
  doc_id          text,      -- the bill / expense id, or the advance id
  doc_ref         text,      -- the bill no (or the bills a payment paid)
  particulars     text,
  amount          bigint,    -- + we owe more, − came off; set_off rows are 0
  set_off         bigint,    -- set_off rows: the advance used on the bill
  bank_txn_id     uuid,
  bank_account_id uuid
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  /* R-1921: a vendor's running statement — rows add up to the popup's net and the Balance Sheet.
     R-2335: a Bills-page TDS row (cash 0) shows as TDS only, never as a ₹0 payment. */
  v_tenant uuid := public.current_tenant_id();
  v_name   text;
begin
  if v_tenant is null then
    raise exception 'No company context — sign in again' using errcode = 'insufficient_privilege';
  end if;
  select upper(trim(v.name)) into v_name from public.vendors v where v.id = p_vendor_id and v.tenant_id = v_tenant;
  if not found then raise exception 'Vendor not found'; end if;

  return query
  with
  bills as (
    select b.* from public.vendor_bills b where b.tenant_id = v_tenant and b.vendor_id = p_vendor_id
  ),
  exps as (
    -- The vendor's expense bills: not salary / payroll / statutory / EMI / a reimbursement, not a
    -- bank charge the payment step booked, and an 'advance' row only when it IS a bill settled
    -- from the advance (R-1913 advance_applied, or a Prepaid → Book invoice row).
    select e.* from public.expenses e
     where e.tenant_id = v_tenant and e.vendor_id = p_vendor_id
       and coalesce(e.category, '') <> 'Salaries'
       and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'employee_advance')
       and (coalesce(e.payment_method, '') <> 'advance' or e.prepaid_advance_id is not null or coalesce(e.advance_applied, 0) > 0)
       and not exists (select 1 from public.bank_vendor_payment_lines l
                        where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'bank_charge')
  ),
  advs as (
    select a.* from public.prepaid_advances a
     where a.tenant_id = v_tenant and coalesce(a.category, '') <> 'Employee advance'
       and (a.vendor_id = p_vendor_id or (a.vendor_id is null and upper(trim(coalesce(a.vendor_name, ''))) = v_name))
  ),
  legs as (
    select l.*, t.txn_date, t.bank_account_id as acct,
           coalesce(b.bill_no, e.bill_no, l.vendor_bill_id, l.expense_id) as no
      from public.bank_vendor_payment_lines l
      join public.bank_transactions t on t.id = l.bank_txn_id
      left join bills b on b.id = l.vendor_bill_id
      left join exps  e on e.id = l.expense_id
     where l.tenant_id = v_tenant
       and l.kind in ('bill', 'new_bill', 'expense', 'new_expense', 'recorded_payment')
       and (b.id is not null or e.id is not null)
  ),
  ev as (
    -- 1. Bills
    select b.bill_date as d, 1 as s, 'bill'::text as k, b.id as doc, b.bill_no as ref,
           'Bill ' || coalesce(b.bill_no, b.id) || coalesce(' · ' || b.category, '') as txt,
           coalesce(b.total, 0)::bigint as amt, 0::bigint as so, null::uuid as txn, null::uuid as acct
      from bills b
    union all
    select e.expense_date, 1, 'bill', e.id, e.bill_no,
           'Bill ' || coalesce(e.bill_no, e.id) || coalesce(' · ' || e.category, ''),
           coalesce(e.amount, 0)::bigint, 0, null, null
      from exps e
    -- 2. TDS withheld: on an expense bill (its tds_amount, dated when the bank first took it,
    --    else the bill date); on a COGS bill (194Q, on the bank part). A Prepaid → Book invoice
    --    row is settled from the advance in full, so its TDS never reduced what the vendor got.
    union all
    select coalesce((select min(l.txn_date) from legs l where l.expense_id = e.id and l.tds_amount > 0), e.expense_date),
           2, 'tds', e.id, e.bill_no,
           'TDS' || coalesce(' ' || nullif(trim(e.tds_section), ''), '') || ' withheld on bill ' || coalesce(e.bill_no, e.id),
           -e.tds_amount::bigint, 0, null, null
      from exps e where coalesce(e.tds_amount, 0) > 0 and e.prepaid_advance_id is null
    union all
    select l.txn_date, 2, 'tds', l.vendor_bill_id, l.no,
           'TDS' || coalesce(' ' || nullif(trim(l.tds_section), ''), '') || ' withheld on bill ' || l.no,
           -l.tds_amount::bigint, 0, l.bank_txn_id, l.acct
      from legs l where l.kind in ('bill', 'new_bill') and l.tds_amount > 0
    -- 3. Advance set off against a bill — no money moves (the bill goes down, the advance too).
    union all
    select a.applied_on, 3, 'set_off', coalesce(a.expense_id, a.vendor_bill_id),
           coalesce(e.bill_no, b.bill_no),
           'Advance set off against bill ' || coalesce(e.bill_no, b.bill_no, a.expense_id, a.vendor_bill_id),
           0, a.amount::bigint, null, null
      from public.vendor_advance_applications a
      left join exps e on e.id = a.expense_id
      left join bills b on b.id = a.vendor_bill_id
     where a.tenant_id = v_tenant and (e.id is not null or b.id is not null)
    union all
    select e.expense_date, 3, 'set_off', e.id, e.bill_no,
           'Advance set off against bill ' || coalesce(e.bill_no, e.id),
           0, coalesce(e.amount, 0)::bigint, null, null
      from exps e where e.prepaid_advance_id is not null
    -- 4. Payments: the bank parts, one row per bank line
    union all
    select l.txn_date, 4, 'payment', min(coalesce(l.vendor_bill_id, l.expense_id)),
           string_agg(distinct l.no, ', '),
           'Paid from bank · ' || case when count(distinct l.no) = 1 then 'bill ' else 'bills ' end || string_agg(distinct l.no, ', '),
           -sum(l.cash)::bigint, 0, l.bank_txn_id, l.acct
      from legs l group by l.bank_txn_id, l.txn_date, l.acct
     having sum(l.cash) <> 0   -- R-2335: a Bills-page TDS row (cash 0) is not a second payment
    --    a bank line matched straight to a COGS bill (Bills page Pay / payment run = 'manual', or a real line)
    union all
    select t.txn_date, 4, 'payment', b.id, b.bill_no,
           case when t.source = 'manual' then 'Paid (recorded on the Bills page) · bill ' else 'Paid from bank · bill ' end
             || coalesce(b.bill_no, b.id),
           -coalesce(t.debit, 0)::bigint, 0, t.id, t.bank_account_id
      from public.bank_transactions t join bills b on b.id = t.matched_to_id
     where t.tenant_id = v_tenant and t.matched_to_type = 'vendor_bill'
    --    an expense bill paid with no bank part: its bank match, or marked paid (cash, card, UPI)
    union all
    select coalesce(t.txn_date, e.paid_date, e.expense_date), 4, 'payment', e.id, e.bill_no,
           case when t.id is not null then 'Paid from bank · bill ' else 'Paid (' || coalesce(nullif(e.payment_method, ''), 'marked paid') || ') · bill ' end
             || coalesce(e.bill_no, e.id),
           -(coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))::bigint,
           0, t.id, t.bank_account_id
      from exps e
      left join public.bank_transactions t on t.id = e.reconciled_txn_id and t.tenant_id = v_tenant
     where not exists (select 1 from legs l where l.expense_id = e.id)
       and e.prepaid_advance_id is null
       and (e.reconciled_txn_id is not null or (e.paid and coalesce(e.payment_method, '') <> 'advance'))
       and coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
    -- 5. Advances paid
    union all
    select coalesce(a.paid_date, a.created_at::date), 5, 'advance', a.id::text, null,
           'Advance paid' || case when a.bank_txn_id is not null or exists (select 1 from public.bank_vendor_payment_lines l
                                     where l.tenant_id = v_tenant and l.prepaid_advance_id = a.id and l.kind = 'advance')
                                  then ' from bank' else coalesce(' (' || nullif(a.payment_method, '') || ')', '') end,
           -coalesce(a.total_amount, 0)::bigint, 0, a.bank_txn_id, a.bank_account_id
      from advs a
    -- 6. An advance closed with money left on it: that rest is no longer with the vendor.
    union all
    select (a.closed_at at time zone 'Asia/Kolkata')::date, 6, 'advance_closed', a.id::text, null,
           'Advance closed — rest not carried',
           greatest(0, coalesce(a.total_amount, 0) - coalesce(a.consumed_amount, 0))::bigint, 0, null, null
      from advs a where a.closed_at is not null and coalesce(a.total_amount, 0) > coalesce(a.consumed_amount, 0)
  ),
  official as (
    -- What the popup and the Balance Sheet carry for this vendor.
    select
      coalesce((select sum(greatest(0, coalesce(b.total, 0) - coalesce(b.paid_amount, 0))) from bills b
                 where coalesce(b.status, 'unpaid') <> 'paid'), 0)
    + coalesce((select sum(coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))
                  from exps e
                 where e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
                   and coalesce(e.payment_method, '') <> 'advance'
                   and coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0), 0)
    - coalesce((select sum(greatest(0, coalesce(a.total_amount, 0) - coalesce(a.consumed_amount, 0))) from advs a
                 where a.closed_at is null), 0) as net
  )
  select ev.d, ev.s, ev.k, ev.doc, ev.ref, ev.txt, ev.amt, ev.so, ev.txn, ev.acct from ev
  union all
  select public.ist_today(), 9, 'adjustment', null, null,
         'Difference not explained by the entries above (paid or changed some other way)',
         (o.net - coalesce((select sum(ev.amt) from ev), 0))::bigint, 0, null, null
    from official o
   where o.net <> coalesce((select sum(ev.amt) from ev), 0)
  order by 1, 2, 5 nulls last, 4;
end
$function$;
revoke all on function public.vendor_statement(uuid) from public, anon;
grant execute on function public.vendor_statement(uuid) to authenticated, service_role;

commit;
