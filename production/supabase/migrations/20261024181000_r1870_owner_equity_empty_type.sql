-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_owner_equity_movement(text,date,integer,uuid,text,text)') and prosrc like '%R-1870%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_owner_equity(uuid,text,text,uuid)') and prosrc like '%R-1870%')
-- deploy-key: r1870drawingsemptytype
-- 20261024181000_r1870_owner_equity_empty_type.sql
--
-- R-1870 (24 Oct 2026, epic R-1841): the drawings / capital functions refuse an EMPTY business
-- type too, the same way they refuse pvt_ltd.
--
-- Coordinator decision (24 Oct): empty tenants.business_type = Pvt Ltd everywhere — one resolver,
-- resolveBusinessType() in lib/compliance/entity.ts. The screens follow it since 7992ba1e (R-1842),
-- but record_owner_equity_movement and book_bank_txn_as_owner_equity
-- (20261024142228_r1839_owner_equity.sql) checked only v_type = 'pvt_ltd', so a direct RPC call by
-- a company with no type set still booked drawings. Now the database agrees with the screens.
--
-- Only the business-type check changes: an empty type gets its own §24 message (what to set, where),
-- pvt_ltd keeps its message. Bodies otherwise byte-identical to R-1839; grants kept. Proof:
-- supabase/tests/r1839_owner_equity.test.sql (section 9, one rollback; mutation: drop the null
-- check → red).

begin;

