-- deploy-peek: to_regprocedure('public.set_emi_down_payment_parts(uuid,jsonb,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_to_emi(uuid,uuid,integer,integer,integer,integer,jsonb)') and prosrc like '%R-2523%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.emi_matches_for_bank_txn(uuid)') and prosrc like '%R-2523%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_emi_line_unmatched()') and prosrc like '%R-2523%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.change_emi_down_payment_source(uuid,uuid,boolean,text,text)') and prosrc like '%R-2523%')
-- deploy-key: r2523emidownpaymentsplit
-- 20261106091000_r2523_emi_down_payment_split.sql
--
-- R-2523 (6 Nov 2026, staging FY 25-26 import, fy-bank / R-2094): the Thar Roxx loan's ₹2,00,000
-- down payment was really paid as HDFC 4523 → Shiva Auto Cars ₹21,000 (2 Jan 2026) + ₹87,394
-- (30 Jan) + ₹19,700 (2 Feb) = ₹1,28,094, and ₹71,906 from Petty Cash. The app could only hold the
-- WHOLE down payment on ONE source (R-1864 / R-2395) and match it to ONE statement line of the
-- full amount. And the first EMI bank line (₹30,183) is ₹2,419 more than the scheduled EMI
-- (₹27,764) — broken-period interest — but the reconcile offered only "late fee" or "extra
-- principal".
--
-- ══ THE MODEL (no new table — R-1864's own) ═════════════════════════════════════════════════
--   A down payment = its PARTS: every bank line matched 'emi' to the purchase id (a 'manual' line
--   the app made on a bank / FD / Petty Cash account, or an imported statement line) + at most one
--   owner-capital row (owner_equity_movements.emi_purchase_id, R-2395). The parts add up to
--   down payment + processing fee (+ its GST). emi_purchases.down_bank_txn_id / down_account_id
--   keep pointing at ONE line — now the biggest part — for the screens that show one source.
--   Cash: each part is its own bank line on its own account, so the Balance Sheet (cash = sum of
--   lines, asset = register cost, loan = financed − principal paid) needs no change.
--
-- ══ WHAT CHANGES ════════════════════════════════════════════════════════════════════════════
--   1. reconcile_bank_debit_to_emi(seq 0) — a statement line is matched as ONE PART: a manual
--      (or owner) part of the same amount is replaced (R-1864 as before); a smaller line is taken
--      out of the biggest manual part (else the owner part). A line bigger than what is still
--      off the statement is refused, nothing written.
--   2. Un-reconciling such a line (trigger) gives its amount back: to a manual part on the same
--      account, else to the only other manual / owner part, else (R-1864) a manual line on the
--      line's own account — the money did leave from there. Re-reconciling takes it again.
--   3. set_emi_down_payment_parts(purchase, parts, note) — the whole split in ONE step from
--      Assets & EMIs: statement lines (used whole), account parts (bank / FD / Petty Cash, an
--      amount and a date) and one "paid by owner" part. Must add up; a statement part already
--      reconciled to it can only be dropped by un-reconciling it in Banking; accounts must be
--      open on the part's date; locked months refused for every caller; one activity_log row.
--   4. change_emi_down_payment_source (R-2395 body) refuses a split down payment (it moves ONE
--      source — use the split instead).
--   5. emi_matches_for_bank_txn — one down-payment row per purchase: exact when a manual / owner
--      part has the line's amount; a "part of the down payment" row (always LOW, never auto-
--      reconciled) when the line is smaller than what is left, its narration names the item
--      (first word, e.g. THAR) and it is dated 90 days before … 10 days after the purchase.
--      A paid-by-hand EMI is also offered for a slightly bigger line (late fee / extra interest).
--   6. EMI with an extra amount — "Broken-period / extra interest": p_interest = schedule
--      interest + the extra, principal = the schedule's. ONE 'Interest' expense (the same head as
--      EMI interest) whose text names the extra; principal, loan and the later schedule are not
--      touched. Also when the EMI was paid by hand: the bigger statement line replaces the manual
--      line and the extra becomes interest (or a late fee) on that payment. Undo as before.
--
-- Existing rows unchanged. §17c guard + money roles (emi_guard) on every entry point.
-- Proof: supabase/tests/r2523_emi_down_payment_split.test.sql (one rollback). R-1864 / R-2395 /
-- R-2341 tests unchanged.

