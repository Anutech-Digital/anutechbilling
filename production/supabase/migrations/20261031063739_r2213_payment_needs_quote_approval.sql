-- deploy-peek: to_regprocedure('public.tg_payments_quote_approval()') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'below_cost')
-- deploy-key: r2213belowcost
--
-- R-2213 (31 Oct 2026) — money on a BELOW-COST quote waits for the owner's approval.
--
-- WHY
--   July reconcile on staging (R-2094): Manage-seats quotes Q-…-0426..0436 were priced below
--   cost and showed "Needs approval", yet bank credits were reconciled to them, and the quote then
--   read "Sent". The approval rule lived only in the screen (lib/quotes/approval.ts) — no money RPC
--   looked at it, and Manage seats never even wrote approval_status.
--
-- WHAT (Pardeep's decision on the card, 31 Oct)
--   1. quotes.below_cost — a FACT written by the server that builds the quote, from the one margin
--      rule (lib/quotes/approval-economics.ts lineEconomics, margin < 0). The DB does not recompute
--      margins: a second copy of the maths would drift (the 0816 approval migration says why).
--   2. ONE guard: a BEFORE INSERT trigger on payments. Every money path on a quote ends in a
--      payments row (record_payment, record_desk_payment, TDS, reconcile_bank_credit_to_item /
--      _split via bank_credit_pay_item, accept_quote …), so one trigger covers them all.
--      Refused: quote.below_cost and approval_status is not 'approved'.
--   3. Never refused: method 'razorpay' (website checkout / pay link / webhook — the gateway already
--      took the money; refusing would lose the record). The quote stays pending, so it stays in the
--      approvals queue and the nav badge for the owner.
--   4. Thinner margins, discounts and unknown cost keep the "Needs approval" flow on screen but do
--      NOT block money (below_cost is false for them).
--   Existing rows: below_cost defaults to false — nothing already booked is touched (staging
--   Q-0426..0436 are Pardeep's needsDecision on R-2094).
--
-- Test: supabase/tests/r2213_payment_needs_quote_approval.test.sql

begin;

alter table public.quotes
  add column if not exists below_cost boolean not null default false;

comment on column public.quotes.below_cost is
  'R-2213: the quote is priced below vendor cost (margin < 0 by lib/quotes/approval-economics.ts lineEconomics), written by the server that built it. While true and approval_status is not approved, payments on it are refused (tg_payments_quote_approval) except Razorpay money.';

create or replace function public.tg_payments_quote_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2213: one guard for every money path on a quote. */
declare
  v_q record;
begin
  if new.quote_id is null or new.status is distinct from 'received' then
    return new;
  end if;
  /* Gateway money is already taken — record it, never refuse it (the quote stays pending). */
  if new.method = 'razorpay' then
    return new;
  end if;
  select q.id, q.below_cost, q.approval_status::text as approval_status
    into v_q
    from public.quotes q
   where q.id = new.quote_id;
  if found and v_q.below_cost and v_q.approval_status is distinct from 'approved' then
    raise exception 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → % → Approve), then record the payment.', v_q.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_payments_quote_approval() from public, anon, authenticated;

drop trigger if exists trg_payments_quote_approval on public.payments;
create trigger trg_payments_quote_approval
  before insert on public.payments
  for each row execute function public.tg_payments_quote_approval();

commit;
