-- deploy-peek: exists(select 1 from pg_proc p where p.oid = to_regprocedure('public.settle_invoice_payment_link(text,text,bigint,text)') and p.prosrc like '%R-2439%')
-- deploy-key: r2439settlepaymentlinkv2
-- 20261103190855_r2439_settle_payment_link_v2.sql
--
-- R-2439 (fixes from the independent money review of R-2415, 3 Nov 2026 — items 1 and 3).
-- settle_invoice_payment_link v2, redefined from its LATEST body (20261103151556, the only one).
--
-- ─── THE GAPS ────────────────────────────────────────────────────────────────────────────────
--   (3) The booking's `when others` re-raised only 40001 / 40P01 / 55P03. Any other passing DB
--       error (out of memory 53xxx, a dropped connection 08xxx, operator intervention 57xxx)
--       marked the link needs_review — Razorpay's retry then saw needs_review and stopped, so a
--       payment that would have booked a minute later needed manual work.
--   (1) An already-paid link answered already_recorded + same_payment, but did not say WHICH
--       payment booked it; the webhook ignored same_payment, so a second, different payment on
--       the same link was dropped without anyone being told (fixed in payment-link-paid.server.ts).
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   • Passing errors are raised again: SQLSTATE class 08 (connection), 40 (rollback), 53 (but not 53400)
--     (insufficient resources), 57 (operator intervention, e.g. 57014 statement timeout — never
--     caught by OTHERS anyway), 58 (system / IO) and 55P03 (lock not available). The call rolls back (the
--     link stays active, nothing booked), the webhook answers 5xx and Razorpay retries.
--     Everything else (a business refusal from record_payment: P0001, 22xxx, 23xxx, 42501 …)
--     still goes to needs_review — nothing booked, the owner told why.
--   • already_recorded AND an already needs_review link return same_payment + paid_payment_id
--     (the payment that paid / is waiting on the link), so the webhook flags a second payment.
-- Grants unchanged: service role only.

begin;

