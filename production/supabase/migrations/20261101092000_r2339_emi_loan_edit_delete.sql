-- deploy-peek: to_regprocedure('public.edit_emi_loan(jsonb)') is not null and to_regprocedure('public.delete_emi_loan(uuid)') is not null
-- deploy-key: r2339emiloaneditdelete
-- R-2339 (1 Nov 2026): edit or delete a loan set up from an EMI line (R-2323, emi_purchases.kind = 'loan').
--
-- Why: a typing mistake in the lender, rate or EMIs left could only be fixed by undoing every EMI
-- and setting the loan up again (R-2323 worker report).
--
-- delete_emi_loan(p_purchase_id uuid) — only while NO EMI of the loan is on the books
--   (emi_payments of it = 0; refused with a plain message otherwise — undo them first, latest
--   first, the R-1864 rule). Removes the loan; its schedule goes with it (on delete cascade). Its
--   money-in line (emi_purchases.received_bank_txn_id):
--     imported statement line (R-2341) → unmatched again (back on the bank page);
--     manual line made at set-up (R-2323 "came into an account") → removed (that money only
--     existed because of the set-up);
--     none ("taken before these books") → nothing.
--   The loan row is deleted BEFORE the line is freed, so tg_emi_line_unmatched (R-2341 branch)
--   finds no loan and does nothing.
--
-- edit_emi_loan(p jsonb): purchase_id, lender, lender_ref, interest_rate, schedule.
--   Paid EMIs (schedule rows with emi_payment_id) and their payments / expenses are not touched;
--   the principal still owed (emi_outstanding) is not changed. The schedule rows sent replace the
--   UNPAID rows from the first unpaid instalment on (emi_replace_unpaid_schedule — chain, sums,
--   repays exactly what is owed, no paid row after it). The rule is the set-up's reducing-balance
--   one (lib/accounting/loan-edit.ts → emi-schedule.ts buildSchedule), re-checked here row by row:
--     interest = the new monthly rate on the balance still owed (±₹1 for rounding),
--     every row but the last = the same EMI (the bank's EMI kept), the last clears the balance.
--   Refused, nothing written, when the rows cannot clear what is owed or do not follow the rate.
--   The loan's lender / name / loan number / rate / no_cost / EMI / EMI count are updated.
--
-- Both: emi_guard (company on the login + owner / manager / accountant), the loan row locked
-- (for update) and found only in the caller's company, kind = 'loan' only, one transaction,
-- one activity_log row (before / after).
--
-- Proof: supabase/tests/r2339_emi_loan_edit_delete.test.sql (one rollback); R-1864 / R-2323 /
-- R-2341 tests unchanged.

begin;

-- ── 1. Delete a loan with no EMI on the books ────────────────────────────────────────────
create or replace function public.delete_emi_loan(p_purchase_id uuid) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.emi_guard('delete a loan');
  v_p      public.emi_purchases;
  v_line   public.bank_transactions;
  v_n      integer;
  v_what   text := 'none';
begin
  -- R-2339
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That loan is not in your company'; end if;
  if v_p.kind is distinct from 'loan' then
    raise exception 'Only a loan set up from an EMI line can be deleted here — an asset bought on EMI is changed on Assets & EMIs';
  end if;
  select count(*) into v_n from public.emi_payments where purchase_id = v_p.id;
  if v_n > 0 then
    raise exception '% EMI(s) of the loan from % are reconciled — undo them first (Schedule → Undo), then delete the loan',
      v_n, coalesce(v_p.lender, 'the lender');
  end if;

  if v_p.received_bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_p.received_bank_txn_id for update;
  end if;

  delete from public.emi_purchases where id = v_p.id;  -- its schedule goes with it (on delete cascade)

  if v_line.id is not null then
    if v_line.source = 'manual' then
      delete from public.bank_transactions where id = v_line.id;
      v_what := 'manual_line_removed';
    elsif v_line.matched_to_type = 'emi' and v_line.matched_to_id = v_p.id::text then
      update public.bank_transactions
         set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null,
             match_confidence = null, updated_at = now()
       where id = v_line.id;
      v_what := 'line_unmatched';
    end if;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'emi_loan_deleted', 'emi_purchase', v_p.id::text,
          'Loan from ' || coalesce(v_p.lender, v_p.name) || ' (₹' || v_p.financed || ') deleted — no EMI was paid',
          jsonb_build_object('lender', v_p.lender, 'lender_ref', v_p.lender_ref, 'financed', v_p.financed,
                             'interest_rate', v_p.interest_rate, 'emi_amount', v_p.emi_amount, 'emi_count', v_p.emi_count,
                             'first_emi_on', v_p.first_emi_on, 'received_bank_txn_id', v_p.received_bank_txn_id,
                             'money_in_line', v_what));

  return jsonb_build_object('purchase_id', v_p.id, 'money_in_line', v_what);
end;
$$;
revoke all on function public.delete_emi_loan(uuid) from public, anon;
grant execute on function public.delete_emi_loan(uuid) to authenticated, service_role;

