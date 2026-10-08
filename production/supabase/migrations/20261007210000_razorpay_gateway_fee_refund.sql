-- deploy-peek: exists(select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='gateway_refund_ids')
-- deploy-key: rzpfee
-- 20261007210000_razorpay_gateway_fee_refund.sql
--
-- R-045 (P1 money, 7 Oct 2026) — first slice of "Razorpay refunds, fees and settlements
-- are reconciled in the app".
--
-- THE HOLE: a Razorpay capture of Rs 1,180 settles about Rs 1,152 into the bank — Razorpay
-- keeps its fee (MDR) plus 18% GST on that fee. The app recorded only the gross amount, so
-- the bank line never matched the payment and the fee (an expense, and the GST on it an
-- input-credit candidate) was booked nowhere. The captured payment entity already carries
-- both numbers (`fee` = fee incl. GST, `tax` = the GST part, in paise); they were thrown away.
--
-- And `refund.processed` was ignored: money went back to the buyer at Razorpay and the
-- books still said "received".
--
-- THIS FILE only adds three nullable columns. No backfill, no trigger, no function change:
--   gateway_fee         whole rupees Razorpay kept on this payment, GST included
--   gateway_fee_gst     whole rupees of that which is GST on the fee
--   gateway_refund_ids  Razorpay refund ids already acted on for this payment — the
--                       idempotency fact for refund.processed (a refund note is written
--                       once per refund id; nothing is refunded or credit-noted by machine)
-- Cash that reached the settlement = amount - gateway_fee.
--
-- Written only by the Razorpay webhook (service role). RLS/policies on payments are
-- unchanged; the existing tenant policies cover the new columns.

alter table public.payments
  add column if not exists gateway_fee        integer,
  add column if not exists gateway_fee_gst    integer,
  add column if not exists gateway_refund_ids text[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_gateway_fee_check') then
    alter table public.payments
      add constraint payments_gateway_fee_check
      check (gateway_fee is null or gateway_fee >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_gateway_fee_gst_check') then
    alter table public.payments
      add constraint payments_gateway_fee_gst_check
      check (gateway_fee_gst is null or (gateway_fee_gst >= 0 and gateway_fee is not null and gateway_fee_gst <= gateway_fee));
  end if;
end $$;

comment on column public.payments.gateway_fee is
  'R-045: whole rupees the gateway (Razorpay) kept on this payment, GST on the fee included. Cash settled = amount - gateway_fee. NULL = not known (manual payment, or captured before R-045).';
comment on column public.payments.gateway_fee_gst is
  'R-045: whole rupees of gateway_fee that is GST on the fee (input-credit candidate; needs Razorpay''s tax invoice).';
comment on column public.payments.gateway_refund_ids is
  'R-045: Razorpay refund ids (rfnd_...) the webhook has already noted for this payment. Idempotency only — booking the refund / credit note stays a human step.';