create or replace function public.settle_invoice_payment_link(
  p_link_id    text,
  p_payment_id text,
  p_paid_paise bigint,
  p_event_id   text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2415: book a paid Razorpay payment link on the bills it was made for — once.
   R-2439: passing DB errors are raised (Razorpay retries); already_recorded names paid_payment_id. */
declare
  v_link   record;
  v_alloc  jsonb;
  v_inv    record;
  v_quote  record;
  v_recv   integer;
  v_due    integer;
  v_amt    integer;
  v_why    text := null;
  v_ids    text[] := array[]::text[];
  v_lines  jsonb := '[]'::jsonb;
  v_line   jsonb;
  v_r      jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_notes  text;
begin
  /* Same trust rule as record_payment (R-718): service role or a direct DB session only. The
     webhook has verified Razorpay's signature before it calls this. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'))) then
    raise exception 'Only the payment webhook can book a payment link.' using errcode = '42501';
  end if;
  if p_link_id is null or btrim(p_link_id) = '' then
    raise exception 'R-2415: payment link id missing';
  end if;
  if p_payment_id is null or btrim(p_payment_id) = '' then
    raise exception 'R-2415: payment id missing';
  end if;

  select * into v_link
    from public.invoice_payment_links
   where razorpay_link_id = p_link_id
   for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  if v_link.status = 'paid' then
    return jsonb_build_object('found', true, 'already_recorded', true, 'tenant_id', v_link.tenant_id,
      'customer_id', v_link.customer_id, 'link_row', v_link.id,
      'same_payment', v_link.razorpay_payment_id is not distinct from p_payment_id,
      'paid_payment_id', v_link.razorpay_payment_id);
  end if;
  if v_link.status = 'needs_review' then
    /* R-2439: say whether THIS is the payment that is already waiting for a check, or another one. */
    return jsonb_build_object('found', true, 'review', true, 'tenant_id', v_link.tenant_id,
      'customer_id', v_link.customer_id, 'link_row', v_link.id, 'why', v_link.review_reason,
      'same_payment', v_link.razorpay_payment_id is not distinct from p_payment_id,
      'paid_payment_id', v_link.razorpay_payment_id);
  end if;

  if v_link.status <> 'active' then
    v_why := 'the pay link was already ' || v_link.status || ' in the app';
  elsif p_paid_paise is distinct from v_link.amount::bigint * 100 then
    v_why := 'Razorpay paid ' || coalesce((p_paid_paise / 100.0)::text, '?') || ' but the link was for ₹' || v_link.amount;
  end if;

  if v_why is null then
    for v_alloc in select value from jsonb_array_elements(v_link.allocations) loop
      v_ids := v_ids || (v_alloc->>'invoice_id');
    end loop;
    perform 1 from public.invoices
     where id = any(v_ids) and tenant_id = v_link.tenant_id
     order by id
     for update;

    for v_alloc in select value from jsonb_array_elements(v_link.allocations) loop
      v_amt := coalesce((v_alloc->>'amount')::integer, 0);
      select i.id, i.customer_id, i.status::text as status, i.quote_id, i.written_off_at,
             greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))::integer as due
        into v_inv
        from public.invoices i
       where i.id = v_alloc->>'invoice_id' and i.tenant_id = v_link.tenant_id;
      if not found then
        v_why := 'invoice ' || coalesce(v_alloc->>'invoice_id', '?') || ' is not in the app any more'; exit;
      end if;
      if v_inv.customer_id is distinct from v_link.customer_id then
        v_why := 'invoice ' || v_inv.id || ' now belongs to another customer'; exit;
      end if;
      if v_inv.status not in ('pending', 'overdue') then
        v_why := 'invoice ' || v_inv.id || ' is already ' || v_inv.status; exit;
      end if;
      if v_inv.written_off_at is not null then
        v_why := 'invoice ' || v_inv.id || ' was written off'; exit;
      end if;
      select q.id, q.amount into v_quote
        from public.quotes q
       where q.id = v_inv.quote_id and q.tenant_id = v_link.tenant_id and q.invoice_id = v_inv.id;
      if not found then
        v_why := 'invoice ' || v_inv.id || ' has no quote of its own (instalment / project bill)'; exit;
      end if;
      select coalesce(sum(amount), 0)::integer into v_recv
        from public.payments
       where quote_id = v_quote.id and tenant_id = v_link.tenant_id and status = 'received';
      v_due := least(v_inv.due, greatest(0, coalesce(v_quote.amount, 0) - v_recv));
      if v_amt <= 0 or v_amt > v_due then
        v_why := 'invoice ' || v_inv.id || ' now has ₹' || v_due || ' due, but the link paid ₹' || v_amt || ' for it'; exit;
      end if;
      v_lines := v_lines || jsonb_build_object('invoice_id', v_inv.id, 'quote_id', v_quote.id, 'amount', v_amt);
    end loop;
  end if;

  if v_why is not null then
    update public.invoice_payment_links
       set status = 'needs_review', razorpay_payment_id = p_payment_id, review_reason = v_why, updated_at = now()
     where id = v_link.id;
    return jsonb_build_object('found', true, 'review', true, 'tenant_id', v_link.tenant_id,
      'customer_id', v_link.customer_id, 'link_row', v_link.id, 'why', v_why);
  end if;

  v_notes := 'Razorpay pay link ' || p_link_id || coalesce(' · event ' || nullif(btrim(p_event_id), ''), '')
             || case when jsonb_array_length(v_lines) > 1
                     then ' · statement payment across ' || jsonb_array_length(v_lines) || ' invoices' else '' end;

  begin
    for v_line in select value from jsonb_array_elements(v_lines) loop
      v_r := public.record_payment(v_line->>'quote_id', (v_line->>'amount')::integer, 'razorpay', p_payment_id, v_notes);
      if coalesce((v_r->>'already_recorded')::boolean, false)
         or coalesce((v_r->>'idempotent_replay')::boolean, false) then
        raise exception 'R-2415 replay on %', v_line->>'invoice_id' using errcode = 'R2415';
      end if;
      v_out := v_out || jsonb_build_object('invoice_id', v_line->>'invoice_id', 'quote_id', v_line->>'quote_id',
        'amount', (v_line->>'amount')::integer, 'payment_id', v_r->>'payment_id',
        'invoice_paid', coalesce((v_r->>'invoice_paid')::boolean, false));
    end loop;
  exception
    when sqlstate 'R2415' then
      v_why := 'this Razorpay payment was already recorded on one of its invoices another way';
    when others then
      /* R-2439: a passing DB error — connection (08), rollback / deadlock (40), resources (53,
         except 53400 configuration limit, which no retry fixes), operator intervention (57),
         system / IO (58) or lock not available (55P03) — is raised again: the whole call rolls
         back (link still active, nothing booked), the webhook answers 5xx and Razorpay's retry
         can still book it. */
      if (left(sqlstate, 2) in ('08', '40', '53', '57', '58') and sqlstate <> '53400')
         or sqlstate = '55P03' then
        raise;
      end if;
      /* Any other refusal from record_payment would answer 500 for a day of retries and then be
         lost — fail closed to review instead: nothing booked, the owner told why. */
      v_why := 'the app could not book it (' || left(sqlerrm, 160) || ')';
  end;
  if v_why is not null then
    update public.invoice_payment_links
       set status = 'needs_review', razorpay_payment_id = p_payment_id, review_reason = v_why, updated_at = now()
     where id = v_link.id;
    return jsonb_build_object('found', true, 'review', true, 'tenant_id', v_link.tenant_id,
      'customer_id', v_link.customer_id, 'link_row', v_link.id, 'why', v_why);
  end if;

  update public.invoice_payment_links
     set status = 'paid', razorpay_payment_id = p_payment_id, paid_at = now(), updated_at = now()
   where id = v_link.id;

  return jsonb_build_object('found', true, 'recorded', true, 'tenant_id', v_link.tenant_id,
    'customer_id', v_link.customer_id, 'link_row', v_link.id, 'lines', v_out);
end;
$function$;

comment on function public.settle_invoice_payment_link(text, text, bigint, text) is
  'R-2415/R-2439: book a paid Razorpay payment link (payment_link.paid) on the invoices it was made for, once — record_payment per bill in one transaction; anything that does not match the frozen link → needs_review, nothing booked; a passing DB error (class 08/40/53 but 53400/57/58, 55P03) is raised so Razorpay retries. already_recorded and needs_review return same_payment + paid_payment_id. Service role only.';

revoke all on function public.settle_invoice_payment_link(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.settle_invoice_payment_link(text, text, bigint, text) to service_role;

commit;
