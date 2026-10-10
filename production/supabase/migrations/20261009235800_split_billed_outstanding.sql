-- deploy-key: splitbilledoutstanding
-- deploy-peek: to_regprocedure('public.sync_split_outstanding(uuid)') is not null
-- 20261009235800_split_billed_outstanding
--
-- R-527 (P0, money) — an annual commitment billed quarterly owed the whole YEAR on day one.
--
-- Measured 9 Oct 2026 on the local ANUTECH tenant, Q-FBB9-27-0020 (Starter x 8, annual
-- commitment, billed quarterly, Rs 25,920 ex-GST, quotes.amount Rs 30,586):
--   the customer paid Q1 = Rs 7,646, and record_payment wrote
--   subscriptions.outstanding_amount = 30,586 - 7,646 = Rs 22,940 on a07416e3 —
--   three quarters that are not due until Jan/Apr/Jul 2027, shown as OWED today on the
--   subscription list, the customer page, the dashboard and every renewal-risk score
--   (54 readers of that column).
--
-- WHAT THIS ADDS
--   1. public.quote_split_due(quote, term_start, as_of) — Rs incl GST of the instalments of
--      a split-billed quote whose bill date has arrived (the first is due on the start day).
--      The SQL twin of splitDue(quoteInstalmentPlan()) in src/lib/billing/instalments.ts:
--      the same split (floor per instalment, remainder on the last), the same rounding
--      (each instalment taxable + round(taxable x rate / 100) — the figure its own tax
--      invoice carries), the same nulls (flex first line, yearly, nothing to split).
--   2. A BEFORE trigger on subscriptions that, for a subscription sold on a split-billed
--      quote with no whole-term invoice, replaces the outstanding record_payment computes
--      from quotes.amount with (due instalments - received). record_payment itself is NOT
--      rewritten: it is 665 lines that five other cards touch, and a copy of it would be
--      one more drift. The trigger only ever LOWERS a figure on update (least()), so a
--      write-off to 0 or a manual lower figure is kept.
--   3. public.sync_split_outstanding(subscription) — re-reads the due figure as the next
--      instalment's date arrives. Called by the billing cron and right after a payment.
--
-- WHAT IT DOES NOT TOUCH
--   - Issued invoices: not read for amounts, never written.
--   - quotes.amount / payment_status: unchanged (the accepted quotation is not re-priced).
--   - Yearly subscriptions, flex (monthly-commitment) quotes, quotes with a whole-term
--     invoice: quote_split_due() returns null and the trigger leaves the row as written.

begin;

