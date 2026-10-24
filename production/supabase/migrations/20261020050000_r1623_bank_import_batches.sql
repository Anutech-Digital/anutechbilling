-- deploy-peek: to_regclass('public.bank_import_batches') is not null and to_regprocedure('public.remove_bank_import(uuid,uuid,text,text,text)') is not null and to_regprocedure('public.import_bank_statement(uuid,jsonb,text,text)') is not null and to_regprocedure('public.bank_import_history(uuid)') is not null
-- deploy-key: r1623imports
-- 20261020050000_r1623_bank_import_batches.sql
--
-- R-1623 (owner priority, money): a wrong bank-statement import could not be taken back.
-- There was no undo and no line delete — only "delete the whole bank account", which takes
-- the correct lines with it. On staging, the owner's HDFC account holds 1,844 lines: the
-- correct PDF (317 lines, balance chain complete) plus ~1,500 lines from three imports on
-- 17 Oct 2026 that do not fit the chain, so the page shows ₹7.97 L of "Lines missing".
--
-- ══ WHAT THIS ADDS ═════════════════════════════════════════════════════════════════════
--   1. bank_import_batches — one row per Import click: account, file name, source
--      (pdf/csv/xlsx/paste/image), line count, txn date range, who, when; and, once taken
--      back, removed_at / removed_by / remove_reason / removed_lines. A batch row is never
--      deleted — it is the audit of what came in and what was taken out.
--      bank_transactions.import_batch_id (nullable FK) stamps every line of that click.
--   2. import_bank_statement(account, rows, file_name, source) — the import path (lib/queries/
--      bank.ts importBankTransactions) now creates the batch and inserts its lines in ONE
--      transaction (CLAUDE.md §17b). Same roles as the bank_transactions insert policy
--      (owner / manager / accountant); the books-lock trigger still guards each line.
--   3. bank_import_history(account) — the account page's "Imports" list: every batch, plus
--      the OLD imports (lines with no batch, source csv_upload) grouped by insert time.
--      A statement import was always ONE insert statement, so all its lines share one
--      created_at (now() is the transaction's time); a new group starts wherever two
--      consecutive old lines were inserted more than 60 seconds apart. Lines typed by hand
--      or made by a transfer/RPC (source manual) and AA lines (api_fetch) are not imports
--      and are not listed.
--   4. remove_bank_import(account, batch | old-import range, reason) — "Ye import hatao".
--      Owner or accountant only (current_user_has_role, which carries is_active + MFA), the
--      company from current_tenant_id() and never from an argument (§17c, R-1615/R-1618).
--      Deletes ONLY that import's lines, and only when every one is unreconciled and
--      unbooked — otherwise it refuses whole (CLAUDE.md §24):
--        * reconciled / matched lines, or lines a booking points at (expense, tax, statutory,
--          prepaid, loan, project payment, balance-sheet line) → "Ye N lines reconcile hain —
--          pehle Un-reconcile karo";
--        * a line dated inside the books lock (R-1584) → unlock on Month-end close first.
--      Writes one activity_log row (who, how many, which file, why) and marks the batch
--      removed; an old import gets a batch row too (source 'legacy') so the history shows it.
--
-- Cloud SQL: no extensions schema, no auth.users; auth.uid()/auth.role() are rewritten by the
-- staging deploy script. Grants explicit (no PUBLIC EXECUTE). service_role policy (R-450).
-- Test: supabase/tests/bank_import_batches.test.sql (rolled back).
-- Rollback: drop function public.remove_bank_import(uuid,uuid,text,text,text),
--   public.bank_import_history(uuid), public.import_bank_statement(uuid,jsonb,text,text);
--   alter table public.bank_transactions drop column import_batch_id;
--   drop table public.bank_import_batches;  (old lines are unaffected — they never had a batch)

begin;

-- ── 1. Table + column ──────────────────────────────────────────────────────────────────
create table if not exists public.bank_import_batches (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  bank_account_id uuid        not null references public.bank_accounts(id) on delete cascade,
  file_name       text        check (file_name is null or char_length(file_name) <= 300),
  source          text        not null check (source in ('pdf', 'csv', 'xlsx', 'paste', 'image', 'legacy')),
  line_count      integer     not null default 0 check (line_count >= 0),
  txn_from        date,
  txn_to          date,
  created_by      uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  removed_at      timestamptz,
  removed_by      uuid        references public.users(id) on delete set null,
  remove_reason   text        check (remove_reason is null or char_length(remove_reason) <= 500),
  removed_lines   integer     check (removed_lines is null or removed_lines >= 0)
);

comment on table public.bank_import_batches is
  'R-1623: one row per bank-statement Import click (lines carry import_batch_id). Written only by import_bank_statement() / remove_bank_import(); a removed import keeps its row with removed_at.';

create index if not exists bank_import_batches_account_idx
  on public.bank_import_batches (tenant_id, bank_account_id, created_at desc);

alter table public.bank_transactions
  add column if not exists import_batch_id uuid references public.bank_import_batches(id) on delete set null;

create index if not exists bank_txn_import_batch_idx
  on public.bank_transactions (import_batch_id) where import_batch_id is not null;
-- Old imports are grouped by insert time per account.
create index if not exists bank_txn_legacy_import_idx
  on public.bank_transactions (bank_account_id, created_at) where import_batch_id is null;

alter table public.bank_import_batches enable row level security;

revoke all on table public.bank_import_batches from public;
revoke all on table public.bank_import_batches from anon;
revoke all on table public.bank_import_batches from authenticated;
grant select on table public.bank_import_batches to authenticated;
grant all on table public.bank_import_batches to service_role;

drop policy if exists bank_import_batches_select on public.bank_import_batches;
create policy bank_import_batches_select on public.bank_import_batches as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));

