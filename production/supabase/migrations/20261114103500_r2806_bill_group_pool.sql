-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'bill_group_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.billing_pool_subscriptions(uuid)') and prosrc like '%R-2806%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.instalment_credit_parts(uuid)') and prosrc like '%R-2806%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.billing_part_group(uuid)') and prosrc like '%R-2806%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-2806%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_subscription_billings_use_cn_credit()') and prosrc like '%R-2806%')
-- deploy-key: r2806billgrouppool
-- 20261114103500_r2806_bill_group_pool.sql
--
-- R-2806 (14 Nov 2026, p1 money) — part 1 of R-2805 "Bill together" (Pratik, report 8b70e37f: ITBUZZ
-- Technologies, Business Standard 161 seats + Business Starter 49 seats, both "Part not billed (Oct)" — last
-- cycle ONE bill, now two "Bill next part" buttons, two proformas, two GST invoices).
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- R-2092 bills the parts of ONE sale quote's subscriptions together (one proforma, one tax invoice), and the
-- money behind those parts is ONE pool per sale quote (instalment_credit_parts): the quote's receipts + the
-- part requests' receipts − the part invoices' paid_amount. Two subscriptions of one customer on DIFFERENT
-- sale quotes (renewed separately, Zoho-imported, no quote) can never share a bill — and if one invoice ever
-- covered parts of both, the second subscription's pool would subtract the whole invoice without the payment
-- (it sits on the request linked to the first one's part): its pool goes below zero, and its NEXT paid part
-- would be invoiced 'pending' — the customer chased for money already paid.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * subscriptions.bill_group_id — subscriptions billed together share it. Set only by the "Bill together"
--   RPC (R-2810), which puts it on every member AND every member's sale-quote siblings, so one group id is
--   the whole pool. Null (every row today) = nothing below changes.
-- * public.billing_pool_subscriptions(sub) — the subscriptions whose part money is ONE pool: the closure of
--   "same sale quote" (R-2092) and "same bill group" from the sub, inside its company — every member gets the
--   same pool. No group → exactly the old "this sub + its quote's".
-- * instalment_credit_parts, tg_subscription_billings_use_cn_credit and raise_subscription_billing's R-2642
--   receipt day read that pool: receipts of every member's sale quote + every member part's request, minus
--   every member part's invoice ONCE (by invoice id). So a together invoice is paid once and absorbed once.
-- * billing_part_group: for a grouped subscription, a live part request whose lines name this part
--   (billing_id) fixes the group across the pool — so paying the together proforma raises ONE tax invoice
--   for all its parts (every part's invoice_id set → R-2735 renews EACH subscription by its own mark, once),
--   and "Bill next part" on either subscription finds that request (request_open), never a second bill.
--   A request spent on an invoice that credit notes cancelled does not fix it (R-2095, as before).
-- * raise_subscription_billing: each invoice line carries ITS part's period (a together group may mix
--   periods). An R-2092 group is one period, so its lines are unchanged.
-- Known and intended: inside a bill group the customer's money is one pool (as inside one sale quote) — a
-- member's prepaid surplus may settle another member's part.
-- Not changed: R-2092's same-period grouping by sale quote, cancel_quote (already frees every part a group
-- request names), credit notes (release_credited_billing_parts works per invoice → frees every part; R-2749
-- moves each subscription back), R-2735 roll (per part mark). Tenant guards unchanged.
-- Test: supabase/tests/r2806_bill_group_pool.test.sql (one transaction, rolled back).

begin;

-- ── 1. The group ─────────────────────────────────────────────────────────────────────────────────
alter table public.subscriptions add column if not exists bill_group_id uuid;
comment on column public.subscriptions.bill_group_id is
  'R-2806: subscriptions billed together (Renewals → Bill together, R-2810) share it — their parts can go on ONE proforma / tax invoice and their part money is ONE pool (billing_pool_subscriptions). Null = billed on their own (R-2092 sale-quote grouping still applies).';
