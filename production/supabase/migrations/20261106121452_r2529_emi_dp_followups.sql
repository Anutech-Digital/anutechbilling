-- deploy-peek: to_regprocedure('public.emi_down_assert_open(uuid,date,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_emi(uuid,uuid,integer,integer,integer,integer,jsonb)') and prosrc like '%R-2529%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.emi_matches_for_bank_txn(uuid)') and prosrc like '%R-2529%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_emi_line_unmatched()') and prosrc like '%R-2529%')
-- deploy-key: r2529emidpfollowups
-- 20261106121452_r2529_emi_dp_followups.sql
--
-- R-2529 (6 Nov 2026): follow-ups of the independent review of R-2523 (EMI down payment from
-- several sources, 20261106100856_r2523_emi_down_payment_split.sql). Must land before staging
-- carries the real Thar Roxx data.
--
--   1. Un-reconcile restored to the wrong account. A 'line' record in down_taken_from kept only
--      line_id; when that manual part was later deleted (replaced by an equal statement line),
--      un-reconcile fell back to a manual line on the statement line's OWN account (Petty Cash
--      ₹2L, HDFC ₹1L #1 taken out of it, HDFC ₹1L #2 replaces the rest, un-reconcile #1 → HDFC
--      manual ₹1L — the outflow then shows twice on HDFC). The record now also keeps account_id,
--      date; when the part is gone it is made again on that account and date. (A record written
--      by R-2523 itself has no account_id and still falls back as before — R-2523 is not on
--      staging/live yet, so only test data can carry one.) The owner record keeps the partner
--      and note too, so a re-made owner part lands on the same partner.
--   2. Books lock. The seq-0 reconcile and the un-reconcile trigger changed owner parts (no lock
--      trigger on owner_equity_movements) and manual parts (the bank_transactions lock trigger
--      lets service_role through) dated in a locked month. Every part they change, delete or
--      make is now checked against books_locked_until by its own date — for every caller, the
--      same rule set_emi_down_payment_parts applies inline (helper: emi_down_assert_open). The
--      paid-by-hand EMI that a bigger statement line replaces is checked the same way.
--   3. Extra interest cap. The RPC took any extra as interest; it now refuses more than the
--      bank page offers: ₹2,000 or 10% of the EMI, whichever is bigger
--      (emi_matches_for_bank_txn: diff <= greatest(2000, expected / 10)) — on a fresh instalment
--      and on a paid-by-hand EMI replaced by a bigger line.
--   4. Down-payment candidates. A manual / owner part of the line's exact amount was offered for
--      ANY debit (no date or name check) and, being a match, stopped the R-1867 vendor
--      auto-match for that line. Every down-payment row now needs the 90-days-before …
--      10-days-after window, and the narration naming the item as a whole word — except the
--      R-1864 case (the down payment is ONE manual line of this amount) within 10 days of the
--      purchase, which stays offered (dealer narrations rarely name the car).
--
-- Bodies: the R-2523 definitions (newest), changed only where marked R-2529.
-- Proof: supabase/tests/r2529_emi_dp_followups.test.sql (one rollback); R-1864 / R-2395 /
-- R-2523 tests unchanged.

begin;

