-- Website theme switch (13 Nov 2026). Migration: 20261113102122_website_theme_switch.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- The fixture owns its data (AGENTS.md L11): its own tenant, never the live one.
--
-- Proves:
--   A. A new tenant starts on 'classic' — deploying the column changes no website.
--   B. 'warm' is accepted, and switching back to 'classic' works (the switch goes both ways).
--   C. Anything else is refused by the CHECK constraint.

begin;

-- tenants carries supplier-identity guards on insert; fill them the way r2416's test does.
create function pg_temp.wts_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_wts_supplier before insert on public.tenants for each row execute function pg_temp.wts_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-00000000a7e1', 'Theme Test Co', 'theme-test@example.in', '07', 'THMT');

do $$
declare
  v text;
  refused boolean := false;
begin
  -- A
  select website_theme into v from public.tenants where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  if v is distinct from 'classic' then
    raise exception 'FAIL A: a new tenant should start on classic, got %', v;
  end if;

  -- B
  update public.tenants set website_theme = 'warm' where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  select website_theme into v from public.tenants where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  if v is distinct from 'warm' then raise exception 'FAIL B: could not switch to warm, got %', v; end if;
  update public.tenants set website_theme = 'classic' where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  select website_theme into v from public.tenants where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  if v is distinct from 'classic' then raise exception 'FAIL B: could not switch back to classic, got %', v; end if;

  -- C
  begin
    update public.tenants set website_theme = 'blue' where id = 'dddddddd-0000-0000-0000-00000000a7e1';
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'FAIL C: an unknown theme was accepted'; end if;

  raise notice 'PASS: website_theme defaults to classic, switches both ways, refuses unknown values';
end $$;

select 'PASS' as website_theme_switch;

rollback;