-- ── 2. Edit lender / rate / EMIs left / EMI — the unpaid schedule recomputed ─────────────
create or replace function public.edit_emi_loan(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('change a loan');
  v_id      uuid := nullif(p ->> 'purchase_id', '')::uuid;
  v_lender  text := nullif(trim(coalesce(p ->> 'lender', '')), '');
  v_ref     text := nullif(trim(coalesce(p ->> 'lender_ref', '')), '');
  v_rate    numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_rows    jsonb := p -> 'schedule';
  v_p       public.emi_purchases;
  v_out     integer;
  v_next    integer;
  v_before  jsonb;
  v_n       integer;
  v_emi     integer;
  v_bal     numeric;
  v_i       integer;
  v_r       jsonb;
  v_want    integer;
begin
  -- R-2339
  if v_id is null then raise exception 'Pick the loan to change'; end if;
  select * into v_p from public.emi_purchases where id = v_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That loan is not in your company'; end if;
  if v_p.kind is distinct from 'loan' then
    raise exception 'Only a loan set up from an EMI line can be changed here — an asset bought on EMI is changed on Assets & EMIs';
  end if;
  if v_lender is null then raise exception 'Enter the lender (bank / NBFC)'; end if;
  if char_length(v_lender) > 100 then raise exception 'Keep the lender name under 100 characters'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'Keep the loan number under 60 characters'; end if;
  if v_rate is null or v_rate < 0 or v_rate > 60 then raise exception 'Enter the interest rate (0 to 60%% a year)'; end if;

  v_out := public.emi_outstanding(v_p.id);
  select min(seq) into v_next from public.emi_schedule where purchase_id = v_p.id and emi_payment_id is null;
  if v_p.status <> 'active' or v_out <= 0 or v_next is null then
    raise exception 'This loan is cleared — there is no EMI left to change';
  end if;

  v_n := coalesce(jsonb_array_length(case when jsonb_typeof(v_rows) = 'array' then v_rows end), 0);
  if v_n = 0 then raise exception 'The EMI schedule is missing'; end if;

  -- The set-up's rule, row by row: interest on the balance still owed at the new rate; the same
  -- EMI on every row but the last; the last one clears (emi_replace_unpaid_schedule checks sums).
  v_emi := (v_rows -> 0 ->> 'emi')::integer;
  v_bal := v_out;
  for v_i in 0 .. v_n - 1 loop
    v_r := v_rows -> v_i;
    v_want := round(v_bal * v_rate / 1200)::integer;
    if abs(coalesce((v_r ->> 'interest')::integer, -1) - v_want) > 1 then
      raise exception 'EMI %: interest at % %% a year on ₹% still owed is ₹%, not ₹% — refresh and try again',
        v_r ->> 'seq', v_rate, v_bal, v_want, v_r ->> 'interest';
    end if;
    if v_i < v_n - 1 and (v_r ->> 'emi')::integer is distinct from v_emi then
      raise exception 'EMI % is ₹% but the EMI is ₹% — only the last EMI can differ', v_r ->> 'seq', v_r ->> 'emi', v_emi;
    end if;
    v_bal := v_bal - coalesce((v_r ->> 'principal')::integer, 0);
  end loop;

  v_before := jsonb_build_object('lender', v_p.lender, 'lender_ref', v_p.lender_ref, 'interest_rate', v_p.interest_rate,
                                 'emi_amount', v_p.emi_amount, 'emi_count', v_p.emi_count,
                                 'unpaid', public.emi_unpaid_rows(v_p.id, v_next));

  -- Unpaid rows from v_next replaced; refused (nothing written) unless they repay exactly v_out.
  perform public.emi_replace_unpaid_schedule(v_tenant, v_p.id, v_next, v_out, v_rows, v_rate = 0,
    coalesce((select max(s.due_on) from public.emi_schedule s where s.purchase_id = v_p.id and s.emi_payment_id is not null),
             v_p.purchased_on));

  update public.emi_purchases
     set lender = v_lender, name = 'Loan — ' || v_lender, lender_ref = v_ref, interest_rate = v_rate,
         no_cost = (v_rate = 0), emi_amount = v_emi,
         emi_count = (select count(*) from public.emi_schedule where purchase_id = v_p.id),
         updated_at = now()
   where id = v_p.id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'emi_loan_edited', 'emi_purchase', v_p.id::text,
          'Loan from ' || v_lender || ' changed — ' || v_rate || '% a year, ' || v_n || ' EMIs left of ₹' || v_emi
            || ' from EMI ' || v_next || ' (₹' || v_out || ' still owed; paid EMIs unchanged)',
          jsonb_build_object('before', v_before,
                             'after', jsonb_build_object('lender', v_lender, 'lender_ref', v_ref, 'interest_rate', v_rate,
                                                         'emi_amount', v_emi, 'unpaid', public.emi_unpaid_rows(v_p.id, v_next)),
                             'outstanding', v_out, 'from_seq', v_next));

  return jsonb_build_object('purchase_id', v_p.id, 'from_seq', v_next, 'emis_left', v_n, 'emi', v_emi, 'outstanding', v_out);
end;
$$;
revoke all on function public.edit_emi_loan(jsonb) from public, anon;
grant execute on function public.edit_emi_loan(jsonb) to authenticated, service_role;

commit;