begin;

-- ── 1. Internal helpers ─────────────────────────────────────────────────────────────────────
-- ₹ with Indian grouping, for messages and texts.
create or replace function public.emi_inr(p integer) returns text
language sql immutable set search_path = public as $$
  -- R-2523
  select case when p is null then null
              when abs(p) < 1000 then p::text
              else case when p < 0 then '-' else '' end
                   || regexp_replace((abs(p) / 1000)::text, '(\d)(?=(\d\d)+$)', '\1,', 'g')
                   || ',' || lpad((abs(p) % 1000)::text, 3, '0') end;
$$;
revoke all on function public.emi_inr(integer) from public, anon, authenticated;

-- Points emi_purchases.down_bank_txn_id / down_account_id at the biggest line part (or nothing).
create or replace function public.emi_down_set_primary(p_purchase uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_p public.emi_purchases; v_line public.bank_transactions;
begin
  -- R-2523
  select * into v_p from public.emi_purchases where id = p_purchase;
  if not found then return; end if;
  select * into v_line from public.bank_transactions
   where tenant_id = v_p.tenant_id and matched_to_type = 'emi' and matched_to_id = v_p.id::text
     and id is distinct from v_p.received_bank_txn_id
   order by debit desc, txn_date, id limit 1;
  update public.emi_purchases
     set down_bank_txn_id = v_line.id,
         down_account_id = case when v_line.id is not null then v_line.bank_account_id
                                when exists (select 1 from public.owner_equity_movements where emi_purchase_id = v_p.id) then null
                                else down_account_id end,
         updated_at = now()
   where id = v_p.id;
end;
$$;
revoke all on function public.emi_down_set_primary(uuid) from public, anon, authenticated;

-- The down payment's parts as jsonb (for activity_log before / after).
create or replace function public.emi_down_parts_json(p_purchase uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  -- R-2523
  select coalesce((select jsonb_agg(jsonb_build_object('kind', case when bt.source = 'manual' then 'account' else 'statement' end,
                                                       'line_id', bt.id, 'account_id', bt.bank_account_id,
                                                       'amount', bt.debit, 'date', bt.txn_date) order by bt.txn_date, bt.id)
                     from public.bank_transactions bt
                     join public.emi_purchases p on p.id = p_purchase
                    where bt.tenant_id = p.tenant_id and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
                      and bt.id is distinct from p.received_bank_txn_id), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('kind', 'owner', 'equity_id', m.id, 'partner', m.partner_name,
                                                       'amount', m.amount, 'date', m.movement_date))
                     from public.owner_equity_movements m where m.emi_purchase_id = p_purchase), '[]'::jsonb);
