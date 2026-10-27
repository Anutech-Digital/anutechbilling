-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.consume_prepaid_advance(uuid,integer,date,text,integer,text)') and pg_get_function_arguments(oid) ilike '%ist_today()%' and pg_get_function_arguments(oid) not ilike '%current_date%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.consume_prepaid_fifo(text,integer,integer,date,text,text,uuid,text,integer,integer,integer,text,integer)') and pg_get_function_arguments(oid) ilike '%ist_today()%' and pg_get_function_arguments(oid) not ilike '%current_date%')
-- deploy-key: r1830prepaidpdateist
-- 20261024091100_r1830_prepaid_pdate_ist.sql
--
-- R-1830 (24 Oct 2026) — follow-up to R-1828 (20261024085113). consume_prepaid_advance and
-- consume_prepaid_fifo still had `p_date date DEFAULT CURRENT_DATE`. CURRENT_DATE is the day in
-- the session time zone and Cloud SQL runs in UTC, so a call between 00:00 and 05:30 IST that
-- leaves p_date out booked the prepaid expense (expense_date + paid_date) on YESTERDAY — on
-- 1 April, the previous financial year. R-1826's night scan read function BODIES only, so a
-- parameter default slipped past it; night_ist_pin.test.sql now scans argument defaults too.
--
-- The only change: that one parameter default → public.ist_today() (20260930172000 — STABLE,
-- (now() at time zone 'Asia/Kolkata')::date), exactly as R-1828 did for give/top_up/
-- settle_employee_advance. Bodies are the LATEST definitions, copied verbatim from
-- pg_get_functiondef on a database with every supabase migration applied, and checked equal
-- (prosrc md5) to the newest create-or-replace in the repo:
--
--   consume_prepaid_advance   20261018225100_r1615_definer_tenant_gate (supabase; the older prisma
--                             20261005120000_tenant_context copy is superseded by it)
--   consume_prepaid_fifo      20260927210000_prepaid_invoice_details (supabase; not in prisma)
--
-- Neither body uses auth.uid()/auth.role(), so the deploy-db token rewrite has nothing to swap.
-- Same signature (a default is not part of it), so CREATE OR REPLACE keeps owner, grants
-- (authenticated + service_role, no anon/PUBLIC), SECURITY DEFINER, search_path and comment.
-- Stored rows are NOT changed.
-- Proof: supabase/tests/night_ist_pin.test.sql (ARGS ratchet) + the R-1830 rollback run.

begin;