create index if not exists subscriptions_bill_group_idx
  on public.subscriptions (tenant_id, bill_group_id) where bill_group_id is not null;

-- ── 2. The pool ──────────────────────────────────────────────────────────────────────────────────
create or replace function public.billing_pool_subscriptions(p_subscription_id uuid)
returns table(subscription_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2806: the subscriptions whose part money is ONE pool — the closure of "same sale quote" (R-2092) and
     "same bill group" (Bill together) from this one, inside its company. Every member of a pool gets the same
     pool (a sub added later to a grouped sub's quote is in it too). No group → this + its quote's, as before. */
  with recursive pool(id, quote_id, bill_group_id) as (
    select s.id, s.quote_id, s.bill_group_id from public.subscriptions s where s.id = p_subscription_id
    union
    select s2.id, s2.quote_id, s2.bill_group_id
      from pool p
      join public.subscriptions s2
        on s2.tenant_id = (select s0.tenant_id from public.subscriptions s0 where s0.id = p_subscription_id)
       and ((p.quote_id is not null and s2.quote_id = p.quote_id)
            or (p.bill_group_id is not null and s2.bill_group_id = p.bill_group_id))
  )
  select pool.id from pool;
$$;
revoke all on function public.billing_pool_subscriptions(uuid) from public, anon, authenticated;
grant execute on function public.billing_pool_subscriptions(uuid) to service_role;

-- ── 3. instalment_credit_parts — body of 20261030035007 (R-2095) + R-2806 pool ─────────────────────
create or replace function public.instalment_credit_parts(p_subscription_id uuid)
returns table(base integer, open_cn integer)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2044; R-2092: ONE pool per quote. R-2095: cancelled part invoices (credited_invoice_ids).
     R-2806: ONE pool per bill group (Bill together) — billing_pool_subscriptions; no group = the quote's pool as before. */
  with subs as (
    select bp.subscription_id as id from public.billing_pool_subscriptions(p_subscription_id) bp
  ), sale_quotes as (
    select distinct s3.quote_id from public.subscriptions s3
     where s3.id in (select id from subs) and s3.quote_id is not null
  ), parts as (
    select b.id, b.invoice_id, b.credited_invoice_ids from public.subscription_billings b
     where b.subscription_id in (select id from subs)
  ), cancelled as (
    select distinct x.inv from parts, unnest(parts.credited_invoice_ids) as x(inv)
     where not exists (select 1 from parts p2 where p2.invoice_id = x.inv)
  )
  select (coalesce((select sum(p.amount)::int from public.payments p
                     where p.quote_id in (select quote_id from sale_quotes) and p.status = 'received'), 0)
        + coalesce((select sum(least(coalesce(q.amount, 0), coalesce(pr.received, 0)))::int
                      from public.quotes q
                      cross join lateral (select sum(p.amount) as received from public.payments p
                                           where p.quote_id = q.id and p.status = 'received') pr
                     where q.subscription_billing_id in (select id from parts)), 0)
        - coalesce((select sum(i.paid_amount)::int from public.invoices i
                     where i.id in (select invoice_id from parts where invoice_id is not null)), 0)
        - coalesce((select sum(i.paid_amount)::int from public.invoices i
                     where i.id in (select inv from cancelled)), 0)
        + coalesce((select sum(c.amount)::int from public.customer_credits c
                     where c.source = 'credit_note' and c.status = 'used' and c.used_invoice_id is not null
                       and c.source_invoice_id in (select inv from cancelled)), 0))::int,
         coalesce((select sum(c.amount)::int from public.customer_credits c
                    where c.source = 'credit_note' and c.status = 'open'
                      and c.source_invoice_id in (select inv from cancelled)), 0)::int;
$$;
revoke all on function public.instalment_credit_parts(uuid) from public, anon, authenticated;
grant execute on function public.instalment_credit_parts(uuid) to service_role;

-- ── 4. tg_subscription_billings_use_cn_credit — body of 20261030035007 (R-2095) + R-2806 pool ───────
create or replace function public.tg_subscription_billings_use_cn_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2095: a part was just invoiced. If the quote's pool without the open credit-note credit is
   short, the invoice was paid from that credit — mark it used (oldest first, the last one split). */
declare
  v_p     record;
  v_need  integer;
  v_c     record;
  v_take  integer;
begin
  select * into v_p from public.instalment_credit_parts(new.subscription_id);
  if v_p.open_cn is null or v_p.open_cn <= 0 or v_p.base >= 0 then return null; end if;
  v_need := least(v_p.open_cn, -v_p.base);
  for v_c in
    select c.* from public.customer_credits c
     where c.source = 'credit_note' and c.status = 'open'
       and c.source_invoice_id in (
             select distinct x.inv
               from public.subscription_billings b
               cross join unnest(b.credited_invoice_ids) as x(inv)
              where b.subscription_id in (select bp.subscription_id
                                            from public.billing_pool_subscriptions(new.subscription_id) bp))   -- R-2806
     order by c.created_at, c.id
     for update of c
  loop
    exit when v_need <= 0;
    v_take := least(v_need, v_c.amount);
    if v_take < v_c.amount then
      insert into public.customer_credits
        (tenant_id, customer_id, amount, source, source_quote_id, source_credit_note_id, source_invoice_id, note, status)
      values (v_c.tenant_id, v_c.customer_id, v_c.amount - v_take, v_c.source, v_c.source_quote_id,
              v_c.source_credit_note_id, v_c.source_invoice_id, v_c.note, 'open');
    end if;
    update public.customer_credits
       set amount = v_take, status = 'used', used_at = now(), used_invoice_id = new.invoice_id,
           note = concat_ws(' · ', nullif(note, ''), 'Re-billed on ' || new.invoice_id)
     where id = v_c.id;
    v_need := v_need - v_take;
  end loop;
  return null;
end;
$$;
revoke all on function public.tg_subscription_billings_use_cn_credit() from public, anon, authenticated;

-- ── 5. billing_part_group — body of 20261106065103 (R-2519) + R-2806 together request ─────────────
create or replace function public.billing_part_group(p_billing_id uuid)
returns table(billing_id uuid, subscription_id uuid, taxable integer, plan text, seats integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2806: a grouped subscription's part — the live request naming it fixes the group across the bill group's pool. R-2519: a request line's taxable is qty × rate. R-2092: the not-yet-invoiced parts of one quote for one period — one tax invoice, one request.
   R-2095: a request spent on an invoice that credit notes cancelled no longer fixes the group.
   R-2104: the quote-period rounding applies when the subscriptions are the quote's deal (MRR × 12
   within ₹6 a subscription of the quote's term taxable), however many rupees the parts are off. */
declare
  v_b       record;
  v_sub     record;
  v_req     record;
  v_ids     uuid[];
  v_tax     integer[];
  v_plans   text[];
  v_seats   integer[];
  v_subs    uuid[];
  v_mrr     integer;
  v_q       record;
  v_months  integer;
  v_count   integer;
  v_qtax    integer;
  v_per     integer;
  v_target  integer;
  v_sum     integer;
  v_diff    integer;
  v_pick    integer;
  v_all     integer;
  v_exact   numeric;
  v_line    jsonb;
  i         integer;
begin
  select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  if not found then return; end if;
  select s.id, s.tenant_id, s.quote_id, s.plan, s.seats, s.billing_cycle::text as cycle, s.bill_group_id   -- R-2806
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then return; end if;

  /* R-2806 (Bill together): a part of a subscription in a bill group — a live part request whose lines
     name this part (billing_id) fixes the group, across the group's pool (different sale quotes, or none).
     Only for a grouped subscription: without bill_group_id nothing below changes. */
  if v_b.invoice_id is null and v_sub.bill_group_id is not null then
    select q.id, q.line_items into v_req
      from public.quotes q
     where q.tenant_id = v_b.tenant_id
       and q.subscription_billing_id in (
             select b2.id from public.subscription_billings b2
              where b2.subscription_id in (select bp.subscription_id from public.billing_pool_subscriptions(v_sub.id) bp))
       and q.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text))
       and not (q.invoice_id is not null and q.invoice_id = any(v_b.credited_invoice_ids))
     order by (q.subscription_billing_id = v_b.id) desc, q.created_at desc, q.id
     limit 1;
    if found then
      return query
        select b2.id, b2.subscription_id, (coalesce(nullif(l->>'qty', '')::numeric, 1) * (l->>'rate')::numeric)::integer, s2.plan, s2.seats
          from jsonb_array_elements(v_req.line_items) with ordinality as x(l, n)
          join public.subscription_billings b2 on b2.id = (l->>'billing_id')::uuid
          join public.subscriptions s2 on s2.id = b2.subscription_id
         where b2.invoice_id is null and b2.tenant_id = v_b.tenant_id
           /* only parts still in this pool and at this part's GST rate — never a part whose money is another pool's */
           and b2.subscription_id in (select bp.subscription_id from public.billing_pool_subscriptions(v_sub.id) bp)
           and b2.tax_rate is not distinct from v_b.tax_rate
         order by x.n;
      return;
    end if;
  end if;

  /* Invoiced, or not sold on a quote: itself only (as before). */
  if v_b.invoice_id is not null or v_sub.quote_id is null then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* A payment request already made for this part's group fixes the group: its lines name their
     parts (billing_id). A request without such lines (one subscription, before R-2092) keeps its
     part alone. */
  select q.id, q.line_items into v_req
    from public.quotes q
   where q.subscription_billing_id in (
           select b2.id from public.subscription_billings b2
             join public.subscriptions s2 on s2.id = b2.subscription_id
            where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id
              and b2.period_start = v_b.period_start and b2.period_end = v_b.period_end)
     and (q.subscription_billing_id = v_b.id
          or q.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text)))
     /* R-2095: a request whose invoice credit notes cancelled is spent — the freed part gets a new one. */
     and not (q.invoice_id is not null and q.invoice_id = any(v_b.credited_invoice_ids))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  if found then
    if not (v_req.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text))) then
      return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
      return;
    end if;
    return query
      /* R-2519: a line is qty × rate (seats × a per-seat rate since R-2519; qty 1 before). */
      select b2.id, b2.subscription_id, (coalesce(nullif(l->>'qty', '')::numeric, 1) * (l->>'rate')::numeric)::integer, s2.plan, s2.seats
        from jsonb_array_elements(v_req.line_items) with ordinality as x(l, n)
        join public.subscription_billings b2 on b2.id = (l->>'billing_id')::uuid
        join public.subscriptions s2 on s2.id = b2.subscription_id
       where b2.invoice_id is null
       order by x.n;
    return;
  end if;

  /* The quote's other parts for the same period, not invoiced and without a request of their own. */
  select array_agg(g.id order by g.created_at, g.sid), array_agg(g.taxable_amount order by g.created_at, g.sid),
         array_agg(g.plan order by g.created_at, g.sid), array_agg(g.seats order by g.created_at, g.sid),
         array_agg(g.sid order by g.created_at, g.sid), sum(g.mrr)::int
    into v_ids, v_tax, v_plans, v_seats, v_subs, v_mrr
    from (select b2.id, b2.taxable_amount, s2.plan, s2.seats, s2.id as sid, s2.created_at,
                 round(coalesce(s2.mrr, 0))::int as mrr
            from public.subscription_billings b2
            join public.subscriptions s2 on s2.id = b2.subscription_id
           where s2.tenant_id = v_sub.tenant_id
             and s2.quote_id = v_sub.quote_id
             and s2.billing_cycle::text = v_sub.cycle
             and (s2.id = v_sub.id or s2.status = 'active')
             and b2.period_start = v_b.period_start
             and b2.period_end = v_b.period_end
             and b2.tax_rate is not distinct from v_b.tax_rate
             and b2.invoice_id is null
             and not exists (select 1 from public.quotes r where r.subscription_billing_id = b2.id
                               and not (r.invoice_id is not null and r.invoice_id = any(b2.credited_invoice_ids)))) g;

  if v_ids is null or array_length(v_ids, 1) <= 1 then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* Rounding at quote-period level: the quote's own period taxable (quote_split_due's split),
     only when the group is every split-billed subscription of the quote and the difference is
     rounding, never a seat or price change. R-2104: "rounding" was ≤ ₹1 a line — but a part laid
     from a whole-rupee MRR is off by up to ₹0.5 a MONTH (₹1.5 a quarter) plus the quote split's
     remainder on the last part: 2 × (3 seats × ₹1,002) quarterly = ₹1,506 laid vs ₹1,503 asked,
     the sheet's ₹1,774 paid, the group's ₹1,777 "short" — no tax invoice. The test is now the
     DEAL: the group's MRR × 12 within ₹6 a subscription (an MRR's own rounding) of the quote's
     term taxable. A seat or price change moves the MRR by far more and keeps the parts as laid. */
  select q.subtotal, q.discount_pct, q.billing_cycle::text as cycle, q.line_items into v_q
    from public.quotes q where q.id = v_sub.quote_id;
  v_months := case v_q.cycle when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
  select count(*) into v_all from public.subscriptions s2
   where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id and s2.status = 'active'
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle;
  if v_months is not null and v_q.cycle = v_sub.cycle and v_all = array_length(v_ids, 1) then
    v_qtax := round(coalesce(v_q.subtotal, 0))::int;
    v_qtax := v_qtax - round(v_qtax * coalesce(v_q.discount_pct, 0) / 100.0)::int;
    v_count := ceil(12.0 / v_months)::int;
    if v_qtax > 0 and v_count > 1 and v_b.period_index between 1 and v_count then
      v_per := floor(v_qtax::numeric / v_count)::int;
      v_target := v_per + case when v_b.period_index = v_count then v_qtax - v_per * v_count else 0 end;
      select sum(x) into v_sum from unnest(v_tax) x;
      v_diff := v_target - v_sum;
      if v_diff <> 0 and abs(v_mrr * 12 - v_qtax) <= 6 * array_length(v_ids, 1) then
        /* The line whose own share (quote line qty × rate ÷ parts) lies on the side of the
           difference; else the last line. */
        v_pick := null;
        if coalesce(v_q.discount_pct, 0) = 0 and jsonb_typeof(v_q.line_items) = 'array' then
          for i in 1 .. array_length(v_ids, 1) loop
            select l into v_line from jsonb_array_elements(v_q.line_items) l
             where l->>'name' = v_plans[i]
               and (l->>'qty') ~ '^[0-9]+(\.0+)?$' and (l->>'qty')::numeric = v_seats[i]
             limit 1;
            if v_line is not null and (v_line->>'rate') ~ '^[0-9]+(\.[0-9]+)?$' then
              v_exact := (v_line->>'qty')::numeric * (v_line->>'rate')::numeric / v_count;
              if sign(v_exact - v_tax[i]) = sign(v_diff) then v_pick := i; exit; end if;
            end if;
          end loop;
        end if;
        v_pick := coalesce(v_pick, array_length(v_ids, 1));
        v_tax[v_pick] := v_tax[v_pick] + v_diff;
      end if;
    end if;
  end if;

  return query
    select v_ids[k], v_subs[k], v_tax[k], v_plans[k], v_seats[k]
      from generate_subscripts(v_ids, 1) k order by k;