$$;
revoke all on function public.emi_down_parts_json(uuid) from public, anon, authenticated;

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
begin
  v_txn := public.emi_lock_debit_line(v_tenant, p_txn_id);
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;

  -- Down payment — R-2523: the line is ONE part of it.
  if coalesce(p_seq, 0) = 0 then
    if coalesce(v_p.kind, 'asset') <> 'asset' then raise exception 'A loan with no asset has no down payment'; end if;
    -- a. A manual part of the same amount: this line takes its place (R-1864).
    select * into v_old from public.bank_transactions
     where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
       and debit = v_txn.debit and id is distinct from v_p.received_bank_txn_id
     order by txn_date, id limit 1 for update;
    if found then
      delete from public.bank_transactions where id = v_old.id;
      v_how := 'replaced';
    else
      select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;
      if v_eq.id is not null and v_eq.amount = v_txn.debit then
        -- b. The owner part of the same amount (it really left the company's bank).
        perform set_config('app.r2395_down_move', 'on', true);
        delete from public.owner_equity_movements where id = v_eq.id;
        perform set_config('app.r2395_down_move', '', true);
        v_how := 'owner_replaced';
      else
        -- c. Smaller: taken out of the biggest manual part, else the owner part.
        select * into v_old from public.bank_transactions
         where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
           and debit > v_txn.debit and id is distinct from v_p.received_bank_txn_id
         order by debit desc, txn_date, id limit 1 for update;
        if found then
          update public.bank_transactions set debit = debit - v_txn.debit, updated_at = now() where id = v_old.id;
          v_how := 'part_of_manual';
        elsif v_eq.id is not null and v_eq.amount > v_txn.debit then
          update public.owner_equity_movements set amount = amount - v_txn.debit where id = v_eq.id;
          v_how := 'part_of_owner';
        else
          select coalesce(sum(debit), 0)::integer into v_rest from public.bank_transactions
           where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
             and id is distinct from v_p.received_bank_txn_id;
          v_rest := v_rest + coalesce(v_eq.amount, 0);
          if v_rest = 0 then
            raise exception 'The down payment of % is already matched to bank lines in full', v_p.name;
          end if;
          raise exception 'This line is ₹% but only ₹% of the down payment of % is not matched to the bank yet — split the down payment on Assets & EMIs if this line pays more of it',
            v_txn.debit, v_rest, v_p.name;
        end if;
      end if;
    end if;
    perform public.emi_mark_line(v_txn.id, v_p.id);
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
  v_n    integer;
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
      -- The amount goes back to the part it most likely came from, so the parts still add up:
      -- a manual part on the same account → the only other manual / owner part → (R-1864) a
      -- manual line on this account (the money did leave from here).
      select * into v_line from public.bank_transactions
       where tenant_id = old.tenant_id and matched_to_type = 'emi' and matched_to_id = old.matched_to_id
         and source = 'manual' and bank_account_id = old.bank_account_id
       order by txn_date, id limit 1 for update;
      if v_line.id is null then
        select count(*) into v_n from public.bank_transactions
         where tenant_id = old.tenant_id and matched_to_type = 'emi' and matched_to_id = old.matched_to_id and source = 'manual';
        select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;
        if v_n = 1 and v_eq.id is null then
          select * into v_line from public.bank_transactions
           where tenant_id = old.tenant_id and matched_to_type = 'emi' and matched_to_id = old.matched_to_id and source = 'manual'
           for update;
        elsif v_n = 0 and v_eq.id is not null then
          update public.owner_equity_movements set amount = amount + old.debit where id = v_eq.id;
          perform public.emi_down_set_primary(v_p.id);
          return null;
        end if;
      end if;
      if v_line.id is not null then
        update public.bank_transactions set debit = debit + old.debit, updated_at = now() where id = v_line.id;
      else
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
           s.emi as expected, s.principal, s.interest
      from public.emi_purchases p
      join lateral (select * from public.emi_schedule s2
                     where s2.purchase_id = p.id and s2.emi_payment_id is null order by s2.seq limit 1) s on true
     where p.tenant_id = v_tenant and p.status = 'active'
    union all
    -- instalments paid by hand (their manual line can be replaced)
    select p.id, p.name, p.lender, p.lender_ref, s.seq, s.due_on, 'paid_by_hand', ep.amount, ep.principal_part, ep.interest_part
      from public.emi_purchases p
      join public.emi_schedule s on s.purchase_id = p.id
      join public.emi_payments ep on ep.id = s.emi_payment_id
      join public.bank_transactions bt on bt.id = ep.bank_txn_id and bt.source = 'manual'
     where p.tenant_id = v_tenant
    union all
    -- R-2523: the down payment still off the statement (manual parts + owner part), one row per
    -- purchase: the line's own amount when a part has it, else what is left (a part of it).
    select p.id, p.name, p.lender, p.lender_ref, 0, p.purchased_on, 'down_payment',
           case when r.exact then v_txn.debit::integer else r.rest end, 0, 0
      from public.emi_purchases p
      cross join lateral (
        select (coalesce(sum(bt.debit), 0)
                + coalesce((select m.amount from public.owner_equity_movements m where m.emi_purchase_id = p.id), 0))::integer as rest,
               (coalesce(bool_or(bt.debit = v_txn.debit), false)
                or exists (select 1 from public.owner_equity_movements m where m.emi_purchase_id = p.id and m.amount = v_txn.debit)) as exact
          from public.bank_transactions bt
         where bt.tenant_id = v_tenant and bt.matched_to_type = 'emi' and bt.matched_to_id = p.id::text
           and bt.source = 'manual' and bt.id is distinct from p.received_bank_txn_id
      ) r
     where p.tenant_id = v_tenant and coalesce(p.kind, 'asset') = 'asset' and r.rest > 0
  ), scored as (
    select c.*,
           v_txn.debit - c.expected as diff,
           abs(v_txn.txn_date - c.due_on) <= 10 as near,
           ( (c.lname is not null and length(split_part(trim(c.lname), ' ', 1)) >= 3
                and position(upper(split_part(trim(c.lname), ' ', 1)) in v_text) > 0)
             or (c.lender_ref is not null and position(upper(c.lender_ref) in v_text) > 0)
             or v_text ~ '(^|[^A-Z])(EMI|LOAN|NACH|ECS)([^A-Z]|$)' ) as named,
           -- R-2523: the narration names the item ("THAR ADVANCE" for "Thar Roxx").
           (length(split_part(trim(c.name), ' ', 1)) >= 3
              and position(upper(split_part(trim(c.name), ' ', 1)) in v_text) > 0) as item_named
      from cand c
  )
  select s.pid, s.name, s.lname, s.seq, s.due_on, s.kind, s.expected, s.principal, s.interest, s.diff,
         case when s.diff = 0 and s.near and s.named then 'exact'
              when s.diff = 0 and (s.near or s.named) then 'high'
              else 'low' end
    from scored s
   where s.diff = 0
      or (s.kind in ('instalment', 'paid_by_hand') and s.diff > 0 and s.diff <= greatest(2000, s.expected / 10) and (s.near or s.named))
      or (s.kind = 'instalment' and s.diff < 0 and -s.diff < s.expected / 2 and s.named)
      or (s.kind = 'down_payment' and s.diff < 0 and s.item_named
          and v_txn.txn_date between s.due_on - 90 and s.due_on + 10)
   order by case when s.diff = 0 and s.near and s.named then 0 when s.diff = 0 and (s.near or s.named) then 1 else 2 end,
            abs(s.diff), abs(v_txn.txn_date - s.due_on);
