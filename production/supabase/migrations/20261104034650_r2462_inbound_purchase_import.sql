-- deploy-peek: to_regprocedure('public.import_inbound_purchase(bigint)') is not null and to_regprocedure('public.set_inbound_purchase_status(bigint,text)') is not null and exists (select 1 from pg_trigger where tgname = 'trg_inbound_purchases_r2462_guard')
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
--       pending  → create the expense (the fields the browser used to write) + mark imported with
--                  its id, in one transaction; answers {expense_id, already: false}
--       imported → nothing new; answers {expense_id, already: true} (idempotent: a second person,
--                  a double click or a retry gets the SAME expense; the screen says "Already added")
--       imported, but its expense was deleted later (expense_id set null by the FK) → booked again
--       ignored  → refused: restore it first
--     A non-INR order is refused (the browser stored fx_rate 1 = foreign amount as rupees): the
--     message says to add it in Expenses with the rupee rate and Ignore it here.
--   * set_inbound_purchase_status(p_id, p_status) — Ignore ('ignored') and Restore ('pending') with
--     the same gates; an imported row whose expense exists cannot be ignored.
--   * the UPDATE policy is tightened to the same roles (USING + WITH CHECK), not dropped: a tab still
--     on the old page code during the deploy keeps working as before instead of silently changing
--     0 rows; sales / support can no longer change these rows at all.
--   * trigger trg_inbound_purchases_r2462_guard: an imported row that names its expense cannot be
--     moved off 'imported' or pointed at a different expense, and 'imported' needs an expense — so
--     even an old tab's second click errors instead of re-pointing the row (the FK's own
--     "expense deleted → expense_id null" update is still allowed).
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
  v_cur    text;
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

  if v_row.status = 'imported' and v_row.expense_id is not null then
    return jsonb_build_object('expense_id', v_row.expense_id, 'already', true);
  end if;
  if v_row.status = 'ignored' then
    raise exception 'This order email was ignored — restore it before adding it to expenses.' using errcode = 'P0001';
  end if;

  v_cur := upper(coalesce(nullif(btrim(v_row.currency), ''), 'INR'));
  if v_cur <> 'INR' then
    raise exception 'This order is in % — add it from Expenses → Add expense with the rupee rate, then Ignore it here.', v_cur
      using errcode = 'P0001';
  end if;

  -- The same draft expense the browser used to write (paid = false), amount EX-GST. Both parts are
  -- whole rupees and add up to the rounded order total.
  v_gross := round(coalesce(v_row.total, 0));
  v_gst   := least(greatest(round(coalesce(v_row.gst, 0)), 0), greatest(v_gross, 0));
  select left(string_agg(coalesce(i.v->>'qty', '1') || '× ' || coalesce(i.v->>'name', ''), ', ' order by i.n), 500)
    into v_items
    from jsonb_array_elements(case when jsonb_typeof(v_row.items) = 'array' then v_row.items else '[]'::jsonb end)
         with ordinality as i(v, n);
  v_desc := case
              when v_row.source = 'amazon' and coalesce(v_row.order_id, '') <> '' then 'Amazon order ' || v_row.order_id
              when v_row.source = 'amazon' then 'Amazon purchase'
              when coalesce(v_row.order_id, '') <> '' then 'Online order ' || v_row.order_id
              else 'Online purchase'
            end
            || coalesce(' — ' || nullif(v_items, ''), '');

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(lpad(to_hex((random() * 255)::int), 2, '0'));

  insert into public.expenses
    (id, tenant_id, category, vendor_name, currency, fx_rate, bill_type, bill_no,
     expense_date, amount, gst_paid, paid, description)
  values
    (v_exp_id, v_tenant, 'Office Supplies',
     case when v_row.source = 'amazon' then 'Amazon' else 'Online purchase' end,
     'INR', 1,
     case when v_gst > 0 then 'gst' else 'none' end,
     v_row.order_id,
     coalesce(v_row.order_date, public.ist_today()),
     greatest(v_gross - v_gst, 0), v_gst, false, v_desc);

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
grant execute on function public.import_inbound_purchase(bigint) to authenticated;


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

  if v_row.status = 'imported' and v_row.expense_id is not null then
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
  'an imported email whose expense exists is refused.';

revoke all on function public.set_inbound_purchase_status(bigint, text) from public, anon;
grant execute on function public.set_inbound_purchase_status(bigint, text) to authenticated;


-- Direct UPDATE (old page code during the deploy): only the money-write roles of the row's company.
drop policy if exists inbound_purchases_update on public.inbound_purchases;
create policy inbound_purchases_update on public.inbound_purchases as permissive for update
  using ((tenant_id = (select public.current_tenant_id()))
         and (select public.current_user_has_role('owner', 'manager', 'accountant')))
  with check ((tenant_id = (select public.current_tenant_id()))
              and (select public.current_user_has_role('owner', 'manager', 'accountant')));


-- An imported row that names its expense stays on it; 'imported' needs an expense.
create or replace function public.tg_inbound_purchases_r2462_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  /* R-2462: whoever updates (old page code, a script): one order email → one expense. */
  if old.status = 'imported' and old.expense_id is not null
     and (new.status <> 'imported'
          or (new.expense_id is not null and new.expense_id <> old.expense_id)) then
    raise exception 'Already added to expenses — open the expense in Expenses to change or delete it.'
      using errcode = 'P0001';
  end if;
  if new.status = 'imported' and new.expense_id is null
     and not (old.status = 'imported' and old.expense_id is not null) then
    raise exception 'An order email is marked added to expenses only together with its expense — use Add to expenses.'
      using errcode = 'P0001';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_inbound_purchases_r2462_guard on public.inbound_purchases;
create trigger trg_inbound_purchases_r2462_guard
  before update of status, expense_id on public.inbound_purchases
  for each row execute function public.tg_inbound_purchases_r2462_guard();

commit;
