-- 0209 — link a consumed expense back to the prepaid advance it came from.
--
-- Until now the consume RPC only tagged the booked expense with a description
-- ("Consumed from <vendor> advance") + payment_method='advance'. That can't tell
-- two advances of the same vendor apart. Add a proper FK so each advance can
-- list exactly the expenses booked against it (with their attached bills).

alter table public.expenses
  add column if not exists prepaid_advance_id uuid references public.prepaid_advances(id) on delete set null;

create index if not exists idx_expenses_prepaid_advance on public.expenses(prepaid_advance_id);

comment on column public.expenses.prepaid_advance_id is 'If this expense was booked by consuming a prepaid advance, the advance it came from.';

-- Backfill existing consumed expenses where the vendor has exactly ONE advance
-- (unambiguous). Anything ambiguous is left null rather than mis-linked.
update public.expenses e
set prepaid_advance_id = pa.id
from public.prepaid_advances pa
where e.prepaid_advance_id is null
  and e.payment_method = 'advance'
  and e.tenant_id = pa.tenant_id
  and lower(coalesce(e.vendor_name, '')) = lower(pa.vendor_name)
  and (
    select count(*) from public.prepaid_advances pa2
    where pa2.tenant_id = e.tenant_id and lower(pa2.vendor_name) = lower(coalesce(e.vendor_name, ''))
  ) = 1;

-- Recreate consume_prepaid_advance so future consumptions set the FK.
create or replace function public.consume_prepaid_advance(
  p_advance_id uuid, p_amount int, p_date date default current_date,
  p_note text default null, p_gst int default 0, p_attachment text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_adv    public.prepaid_advances;
  v_exp_id text;
  v_new    int;
begin
  select tenant_id into v_tenant from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  select * into v_adv from public.prepaid_advances where id = p_advance_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Advance not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if p_amount > (v_adv.total_amount - v_adv.consumed_amount) then raise exception 'Amount exceeds remaining balance'; end if;

  v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, expense_date, paid, paid_date, bill_type, payment_method, description, notes, attachment_url, prepaid_advance_id)
  values
    (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_adv.vendor_id, p_amount, greatest(0, coalesce(p_gst,0)), p_date, true, p_date,
     case when coalesce(p_gst,0) > 0 then 'gst' else 'none' end, 'advance',
     'Consumed from ' || v_adv.vendor_name || ' advance', p_note, p_attachment, p_advance_id);

  v_new := v_adv.consumed_amount + p_amount;
  update public.prepaid_advances set consumed_amount = v_new, updated_at = now() where id = p_advance_id;
  return v_adv.total_amount - v_new;
end $$;
grant execute on function public.consume_prepaid_advance(uuid, int, date, text, int, text) to authenticated;
