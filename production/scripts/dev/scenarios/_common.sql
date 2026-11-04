-- R-1957 — shared part of every test scenario (scripts/dev/scenario.mjs). LOCAL docker DB only.
-- scenario.mjs pipes: psql vars (tenant, acct) → this file → the scenario's own .sql → counts,
-- all inside ONE transaction (begin … commit, or rollback for --self-test).
--
-- A scenario owns: its vendors (fixed ids), its bank lines (fixed ids), its bills (fixed ids,
-- bill no "SCN-…"), and everything the app made FROM them while someone was checking a card —
-- payments from its lines, advances, a vendor added from its narration ("＋ New vendor", R-1918),
-- learned aliases (R-1919), payment-run items, the manual line the Bills page writes (R-1911).
-- pg_temp.scn_scope finds all of that; pg_temp.scn_clear deletes exactly that and nothing else.

/* The scenarios' own bank account ("create one if missing") — shared, never deleted. */
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, ifsc, account_type,
                                  opening_balance, opening_balance_date, is_active, notes)
values (:'acct', :'tenant', 'SCN HDFC Current', 'HDFC Bank', '7788', 'HDFC0000123', 'current',
        500000, current_date - 120, true, 'R-1957 test scenarios (local only): scripts/dev/scenario.mjs')
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from public.bank_accounts
                  where id = current_setting('scn.acct')::uuid and tenant_id = current_setting('scn.tenant')::uuid) then
    raise exception 'R-1957: bank account % belongs to another company — not touching it', current_setting('scn.acct');
  end if;
end $$;

/* R-1980 — sales-side scenarios (ads-month). Their rows are found from the scope's `docs` alone:
   lead ids, quote ids, invoice ids, campaign codes and ad-account ids listed there, plus everything
   hanging off them — the quotes of those leads, the subscriptions of those quotes and their
   billing rows, the invoices of those quotes / billings, and every payment on any of them (so a
   payment a tester records on a scenario quote goes with it). Vendor scenarios list none of
   these, so for them every count is 0. */
create function pg_temp.scn_sales_scope(p_tenant uuid, p_docs text[])
returns table(kind text, id text)
language sql stable as $f$
  with l as (
    select x.id from public.leads x where x.tenant_id = p_tenant and x.id = any(p_docs)
  ), q as (
    select x.id from public.quotes x
     where x.tenant_id = p_tenant and (x.id = any(p_docs) or x.lead_id in (select id from l))
  ), s as (
    select x.id from public.subscriptions x where x.tenant_id = p_tenant and x.quote_id in (select id from q)
  ), sb as (
    select x.id, x.invoice_id from public.subscription_billings x
     where x.tenant_id = p_tenant and x.subscription_id in (select id from s)
  ), i as (
    select x.id from public.invoices x
     where x.tenant_id = p_tenant
       and (x.id = any(p_docs) or x.quote_id in (select id from q) or x.id in (select invoice_id from sb))
  ), p as (
    select x.id from public.payments x
     where x.tenant_id = p_tenant and (x.quote_id in (select id from q) or x.invoice_id in (select id from i))
  ), c as (
    select x.id from public.marketing_campaigns x where x.tenant_id = p_tenant and x.code = any(p_docs)
  ), a as (
    select x.id from public.ad_accounts x where x.tenant_id = p_tenant and x.account_id = any(p_docs)
  )
  select 'lead', id from l
  union all select 'quote', id from q
  union all select 'subscription', id::text from s
  union all select 'billing', id::text from sb
  union all select 'invoice', id from i
  union all select 'payment', id::text from p
  union all select 'campaign', id::text from c
  union all select 'adAccount', id::text from a
$f$;

create function pg_temp.scn_sales_count(p_tenant uuid, p_docs text[])
returns jsonb
language sql stable as $f$
  with s as (select * from pg_temp.scn_sales_scope(p_tenant, p_docs))
  select jsonb_build_object(
    'leads',         (select count(*) from s where kind = 'lead'),
    'quotes',        (select count(*) from s where kind = 'quote'),
    'invoices',      (select count(*) from s where kind = 'invoice'),
    'payments',      (select count(*) from s where kind = 'payment'),
    'subscriptions', (select count(*) from s where kind = 'subscription'),
    'campaigns',     (select count(*) from s where kind = 'campaign'),
    'adDays',        (select count(*) from public.ad_spend_daily d
                       where d.tenant_id = p_tenant and d.ad_account_id::text in (select id from s where kind = 'adAccount'))
  )
