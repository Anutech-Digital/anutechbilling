-- R-2011 (1 Nov 2026, goal G-DPDP): website forms record the marketing opt-in in consent_events.
-- Migration 20261101203103_r2011_form_consent.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. The server records a form row for a LEAD: source 'form', the form's key, purpose
--      marketing, granted (box ticked) or denied (box left empty).
--   B. A bad form key is refused; an unknown source is still refused.
--   C. Still insert-only: the form and the choice of a recorded row cannot be changed.
--   D. The latest row per lead decides (ticked earlier, unticked later = no consent).

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000201101','R2011 Site','r2011@example.in','07','R2011');

-- ── A. Form rows for leads ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.consent_events (tenant_id, lead_id, purpose, choice, notice_version, source, form, page, created_at) values
  ('dddddddd-0000-0000-0000-000000201101','L-R2011A','marketing','granted','2026-11-01','form','enquiry','/enquiry', now() - interval '2 hours'),
  ('dddddddd-0000-0000-0000-000000201101','L-R2011B','marketing','denied','2026-11-01','form','buy_checkout','/buy/workspace', now() - interval '2 hours'),
  ('dddddddd-0000-0000-0000-000000201101','L-R2011C','marketing','granted','2026-11-01','form','trial','/trial', now() - interval '2 hours'),
  ('dddddddd-0000-0000-0000-000000201101','L-R2011C','marketing','denied','2026-11-01','form','callback','/', now() - interval '1 hour');

do $$
begin
  if (select count(*) from public.consent_events where tenant_id = 'dddddddd-0000-0000-0000-000000201101' and source = 'form') <> 4 then
    raise exception 'FAIL A1: form consent rows were not recorded';
  end if;
  if (select form from public.consent_events where lead_id = 'L-R2011B') is distinct from 'buy_checkout' then
    raise exception 'FAIL A2: the form key was not kept';
  end if;
end $$;

-- ── B. Checks ──────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.consent_events (tenant_id, lead_id, purpose, choice, notice_version, source, form)
    values ('dddddddd-0000-0000-0000-000000201101','L-R2011X','marketing','granted','x','form','Enquiry Form!');
    raise exception 'FAIL B1: a bad form key was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.consent_events (tenant_id, lead_id, purpose, choice, notice_version, source, form)
    values ('dddddddd-0000-0000-0000-000000201101','L-R2011X','marketing','granted','x','popup','enquiry');
    raise exception 'FAIL B2: an unknown source was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ── C. Insert-only ─────────────────────────────────────────────────────────
do $$
begin
  begin
    update public.consent_events set form = 'trial' where lead_id = 'L-R2011A';
    raise exception 'FAIL C1: the server changed the form of a consent record';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.consent_events set choice = 'granted' where lead_id = 'L-R2011B';
    raise exception 'FAIL C2: the server turned a declined opt-in into a yes';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── D. Latest row per lead decides ─────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(lead_id || '=' || choice, ',' order by lead_id) into v from (
    select distinct on (lead_id) lead_id, choice from public.consent_events
     where tenant_id = 'dddddddd-0000-0000-0000-000000201101' and purpose = 'marketing' and lead_id is not null
     order by lead_id, created_at desc
  ) x;
  if v is distinct from 'L-R2011A=granted,L-R2011B=denied,L-R2011C=denied' then
    raise exception 'FAIL D1: latest marketing choice per lead is wrong: %', v;
  end if;
end $$;
reset role;

rollback;
