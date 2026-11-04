-- deploy-peek: to_regprocedure('public.import_inbound_purchase(bigint)') is not null and to_regprocedure('public.set_inbound_purchase_status(bigint,text)') is not null and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inbound_purchases' and policyname = 'inbound_purchases_update')
-- deploy-key: r2462inboundimport
-- 20261104034650_r2462_inbound_purchase_import.sql
--
-- R-2462 (4 Nov 2026): Purchases → Purchase Inbox "Add to expenses" can book one order email twice.
--
-- THE BUG: useImportPurchase (lib/queries/inbound-purchases.ts) inserted the expense FIRST from the
-- browser, then updated inbound_purchases to 'imported' with no status = 'pending' check. Since
-- R-2461 the owner AND the accountant work this inbox, so two people (or a double click / retry)
-- on the same order = two expenses → P&L and GST input counted twice. And the UPDATE policy on
-- inbound_purchases was tenant-only (20261019003408), so any role — sales, support — could mark a
-- row imported / ignored straight through the table.
--
-- THE FIX (production/CLAUDE.md §17b — one atomic SECURITY DEFINER function per multi-row write):
--   * import_inbound_purchase(p_id) — tenant gate (fails closed, §17c), personal-workspace wall
--     (GP-09: expenses are walled for a personal session), money-write roles owner / manager /
--     accountant (= MONEY_WRITE_ROLES in lib/nav.ts, who see the page), row lock FOR UPDATE, then:
--       pending  → create the expense (the same fields the browser used to write) + mark imported
--                  with its id, in one transaction; answers {expense_id, already: false}
--       imported → nothing new; answers {expense_id, already: true} (idempotent: a second person,
--                  a double click or a retry gets the SAME expense, the screen says "Already added")
--       ignored  → refused: restore it first
--   * set_inbound_purchase_status(p_id, p_status) — Ignore ('ignored') and Restore ('pending') with
--     the same gates; an imported row cannot be ignored (the expense exists — delete that instead).
--   * the tenant-only UPDATE policy is dropped: the webhook inserts with the service role and every
--     status change now goes through the two functions, so the browser has no direct UPDATE left.
--     (supabase/cloudsql/05-restore-app-rls-policies.sql is the 7 Sep one-off Cloud SQL restore;
--     it is not part of the deploy and is left as it is.)
--
-- Test: supabase/tests/r2462_inbound_purchase_import.test.sql (rolled back; red without this file).

begin;

create or replace function public.import_inbound_purchase(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2462: one order email → one expense, whoever clicks and however often. */
  v_tenant uuid := public.current_tenant_id();
  v_row    public.inbound_purchases;
  v_gross  numeric;
  v_gst    numeric;
  v_items  text;
  v_desc   text;
  v_exp_id text;
begin
  if v_tenant is null then
    raise exception 'Sign in to your company to add purchases to expenses.' using errcode = '28000';
  end if;
  if public.is_personal_session() then
    raise exception 'Purchases are part of a business account — switch to your business to add this to expenses.'
      using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only the owner, a manager or the accountant can add purchases to expenses — ask one of them.'
      using errcode = '42501';
  end if;

  select * into v_row from public.inbound_purchases
   where id = p_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'This order email was not found — refresh the Purchase Inbox.' using errcode = 'P0002';
  end if;

  if v_row.status = 'imported' then
    return jsonb_build_object('expense_id', v_row.expense_id, 'already', true);
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This order email was ignored — restore it before adding it to expenses.' using errcode = 'P0001';
  end if;

  -- The same expense the browser used to write: a draft (paid = false), amount EX-GST.
  v_gross := coalesce(v_row.total, 0);
  v_gst   := coalesce(v_row.gst, 0);
  select left(string_agg(coalesce(i.v->>'qty', '1') || '× ' || coalesce(i.v->>'name', ''), ', ' order by i.n), 500)
    into v_items
    from jsonb_array_elements(case when jsonb_typeof(v_row.items) = 'array' then v_row.items else '[]'::jsonb end)
         with ordinality as i(v, n);
  v_desc := case when coalesce(v_row.order_id, '') <> '' then 'Amazon order ' || v_row.order_id else 'Amazon purchase' end
            || coalesce(' — ' || nullif(v_items, ''), '');

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(lpad(to_hex((random() * 255)::int), 2, '0'));

  insert into public.expenses
    (id, tenant_id, category, vendor_name, currency, fx_rate, bill_type, bill_no,
     expense_date, amount, gst_paid, paid, description)
  values
    (v_exp_id, v_tenant, 'Office Supplies',
     case when v_row.source = 'amazon' then 'Amazon' else 'Online purchase' end,
     coalesce(nullif(v_row.currency, ''), 'INR'), 1,
     case when v_gst > 0 then 'gst' else 'none' end,
     v_row.order_id,
     coalesce(v_row.order_date, public.ist_today()),
     greatest(0, round(v_gross - v_gst)), round(v_gst), false, v_desc);

  update public.inbound_purchases
     set status = 'imported', expense_id = v_exp_id
   where id = v_row.id;

  return jsonb_build_object('expense_id', v_exp_id, 'already', false);
end
$function$;

comment on function public.import_inbound_purchase(bigint) is
  'R-2462: Purchase Inbox "Add to expenses" — locks the order email, books ONE draft expense and marks it imported in one '
  'transaction; a repeat call answers {already: true} with the same expense. Owner / manager / accountant of the row''s company.';

revoke all on function public.import_inbound_purchase(bigint) from public, anon;
grant execute on function public.import_inbound_purchase(bigint) to authenticated, service_role;


create or replace function public.set_inbound_purchase_status(p_id bigint, p_status text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2462: Ignore / Restore an order email — the same gates as import_inbound_purchase. */
  v_tenant uuid := public.current_tenant_id();
  v_row    public.inbound_purchases;
begin
  if p_status is null or p_status not in ('ignored', 'pending') then
    raise exception 'An order email can only be ignored or restored here.' using errcode = '22023';
  end if;
  if v_tenant is null then
    raise exception 'Sign in to your company to change the Purchase Inbox.' using errcode = '28000';
  end if;
  if public.is_personal_session() then
    raise exception 'Purchases are part of a business account — switch to your business to change this.'
      using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only the owner, a manager or the accountant can change the Purchase Inbox — ask one of them.'
      using errcode = '42501';
  end if;

  select * into v_row from public.inbound_purchases
   where id = p_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'This order email was not found — refresh the Purchase Inbox.' using errcode = 'P0002';
  end if;

  if v_row.status = 'imported' then
    raise exception 'Already added to expenses — open the expense in Expenses to change or delete it.' using errcode = 'P0001';
  end if;
  if v_row.status <> p_status then
    update public.inbound_purchases set status = p_status where id = v_row.id;
  end if;
  return p_status;
end
$function$;

comment on function public.set_inbound_purchase_status(bigint, text) is
  'R-2462: Ignore (''ignored'') or Restore (''pending'') a Purchase Inbox order email. Owner / manager / accountant; '
  'an imported email is refused (its expense exists).';

revoke all on function public.set_inbound_purchase_status(bigint, text) from public, anon;
grant execute on function public.set_inbound_purchase_status(bigint, text) to authenticated, service_role;


-- No direct UPDATE from the browser any more: every status change goes through the two functions.
drop policy if exists inbound_purchases_update on public.inbound_purchases;

commit;
