-- R-2968 — website_lead_once (migration 20261120133500_r2968_website_lead_once).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2968_website_lead_once.test.sql
--
-- The owner's case (20 Nov): "Start free trial" pressed again and again for one domain made a new
-- trial lead each time. What it proves:
--   1. first request → a lead is created (with the column defaults, under the given tenant);
--   2. the same domain again → no new lead; the first lead's notes get "Asked again … IST" and
--      what changed (seats); the same mobile in another format / the same email (any case) also join;
--   3. another domain + contact → a new lead; another tenant → a new lead in THAT tenant;
--   4. a lead older than the window, a junk lead, a lost lead → not joined (new lead);
--   5. p_match_offer (quote route): same contact but other seats → new lead; same offer → joined;
--   6. an unknown column is refused; anon / authenticated cannot call it; it takes an advisory lock.

begin;

insert into public.tenants (id, name, email) values
  ('c2968000-0000-0000-0000-0000000000a1'::uuid, 'T-R2968 A', 'r2968-a@example.in'),
  ('c2968000-0000-0000-0000-0000000000b1'::uuid, 'T-R2968 B', 'r2968-b@example.in');

do $$
declare
  t  constant uuid := 'c2968000-0000-0000-0000-0000000000a1';
  tb constant uuid := 'c2968000-0000-0000-0000-0000000000b1';
  base jsonb := jsonb_build_object(
    'company', 'T Ravi Traders', 'contact_name', 'T Ravi', 'contact_email', 'ravi@example.in',
    'contact_phone', '+91 98765 43210', 'plan', 'google-workspace-standard', 'seats', 5, 'value', 0,
    'stage', 'trial', 'source', 'buy-workspace-trial', 'domain', 'ravitraders.in',
    'notes', 'TRIAL REQUEST', 'utm_source', 'google');
  r jsonb;
  n int;
  l public.leads;
