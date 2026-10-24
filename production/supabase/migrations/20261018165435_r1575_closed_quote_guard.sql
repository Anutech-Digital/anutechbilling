-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_payment_closed_quote_guard') and exists(select 1 from pg_trigger where tgname = 'trg_invoice_closed_quote_guard')
-- deploy-key: r1575closedquote
-- 20261018165435_r1575_closed_quote_guard.sql
--
-- R-1575 (with R-1569, P1 money, audit 18 Oct 2026): a quote that was REPLACED (revised
-- R-448, or combined R-1527 — superseded_by set) or REJECTED still took a payment and a tax
-- invoice. record_payment (20261011120000_r718_money_roles.sql:1249) and generate_invoice
-- (20261012025800_r885_money_roles_more.sql:497) never looked at superseded_by or status;
-- trg_quote_superseded_guard (20261009120000_quote_revisions.sql:92) only stops an ACCEPT.
-- So an old Razorpay checkout paid after a combine settled — and activated — the closed
-- quote while the combined quote still asked for the same money.
--
-- Two row guards, so EVERY path is covered (record_payment, record_payment_with_tds,
-- record_desk_payment, record_multi_invoice_payment, the webhook) without copying the
-- 700-line record_payment body:
--   1. payments BEFORE INSERT (status 'received', quote_id set): refuse on a replaced or
--      rejected quote, naming the replacing quote (§24: what, why, next step).
--   2. quotes BEFORE UPDATE OF invoice_id (null → set): refuse issuing an invoice on a
--      replaced or rejected quote — generate_invoice's whole transaction rolls back.
-- Insert / first-link only: history (a payment or invoice that already exists) is untouched,
-- and refund/delete rows are not 'received' inserts. A replaced quote never has payments
-- (revise.ts and combine both refuse a quote with money on it), so nothing legitimate is
-- blocked. The Razorpay webhook (R-1569) records a late payment on the REPLACING quote.

begin;

create or replace function public.tg_payment_closed_quote_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_q record;
begin
  select q.id, q.status, q.superseded_by into v_q
    from public.quotes q
   where q.id = new.quote_id;
  if not found then
    return new;
  end if;
  if v_q.superseded_by is not null then
    raise exception 'Quote % was replaced by % (R-1575), so it can''t take a payment. Record this payment on quote % instead (Quotes → % → Record payment).',
      v_q.id, v_q.superseded_by, v_q.superseded_by, v_q.superseded_by
      using errcode = 'check_violation';
  end if;
  if v_q.status = 'rejected' then
    raise exception 'Quote % was rejected (R-1575), so it can''t take a payment. If the customer went ahead after all, open the quote and press Reopen (back to Sent), then record the payment — or make a new quote.',
      v_q.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_closed_quote_guard on public.payments;
create trigger trg_payment_closed_quote_guard
  before insert on public.payments
  for each row
  when (new.quote_id is not null and new.status = 'received')
  execute function public.tg_payment_closed_quote_guard();

create or replace function public.tg_invoice_closed_quote_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.superseded_by is not null then
    raise exception 'Quote % was replaced by % (R-1575), so no invoice can be issued on it. Issue the invoice from quote % instead.',
      new.id, new.superseded_by, new.superseded_by
      using errcode = 'check_violation';
  end if;
  if new.status = 'rejected' then
    raise exception 'Quote % was rejected (R-1575), so no invoice can be issued on it. Open the quote and press Reopen if the customer went ahead, then issue the invoice.',
      new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoice_closed_quote_guard on public.quotes;
create trigger trg_invoice_closed_quote_guard
  before update of invoice_id on public.quotes
  for each row
  when (old.invoice_id is null and new.invoice_id is not null)
  execute function public.tg_invoice_closed_quote_guard();

commit;