$f$;

create function pg_temp.scn_sales_clear(p_tenant uuid, p_docs text[])
returns jsonb
language plpgsql as $f$
declare
  got jsonb := pg_temp.scn_sales_count(p_tenant, p_docs);
  ids record;
  sales_tables text[] := array['payments', 'subscription_billings', 'invoices', 'subscriptions', 'quotes', 'leads',
    'ad_spend_daily', 'ad_accounts', 'marketing_campaigns'];
begin
  if (select sum(v::int) from jsonb_each_text(got) as t(k, v)) = 0 then
    return got;
  end if;
  select coalesce(array_agg(id) filter (where kind = 'lead'), '{}')                 as l,
         coalesce(array_agg(id) filter (where kind = 'quote'), '{}')                as q,
         coalesce(array_agg(id::uuid) filter (where kind = 'subscription'), '{}')   as s,
         coalesce(array_agg(id::uuid) filter (where kind = 'billing'), '{}')        as sb,
         coalesce(array_agg(id) filter (where kind = 'invoice'), '{}')              as i,
         coalesce(array_agg(id::uuid) filter (where kind = 'payment'), '{}')        as p,
         coalesce(array_agg(id::uuid) filter (where kind = 'campaign'), '{}')       as c,
         coalesce(array_agg(id::uuid) filter (where kind = 'adAccount'), '{}')      as a
    into ids
    from pg_temp.scn_sales_scope(p_tenant, p_docs);

  -- Same reason as scn_clear below: test data being taken away, not a user's action.
  execute (select string_agg(format('alter table public.%I disable trigger user', tbl), '; ') from unnest(sales_tables) tbl);
  delete from public.payments where id = any(ids.p);
  delete from public.subscription_billings where id = any(ids.sb);
  update public.quotes set invoice_id = null where id = any(ids.q) and invoice_id is not null;
  delete from public.invoices where id = any(ids.i);
  delete from public.subscriptions where id = any(ids.s);
  delete from public.quotes where id = any(ids.q);
  delete from public.leads where id = any(ids.l);
  delete from public.ad_spend_daily where tenant_id = p_tenant and ad_account_id = any(ids.a);
  delete from public.ad_accounts where id = any(ids.a);
  update public.expenses set campaign_id = null where tenant_id = p_tenant and campaign_id = any(ids.c);
  delete from public.marketing_campaigns where id = any(ids.c);
  execute (select string_agg(format('alter table public.%I enable trigger user', tbl), '; ') from unnest(sales_tables) tbl);
  return got;
end
$f$;

/* R-1998 — project scenarios (project-receipts). Found from the scope's `docs`: customer ids and
   project ids listed there, plus everything a tester's Save makes from them — split instalments,
   project payments (bank + 'tds'), the invoices raised on the instalments or for those customers,
   and their TDS receivable rows. Other scenarios list none of these, so for them every count is 0. */
create function pg_temp.scn_project_scope(p_tenant uuid, p_docs text[])
returns table(kind text, id text)
language sql stable as $f$
  with c as (
    select x.id from public.customers x where x.tenant_id = p_tenant and x.id::text = any(p_docs)
  ), pr as (
    select x.id from public.project_sales x
     where x.tenant_id = p_tenant and (x.id::text = any(p_docs) or x.customer_id in (select id from c))
  ), m as (
    select x.id, x.invoice_id from public.project_milestones x where x.tenant_id = p_tenant and x.project_id in (select id from pr)
  ), pp as (
    select x.id from public.project_payments x where x.tenant_id = p_tenant and x.project_id in (select id from pr)
  ), i as (
    select x.id from public.invoices x
     where x.tenant_id = p_tenant and (x.id in (select invoice_id from m) or x.customer_id in (select id from c))
  ), t as (
    select x.id from public.tds_receivable x
     where x.tenant_id = p_tenant and (x.invoice_id in (select id from i) or x.customer_id in (select id from c))
  )
  select 'customer', id::text from c
  union all select 'project', id::text from pr
  union all select 'milestone', id::text from m
  union all select 'projectPayment', id::text from pp
  union all select 'projectInvoice', id from i
  union all select 'tds', id from t