-- ── 0. Books lock for a down-payment part's date — every caller ────────────────────────────
create or replace function public.emi_down_assert_open(p_tenant uuid, p_date date, p_what text)
returns void
language plpgsql stable security definer set search_path = public as $$
declare v_lock date;
begin
  -- R-2529
  if p_date is null then return; end if;
  select books_locked_until into v_lock from public.tenants where id = p_tenant;
  if v_lock is not null and p_date <= v_lock then
    raise exception 'Books are locked up to % — % dated % is in a closed month. The owner can unlock it on Accounting → Month-end close.',
      to_char(v_lock, 'DD Mon YYYY'), p_what, to_char(p_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
end;
$$;
revoke all on function public.emi_down_assert_open(uuid, date, text) from public, anon, authenticated;

-- ── 2. Reconcile — R-1864 body; down payment by PART; extra as interest ─────────────────────
--   p_seq = 0  → a part of the purchase's down payment (see the header).
--   p_seq = n  → instalment n, as R-1864, plus: interest above the schedule's (principal = the
--                schedule's) is broken-period / extra interest; a paid-by-hand EMI can be replaced
--                by a bigger line when the extra is said to be interest (p_interest) or a charge.
create or replace function public.reconcile_bank_debit_to_emi(
  p_txn_id uuid, p_purchase_id uuid, p_seq integer,
  p_principal integer default null, p_interest integer default null, p_charges integer default 0,
  p_new_schedule jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('reconcile an EMI');
  v_txn     public.bank_transactions;
  v_p       public.emi_purchases;
  v_row     public.emi_schedule;
  v_pay     public.emi_payments;
  v_old     public.bank_transactions;
  v_eq      public.owner_equity_movements;
  v_next    integer;
  v_out     integer;
  v_prin    integer;
  v_int     integer;
  v_chg     integer := greatest(coalesce(p_charges, 0), 0);
  v_before  jsonb;
  v_pay_id  uuid;
  v_extra   integer := 0;
  v_rest    integer;
  v_how     text;
  v_exp     text;
  v_taken   jsonb;
begin
  v_txn := public.emi_lock_debit_line(v_tenant, p_txn_id);
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;

  -- Down payment — R-2523: the line is ONE part of it. Where it was taken from is kept on the
  -- purchase (down_taken_from) so un-reconciling gives it back to exactly that part.
  if coalesce(p_seq, 0) = 0 then
    if coalesce(v_p.kind, 'asset') <> 'asset' then raise exception 'A loan with no asset has no down payment'; end if;
    -- R-2529: every part this changes is checked against the books lock by its own date, for
    -- every caller (owner_equity_movements has no lock trigger; service_role skips the bank one).
    perform public.emi_down_assert_open(v_tenant, v_txn.txn_date, 'this bank line');
    -- a. A manual part of the same amount (same account first): this line takes its place (R-1864).
    select * into v_old from public.bank_transactions
     where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
       and debit = v_txn.debit and id is distinct from v_p.received_bank_txn_id
     order by (bank_account_id = v_txn.bank_account_id) desc, txn_date, id limit 1 for update;
    if found then
      perform public.emi_down_assert_open(v_tenant, v_old.txn_date, 'the down-payment part it replaces');  -- R-2529
      delete from public.bank_transactions where id = v_old.id;
      v_how := 'replaced';
      v_taken := jsonb_build_object('kind', 'replaced_line', 'account_id', v_old.bank_account_id, 'date', v_old.txn_date);
    else
      select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;
      if v_eq.id is not null and v_eq.amount = v_txn.debit then
        -- b. The owner part of the same amount (the bank shows it left the company's account) …
        perform public.emi_down_assert_open(v_tenant, v_eq.movement_date, 'the owner''s part of the down payment');  -- R-2529
        perform set_config('app.r2395_down_move', 'on', true);
        delete from public.owner_equity_movements where id = v_eq.id;
        perform set_config('app.r2395_down_move', '', true);
        v_how := 'owner_replaced';
        v_taken := jsonb_build_object('kind', 'replaced_owner', 'date', v_eq.movement_date, 'partner', v_eq.partner_name, 'note', v_eq.note);
      else
        -- c. Smaller: taken out of a manual part (same account first, else the biggest) …
        select * into v_old from public.bank_transactions
         where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
           and debit > v_txn.debit and id is distinct from v_p.received_bank_txn_id
         order by (bank_account_id = v_txn.bank_account_id) desc, debit desc, txn_date, id limit 1 for update;
        if found then
          perform public.emi_down_assert_open(v_tenant, v_old.txn_date, 'the down-payment part it comes out of');  -- R-2529
          update public.bank_transactions set debit = debit - v_txn.debit, updated_at = now() where id = v_old.id;
          v_how := 'part_of_manual';
          -- R-2529: account + date + amount too, so un-reconcile can make the part again on the
          -- SAME account and date when this manual line is gone by then.
          v_taken := jsonb_build_object('kind', 'line', 'line_id', v_old.id, 'account_id', v_old.bank_account_id,
                                        'date', v_old.txn_date);
        elsif v_eq.id is not null and v_eq.amount > v_txn.debit then
          -- … or out of the owner part.
          perform public.emi_down_assert_open(v_tenant, v_eq.movement_date, 'the owner''s part of the down payment');  -- R-2529
          update public.owner_equity_movements set amount = amount - v_txn.debit where id = v_eq.id;
          v_how := 'part_of_owner';
          v_taken := jsonb_build_object('kind', 'owner', 'date', v_eq.movement_date, 'partner', v_eq.partner_name, 'note', v_eq.note);
        else
          select coalesce(sum(debit), 0)::integer into v_rest from public.bank_transactions
           where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
             and id is distinct from v_p.received_bank_txn_id;
          v_rest := v_rest + coalesce(v_eq.amount, 0);
          if v_rest = 0 then
            raise exception 'The down payment of % is already matched to bank lines in full — if this line is part of it, un-reconcile the wrong line in Banking first, or change the parts with "Split across sources" on Assets & EMIs', v_p.name;
          end if;
          raise exception 'This line is ₹% but no part of the down payment of % still recorded by hand is that big (₹% left in all) — change the parts with "Split across sources" on Assets & EMIs',
            v_txn.debit, v_p.name, v_rest;
        end if;
      end if;
    end if;
    perform public.emi_mark_line(v_txn.id, v_p.id);
    update public.emi_purchases set down_taken_from = down_taken_from || jsonb_build_object(v_txn.id::text, v_taken) where id = v_p.id;
    perform public.emi_down_set_primary(v_p.id);
    return jsonb_build_object('kind', 'down_payment', 'purchase_id', v_p.id, 'amount', v_txn.debit, 'how', v_how,
                              'replaced_line', case when v_how = 'replaced' then v_old.id end,
                              'from_line', case when v_how = 'part_of_manual' then v_old.id end);
  end if;

  select * into v_row from public.emi_schedule where purchase_id = v_p.id and seq = p_seq for update;
  if not found then raise exception 'EMI % is not in this loan''s schedule', p_seq; end if;

  -- Paid by hand earlier → this statement line replaces its manual line.
  if v_row.emi_payment_id is not null then
    select * into v_pay from public.emi_payments where id = v_row.emi_payment_id for update;
    select * into v_old from public.bank_transactions where id = v_pay.bank_txn_id;
    if not found or v_old.source <> 'manual' then raise exception 'EMI % is already paid and matched to a bank line', p_seq; end if;
    -- R-2529: the manual line goes and the payment moves to this line's date — both dates must be open.
    perform public.emi_down_assert_open(v_tenant, v_old.txn_date, 'the EMI ' || p_seq || ' paid by hand');
    perform public.emi_down_assert_open(v_tenant, v_txn.txn_date, 'this bank line');
    if v_pay.amount <> v_txn.debit then
      -- R-2523: a bigger line — the extra is interest (broken period) or a late fee, principal unchanged.
      if v_txn.debit < v_pay.amount or v_pay.kind <> 'emi'
         or (p_principal is not null and p_principal <> v_pay.principal_part) then
        raise exception 'EMI % was paid as ₹% but this line is ₹%', p_seq, v_pay.amount, v_txn.debit;
      end if;
      v_extra := v_txn.debit - v_pay.amount;
      if p_interest is not null and p_interest = v_pay.interest_part + v_extra and v_chg = 0 then
        v_how := 'interest';
      elsif p_interest is null or p_interest = v_pay.interest_part then
        if v_chg <> v_extra then
          raise exception 'EMI % was paid as ₹% but this line is ₹% — say what the extra ₹% is: broken-period / extra interest, or a late fee / bounce charge',
            p_seq, v_pay.amount, v_txn.debit, v_extra;
        end if;
        v_how := 'charges';
      else
        raise exception 'EMI % was paid as ₹% but this line is ₹% — the extra ₹% is interest ₹% or a charge, not both',
          p_seq, v_pay.amount, v_txn.debit, v_extra, v_pay.interest_part + v_extra;
      end if;

      if v_how = 'interest' and v_extra > greatest(2000, v_pay.amount / 10) then
        -- R-2529: the same limit the bank page offers (emi_matches_for_bank_txn).
        raise exception 'The extra ₹% is more than ₹% (₹2,000 or 10%% of the EMI, whichever is bigger) — it cannot be broken-period interest. Say it is a late fee / bounce charge, or reconcile the line another way',
          public.emi_inr(v_extra), public.emi_inr(greatest(2000, v_pay.amount / 10));
      end if;
      if v_how = 'interest' then
        if v_pay.expense_id is not null then
          update public.expenses
             set amount = amount + v_extra, expense_date = v_txn.txn_date,
                 description = description || ' (incl. ₹' || public.emi_inr(v_extra) || ' broken-period / extra interest)'
           where id = v_pay.expense_id;
        else
          v_exp := public.emi_new_expense_id();
          insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
          values (v_exp, v_tenant, 'Interest', coalesce(v_p.lender, v_p.name), v_txn.txn_date, v_extra, 0, 'emi',
                  'Interest on loan — ' || v_p.name || ' · EMI ' || p_seq || ' (₹' || public.emi_inr(v_extra) || ' broken-period / extra interest)', 'none');
          update public.emi_payments set expense_id = v_exp where id = v_pay.id;
        end if;
        update public.emi_payments set amount = amount + v_extra, interest_part = interest_part + v_extra where id = v_pay.id;
        update public.emi_schedule set interest = interest + v_extra, emi = emi + v_extra where id = v_row.id;
      else
        if v_pay.charges_expense_id is not null then
          update public.expenses set amount = amount + v_extra, expense_date = v_txn.txn_date where id = v_pay.charges_expense_id;
        else
          v_exp := public.emi_new_expense_id();
          insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
          values (v_exp, v_tenant, 'Bank Charges', coalesce(v_p.lender, v_p.name), v_txn.txn_date, v_extra, 0, 'emi',
                  'EMI late fee / bounce charge — ' || v_p.name, 'none');
          update public.emi_payments set charges_expense_id = v_exp where id = v_pay.id;
        end if;
        update public.emi_payments set amount = amount + v_extra, charges = charges + v_extra where id = v_pay.id;
      end if;
      select * into v_pay from public.emi_payments where id = v_pay.id;
    end if;
    update public.emi_payments set bank_txn_id = v_txn.id, bank_account_id = v_txn.bank_account_id, paid_on = v_txn.txn_date
     where id = v_pay.id;
    delete from public.bank_transactions where id = v_old.id;
    perform public.emi_mark_line(v_txn.id, v_pay.id);
    return jsonb_build_object('kind', 'emi', 'payment_id', v_pay.id, 'seq', p_seq, 'amount', v_txn.debit,
                              'principal', v_pay.principal_part, 'interest', v_pay.interest_part, 'charges', v_pay.charges,
                              'extra_interest', case when v_how = 'interest' then v_extra else 0 end,
                              'replaced_line', v_old.id);
  end if;

  if v_p.status <> 'active' then raise exception 'This loan is already closed'; end if;
  select min(seq) into v_next from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
  if v_next is distinct from p_seq then
    raise exception 'Pay EMI % first — instalments are paid in order', v_next;
  end if;

  v_int  := coalesce(p_interest, least(v_row.interest, v_txn.debit - v_chg));
  v_prin := coalesce(p_principal, v_txn.debit - v_chg - v_int);
  if v_int < 0 or v_prin < 0 then raise exception 'The split cannot be negative'; end if;
  if v_prin + v_int + v_chg <> v_txn.debit then
    raise exception 'Principal ₹% + interest ₹% + charges ₹% is not the line''s ₹%', v_prin, v_int, v_chg, v_txn.debit;
  end if;
  if v_int > v_row.interest then
    -- R-2523: broken-period / extra interest — only on top of the scheduled principal.
    if v_prin <> v_row.principal then
      raise exception 'Extra interest goes on top of the scheduled EMI — principal must stay ₹% for EMI %', v_row.principal, p_seq;
    end if;
    v_extra := v_int - v_row.interest;
    if v_extra > greatest(2000, v_row.emi / 10) then
      -- R-2529: the same limit the bank page offers (emi_matches_for_bank_txn).
      raise exception 'The extra ₹% is more than ₹% (₹2,000 or 10%% of EMI %, whichever is bigger) — it cannot be broken-period interest. Say it is a late fee / bounce charge or extra paid toward the loan',
        public.emi_inr(v_extra), public.emi_inr(greatest(2000, v_row.emi / 10)), p_seq;
    end if;
  elsif v_int <> least(v_row.interest, v_txn.debit - v_chg) then
    raise exception 'Interest for EMI % is ₹% per the schedule', p_seq, v_row.interest;
  end if;
  v_out := public.emi_outstanding(v_p.id);
  if v_prin > v_out then raise exception 'Principal ₹% is more than the ₹% still owed', v_prin, v_out; end if;

  v_before := public.emi_unpaid_rows(v_p.id, p_seq);
  if v_prin <> v_row.principal then
    if p_new_schedule is null then
      raise exception 'This line is not the scheduled EMI — send the recomputed schedule for the rest';
    end if;
    -- The rest keeps its due dates (an overdue one stays overdue): only "not before this EMI".
    perform public.emi_replace_unpaid_schedule(v_tenant, v_p.id, p_seq + 1, v_out - v_prin, p_new_schedule,
                                               v_p.no_cost, v_row.due_on);
  end if;

  v_pay_id := public.emi_post_payment(v_tenant, v_p, v_txn, p_seq, v_prin, v_int, v_chg, 'emi', v_before);
  if v_extra > 0 then
    update public.expenses e
       set description = e.description || ' (incl. ₹' || public.emi_inr(v_extra) || ' broken-period / extra interest)'
      from public.emi_payments ep
     where ep.id = v_pay_id and e.id = ep.expense_id;
  end if;
  update public.emi_schedule
     set emi_payment_id = v_pay_id, principal = v_prin, interest = v_int, emi = v_prin + v_int,
         balance_after = v_out - v_prin
   where id = v_row.id;
  perform public.emi_mark_line(v_txn.id, v_pay_id);

  if v_out - v_prin = 0 then
    delete from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
    update public.emi_purchases set status = 'closed', updated_at = now() where id = v_p.id;
  end if;

  return jsonb_build_object('kind', 'emi', 'payment_id', v_pay_id, 'seq', p_seq, 'amount', v_txn.debit,
                            'principal', v_prin, 'interest', v_int, 'charges', v_chg, 'extra_interest', v_extra,
                            'outstanding', v_out - v_prin);
end;
$$;
revoke all on function public.reconcile_bank_debit_to_emi(uuid, uuid, integer, integer, integer, integer, jsonb) from public, anon;
grant execute on function public.reconcile_bank_debit_to_emi(uuid, uuid, integer, integer, integer, integer, jsonb) to authenticated, service_role;

-- ── 3. Un-reconciling an EMI line — R-2341 body; a down-payment PART goes back ──────────────
create or replace function public.tg_emi_line_unmatched() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pay  public.emi_payments;
  v_p    public.emi_purchases;
  v_new  public.bank_transactions;
  v_line public.bank_transactions;
  v_eq   public.owner_equity_movements;
  v_acc  public.bank_accounts;
  v_t    jsonb;
  v_n    integer;
  v_date date;
begin
  if old.matched_to_type = 'emi'
     and (new.matched_to_type is distinct from 'emi' or new.matched_to_id is distinct from old.matched_to_id) then
    if old.source = 'manual' then
      raise exception 'This line was made by an EMI entry — undo it on Assets & EMIs instead';
    end if;
    select * into v_pay from public.emi_payments where bank_txn_id = old.id;
    if found then
      perform public.emi_undo_payment_core(v_pay);
      return null;
    end if;
    -- R-2523: a part of an asset's down payment (the line is matched to the purchase itself).
    select * into v_p from public.emi_purchases
     where tenant_id = old.tenant_id and coalesce(kind, 'asset') = 'asset'
       and id = case when old.matched_to_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then old.matched_to_id::uuid end
       and received_bank_txn_id is distinct from old.id
     for update;
    if found then
      -- The amount goes back to the part it was taken out of (down_taken_from), so the parts
      -- still add up and every account is as before the reconcile. A line with no record (matched
      -- before R-2523, or kept through a split): a manual part on the same account, else (R-1864)
      -- a manual line on this account — the money did leave from here.
      v_t := v_p.down_taken_from -> old.id::text;
      update public.emi_purchases set down_taken_from = down_taken_from - old.id::text where id = v_p.id;
      -- R-2529: every part this changes or makes is checked against the books lock by its own
      -- date, for every caller (emi_down_assert_open).
      if v_t ->> 'kind' = 'line' then
        select * into v_line from public.bank_transactions
         where id = (v_t ->> 'line_id')::uuid and tenant_id = old.tenant_id and source = 'manual'
           and matched_to_type = 'emi' and matched_to_id = old.matched_to_id
         for update;
        if v_line.id is null and v_t ? 'account_id' then
          -- R-2529: the part it was taken out of is gone (an equal statement line replaced it) →
          -- make the part again on ITS account and date, not on this line's account (that would
          -- show the outflow twice there).
          select * into v_acc from public.bank_accounts where id = (v_t ->> 'account_id')::uuid and tenant_id = old.tenant_id;
          if v_acc.id is not null then
            v_date := coalesce((v_t ->> 'date')::date, old.txn_date);
            perform public.emi_down_assert_open(old.tenant_id, v_date, 'the down-payment part it goes back to');
            v_new := public.emi_manual_line(v_p.tenant_id, v_acc.id, v_date, old.debit,
                       'Down payment: ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
            perform public.emi_mark_line(v_new.id, v_p.id);
            perform public.emi_down_set_primary(v_p.id);
            return null;
          end if;
        end if;
      elsif v_t ->> 'kind' in ('owner', 'replaced_owner') then
        select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;
        if v_eq.id is not null then
          perform public.emi_down_assert_open(old.tenant_id, v_eq.movement_date, 'the owner''s part of the down payment');
          update public.owner_equity_movements set amount = amount + old.debit where id = v_eq.id;
        else
          v_date := coalesce((v_t ->> 'date')::date, v_p.purchased_on);
          perform public.emi_down_assert_open(old.tenant_id, v_date, 'the owner''s part of the down payment');
          insert into public.owner_equity_movements
            (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by, emi_purchase_id)
          values
            (gen_random_uuid(), v_p.tenant_id, 'capital_introduced', v_date, old.debit,
             null, null, false, v_t ->> 'partner',
             left(coalesce(v_t ->> 'note', 'Down payment paid by owner: ' || v_p.name || coalesce(' (' || v_p.lender || ')', '')), 1000),
             auth.uid(), v_p.id);
        end if;
        perform public.emi_down_set_primary(v_p.id);
        return null;
      elsif v_t ->> 'kind' = 'replaced_line' then
        select * into v_acc from public.bank_accounts where id = (v_t ->> 'account_id')::uuid and tenant_id = old.tenant_id;
        if v_acc.id is not null then
          v_date := coalesce((v_t ->> 'date')::date, old.txn_date);
          perform public.emi_down_assert_open(old.tenant_id, v_date, 'the down-payment part it goes back to');
          v_new := public.emi_manual_line(v_p.tenant_id, v_acc.id, v_date, old.debit,
                     'Down payment: ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
          perform public.emi_mark_line(v_new.id, v_p.id);
          perform public.emi_down_set_primary(v_p.id);
          return null;
        end if;
      end if;
      if v_line.id is null then
        select * into v_line from public.bank_transactions
         where tenant_id = old.tenant_id and matched_to_type = 'emi' and matched_to_id = old.matched_to_id
           and source = 'manual' and bank_account_id = old.bank_account_id
         order by txn_date, id limit 1 for update;
      end if;
      if v_line.id is not null then
        perform public.emi_down_assert_open(old.tenant_id, v_line.txn_date, 'the down-payment part it goes back to');  -- R-2529
        update public.bank_transactions set debit = debit + old.debit, updated_at = now() where id = v_line.id;
      else
        perform public.emi_down_assert_open(old.tenant_id, old.txn_date, 'the down-payment part it goes back to');  -- R-2529
        v_new := public.emi_manual_line(v_p.tenant_id, old.bank_account_id, old.txn_date, old.debit,
                   'Down payment: ' || v_p.name || ' (' || coalesce(v_p.lender, '') || ')');
        perform public.emi_mark_line(v_new.id, v_p.id);
      end if;
      perform public.emi_down_set_primary(v_p.id);
      return null;
    end if;
    -- R-2341: the statement's money-in line of a loan set up from an EMI line → remove that loan.
    select * into v_p from public.emi_purchases where received_bank_txn_id = old.id and kind = 'loan' for update;
    if found then
      select count(*) into v_n from public.emi_payments where purchase_id = v_p.id;
      if v_n > 0 then
        raise exception 'This line is the money of the loan from % and % EMI(s) of it are reconciled — undo those EMIs first, then un-reconcile this line',
          coalesce(v_p.lender, 'the lender'), v_n;
      end if;
      delete from public.emi_purchases where id = v_p.id;  -- its schedule goes with it (on delete cascade)
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_emi_line_unmatched() from public, anon, authenticated;

-- ── 4. Which EMI could this money-out line be? — R-1864 body + down-payment parts ───────────
create or replace function public.emi_matches_for_bank_txn(p_txn_id uuid)
returns table (purchase_id uuid, purchase_name text, lender text, seq integer, due_on date, kind text,
               expected integer, principal integer, interest integer, difference integer, confidence text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('reconcile an EMI');
  v_txn    public.bank_transactions;
  v_text   text;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found or coalesce(v_txn.debit, 0) <= 0 then return; end if;
  v_text := upper(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.reference, ''));

  return query
  with cand as (
    -- next unpaid instalment of each active loan
    select p.id as pid, p.name, p.lender as lname, p.lender_ref, s.seq, s.due_on, 'instalment'::text as kind,
           s.emi as expected, s.principal, s.interest, true as whole
      from public.emi_purchases p
      join lateral (select * from public.emi_schedule s2
                     where s2.purchase_id = p.id and s2.emi_payment_id is null order by s2.seq limit 1) s on true
     where p.tenant_id = v_tenant and p.status = 'active'
    union all
    -- instalments paid by hand (their manual line can be replaced)
    select p.id, p.name, p.lender, p.lender_ref, s.seq, s.due_on, 'paid_by_hand', ep.amount, ep.principal_part, ep.interest_part, true
      from public.emi_purchases p
      join public.emi_schedule s on s.purchase_id = p.id
      join public.emi_payments ep on ep.id = s.emi_payment_id
      join public.bank_transactions bt on bt.id = ep.bank_txn_id and bt.source = 'manual'
     where p.tenant_id = v_tenant
    union all
    -- R-2523: the down payment still off the statement, one row per purchase: the line's own
    -- amount when a manual / owner part has it, else the part this line would be taken out of
    -- (the same choice reconcile_bank_debit_to_emi makes: same account first, then the biggest
    -- manual part, then the owner part). "whole" = the down payment is ONE manual line of this
    -- amount (R-1864) — only then can it be sure enough for auto-reconcile.
    select p.id, p.name, p.lender, p.lender_ref, 0, p.purchased_on, 'down_payment',
           coalesce(r.same, r.part), 0, 0, (r.same is not null and r.manual_same and r.n_parts = 1)
      from public.emi_purchases p
      cross join lateral (
        select
          (select count(*) from public.bank_transactions bt
            where bt.tenant_id = v_tenant and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
              and bt.id is distinct from p.received_bank_txn_id)
          + (select count(*) from public.owner_equity_movements m where m.emi_purchase_id = p.id) as n_parts,
          exists (select 1 from public.bank_transactions bt
                   where bt.tenant_id = v_tenant and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
                     and bt.source = 'manual' and bt.debit = v_txn.debit and bt.id is distinct from p.received_bank_txn_id) as manual_same,
          case when exists (select 1 from public.bank_transactions bt
                             where bt.tenant_id = v_tenant and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
                               and bt.source = 'manual' and bt.debit = v_txn.debit and bt.id is distinct from p.received_bank_txn_id)
                 or exists (select 1 from public.owner_equity_movements m where m.emi_purchase_id = p.id and m.amount = v_txn.debit)
               then v_txn.debit::integer end as same,
          coalesce(
            (select bt.debit::integer from public.bank_transactions bt
              where bt.tenant_id = v_tenant and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
                and bt.source = 'manual' and bt.debit > v_txn.debit and bt.id is distinct from p.received_bank_txn_id
              order by (bt.bank_account_id = v_txn.bank_account_id) desc, bt.debit desc, bt.txn_date, bt.id limit 1),
            (select m.amount from public.owner_equity_movements m where m.emi_purchase_id = p.id and m.amount > v_txn.debit)) as part
      ) r
     where p.tenant_id = v_tenant and coalesce(p.kind, 'asset') = 'asset' and coalesce(r.same, r.part) is not null
       and v_txn.txn_date between p.purchased_on - 90 and p.purchased_on + 10  -- R-2529: the window, before the scans
  ), scored as (
    select c.*,
           v_txn.debit - c.expected as diff,
           abs(v_txn.txn_date - c.due_on) <= 10 as near,
           ( (c.lname is not null and length(split_part(trim(c.lname), ' ', 1)) >= 3
                and position(upper(split_part(trim(c.lname), ' ', 1)) in v_text) > 0)
             or (c.lender_ref is not null and position(upper(c.lender_ref) in v_text) > 0)
             or v_text ~ '(^|[^A-Z])(EMI|LOAN|NACH|ECS)([^A-Z]|$)' ) as named,
           -- R-2523: the narration names the item as a whole word ("THAR ADVANCE" for "Thar Roxx";
           -- "CARD" does not name "Car …").
           (split_part(trim(c.name), ' ', 1) ~ '^[A-Za-z0-9]{3,}$'
              and v_text ~ ('(^|[^A-Z0-9])' || upper(split_part(trim(c.name), ' ', 1)) || '([^A-Z0-9]|$)')) as item_named
      from cand c
  )
  select s.pid, s.name, s.lname, s.seq, s.due_on, s.kind, s.expected, s.principal, s.interest, s.diff,
         case when not s.whole then 'low'   -- R-2523: a part of a split down payment is never auto-reconciled
              when s.diff = 0 and s.near and s.named then 'exact'
              when s.diff = 0 and (s.near or s.named) then 'high'
              else 'low' end
    from scored s
   where (s.diff = 0 and s.kind <> 'down_payment')
      -- R-2529: a down-payment row of the line's amount needs the 90-days-before … 10-days-after
      -- window and the item named as a whole word (an equal part offered for any debit stopped
      -- the R-1867 vendor auto-match) — or, R-1864, be the ONE manual line of the down payment
      -- within 10 days of the purchase.
      or (s.kind = 'down_payment' and s.diff = 0
          and v_txn.txn_date between s.due_on - 90 and s.due_on + 10
          and (s.item_named or (s.whole and s.near)))
      or (s.kind = 'instalment' and s.diff > 0 and s.diff <= greatest(2000, s.expected / 10) and (s.near or s.named))
      or (s.kind = 'paid_by_hand' and s.diff > 0 and s.diff <= greatest(2000, s.expected / 10) and s.near and s.named)
      or (s.kind = 'instalment' and s.diff < 0 and -s.diff < s.expected / 2 and s.named)
      or (s.kind = 'down_payment' and s.diff < 0 and s.item_named
          and v_txn.txn_date between s.due_on - 90 and s.due_on + 10)
   order by case when s.diff = 0 and s.near and s.named then 0 when s.diff = 0 and (s.near or s.named) then 1 else 2 end,
            abs(s.diff), abs(v_txn.txn_date - s.due_on);
end;
$$;
revoke all on function public.emi_matches_for_bank_txn(uuid) from public, anon;
grant execute on function public.emi_matches_for_bank_txn(uuid) to authenticated, service_role;

commit;
