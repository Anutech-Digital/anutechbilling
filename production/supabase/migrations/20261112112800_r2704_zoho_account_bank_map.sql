-- deploy-peek: to_regprocedure('public.save_zoho_account_bank_choice(text,text,text)') is not null
-- deploy-key: r2704bankmap
--
-- R-2704 (G-FY2526): the FY Zoho import dialogs remember which app account each Zoho account goes to.
-- 12 Nov staging: the receipts dialog forgot "M/S. EXCEL TECHNOLOGIES → HDFC 4523" on reopen, and the
-- purchase dialog's "Paid from" choice the same — the owner had to set every account again.
--
-- One row per company + use + Zoho account:
--   use 'receipts'  — key = Zoho deposit account id (FY receipts import);
--   use 'purchases' — key = Zoho paid-through account NAME (FY purchase import keys its map by name).
--   choice = an app bank / cash / card account of the SAME company, or 'none' (Leave these out).
-- Written only by save_zoho_account_bank_choice() (owner / accountant); a blank choice forgets the row.
-- Read by the import routes (service role) as the default under what the dialog sends.

create table if not exists public.zoho_account_bank_map (
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  use_for         text        not null check (use_for in ('receipts', 'purchases')),
  zoho_key        text        not null check (char_length(zoho_key) between 1 and 200),
  bank_account_id uuid        references public.bank_accounts(id) on delete cascade,
  leave_out       boolean     not null default false,
  updated_by      uuid        references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, use_for, zoho_key),
  constraint zoho_account_bank_map_one_choice check (leave_out = (bank_account_id is null))
);
comment on table public.zoho_account_bank_map is
  'R-2704: Zoho account → app bank / cash / card account (or Leave these out), per company, for the FY receipts (key = Zoho deposit account id) and purchase (key = Zoho paid-through name) imports. Written only by save_zoho_account_bank_choice().';
alter table public.zoho_account_bank_map enable row level security;
revoke all on table public.zoho_account_bank_map from public, anon, authenticated;
grant select on table public.zoho_account_bank_map to authenticated;
grant all on table public.zoho_account_bank_map to service_role;
drop policy if exists zoho_account_bank_map_select on public.zoho_account_bank_map;
create policy zoho_account_bank_map_select on public.zoho_account_bank_map as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_account_bank_map;
create policy zzz_service_role_all on public.zoho_account_bank_map as permissive for all to service_role using (true) with check (true);

create or replace function public.save_zoho_account_bank_choice(p_use text, p_key text, p_choice text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2704 — one Zoho account's choice; '' forgets it (the dialog then suggests again). */
  v_tenant uuid := public.current_tenant_id();
  v_key    text := btrim(coalesce(p_key, ''));
  v_choice text := btrim(coalesce(p_choice, ''));
  v_bank   uuid;
begin
  if v_tenant is null then
    raise exception 'Saving the account choice needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can choose where Zoho accounts go.' using errcode = '42501';
  end if;
  if p_use is null or p_use not in ('receipts', 'purchases') then
    raise exception 'Choose receipts or purchases.' using errcode = '22023';
  end if;
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'A Zoho account is missing.' using errcode = '22023';
  end if;

  if v_choice = '' then
    delete from public.zoho_account_bank_map where tenant_id = v_tenant and use_for = p_use and zoho_key = v_key;
    return jsonb_build_object('saved', false, 'cleared', true);
  end if;

  if v_choice <> 'none' then
    if v_choice !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Choose one of your accounts, or Leave these out.' using errcode = '22023';
    end if;
    select b.id into v_bank from public.bank_accounts b
     where b.id = v_choice::uuid and b.tenant_id = v_tenant and b.closed_on is null;
    if v_bank is null then
      raise exception 'That account is not one of this company''s open accounts.' using errcode = '22023';
    end if;
  end if;

  insert into public.zoho_account_bank_map (tenant_id, use_for, zoho_key, bank_account_id, leave_out, updated_by, updated_at)
  values (v_tenant, p_use, v_key, v_bank, v_bank is null, auth.uid(), now())
  on conflict (tenant_id, use_for, zoho_key) do update
    set bank_account_id = excluded.bank_account_id, leave_out = excluded.leave_out,
        updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('saved', true, 'cleared', false);
end;
$function$;
comment on function public.save_zoho_account_bank_choice(text, text, text) is
  'R-2704: remember one Zoho account → app account (or none = Leave these out; '''' = forget) for the FY receipts / purchase import, per company. Owner / accountant.';
revoke all on function public.save_zoho_account_bank_choice(text, text, text) from public, anon;
grant execute on function public.save_zoho_account_bank_choice(text, text, text) to authenticated, service_role;
