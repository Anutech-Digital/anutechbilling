-- deploy-peek: to_regprocedure('public.reconcile_bank_txn_manual(uuid,text,uuid)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'reversal_of')
-- deploy-key: r2361manualreconcilereason
-- 20261102091144_r2361_manual_reconcile_reason.sql
--
-- R-2361 (2 Nov 2026, staging reconcile), P1: "Mark reconciled manually" closed a ₹12,00,000 line
-- in one click, with no confirm and no note — later nobody could tell why it was reconciled.
--
--   bank_transactions.reconcile_note   the reason written when a line is reconciled manually
--                                      (shown under the Reconciled badge). The row-change trigger
--                                      trg_activity_bank_transactions already writes every change
--                                      to activity_log, so the reason lands in the audit log too.
--   bank_transactions.reversal_of      for a failed / reversed payment: the opposite line it
--                                      cancels out (both lines point at each other).
--   reconcile_bank_txn_manual(line, reason, reversal line default null)
--                                      the one way to reconcile a line manually: reason required
--                                      (5+ characters); with a reversal line, both are reconciled
--                                      together as a pair after a server check — same company,
--                                      same account, equal amount, opposite sides, both open.
--   Un-reconciling either line of a pair un-reconciles the other (trigger), and any
--   un-reconcile / re-match clears the line's note + pair link.
-- Test: supabase/tests/r2361_manual_reconcile_reason.test.sql

begin;

alter table public.bank_transactions
  add column if not exists reconcile_note text,
  add column if not exists reversal_of uuid references public.bank_transactions(id) on delete set null;

comment on column public.bank_transactions.reconcile_note is
  'R-2361: why the line was reconciled manually (required by reconcile_bank_txn_manual).';
comment on column public.bank_transactions.reversal_of is
  'R-2361: the opposite line this one cancels out (failed / reversed payment); both lines point at each other.';

create index if not exists bank_txn_reversal_of_idx
  on public.bank_transactions (reversal_of) where reversal_of is not null;

-- ── The RPC ──────────────────────────────────────────────────────────────────────────────
create or replace function public.reconcile_bank_txn_manual(p_txn_id uuid, p_reason text, p_reversal_txn_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2361: reconcile a bank line manually — reason required; optionally paired with its reversal. */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_txn     public.bank_transactions;
  v_pair    public.bank_transactions;
  v_amount  integer;
  v_pamount integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match a bank line' using errcode = '42501';
  end if;

  if char_length(v_reason) < 5 then
    raise exception 'Write why this line is reconciled without an entry (at least 5 characters).' using errcode = '22023';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'Keep the reason under 500 characters.' using errcode = '22023';
  end if;

  /* Lock both lines in id order so two people pairing the same two lines cannot deadlock. */
  if p_reversal_txn_id is not null and p_reversal_txn_id < p_txn_id then
    perform 1 from public.bank_transactions where id = p_reversal_txn_id for update;
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  v_amount := greatest(coalesce(v_txn.credit, 0), coalesce(v_txn.debit, 0));

  if p_reversal_txn_id is not null then
    if p_reversal_txn_id = p_txn_id then
      raise exception 'Pick the OTHER line — a line cannot reverse itself.' using errcode = '22023';
    end if;
    select t.* into v_pair from public.bank_transactions t where t.id = p_reversal_txn_id for update;
    if not found or v_pair.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Reversal line not found' using errcode = 'no_data_found';
    end if;
    if v_pair.bank_account_id is distinct from v_txn.bank_account_id then
      raise exception 'The reversal line must be in the same bank account.' using errcode = '22023';
    end if;
    v_pamount := greatest(coalesce(v_pair.credit, 0), coalesce(v_pair.debit, 0));
    if v_pamount <> v_amount then
      raise exception 'The reversal line must be for the same amount (₹% vs ₹%).', v_amount, v_pamount using errcode = '22023';
    end if;
    if (coalesce(v_txn.credit, 0) > 0) = (coalesce(v_pair.credit, 0) > 0) then
      raise exception 'The reversal line must go the other way (money in against money out).' using errcode = '22023';
    end if;
    if v_pair.matched_to_type is not null then
      raise exception 'The reversal line is already reconciled (%). Un-reconcile it first.', v_pair.matched_to_type
        using errcode = 'check_violation';
    end if;
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'manual', null, 'manual');
  update public.bank_transactions
     set reconcile_note = v_reason, reversal_of = p_reversal_txn_id
   where id = p_txn_id;

  if p_reversal_txn_id is not null then
    perform public.reconcile_bank_txn(p_reversal_txn_id, 'manual', null, 'manual');
    update public.bank_transactions
       set reconcile_note = v_reason, reversal_of = p_txn_id
     where id = p_reversal_txn_id;
  end if;

  return jsonb_build_object('txn_id', p_txn_id, 'reversal_id', p_reversal_txn_id, 'reason', v_reason,
                            'bank_account_id', v_txn.bank_account_id);
end;
$$;
revoke all on function public.reconcile_bank_txn_manual(uuid, text, uuid) from public, anon;
grant execute on function public.reconcile_bank_txn_manual(uuid, text, uuid) to authenticated, service_role;

-- ── Un-reconcile / re-match: the note and the pair go with the match ──────────────────────
create or replace function public.tg_bank_txn_manual_note_clear()
returns trigger
language plpgsql
set search_path = public
as $$
/* R-2361: a line that stops being matched the same way loses its manual note + reversal link. */
begin
  if new.matched_to_type is null or new.matched_to_type is distinct from old.matched_to_type then
    new.reconcile_note := null;
    new.reversal_of    := null;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_bank_txn_manual_note_clear() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_manual_note_clear on public.bank_transactions;
create trigger trg_bank_txn_manual_note_clear
  before update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_txn_manual_note_clear();

create or replace function public.tg_bank_txn_reversal_unpair()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2361: un-reconciling one line of a reversal pair un-reconciles the other. A manual line has
   no booking behind it, so clearing the match is the whole undo. The partner's own run of this
   trigger finds this line already unpaired and stops. */
begin
  if old.reversal_of is not null and new.reversal_of is null then
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null,
           matched_by = null, match_confidence = null
     where id = old.reversal_of
       and tenant_id = old.tenant_id
       and reversal_of = old.id;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_bank_txn_reversal_unpair() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_reversal_unpair on public.bank_transactions;
create trigger trg_bank_txn_reversal_unpair
  after update of matched_to_type, matched_to_id, reversal_of on public.bank_transactions
  for each row execute function public.tg_bank_txn_reversal_unpair();

commit;
