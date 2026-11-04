-- deploy-peek: (to_regclass('public.invoice_payment_links') is not null and to_regprocedure('public.settle_invoice_payment_link(text,text,bigint,text)') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_payment_links' and policyname = 'invoice_payment_links_service_role'))
-- deploy-key: r2415invoicepaymentlinks
-- 20261103151556_r2415_invoice_payment_links.sql
--
-- R-2415 (goal G-COLLECT, 3 Nov 2026): ONE Razorpay payment link per open invoice (and per
-- statement total), shown in Send reminder next to the UPI link; Razorpay's payment_link.paid
-- webhook books the payment against that invoice exactly once.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   R-2412's reminder carries only a upi:// link (opens GPay on a phone, nothing on a desktop).
--   lib/payments/payment-link* (R-1608) was quote-only and minted a NEW link per call — one bill
--   would collect many live links, and a customer could pay twice.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   invoice_payment_links — one row per Razorpay link the app made:
--     link_key     'invoice:<invoice id>' or 'statement:<customer id>'.
--     allocations  [{invoice_id, quote_id, amount}] — what the link pays, frozen when made.
--     bill_amount  ₹ of the bills (sum of allocations). amount = ₹ the link asks for; the same
--                  today — R-2417 adds the online fee (amount − bill_amount) when the customer
--                  bears it (lib/payments/payment-link.ts linkAmountFor).
--     status       creating → active → paid | cancelled | failed | needs_review.
--     razorpay_order_id  the order Razorpay made for the payment — so the payment.captured /
--                  order.paid of a link payment is recognised and left to payment_link.paid.
--   At most ONE live link (creating/active) per tenant + link_key — a unique partial index, so
--   two people opening Send reminder at once cannot make two links.
--   RLS: a tenant's users may READ their own rows; every write is the server (service role)
--   after the route has checked the caller — the Razorpay key lives in tenant_secrets.
--
--   settle_invoice_payment_link(link id, payment id, paise paid, event id) — service role only.
--   Locks the link row, then:
--     already paid                    → already_recorded (a retry writes nothing)
--     not active / amount ≠ link      → needs_review, nothing booked
--     any bill closed, other customer,
--     no quote of its own, or due now
--     below the frozen amount         → needs_review, nothing booked (never another bill's money,
--                                       never an overpayment turned into credit by itself)
--     else record_payment per bill (method razorpay, reference = Razorpay payment id) in ONE
--     transaction, link → paid. A replay inside record_payment rolls the whole booking back to
--     needs_review — fail closed.
--
-- Test: supabase/tests/r2415_invoice_payment_links.test.sql (one transaction, rolled back).

begin;

create table if not exists public.invoice_payment_links (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_id         uuid not null references public.customers(id) on delete cascade,
  scope               text not null check (scope in ('invoice', 'statement')),
  invoice_id          text references public.invoices(id) on delete set null,
  link_key            text not null check (link_key ~ '^(invoice:.+|statement:[0-9a-f-]{36})$'),
  allocations         jsonb not null check (jsonb_typeof(allocations) = 'array'
                                            and jsonb_array_length(allocations) between 1 and 200),
  bill_amount         integer not null check (bill_amount > 0),
  amount              integer not null,
  mode                text check (mode is null or mode in ('live', 'test')),
  status              text not null default 'creating'
                        check (status in ('creating', 'active', 'paid', 'cancelled', 'failed', 'needs_review')),
  razorpay_link_id    text unique check (razorpay_link_id is null or razorpay_link_id ~ '^plink_[A-Za-z0-9]{6,40}$'),
  short_url           text check (short_url is null or short_url ~ '^https://'),
  razorpay_payment_id text,
  razorpay_order_id   text,
  review_reason       text,
  cancel_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  expires_at          timestamptz,
  paid_at             timestamptz,
  cancelled_at        timestamptz,
  constraint invoice_payment_links_amount_covers_bill check (amount >= bill_amount),
  constraint invoice_payment_links_scope_invoice check ((scope = 'invoice') = (link_key like 'invoice:%')),
  constraint invoice_payment_links_live_has_link check (status in ('creating', 'failed') or razorpay_link_id is not null)
);

comment on table public.invoice_payment_links is
  'R-2415: one Razorpay payment link per open invoice (link_key invoice:<id>) or statement total (statement:<customer id>). At most one creating/active row per key. Booked once by settle_invoice_payment_link from the payment_link.paid webhook.';
comment on column public.invoice_payment_links.allocations is
  'R-2415: [{invoice_id, quote_id, amount}] — the bills this link pays and how much each, frozen when the link was made.';
comment on column public.invoice_payment_links.amount is
  'R-2415: whole rupees the link asks for. = bill_amount until R-2417 adds the online fee when the customer bears it.';

create unique index if not exists invoice_payment_links_one_live
  on public.invoice_payment_links (tenant_id, link_key)
  where status in ('creating', 'active');
create index if not exists invoice_payment_links_customer_idx
  on public.invoice_payment_links (tenant_id, customer_id, status);
create index if not exists invoice_payment_links_order_idx
  on public.invoice_payment_links (razorpay_order_id)
  where razorpay_order_id is not null;

alter table public.invoice_payment_links enable row level security;

drop policy if exists invoice_payment_links_tenant_read on public.invoice_payment_links;
create policy invoice_payment_links_tenant_read on public.invoice_payment_links
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- R-450: Cloud SQL has no BYPASSRLS; the server writes through its own policy.
drop policy if exists invoice_payment_links_service_role on public.invoice_payment_links;
create policy invoice_payment_links_service_role on public.invoice_payment_links
  for all to service_role using (true) with check (true);

revoke all on public.invoice_payment_links from anon, public;
grant select on public.invoice_payment_links to authenticated;
grant all on public.invoice_payment_links to service_role;

-- ─── settle ────────────────────────────────────────────────────────────────────────────────
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
/* R-2415: book a paid Razorpay payment link on the bills it was made for — once. */
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
      'same_payment', v_link.razorpay_payment_id is not distinct from p_payment_id);
  end if;
  if v_link.status = 'needs_review' then
    return jsonb_build_object('found', true, 'review', true, 'tenant_id', v_link.tenant_id,
      'customer_id', v_link.customer_id, 'link_row', v_link.id, 'why', v_link.review_reason);
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
    when sqlstate '40001' or sqlstate '40P01' or sqlstate '55P03' then
      raise;   -- a lock / serialisation clash: the webhook answers 500 and Razorpay retries
    when others then
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
  'R-2415: book a paid Razorpay payment link (payment_link.paid) on the invoices it was made for, once — record_payment per bill in one transaction; anything that does not match the frozen link → needs_review, nothing booked. Service role only.';

revoke all on function public.settle_invoice_payment_link(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.settle_invoice_payment_link(text, text, bigint, text) to service_role;

commit;