end;
$$;
revoke all on function public.billing_part_group(uuid) from public, anon, authenticated;
grant execute on function public.billing_part_group(uuid) to service_role;

-- ── 6. raise_subscription_billing — body of 20261109220936 (R-2642) + R-2806 pool and line periods ─
CREATE OR REPLACE FUNCTION public.raise_subscription_billing(p_billing_id uuid)
 RETURNS TABLE(invoice_id text, gross integer, already_raised boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_rate     integer;
  v_cust_st  text;
  v_sell_st  text;
  v_cust_gstin   text;
  v_sell_gstin   text;
  v_cust_country text;
  v_is_export    boolean;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 30;
  v_today    date := public.ist_today();
  v_inv_date date;   -- R-2095
  v_existing integer;
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
  v_caller   uuid;
  v_trusted  boolean;
  v_r1803_problem text;
  v_group    record;
  v_taxable  integer;
  v_parts    integer;
  v_once     record;   -- R-2095
  v_pre      date;     -- R-2642: the part's day before R-2631's GST shift
  v_rcpt     date;     -- R-2642: the day the receipts behind it covered it
  v_pool     integer;  -- R-2806: the pool's credit, read once
begin
  /* R-2095 (Sept): the FIRST part of a sale billed in parts also carries the sale quote's one-time
     lines (setup, migration …) — billed once, never spread and never lost (quote_one_time_lines).
     R-2044: credit = public.instalment_credit (part payment requests count too).
     R-2092: one invoice for the quote's period — every part of billing_part_group, one line per
     subscription, tax rounded once on the total; the pool is the quote's.
     R-2101: each line is qty = seats × a per-seat rate when exact (r2101_part_line). */
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can raise its invoice'
      using errcode = '28000';
  end if;
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  /* activate_quote_on_credit ("Activate now, pay later") calls this with the SAME caller and
     has its own rules (any active member of the company; over-limit / annual = owner), so a
     call nested inside it is left to that function's guard. PG_CONTEXT is the real call stack —
     a browser cannot fake it, and nobody but the migration owner can create functions. */
  declare
    v_r885_ctx text;
  begin
    get diagnostics v_r885_ctx = pg_context;
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
       and v_r885_ctx !~ 'function (public\.)?activate_quote_on_credit\(' then
      raise exception 'Only an owner, manager, accountant or billing user can raise an instalment invoice' using errcode = '42501';
    end if;
  end;

  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  /* R-1803 (R-1643 follow-up): the company's own GSTIN + address (Bill of Supply: address)
     before any number is taken — the same rule generate_invoice reads. The billing cron
     calls this once per instalment and records a refusal per subscription (errors[] in
     /api/cron/billing, the [cron/billing] log line, "errors N" in the run history), then
     carries on with the next one; the instalment stays unbilled and the next run issues it
     once the company's details are on record. */
  v_r1803_problem := public.supplier_invoice_problem(v_b.tenant_id, v_today);
  if v_r1803_problem is not null then
    raise exception '% The next billing run issues this instalment once that is done.', v_r1803_problem
      using errcode = 'check_violation';
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  /* R-2092: the group's parts are locked (id order) before anything is read from them. */
  perform 1 from public.subscription_billings b
   where b.id in (select g.billing_id from public.billing_part_group(p_billing_id) g)
   order by b.id
   for update;

  /* ── R-372: place of supply, same rules as generate_invoice (R-041) ──────────────
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state on either side resolved to FALSE = intra-state = CGST+SGST: a missing
     fact turned into a confident tax head (AGENTS.md §2) on every instalment invoice.

     State = the entered state_code, else the first two digits of the GSTIN (a registered
     party has already told us their state) — the same fallback invoice_party_snapshot
     uses to freeze pos_state_code, so the head and the printed place of supply agree.

     EXPORT (country set and not India) is the one case where no Indian state is correct:
     zero-rated under IGST Section 16, so no tax and no CGST/SGST/IGST split.

     Anything else still unknown REFUSES. The billing cron reports it per subscription and
     the instalment stays unbilled until the state is set. */
  select c.state_code, c.gstin, c.country into v_cust_st, v_cust_gstin, v_cust_country
    from public.customers c where c.id = v_sub.customer_id;
  select t.state_code, t.gstin into v_sell_st, v_sell_gstin
    from public.tenants t where t.id = v_b.tenant_id;

  v_cust_st := case
    when nullif(btrim(coalesce(v_cust_st, '')), '') is not null then lpad(btrim(v_cust_st), 2, '0')
    when btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_cust_gstin) from 1 for 2)
    else null
  end;
  v_sell_st := case
    when nullif(btrim(coalesce(v_sell_st, '')), '') is not null then lpad(btrim(v_sell_st), 2, '0')
    when btrim(coalesce(v_sell_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_sell_gstin) from 1 for 2)
    else null
  end;

  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india', 'bharat');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply
    v_rate  := 0;       -- zero-rated export (IGST s16)
  elsif v_cust_st is null then
    raise exception
      'Cannot issue the instalment invoice: % has no state (or GSTIN) on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit); the next billing run will issue it.',
      v_sub.customer_name, v_sub.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null then
    raise exception
      'Cannot issue the instalment invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company; the next billing run will issue it.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);   -- both lpad-ed to 2 digits above
    v_rate  := v_b.tax_rate;
  end if;

  /* R-2092: ONE line per part of the group. A group of one is exactly the old single line.
     R-2101: qty = seats, rate = the part's taxable ÷ seats (57 × ₹800, 13 × ₹2,750) — only when
     that is exact in whole rupees; else qty 1 × the taxable with the seats in the description
     (₹2,000 over 3 seats is ₹666.67 each, and a tax invoice whose qty × rate does not equal its
     amount is wrong on its face). Either way qty × rate = the line's taxable. */
  v_lines := '[]'::jsonb;
  v_taxable := 0;
  v_parts := 0;
  /* R-2806: each line carries ITS part's own period — a Bill together group can hold subscriptions whose
     periods differ (an R-2092 group is one period, so its lines read exactly as before). */
  for v_group in
    select g.billing_id, g.subscription_id, g.taxable, g.plan, g.seats,
           coalesce(bp.period_start, v_b.period_start) as part_start, coalesce(bp.period_end, v_b.period_end) as part_end
      from public.billing_part_group(p_billing_id) with ordinality as g(billing_id, subscription_id, taxable, plan, seats, n)
      left join public.subscription_billings bp on bp.id = g.billing_id
     order by g.n
  loop
    v_parts := v_parts + 1;
    v_taxable := v_taxable + v_group.taxable;
    v_lines := v_lines || public.r2101_part_line(
      'instalment-' || v_b.period_index::text || case when v_parts > 1 then '-' || v_parts::text else '' end,
      v_group.plan, v_group.seats, v_group.taxable, v_group.part_start, v_group.part_end);
  end loop;
  if v_parts = 0 then
    v_taxable := v_b.taxable_amount;
    v_lines := public.r2101_part_line('instalment-' || v_b.period_index::text, v_sub.plan, v_sub.seats,
                                      v_b.taxable_amount, v_b.period_start, v_b.period_end);
  end if;

  /* R-2095: the sale's one-time lines go on its first part's invoice, once. */
  if v_sub.quote_id is not null and v_b.period_index = 1
     and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = v_b.subscription_id) then
    select * into v_once from public.quote_one_time_lines(v_sub.quote_id);
    if coalesce(v_once.taxable, 0) > 0 then
      v_lines := v_lines || v_once.lines;
      v_taxable := v_taxable + v_once.taxable;
    end if;
  end if;

  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  /* R-2044: one rule, public.instalment_credit — the sale quote's receipts PLUS what was paid
     on this subscription's part payment requests, less what earlier instalment invoices of it
     already absorbed. Before R-2044 only the sale quote's receipts counted.
     R-2092: the pool is the QUOTE's (receipts once, not once per subscription) — an invoice is
     paid only by money really there; short → pending with the balance due. */
  v_received := 0;
  v_applied  := 0;
  v_pool := public.instalment_credit(v_b.subscription_id);   -- R-2806: once (it reads the whole bill group's pool)
  v_credit := least(v_pool, v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* R-2095: a part is dated its period's bill date (the quote period start) when that has passed —
     a part invoiced late for an earlier period was dated today. Never before the books lock. */
  v_inv_date := public.invoice_date_for_receipt(v_b.tenant_id, v_b.bill_on);
  /* R-2642: a settled part is paid on the day the money that pays it came in (R-015; generate_invoice since
     R-2631) — not on the invoice date R-2631 may have moved to the first open day. The quote's pool
     (instalment_credit) is spent oldest money first, so the money left over after this part (pool − gross) is
     the NEWEST receipts: this part was covered on the day the receipts, in order, first reach (all receipts −
     that surplus). Receipts = the same ones the pool counts: the sale quote's and the part requests of every
     part of the quote's subscriptions. Never before the part's own day (invoice_receipt_day of its bill date
     — money paid ahead is used on that day); none at all (a credit-note credit) → that day. */
  if v_status = 'paid' then
    v_pre := public.invoice_receipt_day(v_b.tenant_id, v_b.bill_on);
    with subs as (
      /* R-2806: the bill group's pool (no group = this subscription + its quote's, as before). */
      select bp.subscription_id as id from public.billing_pool_subscriptions(v_b.subscription_id) bp
    ), rc as (
      select p.id, p.received_at, p.amount from public.payments p
       where p.tenant_id = v_b.tenant_id and p.status = 'received'
         and (p.quote_id in (select s3.quote_id from public.subscriptions s3
                              where s3.id in (select id from subs) and s3.quote_id is not null)
              or p.quote_id in (select q.id from public.quotes q
                                 where q.tenant_id = v_b.tenant_id
                                   and q.subscription_billing_id in (select b2.id from public.subscription_billings b2
                                                                      where b2.subscription_id in (select id from subs))))
    ), cum as (
      select rc.received_at, sum(rc.amount) over (order by rc.received_at, rc.id) as c,
             sum(rc.amount) over () as total
        from rc
    )
    select (min(cum.received_at) at time zone 'Asia/Kolkata')::date into v_rcpt
      from cum
     where cum.c >= cum.total - greatest(v_pool - v_gross, 0)
       and cum.total - greatest(v_pool - v_gross, 0) > 0;
  end if;
  v_id := public.next_document_number('invoice', v_b.tenant_id, v_inv_date);
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_inv_date, v_inv_date + v_terms,
    case when v_status = 'paid' then greatest(v_rcpt, v_pre) else null end,   -- R-2642
    null,
    /* R-1561: net_payable = the FULL instalment; the money already received is recorded
       ONCE, in paid_amount. Every reader computes due = net_payable − paid_amount, so the
       old `greatest(0, v_gross - v_credit)` here subtracted the credit a second time
       (₹2,360 with ₹1,000 received showed ₹360 due, not ₹1,360). paid_amount must stay
       = credit: v_applied above sums it to stop one receipt paying every instalment. */
    v_gross, v_credit,
    v_taxable, v_tax, v_rate, v_inter,
    v_lines
  );

  /* R-2092: every part of the group points at this one invoice; a part whose taxable took the
     quote-period rounding carries the figure its line shows. */
  update public.subscription_billings b
     set invoice_id = v_id,
         taxable_amount = g.taxable,
         updated_at = now()
    from public.billing_part_group(p_billing_id) g
   where b.id = g.billing_id;
  update public.subscription_billings b
     set invoice_id = v_id, updated_at = now()
   where b.id = p_billing_id and b.invoice_id is null;

  return query select v_id, v_gross, false;
end;
$function$;
revoke all on function public.raise_subscription_billing(uuid) from public;
grant execute on function public.raise_subscription_billing(uuid) to authenticated, service_role;

commit;