CREATE OR REPLACE FUNCTION public.consume_prepaid_advance(p_advance_id uuid, p_amount integer, p_date date DEFAULT public.ist_today(), p_note text DEFAULT NULL::text, p_gst integer DEFAULT 0, p_attachment text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-1615: current_tenant_id() — NULL for a deactivated user or a half-signed-in MFA session. */
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_exp_id text;
  v_new    int;
begin
  if v_tenant is null then
    raise exception 'Using a prepaid advance needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry — if your account was switched off, ask your workspace owner to turn it on in Team.'
      using errcode = '28000';
  end if;
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
  update public.prepaid_advances set consumed_amount = v_new, updated_at = now()
   where id = p_advance_id and tenant_id = v_tenant;
  return v_adv.total_amount - v_new;
end $function$;

CREATE OR REPLACE FUNCTION public.consume_prepaid_fifo(p_vendor_name text, p_amount integer, p_gst integer DEFAULT 0, p_date date DEFAULT public.ist_today(), p_note text DEFAULT NULL::text, p_attachment text DEFAULT NULL::text, p_vendor_id uuid DEFAULT NULL::uuid, p_bill_no text DEFAULT NULL::text, p_igst integer DEFAULT NULL::integer, p_cgst integer DEFAULT NULL::integer, p_sgst integer DEFAULT NULL::integer, p_tds_section text DEFAULT NULL::text, p_tds_amount integer DEFAULT 0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_available integer;
  v_left      integer := p_amount;
  v_gst_left  integer := greatest(0, coalesce(p_gst, 0));
  v_igst_left integer; v_cgst_left integer; v_sgst_left integer;
  v_adv       record;
  v_take      integer;
  v_gst_take  integer; v_igst_take integer; v_cgst_take integer; v_sgst_take integer;
  v_exp_id    text;
  v_parts     integer;
  v_part      integer := 0;
  v_vendor_id uuid;
  v_tds       integer := greatest(0, coalesce(p_tds_amount, 0));
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Invoice amount must be more than zero.'; end if;
  if v_gst_left > p_amount then raise exception 'GST (₹%) cannot be more than the invoice total (₹%).', v_gst_left, p_amount; end if;

  /* Heads: given → must add up to the GST; not given → all under CGST+SGST split evenly
     (what the GST page assumed before, now stated on the row instead of guessed later). */
  if p_igst is not null or p_cgst is not null or p_sgst is not null then
    v_igst_left := greatest(0, coalesce(p_igst, 0)); v_cgst_left := greatest(0, coalesce(p_cgst, 0)); v_sgst_left := greatest(0, coalesce(p_sgst, 0));
    if v_igst_left + v_cgst_left + v_sgst_left <> v_gst_left then
      raise exception 'IGST + CGST + SGST (₹%) must equal the GST (₹%).', v_igst_left + v_cgst_left + v_sgst_left, v_gst_left;
    end if;
  else
    v_igst_left := 0; v_cgst_left := v_gst_left / 2; v_sgst_left := v_gst_left - v_cgst_left;
  end if;
  if v_tds > p_amount - v_gst_left then raise exception 'TDS (₹%) cannot be more than the pre-GST value (₹%).', v_tds, p_amount - v_gst_left; end if;
  if v_tds > 0 and nullif(trim(coalesce(p_tds_section, '')), '') is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds; end if;

  if p_vendor_id is not null then
    perform 1 from public.vendors where id = p_vendor_id and tenant_id = v_tenant;
    if not found then raise exception 'Vendor not found'; end if;
  end if;

  perform 1 from public.prepaid_advances
    where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
      and total_amount > consumed_amount
    for update;

  select coalesce(sum(total_amount - consumed_amount), 0), count(*)
    into v_available, v_parts
    from public.prepaid_advances
   where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
     and total_amount > consumed_amount;

  if v_available < p_amount then
    raise exception 'Only ₹% is left in % advances, but the invoice is ₹%. Record the missing top-up first (reconcile its bank line as an advance), then book the invoice.',
      v_available, trim(p_vendor_name), p_amount;
  end if;

  /* Teach the advances their vendor, once. */
  if p_vendor_id is not null then
    update public.prepaid_advances set vendor_id = p_vendor_id, updated_at = now()
     where tenant_id = v_tenant and vendor_id is null and upper(trim(vendor_name)) = upper(trim(p_vendor_name));
  end if;

  for v_adv in
    select * from public.prepaid_advances
     where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
       and total_amount > consumed_amount
     order by paid_date, created_at, id
  loop
    exit when v_left <= 0;
    v_part := v_part + 1;
    v_take := least(v_left, v_adv.total_amount - v_adv.consumed_amount);
    if v_take = v_left then
      v_gst_take := v_gst_left; v_igst_take := v_igst_left; v_cgst_take := v_cgst_left; v_sgst_take := v_sgst_left;
    else
      v_gst_take  := least(v_gst_left,  round(coalesce(p_gst, 0)::numeric * v_take / p_amount)::int);
      v_igst_take := least(v_igst_left, round(v_igst_left::numeric * v_take / v_left)::int);
      v_cgst_take := least(v_cgst_left, round(v_cgst_left::numeric * v_take / v_left)::int);
      v_sgst_take := least(v_sgst_left, v_gst_take - v_igst_take - v_cgst_take);
    end if;
    v_vendor_id := coalesce(p_vendor_id, v_adv.vendor_id);

    v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, igst, cgst, sgst, expense_date, paid, paid_date,
       bill_type, bill_no, payment_method, description, notes, attachment_url, prepaid_advance_id,
       tds_section, tds_amount)
    values
      (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_vendor_id, v_take, v_gst_take, v_igst_take, v_cgst_take, v_sgst_take, p_date, true, p_date,
       case when v_gst_take > 0 then 'gst' else 'none' end, nullif(trim(coalesce(p_bill_no, '')), ''), 'advance',
       'Invoice from ' || v_adv.vendor_name || ' advance' ||
         case when v_take < p_amount then ' (part ' || v_part || ', ₹' || v_take || ' of ₹' || p_amount || ')' else '' end,
       p_note, p_attachment, v_adv.id,
       case when v_take = v_left and v_tds > 0 then trim(p_tds_section) end,
       case when v_take = v_left then v_tds else 0 end);

    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, updated_at = now()
     where id = v_adv.id;

    v_left := v_left - v_take;
    v_gst_left := v_gst_left - v_gst_take; v_igst_left := v_igst_left - v_igst_take; v_cgst_left := v_cgst_left - v_cgst_take; v_sgst_left := v_sgst_left - v_sgst_take;
  end loop;

  return v_available - p_amount;
end;
$function$;

commit;
