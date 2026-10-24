\set ON_ERROR_STOP on
-- R-1816: the money RPCs stamp the IST calendar day, not CURRENT_DATE (the UTC day on Cloud SQL —
-- a day behind between 00:00 and 05:30 IST). Migration: 20261024022950_r1816_money_rpcs_ist_today.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1816_money_rpcs_ist_today.test.sql
--
-- Expect "PASS r1816_money_rpcs_ist_today".
--
--   RULE      00:30 IST 21 Oct (19:00 UTC 20 Oct): the IST rule gives 21 Oct, the UTC day 20 Oct
--   SOURCE    none of the nine functions has CURRENT_DATE in its code; each calls ist_today()
--   CLOCK     public.ist_today() is pinned (inside this transaction) to that 00:30 IST instant;
--             create_project_sale stamps customers.since and record_project_payment (no received
--             date) stamps the receipt + invoice paid date with 21 Oct, not the server's day
--   MUTATION  put CURRENT_DATE back in create_project_sale → the same CLOCK check refuses it

begin;

set local timezone = 'UTC';

-- ── RULE ────────────────────────────────────────────────────────────────────────────────
do $$
declare
  c_clock constant timestamptz := timestamptz '2026-10-20 19:00:00+00';  -- 00:30 IST 21 Oct
begin
  if (c_clock at time zone 'Asia/Kolkata')::date <> date '2026-10-21' then
    raise exception 'R-1816: 00:30 IST on 21 Oct must be 21 Oct';
  end if;
  if c_clock::date <> date '2026-10-20' then
    raise exception 'R-1816: the UTC day of that instant must be 20 Oct (what CURRENT_DATE gave)';
  end if;
end $$;

-- ── SOURCE ──────────────────────────────────────────────────────────────────────────────
create function pg_temp.r1816_source_check() returns void language plpgsql as $f$
declare
  r record;
  v_code text;
begin
  for r in
    select n from unnest(array['accept_quote', 'record_payment', 'customer_from_prospect_quote',
      'accept_project_quote', 'create_project_sale', 'activate_quote_on_credit',
      'record_project_payment', 'fn_accrue_referral_commission', 'get_partner_metrics']) as t(n)
  loop
    if (select count(*) from pg_proc where proname = r.n and pronamespace = 'public'::regnamespace) <> 1 then
      raise exception 'R-1816: expected exactly one public.%', r.n;
    end if;
    select regexp_replace(regexp_replace(prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') into v_code
      from pg_proc where proname = r.n and pronamespace = 'public'::regnamespace;
    if v_code ~* '\mcurrent_date\M' then
      raise exception 'R-1816: public.% still stamps CURRENT_DATE (the UTC day)', r.n;
    end if;
    if v_code !~* 'ist_today\(\)' then
      raise exception 'R-1816: public.% does not use ist_today()', r.n;
    end if;
    if not (select prosecdef from pg_proc where proname = r.n and pronamespace = 'public'::regnamespace) then
      raise exception 'R-1816: public.% lost SECURITY DEFINER', r.n;
    end if;
  end loop;
end $f$;

select pg_temp.r1816_source_check();

-- ── CLOCK: pin "today" to 00:30 IST 21 Oct, inside this transaction only ─────────────────
create or replace function public.ist_today()
returns date
language sql
stable
as $function$
  select (timestamptz '2026-10-20 19:00:00+00' at time zone 'Asia/Kolkata')::date;
$function$;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000018a6', 'R1816 TEST A', 'r1816-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000018a0a6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1816-a-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000018a0a6', 'aaaaaaaa-0000-0000-0000-0000000018a6', 'r1816-a-user@example.in', 'owner');

create temp table r1816_ids (k text primary key, v uuid);
grant all on r1816_ids to authenticated;

create function pg_temp.r1816_clock_check(p_tag text) returns void language plpgsql as $f$
declare
  v_project uuid;
  v_milestone uuid;
  v_since date;
  v_received date;
  v_paid date;
begin
  insert into r1816_ids select p_tag, public.create_project_sale(null::uuid, 'R1816 Night Co ' || p_tag, 'Night sale'::text,
    null::text, 100000, 18, false, '[{"label":"Full payment","total_amount":118000,"due_date":null}]'::jsonb);
  v_project := (select v from r1816_ids where k = p_tag);
  select c.since into v_since from public.project_sales p join public.customers c on c.id = p.customer_id where p.id = v_project;
  if v_since is distinct from date '2026-10-21' then
    raise exception 'R-1816 CLOCK: create_project_sale stamped customers.since % at 00:30 IST 21 Oct', v_since;
  end if;

  select id into v_milestone from public.project_milestones where project_id = v_project;
  perform public.record_project_payment(v_milestone, 118000, 'bank_transfer', null, null::date, null::uuid);
  select received_at into v_received from public.project_payments where project_id = v_project;
  if v_received is distinct from date '2026-10-21' then
    raise exception 'R-1816 CLOCK: record_project_payment stamped received % at 00:30 IST 21 Oct', v_received;
  end if;
  select i.paid_date into v_paid from public.project_milestones m join public.invoices i on i.id = m.invoice_id
   where m.id = v_milestone;
  if v_paid is not null and v_paid <> date '2026-10-21' then
    raise exception 'R-1816 CLOCK: record_project_payment stamped invoice paid_date % at 00:30 IST 21 Oct', v_paid;
  end if;
end $f$;
grant execute on function pg_temp.r1816_clock_check(text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000018a0a6', 'role', 'authenticated')::text, true);

select pg_temp.r1816_clock_check('ok');

reset role;

-- ── MUTATION: CURRENT_DATE back in create_project_sale must be refused ───────────────────
-- (Skipped only on 21 Oct 2026 itself, when the server day happens to equal the pinned day.)
do $$
declare
  v_def text := pg_get_functiondef('public.create_project_sale(uuid,text,text,text,integer,integer,boolean,jsonb)'::regprocedure);
begin
  if position('public.ist_today()' in v_def) = 0 then
    raise exception 'R-1816 MUTATION: create_project_sale has no ist_today() to put back';
  end if;
  execute replace(v_def, 'public.ist_today()', 'current_date');
end $$;

do $$
begin
  if current_date = date '2026-10-21' then
    raise notice 'mutation skipped: the server day is the pinned day';
    return;
  end if;
  begin
    perform pg_temp.r1816_source_check();
    raise exception 'R-1816 MUTATION: SOURCE check missed CURRENT_DATE';
  exception when raise_exception then
    if sqlerrm like 'R-1816 MUTATION%' then raise; end if;
    raise notice 'mutation caught (source): %', sqlerrm;
  end;
  set local role authenticated;
  begin
    perform pg_temp.r1816_clock_check('mut');
    raise exception 'R-1816 MUTATION: CLOCK check missed CURRENT_DATE';
  exception when raise_exception then
    if sqlerrm like 'R-1816 MUTATION%' then raise; end if;
    raise notice 'mutation caught (clock): %', sqlerrm;
  end;
  reset role;
end $$;

select 'PASS r1816_money_rpcs_ist_today' as result;
rollback;