-- Cloud SQL has no BYPASSRLS: the server (service_role) client needs its own policy (R-450).
drop policy if exists zzz_service_role_all on public.bank_import_batches;
create policy zzz_service_role_all on public.bank_import_batches
  as permissive for all to service_role using (true) with check (true);

-- ── 2. Import: one batch + its lines, one transaction ─────────────────────────────────
create or replace function public.import_bank_statement(
  p_account_id uuid, p_rows jsonb, p_file_name text default null, p_source text default 'csv')
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 */
  v_tenant uuid := public.current_tenant_id();
  v_acc    public.bank_accounts;
  v_batch  uuid;
  v_n      integer;
  v_from   date;
  v_to     date;
  v_source text := lower(btrim(coalesce(p_source, 'csv')));
begin
  if v_tenant is null then
    raise exception 'Statement import needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry — if your account was switched off, ask your workspace owner to turn it on in Team.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Bank statement import owner, manager ya accountant hi kar sakte hain. Owner se import karwao, ya Team me aapka role badalwao.'
      using errcode = '42501';
  end if;
  select * into v_acc from public.bank_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Ye bank account nahi mila (ya aapki company ka nahi hai). Banking page kholo aur sahi account chun kar dobara import karo.'
      using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Import me koi line nahi hai. Statement file dobara upload karo — preview me lines dikhein tab Import dabao.'
      using errcode = '22023';
  end if;
  if v_source not in ('pdf', 'csv', 'xlsx', 'paste', 'image') then v_source := 'csv'; end if;

  insert into public.bank_import_batches (tenant_id, bank_account_id, file_name, source, created_by)
  values (v_tenant, p_account_id, nullif(left(btrim(coalesce(p_file_name, '')), 300), ''), v_source, auth.uid())
  returning id into v_batch;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, reference,
     source, category, category_source, category_confidence, import_batch_id)
  select v_tenant, p_account_id, r.txn_date, coalesce(r.description, ''),
         greatest(0, round(coalesce(r.debit, 0)))::integer,
         greatest(0, round(coalesce(r.credit, 0)))::integer,
         round(r.balance_after)::integer, nullif(r.reference, ''),
         'csv_upload', r.category, r.category_source, r.category_confidence, v_batch
    from jsonb_to_recordset(p_rows) as r(
           txn_date date, description text, debit numeric, credit numeric, balance_after numeric,
           reference text, category text, category_source text, category_confidence integer);
  get diagnostics v_n = row_count;

  select min(txn_date), max(txn_date) into v_from, v_to
    from public.bank_transactions where import_batch_id = v_batch;
  update public.bank_import_batches
     set line_count = v_n, txn_from = v_from, txn_to = v_to
   where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'inserted', v_n);
end
$function$;