$f$;

create function pg_temp.scn_project_count(p_tenant uuid, p_docs text[])
returns jsonb
language sql stable as $f$
  with s as (select * from pg_temp.scn_project_scope(p_tenant, p_docs))
  select jsonb_build_object(
    'customers',       (select count(*) from s where kind = 'customer'),
    'projects',        (select count(*) from s where kind = 'project'),
    'milestones',      (select count(*) from s where kind = 'milestone'),
    'projectPayments', (select count(*) from s where kind = 'projectPayment'),
    'projectInvoices', (select count(*) from s where kind = 'projectInvoice'),
    'tdsRows',         (select count(*) from s where kind = 'tds')
  )
$f$;

/* R-2458 — the E2E user a scenario acts as / names (approver, maker, owner): the seeded e2e-<role>@ login
   when it exists, else the company's oldest active user with that role ("owner2" is the second owner). */
create function pg_temp.scn_user(p_tenant uuid, p_role text)
returns uuid
language sql stable as $f$
  select coalesce(
    (select u.id from public.users u where u.tenant_id = p_tenant and lower(u.email) = 'e2e-' || p_role || '@example.test'),
    (select u.id from public.users u where u.tenant_id = p_tenant and u.role::text = p_role order by u.created_at limit 1))
$f$;

/* R-2458 — everything that hangs off scenario customers (and listed quotes / invoices), so a customer can
   go even after a tester quoted, invoiced, took a payment or started a subscription on it (4 Nov: the
   project-receipts reset stopped on SCN Acme's later quotes and payments). A NON-scenario bank line a
   tester matched to one of these documents stays, only unmatched (as scn_clear does for bills). The
   customers themselves stay — the caller removes them. Used by scn_project_clear and scn_extra_clear.
   It switches user triggers off and on for ITS tables only; a caller that deletes from these tables after
   calling it must switch them off again. */
create function pg_temp.scn_drop_customer_docs(p_tenant uuid, p_customers uuid[], p_quotes text[], p_invoices text[])
returns void
language plpgsql as $f$
declare
  q text[]; i text[]; s uuid[]; p uuid[];
  doc_tables text[] := array['bank_transactions', 'payments', 'credit_notes', 'debit_notes', 'tds_receivable',
    'subscription_billings', 'subscriptions', 'invoices', 'quotes'];
begin
  select coalesce(array_agg(x.id), '{}') into q from public.quotes x
   where x.tenant_id = p_tenant and (x.id = any(p_quotes) or x.customer_id = any(p_customers));
  select coalesce(array_agg(x.id), '{}') into s from public.subscriptions x
   where x.tenant_id = p_tenant and (x.customer_id = any(p_customers) or x.quote_id = any(q));
  select coalesce(array_agg(x.id), '{}') into i from public.invoices x
   where x.tenant_id = p_tenant
     and (x.id = any(p_invoices) or x.customer_id = any(p_customers) or x.quote_id = any(q)
          or x.id in (select b.invoice_id from public.subscription_billings b where b.subscription_id = any(s)));
  select coalesce(array_agg(x.id), '{}') into p from public.payments x
   where x.tenant_id = p_tenant and (x.customer_id = any(p_customers) or x.invoice_id = any(i) or x.quote_id = any(q));
  if cardinality(q) + cardinality(i) + cardinality(s) + cardinality(p) = 0 then
    return;
  end if;
  execute (select string_agg(format('alter table public.%I disable trigger user', tbl), '; ') from unnest(doc_tables) tbl);
  update public.bank_transactions
     set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
   where tenant_id = p_tenant
     and (matched_to_id = any(i) or matched_to_id = any(q)
          or matched_to_id = any(select x::text from unnest(p) x));
  delete from public.payments where id = any(p);
  delete from public.credit_notes where tenant_id = p_tenant and (invoice_id = any(i) or customer_id = any(p_customers));
  delete from public.debit_notes where tenant_id = p_tenant and (invoice_id = any(i) or customer_id = any(p_customers));
  delete from public.tds_receivable where tenant_id = p_tenant and (invoice_id = any(i) or customer_id = any(p_customers));
  delete from public.subscription_billings where tenant_id = p_tenant and subscription_id = any(s);
  update public.quotes set invoice_id = null where id = any(q) and invoice_id is not null;
  update public.quotes set renewal_subscription_id = null, add_seats_subscription_id = null
   where tenant_id = p_tenant and (renewal_subscription_id = any(s) or add_seats_subscription_id = any(s));
  delete from public.subscriptions where id = any(s);
  delete from public.invoices where id = any(i);
  delete from public.quotes where id = any(q);
  execute (select string_agg(format('alter table public.%I enable trigger user', tbl), '; ') from unnest(doc_tables) tbl);
