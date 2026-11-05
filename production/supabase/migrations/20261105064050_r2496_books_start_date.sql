-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'books_start_date') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_books_start_date(date)') and prosrc like '%R-2496%') and to_regprocedure('public.books_start_for(uuid)') is not null and exists(select 1 from pg_trigger where tgname = 'r2496_books_start_guard' and tgrelid = to_regclass('public.tenants'))
-- R-2496 (goal G-FY2526, owner decision 5 Nov 2026: Excel's books start 1 Apr 2025) — ONE
-- per-company books start, read everywhere instead of guessing "1 Apr 2026" from an invoice
-- number, a bank line's year or a hard-coded date.
--
--   1. tenants.books_start_date (date, null = not set) — the first day whose money lives in the app.
--   2. books_start_for(tenant) — the setting, else the CA's opening balances date + 1 (what the app
--      used before), else null. SECURITY INVOKER: a login only sees its own company's rows (RLS);
--      the server's admin client passes its own tenant. TS twin: src/lib/accounting/books-start.ts.
--   3. set_books_start_date(date) — the OWNER only (it moves what the reports and Reconcile from Zoho
--      count as "before the books"). Refused: no company (28000), not the owner (42501), a future
--      date, or a date LATER than a money row already in the books (that row would fall outside the
--      books) — invoices (not opening invoices, which are dated before the start on purpose),
--      receipts, credit / debit notes, expenses, vendor bills, salaries, tax payments, project
--      receipts, statutory dues, prepaid advances, capital / drawings, loan repayments. Bank lines and
--      fixed assets (bought before the books, carried at WDV) are not checked: bank lines before the
--      account's opening date are allowed (R-2497). NULL clears it. It does NOT stop a later entry
--      dated before the start — that is the books lock's job (R-2506 locks to 31 Mar 2026).
--      Each change writes one activity_log row (action books.start_date_set,
--      changes {books_start_date: {old, new}} — the shape the Activity page shows).
--   4. r2496_books_start_guard — a direct table write (the owner's tenants_self_update) cannot change
--      books_start_date; only the function (SECURITY DEFINER: not a request login) or the server.
-- opening_balances.as_of should equal books start − 1; the Balance Sheet warns when not (no
-- data is changed here). Test: supabase/tests/r2496_books_start_date.test.sql (rolled back).

begin;

alter table public.tenants add column if not exists books_start_date date;

comment on column public.tenants.books_start_date is
  'R-2496: first day of the company''s books in the app (e.g. 2025-04-01). NULL = not set → books_start_for() falls back to opening_balances.as_of + 1. Written only by set_books_start_date() (owner).';

create or replace function public.books_start_for(p_tenant uuid)
returns date
language sql
stable
security invoker
set search_path = public
as $function$
  /* R-2496: the setting, else the day after the CA's opening balances date, else null. */
  select coalesce(
    (select t.books_start_date from public.tenants t where t.id = p_tenant),
    (select max(ob.as_of) + 1 from public.opening_balances ob where ob.tenant_id = p_tenant)
  );
$function$;

comment on function public.books_start_for(uuid) is
  'R-2496: the company''s books start — tenants.books_start_date, else opening_balances.as_of + 1, else NULL. Security invoker (RLS applies).';

revoke all on function public.books_start_for(uuid) from public, anon;
grant execute on function public.books_start_for(uuid) to authenticated, service_role;

create or replace function public.set_books_start_date(p_date date)
returns date
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  /* R-2496 */
  v_tenant  uuid := public.current_tenant_id();
  v_current date;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_first   date;
  v_what    text;
begin
  if v_tenant is null then
    raise exception 'Sign in to your company to change the books start date.'
      using errcode = '28000';
  end if;

  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can change the books start date.'
      using errcode = '42501';
  end if;

  if p_date is not null and p_date > v_today then
    raise exception 'The books start date cannot be a future date.'
      using errcode = '22023';
  end if;

  select t.books_start_date into v_current
    from public.tenants t where t.id = v_tenant
    for update;

  if p_date is not distinct from v_current then
    return p_date;
  end if;

  if p_date is not null then
    select d, what into v_first, v_what from (
      select min(i.invoice_date) as d, 'an invoice' as what from public.invoices i
       where i.tenant_id = v_tenant and i.document_kind is distinct from 'opening_invoice'
      union all
      select min((p.received_at at time zone 'Asia/Kolkata')::date), 'a receipt' from public.payments p
       where p.tenant_id = v_tenant
      union all
      select min(c.credit_date), 'a credit note' from public.credit_notes c where c.tenant_id = v_tenant
      union all
      select min(d.debit_date), 'a debit note' from public.debit_notes d where d.tenant_id = v_tenant
      union all
      select min(e.expense_date), 'an expense' from public.expenses e where e.tenant_id = v_tenant
      union all
      select min(b.bill_date), 'a vendor bill' from public.vendor_bills b where b.tenant_id = v_tenant
      union all
      select min(s.pay_date), 'a salary payment' from public.salary_payments s where s.tenant_id = v_tenant
      union all
      select min(x.paid_on), 'a tax payment' from public.tax_payments x where x.tenant_id = v_tenant
      union all
      select min(pp.received_at), 'a project receipt' from public.project_payments pp where pp.tenant_id = v_tenant
      union all
      select min(sd.paid_on), 'a statutory dues payment' from public.statutory_dues_payments sd where sd.tenant_id = v_tenant
      union all
      select min(pa.paid_date), 'a prepaid advance' from public.prepaid_advances pa where pa.tenant_id = v_tenant
      union all
      select min(om.movement_date), 'a capital / drawings entry' from public.owner_equity_movements om where om.tenant_id = v_tenant
      union all
      select min(lr.repaid_on), 'a loan repayment' from public.loan_repayments lr where lr.tenant_id = v_tenant
    ) m
    where d is not null
    order by d
    limit 1;

    if v_first is not null and p_date > v_first then
      raise exception 'The books already have % dated %, before %. Pick a date on or before %.',
        v_what, to_char(v_first, 'FMDD Mon YYYY'), to_char(p_date, 'FMDD Mon YYYY'), to_char(v_first, 'FMDD Mon YYYY')
        using errcode = '22023';
    end if;
  end if;

  update public.tenants set books_start_date = p_date where id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'books.start_date_set', 'tenant', v_tenant::text,
          case when p_date is null then 'Books start date cleared'
               else 'Books start date set to ' || to_char(p_date, 'FMDD Mon YYYY') end,
          jsonb_build_object('books_start_date', jsonb_build_object('old', v_current, 'new', p_date)));

  return p_date;
end;
$function$;

comment on function public.set_books_start_date(date) is
  'R-2496: the owner sets (or clears with NULL) the company''s books start. Refuses a future date or a date after a money row already in the books; logs books.start_date_set in activity_log.';

revoke all on function public.set_books_start_date(date) from public, anon;
grant execute on function public.set_books_start_date(date) to authenticated, service_role;

create or replace function public.r2496_books_start_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2496: only set_books_start_date() (SECURITY DEFINER) or the server changes the books start. */
  if public.is_direct_request_login()
     and new.books_start_date is distinct from old.books_start_date then
    raise exception 'The books start date is changed only from Accounting → Overview → Books start (owner).'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.r2496_books_start_guard() from public, anon, authenticated;

drop trigger if exists r2496_books_start_guard on public.tenants;
create trigger r2496_books_start_guard
  before update of books_start_date on public.tenants
  for each row execute function public.r2496_books_start_guard();

commit;
