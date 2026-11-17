-- deploy-peek: to_regprocedure('public._r2911_is_salary_account(text)') is not null and to_regprocedure('public._r2911_words(text)') is not null and to_regprocedure('public._r2911_names(text,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_purchases(text,text,jsonb,boolean)') and prosrc like '%Payroll already books this salary%') and to_regprocedure('public._r2911_covers(text,date,date)') is not null
-- deploy-key: r2911zohosalaryvspayroll
-- R-2911 (17 Nov 2026, p0 paisa, G-FY2526) — corrects R-2681's salary part.
-- R-2681 refused every Zoho salary ("Payroll books salaries") on the owner's assumption that Prashant's
-- salary is in Payroll. A staging check on 17 Nov showed the company's Payroll has NO payslip before
-- Jun 2026, so for FY 2025-26 Zoho's salary expenses (~Rs 45.6L salary-type, Prashant's 9 rows Rs 1.52L)
-- are the ONLY salary record — refusing them drops real cost from the FY 2025-26 books. Pardeep, 17 Nov:
-- "jo logically thik ho wo kro". The rule now:
--   1. A line on an UNMAPPED Zoho account whose NAME says salary ("salar…" or the word "wage(s)" at a
--      word start — _r2911_is_salary_account; not "Sewage", not "Payroll processing fees") is category
--      Salaries (Salaries can never be mapped), not "unmapped". R-2681's type rule still runs first:
--      "Salary advance" (asset) / "Salary payable" (liability) stay "Not an expense".
--   2. A Salaries leg on a Zoho BILL stays out (an unpaid Salaries row has no pay path); a Salaries leg
--      with TDS stays out (salary TDS 192 is Payroll's).
--   3. Any line on a salary-named account (mapped too, e.g. to Director's Remuneration) is checked
--      against Payroll: a payslip (salary_payments) covers the row when its period is the row's month,
--      or the month before AND it was paid within 7 days of the row (_r2911_covers). The payee (vendor
--      name + reference + line descriptions) names an employee (whole name, or first word of 3+ letters,
--      as whole words — _r2911_names) with a covering payslip → refused "Payroll already books this
--      salary …"; named employees without one → it comes in; the payee names nobody → it comes in only
--      when no payslip of anyone covers the row (else refused: add it by hand).
-- R-2681's other refusals (types not read, not an expense type, a line with no account, unmapped
-- non-salary account), R-2676 (no vendor) and everything else are unchanged; the "not an expense"
-- sentence now reads "in Zoho, "X" is an account of type "other current asset"" (was "is a other ...").
-- Stored data is not changed. Body = 20261117125913_r2681 + the R-2911 lines. Preview mirror:
-- src/lib/integrations/zoho-books/purchase-import/account-types.ts salaryPayrollRefusal.
-- Test: supabase/tests/r2911_zoho_salary_vs_payroll.test.sql.
begin;

create or replace function public._r2911_is_salary_account(p_name text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2911: the same pattern as purchase-import/account-types.ts isSalaryAccount ("salar…" or the word
     "wage(s)", each at a word start). */
  select coalesce(p_name ~* '\m(salar|wages?\M)', false);
$function$;
revoke all on function public._r2911_is_salary_account(text) from public, anon;
grant execute on function public._r2911_is_salary_account(text) to authenticated, service_role;

create or replace function public._r2911_covers(p_period text, p_pay_date date, p_date date)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2911: does this payslip pay the salary a Zoho row dated p_date records? Its period is the row's
     month, or the month before AND it was paid within 7 days of the row (account-types.ts payslipCovers). */
  select coalesce(p_period = to_char(p_date, 'YYYY-MM')
               or (p_period = to_char(p_date - interval '1 month', 'YYYY-MM') and abs(p_pay_date - p_date) <= 7), false);
$function$;
revoke all on function public._r2911_covers(text, date, date) from public, anon;
grant execute on function public._r2911_covers(text, date, date) to authenticated, service_role;

create or replace function public._r2911_words(p text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2911: lower case, every run of other characters one space, padded with one space each side
     (account-types.ts words). */
  select ' ' || btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g')) || ' ';
$function$;
revoke all on function public._r2911_words(text) from public, anon;
grant execute on function public._r2911_words(text) to authenticated, service_role;

create or replace function public._r2911_names(p_employee text, p_payee_words text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2911: does the payee text (already _r2911_words) name this employee — the whole name, or its
     first word when that has 3+ letters, as whole words (account-types.ts employeesNamed). */
  select n <> ''
     and (position(' ' || n || ' ' in p_payee_words) > 0
          or (char_length(split_part(n, ' ', 1)) >= 3 and position(' ' || split_part(n, ' ', 1) || ' ' in p_payee_words) > 0))
    from (select btrim(public._r2911_words(p_employee)) as n) x;
$function$;
revoke all on function public._r2911_names(text, text) from public, anon;
grant execute on function public._r2911_names(text, text) to authenticated, service_role;

create or replace function public.import_zoho_fy_purchases(p_kind text, p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2502 — R-2502c: vendor GSTIN rule + change log, duplicate check, TDS spread, paid-from account, fingerprint;
     R-2629: the Zoho reference_number kept in the notes (" Ref: …") — notes are not in the fingerprint;
     R-2676: a Zoho EXPENSE with no vendor comes in as a vendor-less expense (every line on a mapped
     expense account, no GST claim / RCM / TDS, not already booked without a vendor);
     R-2681: Zoho's own account TYPE (zoho_account_types) must be an expense type on every line, even
     when the owner mapped it (fail closed when not read); an unmapped account leaves the document out
     (owner, 17 Nov: no more "Unmapped — review" landing);
     R-2911: a line on a SALARY account (by its Zoho name — Salaries can never be mapped) is Salaries, not
     unmapped; the document is refused only when Payroll already books that salary for the month (the
     payee names an employee with a payslip for it, or names no employee while Payroll has payslips that
     month) — for FY 2025-26 Zoho is the only salary record (Payroll starts Jun 2026) */
  v_tenant   uuid := public.current_tenant_id();
  v_create   boolean;
  v_no_vendor boolean;
  v_n_nov    integer := 0;
  v_unmapped text;
  v_bad_name text;
  v_bad_type text;
  v_payee    text;
  v_hit      text;
  v_acct     public.bank_accounts;
  v_book     integer;
  v_dup      text;
  v_tx_all   integer;
  v_tds_leg  integer;
  v_tds_left integer;
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_key      text;
  v_num      text;
  v_date     date;
  v_due      date;
  v_status   text;
  v_reason   text;
  v_vendor   public.vendors;
  v_gstin    text;
  v_valid_g  boolean;
  v_legs     jsonb;
  v_leg      jsonb;
  v_n_legs   integer;
  v_cogs     integer;
  v_cost     integer;
  v_rcm      boolean;
  v_tds      integer;
  v_tsec     text;
  v_taxable  integer;
  v_tax      integer;
  v_amount   integer;
  v_i        integer;
  v_ids      text[];
  v_hash     text;
  v_new_v    integer := 0;
  v_seen     text[] := array[]::text[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_tx   bigint := 0;
  v_sum_tax  bigint := 0;
  v_sum_amt  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing purchases needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY purchases from Zoho. Ask one of them.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('bills', 'expenses') then
    raise exception 'Choose bills or expenses.' using errcode = '22023';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$' or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There is nothing to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many documents in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2502 at the end, so the batch, every row, every vendor made and
     every trigger's work roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, p_kind, p_fy, auth.uid())
  returning id into v_batch;
  /* Only this import may write the Zoho id / batch on expenses and vendor_bills (tg_purchases_zoho_doc_guard). */
  perform set_config('app.zoho_purchase_import', 'on', true);

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_id', ''));
    v_key := p_kind || ':' || v_zid;
    v_reason := null;
    v_scan := null;
    v_num := v_zid;

    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = p_kind and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then
        v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
      end if;
    end if;

    if v_reason is null then
      v_p      := v_scan.payload;
      v_num    := btrim(coalesce(v_p->>'number', ''));
      v_status := lower(coalesce(v_p->>'status', ''));
      v_rcm    := coalesce((v_p->>'rcm')::boolean, false);
      begin
        v_date := (v_p->>'date')::date;
        v_due  := nullif(v_p->>'dueDate', '')::date;
        v_tds  := coalesce((v_p->>'tdsAmount')::integer, 0);
      exception when others then
        v_reason := 'Its date or amounts could not be read — read it from Zoho again.';
      end;
      v_tsec := nullif(v_p->>'tdsSection', '');
    end if;

    if v_reason is null then
      if v_status = 'void' then v_reason := 'Void in Zoho — not a purchase, not in the P&L or ITC.';
      elsif v_status = 'draft' then v_reason := 'Draft in Zoho — never booked there.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif char_length(v_num) > 60 then v_reason := 'The Zoho number is longer than 60 characters.';
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_tds < 0 or (v_tds > 0 and v_tsec is null) then
        v_reason := 'Its TDS has no section.';
      end if;
    end if;

    -- Already here (same Zoho id) → already (a rerun).
    if v_reason is null then
      if exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id = v_key)
         or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id = v_key) then
        v_already := v_already + 1;
        continue;
      end if;
    end if;

    -- Legs: one per category (the company's map; R-2911: a salary account → Salaries; else unmapped →
    -- "Unmapped — review", which R-2681 leaves out below), first-seen order.
    if v_reason is null then
      select coalesce(jsonb_agg(jsonb_build_object(
               'category', g.category, 'taxable', g.taxable, 'gst', g.gst, 'cost_gst', g.cost_gst, 'rcm_tax', g.rcm_tax,
               'lines', g.lines) order by g.first_ord), '[]'::jsonb)
        into v_legs
        from (
          select c.category,
                 sum(coalesce((x.l->>'taxable')::integer, 0)) as taxable,
                 sum(case when not v_rcm and coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as gst,
                 sum(case when not v_rcm and not coalesce((x.l->>'itcEligible')::boolean, true) then coalesce((x.l->>'tax')::integer, 0) else 0 end) as cost_gst,
                 sum(case when v_rcm then coalesce((x.l->>'tax')::integer, 0) else 0 end) as rcm_tax,
                 min(x.ord) as first_ord,
                 jsonb_agg(x.l order by x.ord) as lines
            from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
            left join public.zoho_account_category_map m
              on m.tenant_id = v_tenant and m.zoho_account_id = coalesce(x.l->>'accountId', '')
            /* R-2502c: a map row saved before the whitelist (any text) counts as unmapped. */
            cross join lateral (select coalesce(case when public._r2502_category_allowed(m.category) then m.category end,
                                                case when public._r2911_is_salary_account(x.l->>'accountName') then 'Salaries' end,
                                                'Unmapped — review') as category) c
           group by c.category
        ) g;
      v_n_legs := jsonb_array_length(v_legs);
      select count(*) filter (where (l->>'category') like 'COGS-%'), coalesce(sum((l->>'cost_gst')::integer), 0)
        into v_cogs, v_cost from jsonb_array_elements(v_legs) l;
      if v_n_legs = 0 then v_reason := 'It has no lines or account in Zoho.';
      elsif v_cogs > 0 and v_cogs < v_n_legs then v_reason := 'It has COGS and expense lines — add it by hand, or map its accounts to one kind.';
      elsif v_cogs > 0 and p_kind = 'expenses' then v_reason := 'A Zoho expense on a COGS account — add it as a COGS bill by hand.';
      elsif v_cogs > 0 and v_rcm then v_reason := 'A COGS bill under reverse charge — add it by hand.';
      elsif v_cogs > 0 and v_cost > 0 then v_reason := 'A COGS bill with ineligible ITC — add it by hand.';
      end if;
    end if;
    /* R-2681: Zoho's own account TYPE first — a fixed deposit, loan, GST, asset, advance or bank account
       is never an expense, whatever the owner mapped it to (the map is shared with bills and editable).
       Fail closed: the company's types never read, or this account missing from them → left out. */
    if v_reason is null then
      if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) x(l)
                  where btrim(coalesce(x.l->>'accountId', '')) = '') then
        v_reason := 'A line has no account in Zoho — add it by hand.';
      elsif not exists (select 1 from public.zoho_account_types t where t.tenant_id = v_tenant) then
        v_reason := 'Zoho account types are not read yet — press Read from Zoho again, then preview again.';
      else
        v_bad_name := null; v_bad_type := null;
        select coalesce(nullif(btrim(x.l->>'accountName'), ''), nullif(btrim(x.l->>'accountId'), ''), '?'), t.account_type
          into v_bad_name, v_bad_type
          from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
          left join public.zoho_account_types t
            on t.tenant_id = v_tenant and t.zoho_account_id = coalesce(x.l->>'accountId', '')
         where t.account_type is null or not public._r2681_is_expense_type(t.account_type)
         order by (t.account_type is null), x.ord
         limit 1;
        if v_bad_name is not null and v_bad_type is null then
          v_reason := format('Zoho''s account type for "%s" is not read yet — press Read from Zoho again, then preview again.', v_bad_name);
        elsif v_bad_name is not null then
          v_reason := format('Not an expense — needs another path: in Zoho, "%s" is an account of type "%s". Fixed deposits, loans, GST, assets and advances are never booked as an expense.', v_bad_name, replace(v_bad_type, '_', ' '));
        end if;
      end if;
    end if;

    /* R-2681 (owner, 17 Nov): a line on an unmapped account leaves the whole document out — listed in the
       preview's Unmapped list, never "Unmapped — review" in the books. R-2911: a salary account is not
       unmapped (it is Salaries — the Payroll rule below). A Zoho EXPENSE with no vendor keeps R-2676's own
       sentence (it says the same: left out). */
    if v_reason is null then
      select coalesce(nullif(btrim(x.l->>'accountName'), ''), nullif(btrim(x.l->>'accountId'), ''), '?')
        into v_unmapped
        from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
        left join public.zoho_account_category_map m
          on m.tenant_id = v_tenant and m.zoho_account_id = coalesce(x.l->>'accountId', '')
       where not coalesce(public._r2502_category_allowed(m.category), false)
         and not public._r2911_is_salary_account(x.l->>'accountName')
       order by x.ord
       limit 1;
      if v_unmapped is not null then
        if p_kind = 'expenses' and btrim(coalesce(v_p->>'vendorName', '')) = '' and btrim(coalesce(v_p->>'vendorZohoId', '')) = '' then
          v_reason := format('Zoho account "%s" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST or asset payment is not an expense and stays out.', v_unmapped);
        else
          v_reason := format('Zoho account "%s" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.', v_unmapped);
        end if;
      end if;
      v_unmapped := null;
    end if;

    /* R-2911 — the same sentences, in the same order, as purchase-import/plan.ts + account-types.ts:
       1. a Salaries leg (an unmapped salary account) on a Zoho BILL stays out (an unpaid Salaries row has
          no pay path); 2. a Salaries leg with TDS stays out (salary TDS 192 is Payroll's);
       3. ANY line on a salary-named account (mapped or not) is checked against Payroll: a payslip covers
          the row when its period is the row's month, or the month before AND it was paid within 7 days
          of the row (_r2911_covers). The payee (Zoho vendor name + reference + line descriptions) names an
          employee (_r2911_names) with a covering payslip → refused; it names employees, none covered →
          comes in; it names nobody → comes in only when no payslip of anyone covers the row. */
    if v_reason is null then
      if exists (select 1 from jsonb_array_elements(v_legs) l where l->>'category' = 'Salaries') and p_kind = 'bills' then
        v_reason := 'A Zoho salary bill stays out — an unpaid salary has no pay path in the app. Pay it in Payroll, or add it by hand as a paid expense.';
      elsif exists (select 1 from jsonb_array_elements(v_legs) l where l->>'category' = 'Salaries') and v_tds <> 0 then
        v_reason := 'A Zoho salary with TDS stays out — salary TDS (section 192) is booked by Payroll. Add this salary in Payroll.';
      elsif exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) x(l)
                     where public._r2911_is_salary_account(x.l->>'accountName')) then
        v_payee := public._r2911_words(coalesce(v_p->>'vendorName', '') || ' ' || coalesce(v_p->>'reference', '') || ' ' ||
          coalesce((select string_agg(coalesce(x.l->>'description', ''), ' ')
                      from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) x(l)), ''));
        v_hit := null;
        if exists (select 1 from public.employees e where e.tenant_id = v_tenant and public._r2911_names(e.name, v_payee)) then
          select format('Payroll already books this salary — %s''s payslip for %s (paid %s) is in Payroll, so this Zoho salary is not imported (it would count twice). If it is a different payment, add it by hand.',
                        e.name, to_char(to_date(sp.period, 'YYYY-MM'), 'Mon YYYY'), to_char(sp.pay_date, 'DD Mon YYYY'))
            into v_hit
            from public.employees e
            join public.salary_payments sp on sp.tenant_id = v_tenant and sp.employee_id = e.id and public._r2911_covers(sp.period, sp.pay_date, v_date)
           where e.tenant_id = v_tenant and public._r2911_names(e.name, v_payee)
           order by e.name collate "C", e.id::text collate "C", sp.period collate "C", sp.pay_date
           limit 1;
        else
          select format('Payroll has salaries for %s and Zoho''s payee is not an employee in Payroll — add it by hand if it is someone else (it could count twice).',
                        to_char(to_date(sp.period, 'YYYY-MM'), 'Mon YYYY'))
            into v_hit
            from public.salary_payments sp
           where sp.tenant_id = v_tenant and public._r2911_covers(sp.period, sp.pay_date, v_date)
           order by sp.period collate "C", sp.pay_date
           limit 1;
        end if;
        v_reason := v_hit;
      end if;
    end if;

    -- Vendor: the preview's pick (this company's), else Zoho contact id → GSTIN → the one vendor with
    -- that exact name whose GSTIN is empty or the same (R-2502c: never a vendor with another GSTIN),
    -- else made from Zoho — but only after the duplicate check below.
    if v_reason is null then
      v_vendor := null; v_create := false; v_no_vendor := false;
      v_gstin := upper(regexp_replace(coalesce(v_p->>'gstin', ''), '[\s.\-]+', '', 'g'));
      v_valid_g := v_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';
      if nullif(v_pick->>'vendor_id', '') is not null then
        if (v_pick->>'vendor_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_reason := 'The vendor picked is not in your company — preview again.';
        else
          select * into v_vendor from public.vendors v where v.id = (v_pick->>'vendor_id')::uuid and v.tenant_id = v_tenant;
          if not found then v_reason := 'The vendor picked is not in your company — preview again.';
          elsif v_valid_g and coalesce(upper(regexp_replace(v_vendor.gstin, '[\s.\-]+', '', 'g')), '') not in ('', v_gstin) then
            v_reason := format('%s has GSTIN %s in the app, but Zoho''s bill says %s — preview again (a new vendor will be made).', v_vendor.name, v_vendor.gstin, v_gstin);
          end if;
        end if;
      else
        select * into v_vendor from public.vendors v
         where v.tenant_id = v_tenant and v.zoho_contact_id = nullif(v_p->>'vendorZohoId', '');
        if not found and v_valid_g then
          select * into v_vendor from public.vendors v
           where v.tenant_id = v_tenant and upper(regexp_replace(coalesce(v.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin
           order by v.created_at limit 1;
        end if;
        if v_vendor.id is null and (select count(*) from public.vendors v where v.tenant_id = v_tenant
                                      and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')))
                                      and (not v_valid_g or coalesce(upper(regexp_replace(v.gstin, '[\s.\-]+', '', 'g')), '') in ('', v_gstin))) = 1 then
          select * into v_vendor from public.vendors v
           where v.tenant_id = v_tenant and lower(btrim(v.name)) = lower(btrim(coalesce(v_p->>'vendorName', '')))
             and (not v_valid_g or coalesce(upper(regexp_replace(v.gstin, '[\s.\-]+', '', 'g')), '') in ('', v_gstin));
        end if;
        if v_vendor.id is null then
          if btrim(coalesce(v_p->>'vendorName', '')) <> '' then v_create := true;
          elsif p_kind <> 'expenses' then v_reason := 'It has no vendor in Zoho.';   -- a bill is a payable: it needs its vendor
          else
            /* R-2676 no-vendor rule: a Zoho expense with no vendor (petty spends, bank charges, fees) is a
               vendor-less expense. A balance-sheet account (fixed deposit, loan, GST, asset) is kept out
               by asking that EVERY line's account is mapped by the owner to an expense category (R-2911:
               or is a salary account, Salaries) — never "Unmapped — review" here. Input GST,
               reverse charge and TDS need the supplier, so those stay out too. */
            v_no_vendor := true;
            select coalesce(nullif(btrim(l->'lines'->0->>'accountName'), ''), nullif(btrim(l->'lines'->0->>'accountId'), ''), '?')
              into v_unmapped
              from jsonb_array_elements(v_legs) l where l->>'category' = 'Unmapped — review' limit 1;
            if v_unmapped is not null then
              v_reason := format('Zoho account "%s" is not mapped to an expense category — map it only if it is an expense. A fixed deposit, loan, GST or asset payment is not an expense and stays out.', v_unmapped);
            elsif v_rcm or exists (select 1 from jsonb_array_elements(v_legs) l where (l->>'gst')::integer <> 0 or (l->>'rcm_tax')::integer <> 0) then
              v_reason := 'It claims input GST (or reverse charge) but has no vendor in Zoho — add the vendor in Zoho, or add it by hand with the supplier.';
            elsif v_tds <> 0 then
              v_reason := 'It has TDS but no vendor in Zoho — add the vendor in Zoho, or add it by hand.';
            end if;
          end if;
        end if;
      end if;
    end if;

    -- R-2502c: a Zoho expense is booked against the app account its paid-through account maps to.
    if v_reason is null and p_kind = 'expenses' then
      v_acct := null;
      if nullif(v_pick->>'account_id', '') is not null and (v_pick->>'account_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select * into v_acct from public.bank_accounts ba
         where ba.id = (v_pick->>'account_id')::uuid and ba.tenant_id = v_tenant and coalesce(ba.is_active, true) and ba.closed_on is null;
      end if;
      if v_acct.id is null then
        v_reason := format('Choose the app account for Zoho''s "%s" (paid from) — petty cash, card or bank.', coalesce(nullif(v_p->>'paidThrough', ''), '(no account in Zoho)'));
      end if;
    end if;

    -- R-2502c: already in the books without a Zoho id? Same vendor (or GSTIN) + date ±3 days + amount (±₹1).
    if v_reason is null then
      v_book := case when v_cogs > 0 then (v_p->>'taxable')::integer + (v_p->>'tax')::integer
                     else (select coalesce(sum((l->>'taxable')::integer + (l->>'gst')::integer + (l->>'cost_gst')::integer), 0) from jsonb_array_elements(v_legs) l) end;
      /* The same number of the same vendor first (the clearer reason). */
      if v_num <> '' and v_vendor.id is not null and (
           exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.zoho_doc_id is null and e.vendor_id = v_vendor.id and upper(btrim(e.bill_no)) = upper(v_num))
        or exists (select 1 from public.vendor_bills b where b.tenant_id = v_tenant and b.zoho_doc_id is null and b.vendor_id = v_vendor.id and upper(btrim(b.bill_no)) = upper(v_num))) then
        v_reason := format('Bill %s of %s is already in the books (entered by hand) — not imported twice.', v_num, v_vendor.name);
      end if;
    end if;
    if v_reason is null then
      select x.ref into v_dup from (
        select coalesce(e.bill_no, e.id) || ' (' || to_char(e.expense_date, 'DD Mon YYYY') || ', ₹' || e.amount || ')' as ref
          from public.expenses e left join public.vendors vv on vv.id = e.vendor_id
         where e.tenant_id = v_tenant and e.zoho_doc_id is null and e.category <> 'Salaries'
           and e.expense_date between v_date - 3 and v_date + 3 and abs(e.amount - v_book) <= 1
           and ((v_vendor.id is not null and e.vendor_id = v_vendor.id)
             or (v_valid_g and upper(regexp_replace(coalesce(vv.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin))
        union all
        select coalesce(b.bill_no, b.id) || ' (' || to_char(b.bill_date, 'DD Mon YYYY') || ', ₹' || b.total || ')'
          from public.vendor_bills b left join public.vendors vv on vv.id = b.vendor_id
         where b.tenant_id = v_tenant and b.zoho_doc_id is null
           and b.bill_date between v_date - 3 and v_date + 3 and abs(b.total - v_book) <= 1
           and ((v_vendor.id is not null and b.vendor_id = v_vendor.id)
             or (v_valid_g and upper(regexp_replace(coalesce(coalesce(vv.gstin, b.vendor_gstin), ''), '[\s.\-]+', '', 'g')) = v_gstin))
        limit 1) x;
      if v_dup is not null then
        v_reason := format('Looks already in the books (not from Zoho): %s — same vendor, ±3 days, same amount. Check it; delete one by hand if it is the same purchase.', v_dup);
      end if;
    end if;

    -- R-2676: a no-vendor expense already in the books without a Zoho id. Two looks, both fail closed:
    --   (a) a vendor-less expense row — booked from the bank line (the no-vendor sheet) or by hand —
    --       ±3 days, same amount (±₹1), paid from the same account (or with no account). A Salaries
    --       row counts too: a pay-out Payroll booked must not come in again as a Zoho expense.
    --   (b) a debit of that amount in the paid-from account, ±3 days, that is ALREADY reconciled as
    --       something that is not a Zoho document (a vendor's bill / expense, a salary, a recorded
    --       payment's stand-in line …) — the spend is in the books whatever it was booked as. An own
    --       transfer is not a spend and is not counted.
    if v_reason is null and v_no_vendor then
      v_dup := null;
      select coalesce(e.bill_no, e.id) || ' (' || to_char(e.expense_date, 'DD Mon YYYY') || ', ₹' || e.amount || ')' into v_dup
        from public.expenses e
       where e.tenant_id = v_tenant and e.zoho_doc_id is null
         and e.vendor_id is null
         and e.expense_date between v_date - 3 and v_date + 3 and abs(e.amount - v_book) <= 1
         and (e.bank_account_id = v_acct.id
              or exists (select 1 from public.bank_transactions t
                          where t.id = e.reconciled_txn_id and t.tenant_id = v_tenant and t.bank_account_id = v_acct.id)
              or (e.bank_account_id is null and e.reconciled_txn_id is null))
       order by abs(e.expense_date - v_date), e.id limit 1;
      if v_dup is not null then
        v_reason := format('Looks already in the books (not from Zoho): %s — no vendor, same paid-from account, ±3 days, same amount. Check it; delete one by hand if it is the same purchase.', v_dup);
      else
        select to_char(t.txn_date, 'DD Mon YYYY') || ', ₹' || t.debit || ', reconciled as ' || replace(t.matched_to_type, '_', ' ') into v_dup
          from public.bank_transactions t
         where t.tenant_id = v_tenant and t.bank_account_id = v_acct.id
           and coalesce(t.debit, 0) > 0 and coalesce(t.credit, 0) = 0
           and abs(t.debit - v_book) <= 1 and t.txn_date between v_date - 3 and v_date + 3
           and t.matched_to_type is not null and t.matched_to_type <> 'transfer'
           and not exists (select 1 from public.expenses z
                            where z.tenant_id = v_tenant and z.zoho_doc_id is not null and z.reconciled_txn_id = t.id)
           and not exists (select 1 from public.bank_vendor_payment_lines pl
                            join public.expenses z on z.id = pl.expense_id and z.tenant_id = v_tenant
                           where pl.bank_txn_id = t.id and z.zoho_doc_id is not null)
         order by abs(t.txn_date - v_date), t.id limit 1;
        if v_dup is not null then
          v_reason := format('Looks already in the books: a debit in %s (%s) of the same amount, ±3 days. If it is this expense it would be counted twice — check it; add it by hand if it is another payment.', v_acct.name, v_dup);
        end if;
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    v_hash := upper(substr(md5(v_tenant::text || ':' || v_key), 1, 12));
    v_taxable := 0; v_tax := 0; v_amount := 0; v_ids := array[]::text[];
    begin
      /* The vendor is made / filled here, with the document: if the document is refused below, the
         vendor change rolls back with it (logged per batch — undo reverses it). */
        if v_create then
          insert into public.vendors (tenant_id, name, gstin, zoho_contact_id, notes)
          /* Vendor names are unique per company: a same-named supplier with another GSTIN gets its GSTIN in the name. */
          values (v_tenant,
                  case when exists (select 1 from public.vendors v where v.tenant_id = v_tenant and lower(btrim(v.name)) = lower(btrim(v_p->>'vendorName')))
                       then left(btrim(v_p->>'vendorName'), 170) || ' (' || case when v_valid_g then v_gstin else coalesce(nullif(v_p->>'vendorZohoId', ''), 'Zoho') end || ')'
                       else left(btrim(v_p->>'vendorName'), 200) end,
                  case when v_valid_g then v_gstin end,
                  case when nullif(v_p->>'vendorZohoId', '') is not null
                        and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.zoho_contact_id = v_p->>'vendorZohoId')
                       then v_p->>'vendorZohoId' end,
                  'Created from Zoho Books by the FY purchase import.')
          returning * into v_vendor;
          insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, created) values (v_tenant, v_batch, v_vendor.id, true);
        elsif v_vendor.id is not null then
          /* Only FILL an empty Zoho contact id / GSTIN — never overwrite one. (R-2676: no vendor → nothing to fill.) */
          if v_vendor.zoho_contact_id is null and nullif(v_p->>'vendorZohoId', '') is not null
             and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.zoho_contact_id = v_p->>'vendorZohoId') then
            update public.vendors set zoho_contact_id = v_p->>'vendorZohoId' where id = v_vendor.id returning * into v_vendor;
            insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, set_zoho_contact_id) values (v_tenant, v_batch, v_vendor.id, v_p->>'vendorZohoId');
          end if;
          /* The ITC rule reads the GSTIN from the vendor master (lib/gst/itc.ts): an empty one is filled. */
          if v_valid_g and coalesce(btrim(v_vendor.gstin), '') = ''
             and not exists (select 1 from public.vendors v where v.tenant_id = v_tenant and v.id <> v_vendor.id
                               and upper(regexp_replace(coalesce(v.gstin, ''), '[\s.\-]+', '', 'g')) = v_gstin) then
            update public.vendors set gstin = v_gstin where id = v_vendor.id returning * into v_vendor;
            insert into public.zoho_purchase_vendor_changes (tenant_id, batch_id, vendor_id, set_gstin) values (v_tenant, v_batch, v_vendor.id, v_gstin);
          end if;
        end if;
      if v_cogs > 0 then
        -- ONE COGS bill; its category = the largest leg's (one leg in practice).
        select l into v_leg from jsonb_array_elements(v_legs) l order by (l->>'taxable')::integer desc limit 1;
        v_taxable := (v_p->>'taxable')::integer;
        v_tax := (v_p->>'tax')::integer;
        v_amount := v_taxable + v_tax;
        insert into public.vendor_bills (
          id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, line_items,
          subtotal, cgst, sgst, igst, total, status, paid_amount, currency, fx_rate, document_type, notes,
          zoho_doc_id, purchase_import_batch_id, zoho_tds_amount, zoho_tds_section)
        values (
          'BILL-Z-' || v_hash, v_tenant, v_vendor.id, v_vendor.name, case when v_valid_g then v_gstin else v_vendor.gstin end,
          nullif(v_num, ''), v_date, v_due, v_leg->>'category',
          (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'description', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
             'hsn', nullif(left(btrim(coalesce(l->>'hsn', '')), 12), ''),
             'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0)))), '[]'::jsonb)
             from jsonb_array_elements(v_p->'lines') l),
          v_taxable, (v_p->>'cgst')::integer, (v_p->>'sgst')::integer, (v_p->>'igst')::integer, v_amount, 'unpaid', 0, 'INR', 1,
          case when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'tax_invoice' else 'other' end,
          left(format('Imported from Zoho Books (bill %s).%s', coalesce(nullif(v_num, ''), v_zid), public._r2629_ref_note(v_p)), 500),
          v_key, v_batch, v_tds, case when v_tds > 0 then v_tsec end);
        update public.vendor_bills b set zoho_import_sig = public._r2502_bill_sig(b) where b.id = 'BILL-Z-' || v_hash;
        v_ids := array['BILL-Z-' || v_hash];
      else
        v_i := 0;
        select coalesce(sum((l->>'taxable')::integer), 0) into v_tx_all from jsonb_array_elements(v_legs) l;
        v_tds_left := v_tds;
        for v_leg in select l from jsonb_array_elements(v_legs) l loop
          v_i := v_i + 1;
          /* R-2502c: the TDS spread over the rows by taxable value (each row's 26Q base right); the last takes the rest. */
          v_tds_leg := case when v_i = v_n_legs or v_tx_all = 0 then v_tds_left
                            else least(v_tds_left, round(v_tds::numeric * (v_leg->>'taxable')::integer / v_tx_all)::integer) end;
          if v_tx_all = 0 and v_i > 1 then v_tds_leg := 0; end if;
          v_tds_left := v_tds_left - v_tds_leg;
          insert into public.expenses (
            id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, igst, cgst, sgst,
            bill_type, bill_no, paid, paid_date, payment_method, description, notes, line_items,
            tds_section, tds_amount, rcm, rcm_tax, currency, fx_rate, zoho_doc_id, zoho_leg, purchase_import_batch_id)
          values (
            'EXP-Z-' || v_hash || '-' || v_i, v_tenant, v_leg->>'category', v_vendor.name, v_vendor.id, v_date,
            case when p_kind = 'bills' then coalesce(v_due, v_date) end,
            (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer,
            (v_leg->>'gst')::integer,
            public._r2502_leg_head('igst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('cgst', v_n_legs, v_rcm, v_leg, v_p),
            public._r2502_leg_head('sgst', v_n_legs, v_rcm, v_leg, v_p),
            case when v_no_vendor then 'none'
                 when v_valid_g or coalesce(v_vendor.gstin, '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then 'gst' else 'none' end,
            nullif(v_num, ''),
            false, null, null,
            left(nullif(btrim(coalesce((select string_agg(nullif(btrim(coalesce(l->>'description', '')), ''), ', ') from jsonb_array_elements(v_leg->'lines') l), '')), ''), 500),
            left(format('Imported from Zoho Books (%s %s).%s%s%s', case when p_kind = 'bills' then 'bill' else 'expense' end, coalesce(nullif(v_num, ''), v_zid),
              case when (v_leg->>'cost_gst')::integer > 0 then format(' GST ₹%s not claimable in Zoho (ineligible ITC) — kept in the cost.', v_leg->>'cost_gst') else '' end,
              case when p_kind = 'expenses' and coalesce(v_p->>'paidThrough', '') <> '' then format(' Paid from %s in Zoho.', v_p->>'paidThrough') else '' end,
              public._r2629_ref_note(v_p)), 500),
            (select coalesce(jsonb_agg(jsonb_build_object(
               'name', left(coalesce(nullif(btrim(l->>'description'), ''), l->>'accountName', 'Item'), 300),
               'qty', coalesce((l->>'qty')::numeric, 1), 'amount', coalesce((l->>'taxable')::integer, 0))), '[]'::jsonb)
               from jsonb_array_elements(v_leg->'lines') l),
            case when v_tds_leg > 0 then v_tsec end, v_tds_leg,
            v_rcm, case when v_rcm then (v_leg->>'rcm_tax')::integer else 0 end,
            'INR', 1, v_key, v_i, v_batch);
          update public.expenses e set zoho_import_sig = public._r2502_expense_sig(e) where e.id = 'EXP-Z-' || v_hash || '-' || v_i;
          v_ids := v_ids || ('EXP-Z-' || v_hash || '-' || v_i);
          v_taxable := v_taxable + (v_leg->>'taxable')::integer;
          v_tax := v_tax + (v_leg->>'gst')::integer;
          v_amount := v_amount + (v_leg->>'taxable')::integer + (v_leg->>'gst')::integer + (v_leg->>'cost_gst')::integer;
        end loop;
        /* A Zoho expense was paid when it was made: paid from the mapped account (cash → its petty-cash line). */
        if p_kind = 'expenses' then
          perform public._r2502_mark_paid(v_ids, v_date, v_acct);
        end if;
      end if;
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;

    v_n := v_n + 1;
    if v_create then v_new_v := v_new_v + 1; end if;
    if v_no_vendor then v_n_nov := v_n_nov + 1; end if;
    v_sum_tx := v_sum_tx + v_taxable;
    v_sum_tax := v_sum_tax + v_tax;
    v_sum_amt := v_sum_amt + v_amount;
    v_done := v_done || jsonb_build_object('zoho_id', v_zid, 'number', v_num, 'ids', to_jsonb(v_ids),
      'target', case when v_cogs > 0 then 'vendor_bill' else 'expense' end, 'no_vendor', v_no_vendor, 'date', v_date, 'taxable', v_taxable, 'itc', v_tax, 'tds', v_tds);
  end loop;

  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_sum_tx, tax_total = v_sum_tax, amount_total = v_sum_amt, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_purchases.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s Zoho %s (taxable ₹%s, ITC ₹%s); %s skipped', v_n, p_fy, p_kind, v_sum_tx, v_sum_tax, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'kind', p_kind, 'fy', p_fy, 'imported', v_n, 'already', v_already,
                             'skipped', jsonb_array_length(v_skipped), 'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt, 'new_vendors', v_new_v));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2502', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2502' then
    v_batch := null;
  end;
  perform set_config('app.zoho_purchase_import', '', true);

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'kind', p_kind, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'skipped', v_skipped, 'done', v_done, 'new_vendors', v_new_v, 'no_vendor', v_n_nov,
    'taxable', v_sum_tx, 'itc', v_sum_tax, 'amount', v_sum_amt);
end;
$function$;
comment on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) is 'R-2502c + R-2629 + R-2676 + R-2681 (Zoho account type must be an expense type; unmapped accounts left out) + R-2911 (a Zoho salary comes in as Salaries unless Payroll books that month for that employee) (a no-vendor Zoho expense comes in vendor-less when every line is on a mapped expense account) (Zoho reference_number kept in notes): FY bills / expenses from Zoho into vendor_bills (all-COGS, Zoho TDS in zoho_tds_*) or expenses (one row per category, TDS spread by taxable; a Zoho expense paid from the mapped app account). Money from zoho_fy_scan; picks = Zoho id + matched vendor (+ account). Duplicate check (vendor/GSTIN ±3 days amount). dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_purchases(text, text, jsonb, boolean) to authenticated, service_role;


commit;