end
$f$;

create function pg_temp.scn_project_clear(p_tenant uuid, p_docs text[])
returns jsonb
language plpgsql as $f$
declare
  got jsonb := pg_temp.scn_project_count(p_tenant, p_docs);
  ids record;
  proj_tables text[] := array['tds_receivable', 'project_payments', 'project_milestones', 'invoices', 'project_sales', 'customers'];
begin
  if (select sum(v::int) from jsonb_each_text(got) as t(k, v)) = 0 then
    return got;
  end if;
  select coalesce(array_agg(id::uuid) filter (where kind = 'customer'), '{}')       as c,
         coalesce(array_agg(id::uuid) filter (where kind = 'project'), '{}')        as pr,
         coalesce(array_agg(id::uuid) filter (where kind = 'projectPayment'), '{}') as pp,
         coalesce(array_agg(id) filter (where kind = 'projectInvoice'), '{}')       as i,
         coalesce(array_agg(id) filter (where kind = 'tds'), '{}')                  as t
    into ids
    from pg_temp.scn_project_scope(p_tenant, p_docs);

  -- Same reason as scn_clear below: test data being taken away, not a user's action.
  execute (select string_agg(format('alter table public.%I disable trigger user', tbl), '; ') from unnest(proj_tables) tbl);
  delete from public.tds_receivable where id = any(ids.t);
  delete from public.project_payments where id = any(ids.pp);
  update public.project_milestones set invoice_id = null where project_id = any(ids.pr) and invoice_id is not null;
  -- R-2458: and whatever a tester quoted / invoiced / received on the scenario customers afterwards
  perform pg_temp.scn_drop_customer_docs(p_tenant, ids.c, '{}', ids.i);
  delete from public.project_milestones where project_id = any(ids.pr);
  delete from public.project_sales where id = any(ids.pr);
  delete from public.customers where id = any(ids.c);
  execute (select string_agg(format('alter table public.%I enable trigger user', tbl), '; ') from unnest(proj_tables) tbl);
  return got;
end
$f$;

/* R-2458 — the localhost-check scenarios (customer-no-state, usd-inw-lines, lut-per-fy, zero-ref-credits,
   small-leftover, salary-part-paid, nbfc-interest, approved-quote, connected-companies). Their rows are
   found from the scope's `extra` ids: customers (+ their quotes, invoices, payments, notes, TDS rows,
   subscriptions — so what a tester makes on a scenario customer goes too), quotes / invoices listed by
   id, employees (+ salary records and the Salaries bills pay_salary booked), business loans (+ their
   payments), LUT rows, and a second company (+ its connections, network documents and GSTIN claims).
   Tables a local DB may not have yet (tenant_luts before R-2444; tenant_connections, network_documents,
   gstin_ownership_claims before R-2433 / R-2434 / R-2445) are only read through dynamic SQL when present,
   so every OTHER scenario still loads on such a DB (the scenario that needs them is skipped by `needs`). */