end;
$$;
revoke all on function public.emi_matches_for_bank_txn(uuid) from public, anon;
grant execute on function public.emi_matches_for_bank_txn(uuid) to authenticated, service_role;

-- ── 5. The whole split in one step ──────────────────────────────────────────────────────────
create or replace function public.set_emi_down_payment_parts(
  p_purchase_id uuid,
  p_parts       jsonb,
  p_note        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('split a down payment');
  v_p       public.emi_purchases;
  v_total   integer;
  v_n       integer := coalesce(jsonb_array_length(case when jsonb_typeof(p_parts) = 'array' then p_parts end), 0);
  v_i       integer;
  v_x       jsonb;
  v_line    public.bank_transactions;
  v_acc     public.bank_accounts;
  v_ids     uuid[] := '{}';
  v_sum     bigint := 0;
  v_owner   integer := 0;
  v_amt     integer;
  v_date    date;
  v_lock    date;
  v_before  jsonb;
  v_after   jsonb;
  v_has_acc boolean := false;
begin
  -- R-2523
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;
  if coalesce(v_p.kind, 'asset') <> 'asset' then raise exception 'A loan with no asset has no down payment'; end if;
  v_total := coalesce(v_p.down_payment, 0) + coalesce(v_p.processing_fee, 0) + coalesce(v_p.processing_fee_gst, 0);
  if v_total <= 0 then raise exception 'This purchase has no down payment'; end if;
  if v_n = 0 then raise exception 'Add at least one part: where the down payment was paid from'; end if;
  if v_n > 12 then raise exception 'A down payment can have at most 12 parts'; end if;
  select books_locked_until into v_lock from public.tenants where id = v_tenant;

  -- Check every part first: nothing is written until all are right.
  for v_i in 0 .. v_n - 1 loop
    v_x := p_parts -> v_i;
    if jsonb_typeof(v_x) <> 'object' then raise exception 'Part % is not readable', v_i + 1; end if;
    if nullif(v_x ->> 'amount', '') is not null and (v_x ->> 'amount') !~ '^\d{1,9}$' then
      raise exception 'Part %: enter the amount in whole rupees', v_i + 1;
    end if;
    v_amt  := nullif(v_x ->> 'amount', '')::bigint;
    v_date := coalesce(nullif(v_x ->> 'date', '')::date, v_p.purchased_on);
    if nullif(v_x ->> 'bank_txn_id', '') is not null then
      select * into v_line from public.bank_transactions where id = (v_x ->> 'bank_txn_id')::uuid for update;
      if not found or v_line.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company'; end if;
      if v_line.id = any (v_ids) then raise exception 'The same bank line is in the list twice'; end if;
      if v_line.source = 'manual' then
        raise exception 'Part %: pick a line from the bank statement, or an account with an amount', v_i + 1;
      end if;
      if v_line.matched_to_type is not null
         and not (v_line.matched_to_type = 'emi' and v_line.matched_to_id = v_p.id::text) then
        raise exception 'The ₹% line of % is already reconciled to something else', v_line.debit, to_char(v_line.txn_date, 'DD Mon YYYY');
      end if;
      if coalesce(v_line.debit, 0) <= 0 then raise exception 'Only a money-out line can pay a down payment'; end if;
      if v_amt is not null and v_amt <> v_line.debit then
        raise exception 'The line of % is ₹% — a statement line is used whole', to_char(v_line.txn_date, 'DD Mon YYYY'), v_line.debit;
      end if;
      if v_lock is not null and v_line.txn_date <= v_lock and v_line.matched_to_type is null then
        raise exception 'Books are locked up to % — the line of % is in a closed month.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_line.txn_date, 'DD Mon YYYY')
          using errcode = 'check_violation';
      end if;
      v_ids := v_ids || v_line.id;
      v_sum := v_sum + v_line.debit;
    else
      if v_amt is null or v_amt <= 0 then raise exception 'Part %: enter the amount', v_i + 1; end if;
      if v_lock is not null and v_date <= v_lock then
        raise exception 'Books are locked up to % — a part dated % is in a closed month.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_date, 'DD Mon YYYY')
          using errcode = 'check_violation';
      end if;
      if coalesce((v_x ->> 'paid_by_owner')::boolean, false) then
        if nullif(v_x ->> 'account_id', '') is not null then raise exception 'Part %: pick either an account or Paid by owner — not both', v_i + 1; end if;
        v_owner := v_owner + 1;
        if v_owner > 1 then raise exception 'Only one part can be paid by the owner — add the amounts together'; end if;
      else
        if nullif(v_x ->> 'account_id', '') is null then raise exception 'Part %: pick where it was paid from', v_i + 1; end if;
        v_acc := public.emi_down_account(v_tenant, (v_x ->> 'account_id')::uuid, v_date);
        if v_acc.account_type = 'credit_card' then raise exception 'Part %: a credit card is not a bank or cash account', v_i + 1; end if;
        v_has_acc := true;
      end if;
      v_sum := v_sum + v_amt;
    end if;
  end loop;

  if v_sum <> v_total then
    raise exception 'The parts add up to ₹% but the down payment (with the processing fee) is ₹%', public.emi_inr(v_sum::integer), public.emi_inr(v_total);
  end if;

  -- A statement line already reconciled to this down payment stays unless un-reconciled in Banking.
  select * into v_line from public.bank_transactions
   where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source <> 'manual'
     and id is distinct from v_p.received_bank_txn_id and not (id = any (v_ids))
   order by txn_date, id limit 1;
  if found then
    raise exception 'The ₹% line of % on the bank statement is reconciled to this down payment — keep it in the list, or un-reconcile it in Banking first',
      v_line.debit, to_char(v_line.txn_date, 'DD Mon YYYY');
  end if;
  -- Parts being removed must not sit in a locked month.
  if v_lock is not null and (
       exists (select 1 from public.bank_transactions where tenant_id = v_tenant and matched_to_type = 'emi'
                and matched_to_id = v_p.id::text and source = 'manual' and txn_date <= v_lock)
    or exists (select 1 from public.owner_equity_movements where emi_purchase_id = v_p.id and movement_date <= v_lock)) then
    raise exception 'Books are locked up to % — part of this down payment is in a closed month. The owner can unlock it on Accounting → Month-end close.',
      to_char(v_lock, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;

  v_before := public.emi_down_parts_json(v_p.id);

  -- Remove the app-made parts (removing them IS the reversal), then book the new ones.
  perform set_config('app.r2395_down_move', 'on', true);
  update public.emi_purchases set down_bank_txn_id = null, down_account_id = null, updated_at = now() where id = v_p.id;
  delete from public.bank_transactions
   where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text and source = 'manual'
     and id is distinct from v_p.received_bank_txn_id;
  delete from public.owner_equity_movements where emi_purchase_id = v_p.id;

  for v_i in 0 .. v_n - 1 loop
    v_x := p_parts -> v_i;
    if nullif(v_x ->> 'bank_txn_id', '') is not null then
      perform public.emi_mark_line((v_x ->> 'bank_txn_id')::uuid, v_p.id);
    else
      select * into v_p from public.emi_purchases where id = v_p.id;
      perform public.emi_down_book(v_tenant, v_p,
        case when coalesce((v_x ->> 'paid_by_owner')::boolean, false) then null else (v_x ->> 'account_id')::uuid end,
        coalesce((v_x ->> 'paid_by_owner')::boolean, false), v_x ->> 'partner', p_note,
        coalesce(nullif(v_x ->> 'date', '')::date, v_p.purchased_on), (v_x ->> 'amount')::integer);
    end if;
  end loop;
  perform set_config('app.r2395_down_move', '', true);
  perform public.emi_down_set_primary(v_p.id);

  v_after := public.emi_down_parts_json(v_p.id);
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'emi_down_payment_split', 'emi_purchase', v_p.id::text,
          'Down payment of ' || v_p.name || ' (₹' || public.emi_inr(v_total) || ') recorded as ' || jsonb_array_length(v_after)
            || ' part(s) — asset cost and loan unchanged',
          jsonb_build_object('before', v_before, 'after', v_after, 'note', nullif(trim(coalesce(p_note, '')), '')));

  return jsonb_build_object('purchase_id', v_p.id, 'total', v_total, 'parts', v_after);
end;
$$;
revoke all on function public.set_emi_down_payment_parts(uuid, jsonb, text) from public, anon;
grant execute on function public.set_emi_down_payment_parts(uuid, jsonb, text) to authenticated, service_role;

-- ── 6. change_emi_down_payment_source — R-2395 body + refuses a split down payment ──────────
create or replace function public.change_emi_down_payment_source(
  p_purchase_id   uuid,
  p_account_id    uuid default null,
  p_paid_by_owner boolean default false,
  p_partner       text default null,
  p_note          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('change where a down payment was paid from');
  v_p       public.emi_purchases;
  v_line    public.bank_transactions;
  v_eq      public.owner_equity_movements;
  v_acc     public.bank_accounts;
  v_amt     integer;
  v_date    date;
  v_lock    date;
  v_owner   boolean := coalesce(p_paid_by_owner, false);
  v_before  jsonb;
  v_after   jsonb;
  v_parts   integer;
begin
  -- R-2395
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;
  if coalesce(v_p.kind, 'asset') <> 'asset' then
    raise exception 'A loan with no asset has no down payment';
  end if;
  -- R-2523: this moves ONE source; a split down payment is changed with the split.
  select (select count(*) from public.bank_transactions
           where tenant_id = v_tenant and matched_to_type = 'emi' and matched_to_id = v_p.id::text
             and id is distinct from v_p.received_bank_txn_id)
       + (select count(*) from public.owner_equity_movements where emi_purchase_id = v_p.id)
    into v_parts;
  if v_parts > 1 then
    raise exception 'The down payment of % is split across % sources — change it with "Split across sources" (Assets & EMIs → Schedule → Down payment)', v_p.name, v_parts;
  end if;
  v_amt  := coalesce(v_p.down_payment, 0) + coalesce(v_p.processing_fee, 0) + coalesce(v_p.processing_fee_gst, 0);
  v_date := v_p.purchased_on;
  if v_amt <= 0 then raise exception 'This purchase has no down payment'; end if;
  if v_owner and p_account_id is not null then
    raise exception 'Pick either an account or Paid by owner — not both';
  end if;
  if not v_owner and p_account_id is null then
    raise exception 'Pick where the down payment was paid from';
  end if;

  -- Where it is now.
  if v_p.down_bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_p.down_bank_txn_id for update;
  end if;
  select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;

  if v_line.id is not null then
    select * into v_acc from public.bank_accounts where id = v_line.bank_account_id;
    if v_line.source <> 'manual' then
      raise exception 'The down payment is reconciled to a statement line on % (%) — the bank shows it left from there. Un-reconcile that line in Banking first if it is wrong, then change it here.',
        coalesce(v_acc.name, 'an account'), to_char(v_line.txn_date, 'DD Mon YYYY');
    end if;
    v_amt  := coalesce(v_line.debit, v_amt);
    v_date := v_line.txn_date;
    v_before := jsonb_build_object('kind', 'account', 'account_id', v_line.bank_account_id, 'account_name', v_acc.name,
                                   'line_id', v_line.id, 'amount', v_amt, 'date', v_date);
  elsif v_eq.id is not null then
    v_amt  := v_eq.amount;
    v_date := v_eq.movement_date;
    v_before := jsonb_build_object('kind', 'owner', 'equity_id', v_eq.id, 'partner', v_eq.partner_name, 'amount', v_amt, 'date', v_date);
  else
    v_before := jsonb_build_object('kind', 'none', 'amount', v_amt, 'date', v_date);
  end if;

  -- Locked month: for every caller (the trigger only checks app logins).
  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Books are locked up to % — the down payment of % is in a closed month. The owner can unlock it on Accounting → Month-end close, then change it.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  -- The same source again.
  if v_owner and v_eq.id is not null then
    raise exception 'The down payment is already recorded as paid by the owner';
  end if;
  if not v_owner and v_line.id is not null and v_line.bank_account_id = p_account_id then
    raise exception 'The down payment is already on %', coalesce(v_acc.name, 'that account');
  end if;

  -- Remove the old source (made by the app: removing it is the reversal).
  perform set_config('app.r2395_down_move', 'on', true);
  update public.emi_purchases set down_bank_txn_id = null, down_account_id = null, updated_at = now() where id = v_p.id;
  if v_line.id is not null then
    delete from public.bank_transactions where id = v_line.id;
  end if;
  if v_eq.id is not null then
    delete from public.owner_equity_movements where id = v_eq.id;
  end if;

  -- Book the new one.
  select * into v_p from public.emi_purchases where id = v_p.id;
  v_after := public.emi_down_book(v_tenant, v_p, p_account_id, v_owner, p_partner, p_note, v_date, v_amt);
  perform set_config('app.r2395_down_move', '', true);

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'emi_down_payment_moved', 'emi_purchase', v_p.id::text,
          'Down payment of ' || v_p.name || ' (₹' || v_amt || ', ' || to_char(v_date, 'DD Mon YYYY') || ') moved from '
            || case v_before ->> 'kind' when 'account' then coalesce(v_before ->> 'account_name', 'an account')
                                        when 'owner' then 'paid by owner' else 'nowhere' end
            || ' to '
            || case v_after ->> 'kind' when 'account' then coalesce(v_after ->> 'account_name', 'an account') else 'paid by owner (capital introduced)' end
            || ' — asset cost and loan unchanged',
          jsonb_build_object('before', v_before, 'after', v_after || jsonb_build_object('amount', v_amt, 'date', v_date)));

  return jsonb_build_object('purchase_id', v_p.id, 'amount', v_amt, 'date', v_date, 'before', v_before, 'after', v_after);
end;
$$;
revoke all on function public.change_emi_down_payment_source(uuid, uuid, boolean, text, text) from public, anon;
grant execute on function public.change_emi_down_payment_source(uuid, uuid, boolean, text, text) to authenticated, service_role;

commit;