create or replace function public.quote_split_due(p_quote_id text, p_term_start date, p_as_of date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q         record;
  v_months    integer;
  v_count     integer;
  v_taxable   integer;
  v_per       integer;
  v_rem       integer;
  v_t         integer;
  v_due       integer := 0;
  v_rate      integer;
  i           integer;
begin
  select q.tenant_id, q.subtotal, q.discount_pct, q.tax_rate, q.amount, q.billing_cycle, q.line_items
    into v_q
    from public.quotes q
   where q.id = p_quote_id;
  if not found then return null; end if;

  if public.current_tenant_id() is not null and v_q.tenant_id is distinct from public.current_tenant_id() then
    return null;
  end if;

  -- flex first line: stored figures are already one month, nothing to split
  if jsonb_typeof(v_q.line_items) = 'array' and jsonb_array_length(v_q.line_items) > 0
     and (v_q.line_items -> 0 ->> 'commitment') = 'monthly' then
    return null;
  end if;

  v_months := case v_q.billing_cycle
                when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6
                else null end;
  if v_months is null then return null; end if;
  if coalesce(v_q.amount, 0) <= 0 then return null; end if;

  v_taxable := round(coalesce(v_q.subtotal, 0))::int;
  v_taxable := v_taxable - round(v_taxable * coalesce(v_q.discount_pct, 0) / 100.0)::int;
  if v_taxable <= 0 then return null; end if;

  v_count := ceil(12.0 / v_months)::int;
  if v_count <= 1 then return null; end if;
  v_per  := floor(v_taxable::numeric / v_count)::int;
  v_rem  := v_taxable - v_per * v_count;
  v_rate := coalesce(v_q.tax_rate, 18);

  for i in 0 .. v_count - 1 loop
    exit when i > 0 and (p_term_start + make_interval(months => i * v_months))::date > p_as_of;
    v_t   := v_per + case when i = v_count - 1 then v_rem else 0 end;
    v_due := v_due + v_t + round(v_t * v_rate / 100.0)::int;
  end loop;
  return v_due;
end;
$$;

grant execute on function public.quote_split_due(text, date, date) to authenticated, service_role;

/* Due minus received for one split-billed quote, or null when the quote is not split-billed
   or already carries a whole-term tax invoice. */
create or replace function public.split_outstanding_for(p_quote_id text, p_term_start date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_due      integer;
  v_received integer;
begin
  if p_quote_id is null then return null; end if;
  if exists (select 1 from public.quotes q where q.id = p_quote_id and q.invoice_id is not null)
     or exists (select 1 from public.invoices i where i.quote_id = p_quote_id and i.status <> 'void') then
    return null;
  end if;
  v_due := public.quote_split_due(p_quote_id, coalesce(p_term_start, public.ist_today()), public.ist_today());
  if v_due is null then return null; end if;
  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p where p.quote_id = p_quote_id and p.status = 'received';
  return greatest(0, v_due - v_received);
end;
$$;

grant execute on function public.split_outstanding_for(text, date) to authenticated, service_role;

create or replace function public.tg_subscriptions_split_outstanding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed integer;
begin
  if new.quote_id is null or coalesce(new.outstanding_amount, 0) <= 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.outstanding_amount is not distinct from old.outstanding_amount then
    return new;
  end if;
  v_owed := public.split_outstanding_for(new.quote_id, new.start_date);
  if v_owed is null then return new; end if;
  if tg_op = 'INSERT' then
    new.outstanding_amount := v_owed;
  else
    new.outstanding_amount := least(new.outstanding_amount, v_owed);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_subscriptions_split_outstanding on public.subscriptions;
create trigger trg_subscriptions_split_outstanding
  before insert or update of outstanding_amount on public.subscriptions
  for each row execute function public.tg_subscriptions_split_outstanding();

/* Re-read the due figure for a split-billed subscription (as Q2's date arrives, after a
   payment). Writes only to the FIRST subscription of the quote — the one record_payment
   puts the quote's outstanding on — and never to a written-off or inactive row.
   Returns the outstanding written, or null when nothing applies. */
create or replace function public.sync_split_outstanding(p_subscription_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub   record;
  v_first uuid;
  v_owed  integer;
begin
  select s.id, s.tenant_id, s.quote_id, s.start_date, s.status, s.written_off_at, s.outstanding_amount
    into v_sub
    from public.subscriptions s where s.id = p_subscription_id
   for update;
  if not found then return null; end if;
  if public.current_tenant_id() is not null and v_sub.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'subscription % is not in the caller''s tenant', p_subscription_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.quote_id is null or v_sub.status <> 'active' or v_sub.written_off_at is not null then
    return null;
  end if;
  select s.id into v_first from public.subscriptions s
   where s.tenant_id = v_sub.tenant_id and s.quote_id = v_sub.quote_id
   order by s.created_at, s.id limit 1;
  if v_first is distinct from v_sub.id then return null; end if;

  v_owed := public.split_outstanding_for(v_sub.quote_id, v_sub.start_date);
  if v_owed is null then return null; end if;
  if v_owed is distinct from coalesce(v_sub.outstanding_amount, 0) then
    -- a raise is a plain write; the trigger only acts on a positive new value and
    -- caps it at the same figure, so this lands as computed
    update public.subscriptions set outstanding_amount = v_owed where id = v_sub.id;
  end if;
  return v_owed;
end;
$$;

grant execute on function public.sync_split_outstanding(uuid) to authenticated, service_role;

commit;
