-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.website_lead_once(uuid,jsonb,integer,boolean)') and prosrc like '%R-2968%')
-- deploy-key: r2968websiteleadonce
--
-- R-2968 (20 Nov 2026) — a website trial / quote request asked again joins the first request.
--
-- The buy page's "Start free trial" made a NEW lead (+ three follow-up tasks + a customer email)
-- on every click: one customer's domain had four trial leads in four minutes. The routes now
-- insert their lead through this function, which in ONE transaction:
--
--   1. takes a transaction advisory lock on (tenant, source) — two clicks that arrive together
--      run one after the other, so the second one always sees the first one's lead;
--   2. looks for an OPEN lead (not junk, stage not won/lost) of the same tenant and source,
--      created within p_window_hours, for the same contact: same cleaned domain OR same mobile
--      (last 10 digits) OR same email. With p_match_offer (the quote route) it must ALSO be the
--      same plan, seats and value — a changed quote request is a new quote;
--   3. found → appends "Asked again <IST time>" (+ what changed: seats / plan / domain) to that
--      lead's notes and returns {action: 'joined', lead_id}; nothing new is created;
--   4. not found → inserts p_row as the new lead (only the keys given, so column defaults still
--      apply) under p_tenant and returns {action: 'created', lead_id}.
--
-- Another tenant's leads are never read or written. Old duplicate leads are not touched.
-- SECURITY DEFINER, execute for service_role only (the public routes use the admin client).

create or replace function public.website_lead_once(
  p_tenant       uuid,
  p_row          jsonb,
  p_window_hours integer,
  p_match_offer  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- R-2968
  v_source text := nullif(btrim(coalesce(p_row->>'source', '')), '');
  v_email  text := lower(btrim(coalesce(p_row->>'contact_email', '')));
  v_phone  text := right(regexp_replace(coalesce(p_row->>'contact_phone', ''), '\D', '', 'g'), 10);
  v_domain text := lower(btrim(coalesce(p_row->>'domain', '')));
  v_hours  integer := least(greatest(coalesce(p_window_hours, 24), 1), 168);
  v_seats  integer;
  v_old    public.leads;
  v_note   text;
  v_cols   text;
  v_bad    text;
  v_id     text;
begin
  if p_tenant is null or p_row is null or jsonb_typeof(p_row) <> 'object'
     or v_source is null or nullif(btrim(coalesce(p_row->>'id', '')), '') is null then
    raise exception 'website_lead_once: tenant, source and lead id are required' using errcode = '22023';
  end if;
  v_seats := nullif(p_row->>'seats', '')::integer;

  -- Two requests at once for the same storefront + form wait for each other here.
  perform pg_advisory_xact_lock(hashtextextended('R-2968|' || p_tenant::text || '|' || v_source, 0));

  select l.* into v_old
    from public.leads l
   where l.tenant_id = p_tenant
     and l.source = v_source
     and not coalesce(l.is_junk, false)
     and l.stage::text not in ('won', 'lost')
     and l.created_at >= now() - make_interval(hours => v_hours)
     and (   (v_domain <> '' and lower(btrim(coalesce(l.domain, ''))) = v_domain)
          or (length(v_phone) = 10 and right(regexp_replace(coalesce(l.contact_phone, ''), '\D', '', 'g'), 10) = v_phone)
          or (v_email <> '' and lower(btrim(coalesce(l.contact_email, ''))) = v_email))
     and (not coalesce(p_match_offer, false)
          or (l.plan is not distinct from (p_row->>'plan')
              and l.seats is not distinct from v_seats
              and l.value is not distinct from nullif(p_row->>'value', '')::numeric))
   order by l.created_at, l.id
   limit 1
   for update;

  if found then
    v_note := 'Asked again ' || to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') || ' IST';
    if v_seats is not null and v_old.seats is distinct from v_seats then
      v_note := v_note || format(' — seats now %s (was %s)', v_seats, coalesce(v_old.seats::text, 'blank'));
    end if;
    if (p_row->>'plan') is not null and v_old.plan is distinct from (p_row->>'plan') then
      v_note := v_note || format(' — plan now %s (was %s)', p_row->>'plan', coalesce(v_old.plan, 'blank'));
    end if;
    if v_domain <> '' and lower(btrim(coalesce(v_old.domain, ''))) <> v_domain then
      v_note := v_note || format(' — domain now %s (was %s)', v_domain, coalesce(nullif(v_old.domain, ''), 'blank'));
    end if;
    update public.leads
       set notes = concat_ws(E'\n', nullif(notes, ''), v_note),
           updated_at = now()
     where id = v_old.id and tenant_id = p_tenant;
    return jsonb_build_object('action', 'joined', 'lead_id', v_old.id, 'note', v_note);
  end if;

  -- Only real leads columns; tenant_id always comes from p_tenant.
  select string_agg(k, ', ' order by k) into v_bad
    from jsonb_object_keys(p_row) k
   where not exists (select 1 from information_schema.columns c
                      where c.table_schema = 'public' and c.table_name = 'leads' and c.column_name = k);
  if v_bad is not null then
    raise exception 'website_lead_once: not a leads column: %', v_bad using errcode = '22023';
  end if;
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'leads'
     and c.column_name <> 'tenant_id' and p_row ? c.column_name;

  execute format(
    'insert into public.leads (tenant_id, %1$s) select $2, %1$s from jsonb_populate_record(null::public.leads, $1) returning id',
    v_cols)
    using p_row, p_tenant
    into v_id;
  return jsonb_build_object('action', 'created', 'lead_id', v_id);
end;
$$;

revoke all on function public.website_lead_once(uuid, jsonb, integer, boolean) from public, anon, authenticated;
grant execute on function public.website_lead_once(uuid, jsonb, integer, boolean) to service_role;

comment on function public.website_lead_once(uuid, jsonb, integer, boolean) is
  'R-2968: website trial / quote request — joins the same contact''s open request of the same form within the window ("Asked again" note) instead of a new lead; race-safe by an advisory lock per tenant + form. Service role only.';