create function pg_temp.scn_has(p_table text)
returns boolean
language sql stable as $f$ select to_regclass('public.' || p_table) is not null $f$;

create function pg_temp.scn_extra_scope(p_tenant uuid, p_txns uuid[], p_extra text[])
returns table(kind text, id text)
language plpgsql stable as $f$
declare
  co uuid[];
begin
  if coalesce(cardinality(p_extra), 0) = 0 then
    return;
  end if;
  return query
  with c as (
    select x.id from public.customers x where x.tenant_id = p_tenant and x.id::text = any(p_extra)
  ), q as (
    select x.id from public.quotes x
     where x.tenant_id = p_tenant and (x.id = any(p_extra) or x.customer_id in (select c.id from c))
  ), i as (
    select x.id from public.invoices x
     where x.tenant_id = p_tenant
       and (x.id = any(p_extra) or x.customer_id in (select c.id from c) or x.quote_id in (select q.id from q))
  ), pay as (
    select x.id from public.payments x
     where x.tenant_id = p_tenant
       and (x.customer_id in (select c.id from c) or x.invoice_id in (select i.id from i)
            or x.quote_id in (select q.id from q) or x.bank_txn_id = any(p_txns))
  ), e as (
    select x.id from public.employees x where x.tenant_id = p_tenant and x.id::text = any(p_extra)
  ), sal as (
    select x.id from public.salary_payments x where x.tenant_id = p_tenant and x.employee_id in (select e.id from e)
  ), l as (
    select x.id from public.business_loans x where x.tenant_id = p_tenant and x.id::text = any(p_extra)
  ), lp as (
    select x.id from public.business_loan_payments x where x.tenant_id = p_tenant and x.loan_id in (select l.id from l)
  )
  select 'customer'::text, x.id::text from c x
  union all select 'quote', x.id from q x
  union all select 'invoice', x.id from i x
  union all select 'payment', x.id::text from pay x
  union all select 'employee', x.id::text from e x
  union all select 'salary', x.id::text from sal x
  union all select 'loan', x.id::text from l x
  union all select 'loanPayment', x.id::text from lp x
  union all select 'company', x.id::text from public.tenants x where x.id::text = any(p_extra) and x.id <> p_tenant;

  select coalesce(array_agg(x.id), '{}') into co from public.tenants x where x.id::text = any(p_extra) and x.id <> p_tenant;
  if cardinality(co) > 0 and pg_temp.scn_has('tenant_connections') then
    return query execute
      'select ''connection''::text, x.id::text from public.tenant_connections x
        where x.id::text = any($1) or x.a_tenant_id = any($2) or x.b_tenant_id = any($2)' using p_extra, co;
  end if;
  if cardinality(co) > 0 and pg_temp.scn_has('network_documents') then
    return query execute
      'select ''networkDoc''::text, x.id::text from public.network_documents x
        where x.seller_tenant_id = any($1) or x.buyer_tenant_id = any($1)' using co;
  end if;
  if cardinality(co) > 0 and pg_temp.scn_has('gstin_ownership_claims') then
    return query execute
      'select ''gstinClaim''::text, x.id::text from public.gstin_ownership_claims x where x.tenant_id = any($1)' using co;
  end if;
  if pg_temp.scn_has('tenant_luts') then
    return query execute 'select ''lut''::text, x.id::text from public.tenant_luts x where x.tenant_id = $1 and x.id::text = any($2)'
      using p_tenant, p_extra;
  end if;
end
$f$;

create function pg_temp.scn_extra_count(p_tenant uuid, p_txns uuid[], p_extra text[])
returns jsonb
language sql stable as $f$
  with s as (select * from pg_temp.scn_extra_scope(p_tenant, p_txns, p_extra))
  select jsonb_build_object(
    'xCustomers',    (select count(*) from s where kind = 'customer'),
    'xQuotes',       (select count(*) from s where kind = 'quote'),
    'xInvoices',     (select count(*) from s where kind = 'invoice'),
    'xPayments',     (select count(*) from s where kind = 'payment'),
    'employees',     (select count(*) from s where kind = 'employee'),
    'salaries',      (select count(*) from s where kind = 'salary'),
    'loans',         (select count(*) from s where kind = 'loan'),
    'loanPayments',  (select count(*) from s where kind = 'loanPayment'),
    'luts',          (select count(*) from s where kind = 'lut'),
    'companies',     (select count(*) from s where kind = 'company'),
    'connections',   (select count(*) from s where kind = 'connection'),
    'networkDocs',   (select count(*) from s where kind = 'networkDoc'),
    'gstinClaims',   (select count(*) from s where kind = 'gstinClaim')
  )