create or replace function public.record_owner_equity_movement(
  p_kind        text,
  p_date        date,
  p_amount      integer,
  p_account_id  uuid,
  p_partner     text default null,
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_acc      public.bank_accounts;
  v_partner  text := nullif(trim(coalesce(p_partner, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_id       uuid := gen_random_uuid();
  v_txn      uuid;
  v_desc     text;
begin
  /* R-1839: §17c guard + money role (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can record owner drawings or capital' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('drawings', 'capital_introduced') then
    raise exception 'Pick drawings (money taken out) or capital introduced (money put in).';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  /* R-1870: empty type = Pvt Ltd, the one rule every screen uses (lib/compliance/entity.ts). */
  if v_type is null then
    raise exception 'Set your business type first: Settings, Company, Compliance profile, Business type. A company with no type set counts as Pvt Ltd, and a Pvt Ltd company has no owner drawings or capital entries. Pick Proprietor, Partnership or LLP if that is what the business is, then record this again.';
  end if;
  if coalesce(v_type, 'pvt_ltd') = 'pvt_ltd' then
    raise exception 'A Pvt Ltd company has no owner drawings or capital entries — money paid to a director is salary (Payroll), a loan (Loans given) or a reimbursement; money a shareholder puts in is share capital or a director''s loan.';
  end if;
  if v_type in ('partnership', 'llp') and v_partner is null then
    raise exception 'Pick the partner whose capital account this is.';
  end if;
  if p_date is null then raise exception 'Pick the date.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  if p_account_id is null then raise exception 'Pick the bank account or Petty Cash.'; end if;
  select * into v_acc from public.bank_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then raise exception 'That account is not in your company — pick another, or add it in Banking.'; end if;
  if v_acc.account_type = 'credit_card' then
    raise exception 'Pick a bank account or Petty Cash — a credit card is not where the owner''s money moves.';
  end if;

  v_desc := case p_kind when 'drawings' then 'Owner drawings' else 'Capital introduced' end
            || coalesce(' — ' || v_partner, '')
            || coalesce(' · ' || v_note, '');

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, matched_at, matched_by, match_confidence)
  values
    (v_tenant, p_account_id, p_date, left(v_desc, 500),
     case when p_kind = 'drawings' then p_amount else 0 end,
     case when p_kind = 'capital_introduced' then p_amount else 0 end,
     'manual', 'owner_equity', v_id::text, now(), auth.uid(), 'manual')
  returning id into v_txn;

  insert into public.owner_equity_movements
    (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by)
  values
    (v_id, v_tenant, p_kind, p_date, p_amount, p_account_id, v_txn, true, v_partner, v_note, auth.uid());

  return v_id;
end;
$$;

revoke all on function public.record_owner_equity_movement(text, date, integer, uuid, text, text) from public, anon;
grant execute on function public.record_owner_equity_movement(text, date, integer, uuid, text, text) to authenticated, service_role;

create or replace function public.book_bank_txn_as_owner_equity(
  p_txn_id       uuid,
  p_partner      text default null,
  p_note         text default null,
  p_movement_id  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_txn      public.bank_transactions;
  v_mov      public.owner_equity_movements;
  v_kind     text;
  v_amount   integer;
  v_partner  text := nullif(trim(coalesce(p_partner, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_id       uuid;
  v_synth    uuid;
begin
  /* R-1839: §17c guard + money role. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book owner drawings or capital' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  /* R-1870: empty type = Pvt Ltd, the one rule every screen uses (lib/compliance/entity.ts). */
  if v_type is null then
    raise exception 'Set your business type first: Settings, Company, Compliance profile, Business type. A company with no type set counts as Pvt Ltd, and a Pvt Ltd company has no owner drawings or capital entries. Pick Proprietor, Partnership or LLP if that is what the business is, then record this again.';
  end if;
  if coalesce(v_type, 'pvt_ltd') = 'pvt_ltd' then
    raise exception 'A Pvt Ltd company has no owner drawings or capital entries — book a director''s salary in Payroll, a loan to a director in Loans given, or a reimbursement.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Bank line not found in your company.';
  end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  v_kind   := case when coalesce(v_txn.debit, 0) > 0 then 'drawings' else 'capital_introduced' end;
  v_amount := greatest(coalesce(v_txn.debit, 0), coalesce(v_txn.credit, 0));

  if p_movement_id is not null then
    -- An entry recorded by hand earlier: its own line is replaced by this real one.
    select * into v_mov from public.owner_equity_movements
     where id = p_movement_id and tenant_id = v_tenant for update;
    if not found then raise exception 'That drawings / capital entry is not in your company.'; end if;
    if v_mov.kind <> v_kind then
      raise exception 'That entry is %, but this line is money %.',
        case v_mov.kind when 'drawings' then 'drawings (money out)' else 'capital introduced (money in)' end,
        case v_kind when 'drawings' then 'out' else 'in' end;
    end if;
    if v_mov.amount <> v_amount then
      raise exception 'That entry is ₹% but this line is ₹% — pick the entry with the same amount.', v_mov.amount, v_amount;
    end if;
    if v_mov.bank_account_id <> v_txn.bank_account_id then
      raise exception 'That entry was recorded on a different account — pick an entry from this account.';
    end if;
    if not v_mov.own_line then
      raise exception 'That entry is already matched to a bank line.';
    end if;
    v_synth := v_mov.bank_txn_id;
    if v_partner is null and v_type in ('partnership', 'llp') then v_partner := v_mov.partner_name; end if;
    update public.owner_equity_movements
       set bank_txn_id = p_txn_id, own_line = false, movement_date = v_txn.txn_date,
           partner_name = coalesce(v_partner, partner_name), note = coalesce(v_note, note)
     where id = v_mov.id;
    -- The old manual line goes; the trigger below must not take the entry with it (it now
    -- points at the real line), and on-delete-cascade no longer reaches it.
    delete from public.bank_transactions where id = v_synth;
    v_id := v_mov.id;
  else
    if v_type in ('partnership', 'llp') and v_partner is null then
      raise exception 'Pick the partner whose capital account this is.';
    end if;
    v_id := gen_random_uuid();
    insert into public.owner_equity_movements
      (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by)
    values
      (v_id, v_tenant, v_kind, v_txn.txn_date, v_amount, v_txn.bank_account_id, p_txn_id, false, v_partner,
       coalesce(v_note, nullif(trim(coalesce(v_txn.description, '')), '')), auth.uid());
  end if;

  update public.bank_transactions
     set matched_to_type = 'owner_equity', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('movement_id', v_id, 'kind', v_kind, 'amount', v_amount, 'replaced_line', v_synth);
end;
$$;

revoke all on function public.book_bank_txn_as_owner_equity(uuid, text, text, uuid) from public, anon;
grant execute on function public.book_bank_txn_as_owner_equity(uuid, text, text, uuid) to authenticated, service_role;

commit;
