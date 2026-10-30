-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.release_credited_billing_parts(text)') and prosrc like '%R-2095%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2095%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.billing_part_group(uuid)') and prosrc like '%R-2095%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.instalment_credit(uuid)') and prosrc like '%R-2095%')
-- deploy-key: r2095creditedpartrebill
-- 20261030035007_r2095_credited_part_rebill.sql
--
-- R-2095 P0 (30 Oct 2026, money, found reconciling staging): one quote, Business Starter 57 +
-- Business Standard 13, billed quarterly. Q1 was invoiced and then fully reversed by two credit
-- notes to re-issue it. The parts still pointed at the credited invoice
-- (subscription_billings.invoice_id), so the schedule said "Q1 invoiced", the pending list had no
-- Generate, and the billing job answered 'already_invoiced' for ever.
--
-- ─── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
--   subscription_billings.credited_invoice_ids  the invoices that billed this part and that credit
--                                 notes then cancelled in full (history; the part is free again).
--   customer_credits.used_invoice_id  credit-note credit spent on a re-issued part invoice.
--   release_credited_billing_parts(invoice)  when the invoice's credit notes reach its value
--                                 (amount + debit notes, ₹1 tolerance), every part it billed drops
--                                 the link (kept in credited_invoice_ids). Called by an AFTER INSERT
--                                 trigger on credit_notes; a partial note frees nothing.
--   instalment_credit(sub)        the quote's pool (R-2092) also subtracts what a CANCELLED part
--                                 invoice absorbed — that money left as customer credit through the
--                                 credit note (R-1566) — and adds that credit back while it is
--                                 still open or was spent on a re-issued part (used_invoice_id).
--                                 So the re-issued Q1 is paid by the same money, never twice.
--   tg_subscription_billings_use_cn_credit  when a part is invoiced and the pool without the open
--                                 note credit is short, that credit is marked used by the new
--                                 invoice (split when only part is needed) — not spendable again.
--   billing_part_group / bill_subscription_instalment  a payment request spent on a cancelled
--                                 invoice is ignored (it no longer fixes the group or counts as the
--                                 period's paid request); a freed FIRST part is not "covered by the
--                                 sale quote" any more — without money it gets its own request.
--   Existing rows: invoices already fully credited today release their parts here (the same rule,
--   applied once). The open note credit then re-pays the period when Generate (or the billing
--   job) raises it again.
--
-- Not changed: issue_credit_note(_core) (its credit-to-customer rule stands); invoices themselves.
-- Bodies: billing_part_group from 20261029131440 (R-2104); bill_subscription_instalment from
-- 20261029052411 (R-2092 siblings laid); instalment_credit from 20261029034541 (R-2092) — the
-- latest definitions.
-- Test: supabase/tests/r2095_credited_part_rebill.test.sql

begin;

alter table public.subscription_billings
  add column if not exists credited_invoice_ids text[] not null default '{}'::text[];
comment on column public.subscription_billings.credited_invoice_ids is
  'R-2095: invoices that billed this part and that credit notes then cancelled in full. The part is free to be invoiced again.';

alter table public.customer_credits add column if not exists used_invoice_id text;
comment on column public.customer_credits.used_invoice_id is
  'R-2095: credit made by a credit note on a cancelled part invoice, spent on the part invoice that re-issued the period.';

-- ── 1. A fully credited invoice frees its parts ─────────────────────────────────────────────
create or replace function public.invoice_fully_credited(p_invoice_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  /* R-2095: credit notes reach the invoice's value (amount + debit notes), ₹1 of rounding tolerated. */
  select coalesce((select sum(c.amount) from public.credit_notes c where c.invoice_id = i.id), 0)
         >= coalesce(i.amount, 0) + coalesce((select sum(d.amount) from public.debit_notes d where d.invoice_id = i.id), 0) - 1
         and coalesce(i.amount, 0) > 0
    from public.invoices i where i.id = p_invoice_id;
$$;
revoke all on function public.invoice_fully_credited(text) from public, anon;
grant execute on function public.invoice_fully_credited(text) to authenticated, service_role;

create or replace function public.release_credited_billing_parts(p_invoice_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2095: a part invoice that credit notes cancelled in full no longer bills its period. */
declare
  v_n integer;
begin
  if p_invoice_id is null or not coalesce(public.invoice_fully_credited(p_invoice_id), false) then
    return 0;
  end if;
  update public.subscription_billings b
     set credited_invoice_ids = case when p_invoice_id = any(b.credited_invoice_ids) then b.credited_invoice_ids
                                     else b.credited_invoice_ids || p_invoice_id end,
         invoice_id = null,
         request_reminder_step = null,
         request_reminded_at = null,
         updated_at = now()
   where b.invoice_id = p_invoice_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.release_credited_billing_parts(text) from public, anon, authenticated;
grant execute on function public.release_credited_billing_parts(text) to service_role;

create or replace function public.tg_credit_notes_release_parts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.release_credited_billing_parts(new.invoice_id);   -- R-2095
  return null;
end;
$$;
drop trigger if exists credit_notes_release_parts on public.credit_notes;
create trigger credit_notes_release_parts after insert on public.credit_notes
  for each row execute function public.tg_credit_notes_release_parts();

-- ── 2. The quote's pool knows cancelled part invoices ───────────────────────────────────────
/* base = the pool WITHOUT open credit-note credit of cancelled part invoices; open_cn = that credit. */
create or replace function public.instalment_credit_parts(p_subscription_id uuid)
returns table(base integer, open_cn integer)
language sql
stable
security definer
set search_path = public
as $$
  /* R-2044; R-2092: ONE pool per quote. R-2095: cancelled part invoices (credited_invoice_ids). */
  with me as (
    select s.id, s.tenant_id, s.quote_id from public.subscriptions s where s.id = p_subscription_id
  ), subs as (
    select s2.id from public.subscriptions s2, me
     where s2.id = me.id
        or (me.quote_id is not null and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id)
  ), parts as (
    select b.id, b.invoice_id, b.credited_invoice_ids from public.subscription_billings b
     where b.subscription_id in (select id from subs)
  ), cancelled as (
    select distinct x.inv from parts, unnest(parts.credited_invoice_ids) as x(inv)
     where not exists (select 1 from parts p2 where p2.invoice_id = x.inv)
  )
  select (coalesce((select sum(p.amount)::int from public.payments p, me
                     where me.quote_id is not null and p.quote_id = me.quote_id and p.status = 'received'), 0)
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

create or replace function public.instalment_credit(p_subscription_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  /* R-2044; R-2092: ONE pool per quote. R-2095: + open credit from credit notes that cancelled a
     part invoice (instalment_credit_parts) — that money re-pays the freed period. */
  select greatest(0, coalesce(base, 0) + coalesce(open_cn, 0))::int
    from public.instalment_credit_parts(p_subscription_id);
$$;
revoke all on function public.instalment_credit(uuid) from public, anon, authenticated;
grant execute on function public.instalment_credit(uuid) to service_role;

-- ── 3. Spending the note's credit on the re-issued invoice ──────────────────────────────────
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
               join public.subscriptions s on s.id = b.subscription_id
               join public.subscriptions me on me.id = new.subscription_id
               cross join unnest(b.credited_invoice_ids) as x(inv)
              where s.id = me.id
                 or (me.quote_id is not null and s.tenant_id = me.tenant_id and s.quote_id = me.quote_id))
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
drop trigger if exists subscription_billings_use_cn_credit on public.subscription_billings;
create trigger subscription_billings_use_cn_credit after update of invoice_id on public.subscription_billings
  for each row when (old.invoice_id is null and new.invoice_id is not null)
  execute function public.tg_subscription_billings_use_cn_credit();

-- ── 4. The parts billed together — body of 20261029131440 (R-2104) ──────────────────────────
create or replace function public.billing_part_group(p_billing_id uuid)
returns table(billing_id uuid, subscription_id uuid, taxable integer, plan text, seats integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2092: the not-yet-invoiced parts of one quote for one period — one tax invoice, one request.
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
  select s.id, s.tenant_id, s.quote_id, s.plan, s.seats, s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then return; end if;

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
      select b2.id, b2.subscription_id, (l->>'rate')::integer, s2.plan, s2.seats
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
comment on function public.billing_part_group(uuid) is
  'R-2092/R-2104: the parts of one quote for one period that are billed together (one tax invoice, one payment request), with each part''s taxable after quote-period rounding.';

-- ── 5. bill_subscription_instalment — body of 20261029052411 (R-2092 siblings laid) ─────────

create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_b        record;
  v_sub      record;
  v_q        record;
  v_has_q    boolean := false;
  v_first    boolean;
  v_rate     integer;
  v_tax      integer;
  v_gross    integer;
  v_country  text;
  v_req_paid boolean := false;
  v_raised   record;
  v_id       text;
  v_period   text;
  v_on_due   boolean := false;
  v_label    text;
  v_cycle    text;
  v_paid_up  boolean := false;
  v_sale     record;
  v_ids      uuid[];
  v_lead     uuid;
  v_taxable  integer;
  v_parts    integer;
  v_lines    jsonb;
  v_g        record;
  v_seats    integer;
  v_unlaid   uuid[];
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can bill its part'
      using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill a subscription part' using errcode = '42501';
  end if;

  if coalesce(p_dry_run, false) then
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  else
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id for update;
  end if;
  if not found then
    raise exception 'Billing part % not found', p_billing_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing part % is not in the caller''s company', p_billing_id using errcode = 'insufficient_privilege';
  end if;

  if v_b.invoice_id is not null then
    return jsonb_build_object('action', 'already_invoiced', 'invoice_id', v_b.invoice_id);
  end if;

  /* R-2092 siblings laid: the quote's parts of one period are billed together — so a part is
     not billed (no invoice, no request) while another active subscription of the SAME quote,
     billed in the same cycle, has no parts laid yet. Its own billing run lays them and bills the
     whole group then. Before: the billing code laid one subscription's parts and billed them
     before the next subscription's were there (a lay that failed was swallowed), and the quote's
     Q1 went out as the Starter alone (localhost, 29 Oct). A subscription whose parts can never be
     laid here (no start date, billed elsewhere for the period) does not hold the others back. */
  select array_agg(s2.id order by s2.created_at, s2.id) into v_unlaid
    from public.subscriptions s2
    join public.subscriptions me on me.id = v_b.subscription_id
   where me.quote_id is not null
     and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
     and s2.status = 'active'
     and s2.billing_cycle = me.billing_cycle
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle
     and s2.start_date is not null
     and coalesce(s2.mrr, 0) > 0
     and (s2.billed_externally_until is null or s2.billed_externally_until < v_b.period_start)
     and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
  if v_unlaid is not null then
    return jsonb_build_object('action', 'waiting', 'reason', 'siblings_not_laid',
                              'subscription_ids', to_jsonb(v_unlaid));
  end if;

  select s.id, s.tenant_id, s.quote_id, s.customer_id, s.customer_name, s.plan, s.seats, s.domain,
         s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then
    raise exception 'Subscription behind billing part % no longer exists', p_billing_id using errcode = 'no_data_found';
  end if;

  /* R-2092: the group (a single part = the old behaviour). Its first part leads: a request is
     linked to it. */
  v_lines := '[]'::jsonb; v_taxable := 0; v_parts := 0; v_seats := 0;
  for v_g in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_ids := coalesce(v_ids, '{}'::uuid[]) || v_g.billing_id;
    v_taxable := v_taxable + v_g.taxable;
    v_seats := v_seats + coalesce(v_g.seats, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'billing_id', v_g.billing_id::text, 'plan', v_g.plan, 'seats', coalesce(v_g.seats, 0), 'taxable', v_g.taxable));
  end loop;
  if v_parts = 0 then
    v_ids := array[v_b.id]; v_taxable := v_b.taxable_amount; v_parts := 1; v_seats := coalesce(v_sub.seats, 0);
  end if;
  v_lead := v_ids[1];

  /* The group's gross, the same figure raise_subscription_billing will invoice: export → 0%. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_sub.customer_id;
  v_rate := case when v_country is not null
                  and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_b.tax_rate end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* R-2095: a request already spent on an invoice that credit notes cancelled is not this period's
     request any more — its money stays in the quote's pool (instalment_credit). */
  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
     and not (q.invoice_id is not null and exists (
               select 1 from public.subscription_billings bx
                where bx.id = any(v_ids) and q.invoice_id = any(bx.credited_invoice_ids)))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  v_has_q := found;
  if v_has_q then
    v_req_paid := coalesce((select sum(p.amount) from public.payments p
                             where p.quote_id = v_q.id and p.status = 'received'), 0) >= coalesce(v_q.amount, 0);
  end if;

  /* The sale quote IS the payment request of the first part of the first term. R-2048: it is
     invoiced only when money covers it (instalment_credit counts the sale quote's receipts) —
     no longer "paid by definition"; an accepted-but-unpaid sale got an unpaid tax invoice.
     R-2092: "money covers it" = the QUOTE's pool covers the GROUP — before, each subscription
     counted the sale quote's whole receipt as its own, so a short payment covered both. */
  /* R-2095: a first part whose invoice credit notes cancelled is not covered by the sale quote
     any more (that quote was spent on the cancelled invoice) — it gets its own request. */
  v_first := v_sub.quote_id is not null
             and cardinality(v_b.credited_invoice_ids) = 0
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_req_paid or v_on_due or v_paid_up then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_first then 'first_part_of_sale' else 'already_paid' end);
    end if;
    select r.* into v_raised from public.raise_subscription_billing(v_b.id) r;
    if v_has_q and v_q.invoice_id is null then
      update public.quotes
         set invoice_id = case when v_req_paid then v_raised.invoice_id else invoice_id end,
             status = case when v_req_paid then status else 'expired'::public.quote_status end,
             notes = case when v_req_paid then notes
                          else concat_ws(E'\n', nullif(notes, ''),
                                 case when v_on_due
                                      then 'Closed: the customer is invoiced on the due date — tax invoice ' || v_raised.invoice_id || '.'
                                      else 'Closed: this part was already paid another way — tax invoice ' || v_raised.invoice_id || '.' end) end
       where id = v_q.id;
    end if;
    return jsonb_build_object('action', 'invoice', 'invoice_id', v_raised.invoice_id,
      'gross', v_raised.gross, 'already_raised', v_raised.already_raised, 'parts', v_parts);
  end if;

  if v_has_q then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'status', v_q.status, 'gross', v_gross);
  end if;
  /* R-2048: the first part of an unpaid sale — the open sale quote is what the customer pays; no
     invoice and no second request. Paying it raises this part's invoice (credit rule above). A
     closed (rejected / expired) sale quote is not a request any more → this part gets its own. */
  if v_first then
    select q.id, q.status::text as status into v_sale
      from public.quotes q where q.id = v_sub.quote_id;
    if found and v_sale.status in ('draft', 'sent', 'viewed', 'accepted') then
      return jsonb_build_object('action', 'request_open', 'quote_id', v_sale.id, 'status', v_sale.status,
                                'gross', v_gross, 'sale_quote', true);
    end if;
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('action', 'request', 'gross', v_gross, 'dry_run', true, 'parts', v_parts);
  end if;

  v_id := public.next_document_number('quote', v_b.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Advance payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name,
    case when v_parts > 1 then (select string_agg(x->>'plan', ' + ' order by n) from jsonb_array_elements(v_lines) with ordinality t(x, n))
         else v_sub.plan end,
    case when v_parts > 1 then v_seats else v_sub.seats end,
    v_gross, 'sent', 'awaiting',
    /* Prepaid: sent on the bill date (the period's first day) and due that day. No expiry — it
       stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    /* R-2092: one line per subscription of the group, each naming its part (billing_id) — the
       group is then fixed by the request (billing_part_group). A group of one: the old line. */
    case when v_parts > 1 then
      (select jsonb_agg(jsonb_build_object(
                'id',          'part-' || v_b.period_index::text || '-' || n::text,
                'name',        v_label,
                'description', coalesce(x->>'plan', 'Subscription') || ' · ' || coalesce(x->>'seats', '0') || ' seats',
                'qty',         1,
                'rate',        (x->>'taxable')::integer,
                'cost',        0,
                'one_time',    true,
                'billing_id',  x->>'billing_id') order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n))
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        v_label,
        'description', coalesce(v_sub.plan, 'Subscription') || ' · ' || coalesce(v_sub.seats, 0)::text || ' seats',
        'qty',         1,
        'rate',        v_b.taxable_amount,
        'cost',        0,
        'one_time',    true))
    end,
    v_taxable, 0, 0, v_rate,
    true, 'yearly', 0,
    v_label || '. Due on ' || to_char(v_b.bill_on, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_lead
  );
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts);
end;
$$;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;


-- ── 6. Invoices already fully credited today release their parts (the same rule, once) ──────
select public.release_credited_billing_parts(x.invoice_id)
  from (select distinct b.invoice_id from public.subscription_billings b where b.invoice_id is not null) x;

commit;
