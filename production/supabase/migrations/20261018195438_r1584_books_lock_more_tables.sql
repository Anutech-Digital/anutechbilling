-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_books_lock' and tgrelid = to_regclass('public.fixed_assets'))
-- deploy-key: r1584lock
-- 20261018195438_r1584_books_lock_more_tables.sql
--
-- R-1584 (audit 18 Oct 2026): the books lock (20260927120000_books_lock.sql) left holes.
--
-- 1. Tables it never covered. A fixed asset, a loan given / taken, an employee loan, an EMI
--    purchase, their repayments, a reimbursement, a manual Balance Sheet line and the CA's
--    opening balances could all be added, changed or deleted inside a locked (filed) month —
--    the Balance Sheet behind a filed return moved. Now each carries trg_books_lock on the
--    date that books it:
--      fixed_assets             put_to_use    (later event: disposed_on + disposal_value)
--      loans_given              given_on      (later event: closed_on + status)
--      loan_repayments          repaid_on
--      employee_loans           disbursed_on  (status flips as repayments come in)
--      employee_loan_repayments repaid_on
--      business_loans           disbursed_on  (status)
--      business_loan_payments   paid_on
--      emi_purchases            purchased_on  (status)
--      emi_payments             paid_on
--      reimbursements           incurred_on   (later event: settled_on + status, notes)
--      balance_sheet_items      created_at    — a manual line has no date of its own; the day
--                                               it was entered (IST) is when it entered the books.
--      opening_balances         as_of
--
-- 2. A row booked in a locked month often has a LATER event: an asset bought in September is
--    sold in November, a September loan is closed in December, a September bill is reimbursed
--    in October. Refusing every update of such a row would freeze those for ever. So the
--    trigger takes two optional arguments: the later-event date column and the columns that
--    event may write. While the booking date is locked, an UPDATE may change ONLY those
--    columns (and updated_at), and only when the later-event date itself is outside the lock.
--    Any other change (cost, principal, amount, the booking date) is refused, as before.
--    The 15 tables already covered keep the strict rule (no extra arguments).
--
-- 3. payments.received_at is a timestamptz. The date was `left(<json text>, 10)` — the UTC
--    date — so a payment at 00:30 IST on 1 Oct read as 30 Sep, and with September locked it
--    could not be recorded or edited. A value with a time part is now turned into the IST
--    calendar day: (value::timestamptz at time zone 'Asia/Kolkata')::date. Plain dates are
--    unchanged. The same rule gives balance_sheet_items.created_at its IST day.
--
-- 4. The refusal says what is locked, why and what to do (CLAUDE.md §24): the owner unlocks
--    on Accounting → Month-end close, or the entry goes on a later date.
--
-- Who is checked is unchanged: only PostgREST callers (JWT role anon / authenticated), also
-- through SECURITY DEFINER RPCs; crons, webhooks and migrations are not blocked.
-- Test: supabase/tests/r1584_books_lock_more_tables.test.sql (rolled back);
--       supabase/tests/books_lock.test.sql still passes.

begin;