$f$;

create function pg_temp.scn_extra_clear(p_tenant uuid, p_txns uuid[], p_extra text[])
returns jsonb
language plpgsql as $f$
declare
  got jsonb := pg_temp.scn_extra_count(p_tenant, p_txns, p_extra);
  ids record;
  x_tables text[] := array['bank_transactions', 'payments', 'customers', 'salary_payments', 'expenses', 'employees',
    'business_loan_payments', 'business_loans', 'tenants'];
  opt_tables text[] := array['network_documents', 'tenant_connections', 'gstin_ownership_claims'];
begin
  if (select sum(v::int) from jsonb_each_text(got) as t(k, v)) = 0 then
    return got;
  end if;
  select coalesce(array_agg(s.id::uuid) filter (where s.kind = 'customer'), '{}')    as c,
         coalesce(array_agg(s.id)       filter (where s.kind = 'quote'), '{}')       as q,
         coalesce(array_agg(s.id)       filter (where s.kind = 'invoice'), '{}')     as i,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'payment'), '{}')     as p,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'employee'), '{}')    as e,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'salary'), '{}')      as sal,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'loan'), '{}')        as l,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'company'), '{}')     as co,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'connection'), '{}')  as cn,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'networkDoc'), '{}')  as nd,
         coalesce(array_agg(s.id::uuid) filter (where s.kind = 'lut'), '{}')         as lut
    into ids
    from pg_temp.scn_extra_scope(p_tenant, p_txns, p_extra) s;

  -- the customers' documents first (it toggles its own tables' triggers)
  perform pg_temp.scn_drop_customer_docs(p_tenant, ids.c, ids.q, ids.i);

  -- Same reason as scn_clear below: test data being taken away, not a user's action.
  x_tables := x_tables || array(select t from unnest(opt_tables) t where pg_temp.scn_has(t));
  execute (select string_agg(format('alter table public.%I disable trigger user', tbl), '; ') from unnest(x_tables) tbl);
  delete from public.payments where id = any(ids.p);  -- a receipt booked from a scenario bank line on another customer
  delete from public.customers where id = any(ids.c);
  -- a NON-scenario bank line a tester linked to a scenario salary stays, only unmatched
  update public.bank_transactions
     set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
   where tenant_id = p_tenant and not (id = any(p_txns)) and matched_to_type = 'salary'
     and matched_to_id = any(select x::text from unnest(ids.sal) x);
  -- the Salaries bills pay_salary booked for the scenario's people
  with gone as (delete from public.salary_payments where id = any(ids.sal) returning expense_id)
  delete from public.expenses x using gone g where x.tenant_id = p_tenant and x.id = g.expense_id;
  delete from public.employees where id = any(ids.e);
  delete from public.business_loan_payments where tenant_id = p_tenant and loan_id = any(ids.l);
  delete from public.business_loans where id = any(ids.l);
  if cardinality(ids.co) > 0 then
    if pg_temp.scn_has('network_documents') then
      execute 'delete from public.network_documents where id = any($1)' using ids.nd;
    end if;
    if pg_temp.scn_has('tenant_connections') then
      execute 'delete from public.tenant_connections where id = any($1)' using ids.cn;
    end if;
    if pg_temp.scn_has('gstin_ownership_claims') then
      execute 'delete from public.gstin_ownership_claims where tenant_id = any($1)' using ids.co;
    end if;
    -- E2E Test Co's "GSTIN ownership proved" — only the stamp a scenario wrote (a real proof stays)
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'tenants' and column_name = 'gstin_owner_verified_by') then
      execute 'update public.tenants
                  set gstin_owner_verified_at = null, gstin_owner_verified_gstin = null,
                      gstin_owner_verified_how = null, gstin_owner_verified_by = null
                where id = $1 and gstin_owner_verified_by = ''R-2458 scenario''' using p_tenant;
    end if;
    delete from public.tenants where id = any(ids.co);
  end if;
  if cardinality(ids.lut) > 0 then
    execute 'delete from public.tenant_luts where id = any($1)' using ids.lut;
  end if;
  execute (select string_agg(format('alter table public.%I enable trigger user', tbl), '; ') from unnest(x_tables) tbl);
  return got;
end
$f$;

create function pg_temp.scn_scope(p_tenant uuid, p_vendors uuid[], p_txns uuid[], p_docs text[], p_names text[], p_upis text[])
returns table(kind text, id text)
language sql stable as $f$
  with v as (
    select x.id from public.vendors x
     where x.tenant_id = p_tenant
       and (x.id = any(p_vendors) or lower(btrim(x.name)) = any(p_names) or lower(coalesce(x.upi_id, '')) = any(p_upis))
  ), e as (
    select x.id from public.expenses x
     where x.tenant_id = p_tenant
       and (x.id = any(p_docs) or x.vendor_id in (select id from v) or x.reconciled_txn_id = any(p_txns))
  ), b as (
    select x.id from public.vendor_bills x
     where x.tenant_id = p_tenant and (x.id = any(p_docs) or x.vendor_id in (select id from v))
  ), t as (
    select x.id from public.bank_transactions x
     where x.tenant_id = p_tenant
       and (x.id = any(p_txns)
            -- the manual line the Bills page / a payment run writes for a scenario bill (R-1911)
            or (x.source = 'manual' and x.matched_to_id in (select id from e union all select id from b)))
  ), p as (
    select x.id from public.prepaid_advances x
     where x.tenant_id = p_tenant and (x.vendor_id in (select id from v) or x.bank_txn_id in (select id from t))
  )
  select 'vendor', id::text from v
  union all select 'expense', id from e
  union all select 'bill', id from b
  union all select 'txn', id::text from t
  union all select 'prepaid', id::text from p
$f$;

create function pg_temp.scn_count(p_tenant uuid, p_vendors uuid[], p_txns uuid[], p_docs text[], p_names text[], p_upis text[], p_extra text[])
returns jsonb
language sql stable as $f$
  with s as (select * from pg_temp.scn_scope(p_tenant, p_vendors, p_txns, p_docs, p_names, p_upis))
  select jsonb_build_object(
    'vendors',  (select count(*) from s where kind = 'vendor'),
    'expenses', (select count(*) from s where kind = 'expense'),
    'bills',    (select count(*) from s where kind = 'bill'),
    'txns',     (select count(*) from s where kind = 'txn'),
    'prepaid',  (select count(*) from s where kind = 'prepaid'),
    'paymentLines', (select count(*) from public.bank_vendor_payment_lines l
                      where l.tenant_id = p_tenant
                        and (l.bank_txn_id::text in (select id from s where kind = 'txn')
                             or l.vendor_id::text in (select id from s where kind = 'vendor'))),
    'aliases', (select count(*) from public.vendor_narration_aliases a
                 where a.tenant_id = p_tenant and a.vendor_id::text in (select id from s where kind = 'vendor')),
    -- same-id rows twice would be a primary-key error; this catches a bill number loaded twice
    'duplicateBillNos', (select count(*) from (
        select bill_no from public.expenses where tenant_id = p_tenant and bill_no like 'SCN-%' group by bill_no having count(*) > 1
        union all
        select bill_no from public.vendor_bills where tenant_id = p_tenant and bill_no like 'SCN-%' group by bill_no having count(*) > 1) d)
  ) || pg_temp.scn_sales_count(p_tenant, p_docs)  -- R-1980: leads, quotes, invoices, payments, …
    || pg_temp.scn_project_count(p_tenant, p_docs)  -- R-1998: customers, projects, instalments, …
    || pg_temp.scn_extra_count(p_tenant, p_txns, p_extra)  -- R-2458: the localhost-check scenarios
$f$;

create function pg_temp.scn_clear(p_tenant uuid, p_vendors uuid[], p_txns uuid[], p_docs text[], p_names text[], p_upis text[], p_extra text[])
returns jsonb
language plpgsql as $f$
declare
  v uuid[]; e text[]; b text[]; t uuid[]; p uuid[]; docs text[]; runs uuid[];
  proj jsonb;
  xtra jsonb;
  scn_tables text[] := array['vendor_advance_applications', 'bank_vendor_payment_lines', 'bank_transactions',
    'payment_run_items', 'payment_runs', 'vendor_narration_aliases', 'expenses', 'vendor_bills', 'prepaid_advances', 'vendors'];
begin
  -- R-2458: its customers' payments / invoices and its salary records first — they point at the bank lines below
  xtra := pg_temp.scn_extra_clear(p_tenant, p_txns, p_extra);
  -- R-1998: projects first — their payments point at the scenario bank lines removed below
  proj := pg_temp.scn_project_clear(p_tenant, p_docs);
  select coalesce(array_agg(id::uuid) filter (where kind = 'vendor'),  '{}'),
         coalesce(array_agg(id)       filter (where kind = 'expense'), '{}'),
         coalesce(array_agg(id)       filter (where kind = 'bill'),    '{}'),
         coalesce(array_agg(id::uuid) filter (where kind = 'txn'),     '{}'),
         coalesce(array_agg(id::uuid) filter (where kind = 'prepaid'), '{}')
    into v, e, b, t, p
    from pg_temp.scn_scope(p_tenant, p_vendors, p_txns, p_docs, p_names, p_upis);
  docs := e || b || coalesce((select array_agg(x::text) from unnest(p) x), '{}');

  /* Business triggers (un-reconcile, books lock, delete guards, alias learning, activity log) are
     for a user's actions; this is test data being taken away, so they are switched off on these
     tables for THIS transaction (ALTER … DISABLE TRIGGER USER is transactional — a failure rolls it
     back). Foreign keys stay ON: rows are removed child-first, and set-null links clear themselves. */
  execute (select string_agg(format('alter table public.%I disable trigger user', tbl), '; ') from unnest(scn_tables) tbl);

  delete from public.vendor_advance_applications where expense_id = any(e) or prepaid_advance_id = any(p);
  delete from public.bank_vendor_payment_lines
   where tenant_id = p_tenant
     and (bank_txn_id = any(t) or expense_id = any(e) or vendor_bill_id = any(b) or prepaid_advance_id = any(p) or vendor_id = any(v));
  -- someone matched a NON-scenario bank line to a scenario bill: the line stays, only unmatched
  update public.bank_transactions
     set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
   where tenant_id = p_tenant and not (id = any(t)) and matched_to_id = any(docs);
  with gone as (
    delete from public.payment_run_items
     where tenant_id = p_tenant and (vendor_id = any(v) or doc_id = any(e || b))
    returning run_id)
  select coalesce(array_agg(distinct run_id), '{}') into runs from gone;
  delete from public.payment_runs r
   where r.id = any(runs) and not exists (select 1 from public.payment_run_items i where i.run_id = r.id);
  delete from public.vendor_narration_aliases where vendor_id = any(v);

  delete from public.expenses where id = any(e);
  delete from public.vendor_bills where id = any(b);
  delete from public.prepaid_advances where id = any(p);
  delete from public.bank_transactions where id = any(t);
  delete from public.vendors where id = any(v);

  execute (select string_agg(format('alter table public.%I enable trigger user', tbl), '; ') from unnest(scn_tables) tbl);
  return jsonb_build_object('vendors', cardinality(v), 'expenses', cardinality(e), 'bills', cardinality(b),
                            'txns', cardinality(t), 'prepaid', cardinality(p))
         || pg_temp.scn_sales_clear(p_tenant, p_docs)  -- R-1980: after the expenses, so a campaign's bills are gone first
         || proj
         || xtra;
end
$f$;
