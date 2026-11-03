-- deploy-peek: to_regprocedure('public.bank_reference_is_real(text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.payment_ref_key(text,text)') and prosrc like '%bank_reference_is_real%')
-- deploy-key: r2424placeholderbankref
--
-- R-2424 (p0 money, 3 Nov 2026) — an all-zero bank reference blocked a real payment.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Staging, Reconcile from Zoho: a ₹2,88,982 credit (19 May) was refused with "Ye UTR pehle se
--   RV-…-0558 par hai — reference 000000000000000 is already recorded (another customer,
--   ₹68,676)". HDFC prints an all-zero reference on credits that carry no UTR. The R-1676
--   one-credit-once rule (trg_payments_ref_once → assert_payment_ref_unused) keys every
--   UPI / bank-transfer reference of 6+ characters through payment_ref_key(), so two DIFFERENT
--   payments with zeros collided and the second could never be booked.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   * bank_reference_is_real(ref): false when the reference, keeping only letters and digits,
--     is under 6 characters or is one character repeated ("000000000000000", "111111",
--     "XXXXXXXX", "NA", "-"). The SAME rule as isRealBankReference() in
--     src/lib/payments/bank-reference.ts.
--   * payment_ref_key(method, reference) — redefined from its only (and so latest) definition,
--     20261019125620_r1676_payment_ref_once — now also returns NULL for a placeholder. Every
--     guard reads the key through this one function: the trigger trg_payments_ref_once, its
--     helper assert_payment_ref_unused, payment_reference_duplicates(), and the batch marker
--     app.payment_ref_batch set by record_multi_invoice_payment, _record_opening_invoice_payment
--     (R-1739) and reconcile_bank_credit_split (R-2098 / R-2397) via coalesce(key, '') — so none
--     of those bodies changes. A real UTR keeps exactly the key it had (still refused twice).
--   * payments_ref_key_idx is an index on payment_ref_key(): it is rebuilt here so rows with a
--     placeholder reference carry the new NULL key.
--   * Not changed: record_payment's same-QUOTE replay (tenant, quote, reference) — a retry of
--     one receipt on the same quote stays a replay, as before.
--
-- Test: supabase/tests/r2424_placeholder_bank_ref.test.sql

create or replace function public.bank_reference_is_real(p_reference text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public'
as $$
  /* R-2424: letters and digits only, upper-case; real = 6+ of them and not one repeated. */
  select length(v) >= 6 and length(replace(v, left(v, 1), '')) > 0
    from (select upper(regexp_replace(coalesce(p_reference, ''), '[^A-Za-z0-9]', '', 'g')) as v) s
$$;

comment on function public.bank_reference_is_real(text) is
  'R-2424: false for a placeholder bank reference (under 6 letters/digits, or one character repeated such as 000000000000000) — it is not a UTR and must not block another payment.';

revoke all on function public.bank_reference_is_real(text) from public, anon;
grant execute on function public.bank_reference_is_real(text) to authenticated, service_role;

create or replace function public.payment_ref_key(p_method text, p_reference text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $$
  select case
    when p_method in ('upi', 'bank_transfer')
     and length(upper(regexp_replace(coalesce(p_reference, ''), '[[:space:]-]', '', 'g'))) >= 6
     and public.bank_reference_is_real(p_reference)   -- R-2424: zeros / placeholders are not a UTR
    then 'BANK:' || upper(regexp_replace(p_reference, '[[:space:]-]', '', 'g'))
  end
$$;

comment on function public.payment_ref_key(text, text) is
  'R-1676 / R-2424: the bank reference a payment is keyed on for the one-credit-once rule — UPI/bank transfer only, spaces/hyphens dropped, upper-case; NULL when the rule does not apply or the reference is a placeholder (all zeros etc.).';

revoke all on function public.payment_ref_key(text, text) from public, anon;
grant execute on function public.payment_ref_key(text, text) to authenticated, service_role;

reindex index public.payments_ref_key_idx;
