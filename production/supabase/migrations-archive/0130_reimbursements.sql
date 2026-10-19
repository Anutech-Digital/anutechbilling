-- 0130: reimbursements — company expenses paid from a person's own card/money.
-- ============================================================================
-- Scenario: a purchase is made in the company's name but paid with someone
-- else's credit card / cash. The COST is a real company expense (P&L), and the
-- company now OWES that person until it repays them.
--
--   add_reimbursement    → books the expense (P&L) + records the payable (pending)
--   settle_reimbursement → marks it repaid (the actual bank transfer to the
--                          person is reconciled manually in Banking — it is NOT
--                          a second expense)
--   delete_reimbursement → undo (also removes the booked expense if unreconciled)

create table if not exists public.reimbursements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  person_name   text not null,
  purpose       text not null,
  category      text not null default 'Other',
  amount        integer not null,
  gst_paid      integer not null default 0,
  incurred_on   date not null,
  paid_via      text,                    -- e.g. "Ramesh's HDFC credit card"
  status        text not null default 'pending' check (status in ('pending','settled')),
  settled_on    date,
  settled_notes text,
  expense_id    text references public.expenses(id) on delete set null,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists reimbursements_tenant_idx on public.reimbursements(tenant_id);
create index if not exists reimbursements_status_idx on public.reimbursements(tenant_id, status);

alter table public.reimbursements enable row level security;
drop policy if exists "reimbursements tenant all" on public.reimbursements;
create policy "reimbursements tenant all" on public.reimbursements
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ── Add: book the expense (P&L) + track the payable ──────────────────────────
create or replace function public.add_reimbursement(
  p_person text, p_purpose text, p_category text, p_amount integer,
  p_gst integer, p_incurred_on date, p_paid_via text
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'Other');
  v_via    text := nullif(trim(coalesce(p_paid_via, '')), '');
  v_exp_id text;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if coalesce(trim(p_person), '') = '' then raise exception 'Who paid? — person name is required'; end if;
  if coalesce(trim(p_purpose), '') = '' then raise exception 'What was it for? — purpose is required'; end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, v_cat, trim(p_person), coalesce(p_incurred_on, current_date), p_amount, greatest(coalesce(p_gst, 0), 0), 'reimbursement',
          'Reimbursement · ' || p_purpose || ' · paid by ' || trim(p_person) || coalesce(' (' || v_via || ')', ''));

  insert into public.reimbursements (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, expense_id, created_by)
  values (v_tenant, trim(p_person), trim(p_purpose), v_cat, p_amount, greatest(coalesce(p_gst, 0), 0), coalesce(p_incurred_on, current_date), v_via, v_exp_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$;

-- ── Settle: mark repaid (no second expense; bank transfer reconciled manually) ─
create or replace function public.settle_reimbursement(p_id uuid, p_settled_on date, p_notes text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  update public.reimbursements
     set status = 'settled', settled_on = coalesce(p_settled_on, current_date),
         settled_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_id;
end;
$function$;

-- ── Delete/undo: remove the payable + its booked expense (if still unreconciled) ─
create or replace function public.delete_reimbursement(p_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  delete from public.reimbursements where id = p_id;
  if v_r.expense_id is not null then
    delete from public.expenses where id = v_r.expense_id and tenant_id = v_r.tenant_id and reconciled_txn_id is null;
  end if;
end;
$function$;