begin
  -- ── 1. first request → created ──────────────────────────────────────────────────────────────
  r := public.website_lead_once(t, base || '{"id":"L-R2968A1"}', 24, false);
  if r->>'action' <> 'created' or r->>'lead_id' <> 'L-R2968A1' then
    raise exception 'R-2968 case 1: expected created L-R2968A1, got %', r;
  end if;
  select * into l from public.leads where id = 'L-R2968A1';
  if l.tenant_id <> t or l.is_junk is distinct from false or l.created_at is null or l.utm_source <> 'google' or l.stage::text <> 'trial' then
    raise exception 'R-2968 case 1: row not as given / defaults missing: %', to_jsonb(l);
  end if;

  -- ── 2. same domain (other case, other seats) → joined, note says what changed ───────────────
  r := public.website_lead_once(t, base || '{"id":"L-R2968A2","domain":"RavITraders.in ","seats":8,"contact_email":"x@example.in","contact_phone":"9000000000"}', 24, false);
  if r->>'action' <> 'joined' or r->>'lead_id' <> 'L-R2968A1' then
    raise exception 'R-2968 case 2: expected joined L-R2968A1, got %', r;
  end if;
  if exists (select 1 from public.leads where id = 'L-R2968A2') then
    raise exception 'R-2968 case 2: a second lead was created';
  end if;
  select * into l from public.leads where id = 'L-R2968A1';
  if l.notes not like 'TRIAL REQUEST' || E'\n' || 'Asked again % IST — seats now 8 (was 5)' then
    raise exception 'R-2968 case 2: notes wrong: %', l.notes;
  end if;
  -- same mobile in another format, other domain/email
  r := public.website_lead_once(t, base || '{"id":"L-R2968A3","domain":"other.in","contact_email":"y@example.in","contact_phone":"098765-43210"}', 24, false);
  if r->>'lead_id' <> 'L-R2968A1' then raise exception 'R-2968 case 2b (mobile): got %', r; end if;
  -- same email in another case
  r := public.website_lead_once(t, base || '{"id":"L-R2968A4","domain":"other2.in","contact_email":" RAVI@example.IN","contact_phone":"9111111111"}', 24, false);
  if r->>'lead_id' <> 'L-R2968A1' then raise exception 'R-2968 case 2c (email): got %', r; end if;
  select count(*) into n from public.leads where tenant_id = t;
  if n <> 1 then raise exception 'R-2968 case 2: expected 1 lead, got %', n; end if;
  select * into l from public.leads where id = 'L-R2968A1';
  if (length(l.notes) - length(replace(l.notes, 'Asked again', ''))) / length('Asked again') <> 3 then
    raise exception 'R-2968 case 2: expected 3 "Asked again" lines: %', l.notes;
  end if;

  -- ── 3. another customer → new; another tenant → new there ───────────────────────────────────
  r := public.website_lead_once(t, base || '{"id":"L-R2968B1","domain":"acme.in","contact_email":"a@acme.in","contact_phone":"9222222222"}', 24, false);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 3: other customer joined: %', r; end if;
  r := public.website_lead_once(tb, base || '{"id":"L-R2968TB1","tenant_id":"c2968000-0000-0000-0000-0000000000a1"}', 24, false);
  if r->>'action' <> 'created' or (select tenant_id from public.leads where id = 'L-R2968TB1') <> tb then
    raise exception 'R-2968 case 3: other tenant not separate (or tenant_id taken from the row): %', r;
  end if;

  -- ── 4. outside the window / junk / lost → not joined ────────────────────────────────────────
  update public.leads set created_at = now() - interval '25 hours' where id = 'L-R2968B1';
  r := public.website_lead_once(t, base || '{"id":"L-R2968B2","domain":"acme.in","contact_email":"a@acme.in","contact_phone":"9222222222"}', 24, false);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 4 (25 h old): joined: %', r; end if;
  update public.leads set is_junk = true where id = 'L-R2968B2';
  r := public.website_lead_once(t, base || '{"id":"L-R2968B3","domain":"acme.in","contact_email":"a@acme.in","contact_phone":"9222222222"}', 24, false);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 4 (junk): joined: %', r; end if;
  update public.leads set stage = 'lost' where id = 'L-R2968B3';
  r := public.website_lead_once(t, base || '{"id":"L-R2968B4","domain":"acme.in","contact_email":"a@acme.in","contact_phone":"9222222222"}', 24, false);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 4 (lost): joined: %', r; end if;
  -- a different source (another form) is its own request
  r := public.website_lead_once(t, base || '{"id":"L-R2968C1","source":"buy-workspace","stage":"new"}', 24, false);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 4 (other form): joined: %', r; end if;

  -- ── 5. quote route: the offer must match too ────────────────────────────────────────────────
  r := public.website_lead_once(t, base || '{"id":"L-R2968C2","source":"buy-workspace","stage":"new","seats":9,"domain":null}', 24, true);
  if r->>'action' <> 'created' then raise exception 'R-2968 case 5 (other seats): joined: %', r; end if;
  r := public.website_lead_once(t, base || '{"id":"L-R2968C3","source":"buy-workspace","stage":"new","seats":9,"domain":null}', 24, true);
  if r->>'action' <> 'joined' or r->>'lead_id' <> 'L-R2968C2' then raise exception 'R-2968 case 5 (same offer): %', r; end if;

  -- ── 6. guards ───────────────────────────────────────────────────────────────────────────────
  begin
    perform public.website_lead_once(t, base || '{"id":"L-R2968X","not_a_column":1,"domain":"zzz.in","contact_email":"z@z.in","contact_phone":"9333333333"}', 24, false);
    raise exception 'R-2968 case 6: unknown column accepted';
  exception when sqlstate '22023' then null;
  end;
  if has_function_privilege('anon', 'public.website_lead_once(uuid,jsonb,integer,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.website_lead_once(uuid,jsonb,integer,boolean)', 'execute') then
    raise exception 'R-2968 case 6: anon/authenticated can call it';
  end if;
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) then
    raise exception 'R-2968 case 6: no advisory lock taken';
  end if;
  raise notice 'R-2968 website_lead_once: all cases passed';
end;
$$;

rollback;