comment on function public.import_bank_statement(uuid, jsonb, text, text) is
  'R-1623: one Import click = one bank_import_batches row + its lines, atomically. Company from current_tenant_id(); owner/manager/accountant.';

revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from public;
revoke all on function public.import_bank_statement(uuid, jsonb, text, text) from anon;
grant execute on function public.import_bank_statement(uuid, jsonb, text, text) to authenticated, service_role;

-- ── 3. History: batches + old imports grouped by insert time ──────────────────────────
create or replace function public.bank_import_history(p_account_id uuid)
returns table (
  kind             text,
  batch_id         uuid,
  legacy_from      text,
  legacy_to        text,
  file_name        text,
  source           text,
  line_count       integer,
  imported_at      timestamptz,
  imported_by      text,
  txn_from         date,
  txn_to           date,
  first_balance    integer,
  last_balance     integer,
  reconciled_count integer,
  removed_at       timestamptz,
  removed_by       text,
  remove_reason    text,
  removed_lines    integer
)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  /* R-1623: definer reads past RLS — the company is current_tenant_id() and nothing else. */
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'Import history needs an active user who has finished sign-in. Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not exists (select 1 from public.bank_accounts a where a.id = p_account_id and a.tenant_id = v_tenant) then
    return;
  end if;

  return query
  with lines as (
    select t.id, t.txn_date, t.debit, t.credit, t.balance_after, t.matched_to_type,
           t.import_batch_id, t.created_at
      from public.bank_transactions t
     where t.tenant_id = v_tenant and t.bank_account_id = p_account_id
  ),
  b as (
    select ib.*,
           (select count(*) from lines l where l.import_batch_id = ib.id)::int as live_n,
           (select count(*) from lines l where l.import_batch_id = ib.id and l.matched_to_type is not null)::int as rec_n,
           (select l.balance_after from lines l where l.import_batch_id = ib.id and l.balance_after is not null
             order by l.txn_date, l.created_at, l.id limit 1) as first_bal,
           (select l.balance_after from lines l where l.import_batch_id = ib.id and l.balance_after is not null
             order by l.txn_date desc, l.created_at desc, l.id desc limit 1) as last_bal
      from public.bank_import_batches ib
     where ib.tenant_id = v_tenant and ib.bank_account_id = p_account_id
  ),
  old as (
    select t.*,
           case when lag(t.created_at) over w is null
                  or t.created_at - lag(t.created_at) over w > interval '60 seconds'
                then 1 else 0 end as brk
      from public.bank_transactions t
     where t.tenant_id = v_tenant and t.bank_account_id = p_account_id
       and t.import_batch_id is null and t.source = 'csv_upload'
    window w as (order by t.created_at, t.id)
  ),
  old_g as (
    select o.*, sum(o.brk) over (order by o.created_at, o.id rows between unbounded preceding and current row) as grp
      from old o
  ),
  legacy as (
    select g.grp, min(g.created_at) as t_from, max(g.created_at) as t_to, count(*)::int as n,
           count(*) filter (where g.matched_to_type is not null)::int as rec_n,
           min(g.txn_date) as d_from, max(g.txn_date) as d_to,
           (array_agg(g.balance_after order by g.txn_date, g.id) filter (where g.balance_after is not null))[1] as first_bal,
           (array_agg(g.balance_after order by g.txn_date desc, g.id desc) filter (where g.balance_after is not null))[1] as last_bal
      from old_g g
     group by g.grp
  )
  select 'batch'::text, b.id, null::text, null::text, b.file_name, b.source,
         case when b.removed_at is null then b.live_n else b.line_count end,
         b.created_at, coalesce(u.full_name, u.email), b.txn_from, b.txn_to,
         b.first_bal, b.last_bal, b.rec_n,
         b.removed_at, coalesce(ru.full_name, ru.email), b.remove_reason, b.removed_lines
    from b
    left join public.users u  on u.id  = b.created_by
    left join public.users ru on ru.id = b.removed_by
  union all
  select 'legacy'::text, null::uuid,
         to_char(lg.t_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         to_char(lg.t_to   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         null::text, 'legacy'::text, lg.n, lg.t_from, null::text, lg.d_from, lg.d_to,
         lg.first_bal, lg.last_bal, lg.rec_n, null::timestamptz, null::text, null::text, null::int
    from legacy lg
  order by 8 desc;
end
$function$;

comment on function public.bank_import_history(uuid) is
  'R-1623: the account page Imports list — batches, plus old imports (no batch, csv_upload) grouped where consecutive inserts are more than 60 s apart.';

revoke all on function public.bank_import_history(uuid) from public;
revoke all on function public.bank_import_history(uuid) from anon;
grant execute on function public.bank_import_history(uuid) to authenticated, service_role;

-- ── 4. "Ye import hatao" ──────────────────────────────────────────────────────────────
create or replace function public.remove_bank_import(
  p_account_id uuid, p_batch_id uuid, p_legacy_from text, p_legacy_to text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-1623 */
  v_tenant  uuid := public.current_tenant_id();
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_batch   public.bank_import_batches;
  v_from    timestamptz;
  v_to      timestamptz;
  v_ids     uuid[];
  v_n       integer;
  v_rec     integer;
  v_recids  text;
  v_lock    date;
  v_inlock  integer;
  v_first   date;
  v_dfrom   date;
  v_dto     date;
  v_bid     uuid;
  v_file    text;
begin
  if v_tenant is null then
    raise exception 'Import hatane ke liye active user chahiye jisne sign-in poora kiya ho (authenticator code bhi). Dobara sign in karke try karo.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Import hatana sirf owner ya accountant kar sakte hain. Owner se ye kaam karwao, ya Team me aapka role accountant karwao.'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Import kyun hata rahe ho, wajah likho (kam se kam 3 akshar) — ye activity log me jaati hai.'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.bank_accounts a where a.id = p_account_id and a.tenant_id = v_tenant) then
    raise exception 'Ye bank account nahi mila (ya aapki company ka nahi hai). Banking page kholo aur sahi account chuno.'
      using errcode = 'P0002';
  end if;

  if p_batch_id is not null then
    select * into v_batch from public.bank_import_batches
     where id = p_batch_id and tenant_id = v_tenant and bank_account_id = p_account_id
     for update;
    if not found then
      raise exception 'Ye import nahi mila. Page refresh karke Imports list dobara dekho.' using errcode = 'P0002';
    end if;
    if v_batch.removed_at is not null then
      raise exception 'Ye import % ko pehle hi hata diya gaya tha — kuch karna baaki nahi. Page refresh karo.',
        to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
    end if;
    select array_agg(t.id order by t.txn_date, t.id) into v_ids
      from (select id, txn_date from public.bank_transactions
             where import_batch_id = p_batch_id and tenant_id = v_tenant
             for update) t;
    v_file := v_batch.file_name;
  else
    if p_legacy_from is null or p_legacy_to is null then
      raise exception 'Kaunsa import hatana hai, ye nahi bataya. Imports list me us import par "Ye import hatao" dabao.'
        using errcode = '22023';
    end if;
    begin
      v_from := p_legacy_from::timestamptz;
      v_to   := p_legacy_to::timestamptz;
    exception when others then
      raise exception 'Purane import ka samay samajh nahi aaya. Page refresh karke dobara try karo.' using errcode = '22023';
    end;
    -- The range must be exactly one old import: no old line within 60 s just outside it,
    -- and no 60 s break inside it (bank_import_history's grouping rule).
    if exists (select 1 from public.bank_transactions t
                where t.tenant_id = v_tenant and t.bank_account_id = p_account_id
                  and t.import_batch_id is null and t.source = 'csv_upload'
                  and ((t.created_at < v_from and t.created_at >= v_from - interval '60 seconds')
                    or (t.created_at > v_to   and t.created_at <= v_to   + interval '60 seconds'))) then
      raise exception 'Ye purana import list se mel nahi khaata (beech se kata hua). Page refresh karke Imports list se dobara chuno.'
        using errcode = '22023';
    end if;
    select array_agg(t.id order by t.txn_date, t.id) into v_ids
      from (select id, txn_date from public.bank_transactions
             where tenant_id = v_tenant and bank_account_id = p_account_id
               and import_batch_id is null and source = 'csv_upload'
               and created_at between v_from and v_to
             for update) t;
    if exists (
      select 1 from (
        select t.created_at - lag(t.created_at) over (order by t.created_at, t.id) as gap
          from public.bank_transactions t
         where t.id = any (coalesce(v_ids, '{}'::uuid[]))) x
       where x.gap > interval '60 seconds') then
      raise exception 'Ye range ek se zyada purane imports ko chhoo rahi hai. Page refresh karke Imports list se ek hi import chuno.'
        using errcode = '22023';
    end if;
  end if;

  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then
    raise exception 'Is import ki koi line ab account me nahi hai — kuch hatane ko nahi bacha. Page refresh karo.'
      using errcode = 'P0002';
  end if;

  -- Reconciled / matched, or pointed at by a booking: refuse the whole removal (§24).
  select count(*), string_agg(t.id::text, ',' order by t.txn_date, t.id)
    into v_rec, v_recids
    from public.bank_transactions t
   where t.id = any (v_ids)
     and (t.matched_to_type is not null
       or exists (select 1 from public.expenses e                where e.reconciled_txn_id = t.id)
       or exists (select 1 from public.balance_sheet_items s     where s.bank_txn_id = t.id)
       or exists (select 1 from public.loan_repayments r         where r.bank_txn_id = t.id)
       or exists (select 1 from public.loans_given g             where g.bank_txn_id = t.id)
       or exists (select 1 from public.prepaid_advances p        where p.bank_txn_id = t.id)
       or exists (select 1 from public.project_payments pp       where pp.bank_txn_id = t.id)
       or exists (select 1 from public.statutory_dues_payments d where d.bank_txn_id = t.id)
       or exists (select 1 from public.tax_payments x            where x.bank_txn_id = t.id));
  if v_rec > 0 then
    raise exception 'Ye % lines reconcile hain — pehle Un-reconcile karo. Is import ki % lines me se % kisi payment / expense / booking se judi hain; unhe account page par Un-reconcile karke phir "Ye import hatao" dabao.',
      v_rec, v_n, v_rec
      using errcode = 'P0001', detail = 'reconciled_ids=' || left(v_recids, 4000);
  end if;

  -- Books lock (R-1584): a removal would change a filed month.
  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null then
    select count(*), min(txn_date) into v_inlock, v_first
      from public.bank_transactions where id = any (v_ids) and txn_date <= v_lock;
    if v_inlock > 0 then
      raise exception 'Is import ki % lines (pehli % ki) band books me hain — books % tak lock hain. Owner Accounting → Month-end close par lock kholein, phir import hatao.',
        v_inlock, to_char(v_first, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY')
        using errcode = 'P0001';
    end if;
  end if;

  select min(txn_date), max(txn_date) into v_dfrom, v_dto
    from public.bank_transactions where id = any (v_ids);

  delete from public.bank_transactions where id = any (v_ids);
  get diagnostics v_n = row_count;

  if p_batch_id is not null then
    update public.bank_import_batches
       set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_lines = v_n
     where id = p_batch_id;
    v_bid := p_batch_id;
  else
    insert into public.bank_import_batches
      (tenant_id, bank_account_id, file_name, source, line_count, txn_from, txn_to, created_by, created_at,
       removed_at, removed_by, remove_reason, removed_lines)
    values (v_tenant, p_account_id, null, 'legacy', v_n, v_dfrom, v_dto, null, v_from,
            now(), auth.uid(), left(v_reason, 500), v_n)
    returning id into v_bid;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'bank_import.removed', 'bank_account', p_account_id::text,
          left(format('Import hataya: %s lines%s — %s', v_n,
                      case when v_file is not null then ' (' || v_file || ')' else '' end, v_reason), 120),
          jsonb_build_object('batch_id', v_bid, 'lines', v_n, 'file', v_file, 'reason', v_reason,
                             'txn_from', v_dfrom, 'txn_to', v_dto,
                             'legacy_from', p_legacy_from, 'legacy_to', p_legacy_to));

  return jsonb_build_object('removed', v_n, 'batch_id', v_bid);
end
$function$;

comment on function public.remove_bank_import(uuid, uuid, text, text, text) is
  'R-1623: "Ye import hatao" — deletes one import''s lines only when none is reconciled/booked and none is in the books lock. Owner/accountant; company from current_tenant_id(); writes activity_log; the batch row stays, marked removed.';

revoke all on function public.remove_bank_import(uuid, uuid, text, text, text) from public;
revoke all on function public.remove_bank_import(uuid, uuid, text, text, text) from anon;
grant execute on function public.remove_bank_import(uuid, uuid, text, text, text) to authenticated, service_role;

commit;
