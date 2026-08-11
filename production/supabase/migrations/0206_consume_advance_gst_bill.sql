-- 0206 — consume_prepaid_advance now captures the vendor's GST invoice: the input
-- GST (ITC) and the attached bill flow onto the booked expense (e.g. Facebook's
-- monthly ad tax-invoice). Adds p_gst + p_attachment params.
drop function if exists public.consume_prepaid_advance(uuid, int, date, text);

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
    (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, expense_date, paid, paid_date, bill_type, payment_method, description, notes, attachment_url)
  values
    (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_adv.vendor_id, p_amount, greatest(0, coalesce(p_gst,0)), p_date, true, p_date,
     case when coalesce(p_gst,0) > 0 then 'gst' else 'none' end, 'advance',
     'Consumed from ' || v_adv.vendor_name || ' advance', p_note, p_attachment);

  v_new := v_adv.consumed_amount + p_amount;
  update public.prepaid_advances set consumed_amount = v_new, updated_at = now() where id = p_advance_id;
  return v_adv.total_amount - v_new;
end $$;
grant execute on function public.consume_prepaid_advance(uuid, int, date, text, int, text) to authenticated;