create or replace function public.tg_books_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  /* R-1584 */
  v_col    text := tg_argv[0];
  v_later  text := case when tg_nargs > 1 then nullif(tg_argv[1], '') end;
  v_free   text[] := case when tg_nargs > 2 then string_to_array(tg_argv[2], ',') else '{}'::text[] end;
  v_oldj   jsonb;
  v_newj   jsonb;
  v_lock   date;
  v_old    date;
  v_new    date;
  v_old_l  date;
  v_new_l  date;
  v_tenant uuid;
  v_hit    date;
  v_txt    text;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    v_oldj := to_jsonb(old);
    v_tenant := (v_oldj ->> 'tenant_id')::uuid;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_newj := to_jsonb(new);
    v_tenant := coalesce(v_tenant, (v_newj ->> 'tenant_id')::uuid);
  end if;

  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- The IST calendar day of a date or timestamptz value (R-1584: never the UTC date).
  v_txt := v_oldj ->> v_col;
  v_old := case when v_txt is null then null when length(v_txt) <= 10 then v_txt::date
                else (v_txt::timestamptz at time zone 'Asia/Kolkata')::date end;
  v_txt := v_newj ->> v_col;
  v_new := case when v_txt is null then null when length(v_txt) <= 10 then v_txt::date
                else (v_txt::timestamptz at time zone 'Asia/Kolkata')::date end;
  if v_later is not null then
    v_txt := v_oldj ->> v_later;
    v_old_l := case when v_txt is null then null when length(v_txt) <= 10 then v_txt::date
                    else (v_txt::timestamptz at time zone 'Asia/Kolkata')::date end;
    v_txt := v_newj ->> v_later;
    v_new_l := case when v_txt is null then null when length(v_txt) <= 10 then v_txt::date
                    else (v_txt::timestamptz at time zone 'Asia/Kolkata')::date end;
  end if;

  if tg_op = 'INSERT' then
    if v_new <= v_lock then v_hit := v_new;
    elsif v_new_l <= v_lock then v_hit := v_new_l;
    end if;
  elsif tg_op = 'DELETE' then
    if v_old <= v_lock then v_hit := v_old;
    elsif v_old_l <= v_lock then v_hit := v_old_l;
    end if;
  else
    if v_old_l <= v_lock then v_hit := v_old_l;              -- later event already in a locked month
    elsif v_new_l <= v_lock then v_hit := v_new_l;           -- later event back-dated into the lock
    elsif v_new <= v_lock and v_new is distinct from v_old then v_hit := v_new;   -- moved into the lock
    elsif v_old <= v_lock then
      -- Booked in a locked month: only the later event's own columns may change.
      if v_later is null and cardinality(v_free) = 0 then
        v_hit := v_old;
      elsif exists (
        select 1 from jsonb_object_keys(v_newj) k
         where k <> all (v_free || array[coalesce(v_later, ''), 'updated_at'])
           and (v_newj -> k) is distinct from (v_oldj -> k)
      ) then
        v_hit := v_old;
      end if;
    end if;
  end if;

  if v_hit is not null then
    raise exception 'Books % tak lock hain (% · %) — us tareekh tak ki entry badal nahi sakti, kyunki us mahine ke return / books band ho chuke. Owner Accounting → Month-end close par lock hata kar (unlock karein) badlein, ya entry ko baad ki tareekh par karein.',
      to_char(v_lock, 'DD Mon YYYY'), tg_table_name, v_hit
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('fixed_assets',             'put_to_use',   'disposed_on', 'disposal_value,notes'),
      ('loans_given',              'given_on',     'closed_on',   'status,notes'),
      ('loan_repayments',          'repaid_on',    null,          null),
      ('employee_loans',           'disbursed_on', '',            'status,notes'),
      ('employee_loan_repayments', 'repaid_on',    null,          null),
      ('business_loans',           'disbursed_on', '',            'status,notes'),
      ('business_loan_payments',   'paid_on',      null,          null),
      ('emi_purchases',            'purchased_on', '',            'status,notes'),
      ('emi_payments',             'paid_on',      null,          null),
      ('reimbursements',           'incurred_on',  'settled_on',  'status,settled_notes,expense_id,receipt_path'),
      ('balance_sheet_items',      'created_at',   '',            'notes,sort_order'),
      ('opening_balances',         'as_of',        '',            'notes,updated_by')
    ) as v(tbl, col, later, free)
  loop
    if to_regclass('public.' || t.tbl) is null then
      raise notice 'R-1584: table % not found — skipped', t.tbl;
      continue;
    end if;
    execute format('drop trigger if exists trg_books_lock on public.%I', t.tbl);
    if t.later is null then
      execute format(
        'create trigger trg_books_lock before insert or update or delete on public.%I for each row execute function public.tg_books_locked(%L)',
        t.tbl, t.col);
    else
      execute format(
        'create trigger trg_books_lock before insert or update or delete on public.%I for each row execute function public.tg_books_locked(%L, %L, %L)',
        t.tbl, t.col, t.later, t.free);
    end if;
  end loop;
end $$;

commit;
