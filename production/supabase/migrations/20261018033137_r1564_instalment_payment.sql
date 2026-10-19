-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_instalment_payment(text,integer,text,text,text,uuid,integer,date,uuid,integer,integer,integer,text,numeric,text,text)') and prosrc like '%R-1564%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_multi_invoice_payment(uuid,date,text,uuid,text,integer,jsonb,boolean,text)') and prosrc like '%R-1564%')
-- deploy-key: r1564instalmentpay
--
-- R-1564 (P1 money, 18 Oct 2026) — a payment could not be recorded on an instalment invoice
-- (a quarterly / monthly split-billed subscription), and when it was recorded the only other
-- way — on the subscription's quote — it was credited to the NEXT instalment while this one
-- stayed Pending and the paying customer was chased.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   * raise_subscription_billing leaves invoices.quote_id NULL on purpose (the PDF would
--     print the year's quote total) — the link lives on subscription_billings.invoice_id.
--   * Every payment path is quote-keyed: record_payment settles quotes.invoice_id, which for
--     a split-billed quote is NULL. So the invoice page's Record payment looked for "the quote
--     whose invoice_id is this invoice", never found one, and sat on "Loading payment…"
--     (src/app/(app)/invoices/page.tsx:1283). record_multi_invoice_payment refused the
--     invoice outright (20261017152833_r1525_multi_invoice_payment.sql:193-195).
--   * Money recorded on the subscription's quote is "received, not applied". The instalment
--     invoice already raised is never touched; raise_subscription_billing credits it to the
--     NEXT instalment when that is raised (received − applied).
--
-- ─── THE FIX — a wrapper, no new money semantics ────────────────────────────
--   record_instalment_payment(invoice, …same arguments as record_desk_payment…)
--     1. finds the instalment's subscription and the quote it was sold on,
--     2. records the money through the EXISTING record_desk_payment on that quote (credit
--        redemption, record_payment / record_payment_with_tds, receipt date + bank tag, TDS
--        receivable — all as today, one transaction),
--     3. applies it to THIS invoice: paid_amount += least(money, due); status 'paid' and
--        paid_date = receipt date when nothing is left (due = net_payable − paid_amount, the
--        R-1561 convention every reader uses),
--     4. money beyond this invoice's due goes to the subscription's OTHER already-raised open
--        instalments, oldest first, and whatever is still left stays as received-not-applied
--        on the subscription — raise_subscription_billing credits it to the next instalment
--        when that is raised (its rule since 20260817120100). That is this module's existing
--        advance rule.
--   Because applied = Σ instalment paid_amount and received = Σ quote payments,
--   raise_subscription_billing's "available = received − applied" sees this payment as
--   ALREADY applied: nothing spills to the next instalment.
--
--   record_payment's own overpayment branch writes a customer_credits row only when the
--   quote's YEAR total is exceeded (e.g. a renewal term's instalments, paid on the original
--   quote). Here that money is already applied to an instalment or held for the next one, so
--   keeping that row would count it twice; the row record_payment wrote in THIS call (its
--   source_payment_id is the new payment) is removed in the same transaction.
--
--   record_multi_invoice_payment (R-1525) now takes instalment invoices too: such a line
--   goes through record_instalment_payment. Two instalments of the same subscription in one
--   receipt are refused (they share one quote, and a quote + reference is the replay key);
--   an instalment line never carries the left-over advance credit.
--
-- ─── GUARDS (§17c fail-closed) ──────────────────────────────────────────────
--   R-718 role gate (owner, manager, accountant, billing; service_role / direct DB trusted);
--   current_tenant_id() must be set (record_desk_payment needs a company); the invoice, its
--   instalment row, the subscription and the quote must all be in that company.
--
-- Known, not changed here (same as every payment on a split-billed quote today):
-- record_payment mints a receipt voucher because the quote has no invoice_id.
--
-- Test: supabase/tests/r1564_instalment_payment.test.sql (rolled back).

begin;

/* The invoice → instalment lookup every path now makes. */
create index if not exists subscription_billings_invoice_idx
  on public.subscription_billings (invoice_id) where invoice_id is not null;

create or replace function public.record_instalment_payment(
  p_invoice_id         text,
  p_amount             integer,
  p_method             text,
  p_reference          text,
  p_notes              text    default null,
  p_credit_customer_id uuid    default null,
  p_credit_amount      integer default 0,
  p_received_on        date    default null,
  p_bank_account_id    uuid    default null,
  p_tds_amount         integer default 0,
  p_tds_gross          integer default 0,
  p_tds_net_paid       integer default 0,
  p_tds_section        text    default null,
  p_tds_rate_pct       numeric default null,
  p_customer_tan       text    default null,
  p_fiscal_year        text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1564: a payment on an instalment invoice — record_desk_payment on the subscription's
   quote, then applied to THIS invoice in the same transaction. */
declare
  v_tenant    uuid := public.current_tenant_id();
  v_trusted   boolean;
  v_inv       record;
  v_sub_id    uuid;
  v_quote_id  text;
  v_q         record;
  v_due       integer := 0;
  v_r         jsonb;
  v_pay_id    uuid;
  v_settled   integer;
  v_apply     integer;
  v_left      integer;
  v_paid_on   date;
  v_now_paid  boolean;
  v_other     record;
  v_o_due     integer;
  v_o_apply   integer;
  v_also      jsonb := '[]'::jsonb;
  v_credit_rm integer := 0;
begin
  /* R-718 role gate — same as record_desk_payment. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment. Ask one of them to record it.'
      using errcode = '42501';
  end if;
  /* §17c fail-closed: no company → nothing (record_desk_payment needs one too). */
  if v_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.amount, i.net_payable, i.paid_amount, i.status
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'Invoice % was not found in your company. Refresh the invoice list and try again.', p_invoice_id
      using errcode = '42501';
  end if;

  select b.subscription_id into v_sub_id
    from public.subscription_billings b
   where b.invoice_id = v_inv.id and b.tenant_id = v_tenant
   limit 1;
  if not found then
    raise exception 'Invoice % is not a subscription instalment invoice. Record its payment from its quote (Invoices → the invoice → Record payment).', v_inv.id;
  end if;

  select s.quote_id into v_quote_id
    from public.subscriptions s
   where s.id = v_sub_id and s.tenant_id = v_tenant;
  select q.id, q.invoice_id into v_q
    from public.quotes q
   where q.id = v_quote_id and q.tenant_id = v_tenant;
  if v_quote_id is null or not found then
    raise exception 'Invoice %''s subscription was not sold through a quote, so the payment has nothing to be recorded against. Open Subscriptions, link the subscription to its quote, then record the payment.', v_inv.id;
  end if;
  /* A quote with its OWN invoice is settled by record_payment on that invoice — applying the
     same money here as well would count it twice. */
  if v_q.invoice_id is not null then
    raise exception 'Quote % already has its own invoice %, so its payments settle that invoice. Record the payment on invoice % instead.',
      v_quote_id, v_q.invoice_id, v_q.invoice_id;
  end if;

  /* Every open instalment of this subscription is locked (id order) before any due is read,
     so two payments on two instalments of one subscription cannot interleave. */
  perform 1 from public.invoices i
   where i.tenant_id = v_tenant
     and i.id in (select b.invoice_id from public.subscription_billings b
                   where b.subscription_id = v_sub_id and b.invoice_id is not null)
   order by i.id
   for update;

  /* Replay (R-374): the reference is already on this quote → record_desk_payment returns the
     earlier payment and changes nothing; nothing is applied again. */
  if not exists (select 1 from public.payments p
                  where p.tenant_id = v_tenant and p.quote_id = v_quote_id
                    and p.reference = p_reference and p.status = 'received') then
    if v_inv.status::text = 'void' then
      raise exception 'Invoice % is void — there is nothing to pay on it.', v_inv.id;
    end if;
    v_due := case when v_inv.status::text = 'paid' then 0
                  else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
    if v_due <= 0 then
      raise exception 'Invoice % is already paid in full. Record this money on the next instalment invoice of the subscription instead.', v_inv.id;
    end if;
  end if;

  v_r := public.record_desk_payment(
    v_quote_id, p_amount, p_method, p_reference, p_notes,
    p_credit_customer_id, p_credit_amount, p_received_on, p_bank_account_id,
    p_tds_amount, p_tds_gross, p_tds_net_paid, p_tds_section, p_tds_rate_pct,
    p_customer_tan, v_inv.id, p_fiscal_year);

  if coalesce((v_r->>'already_recorded')::boolean, false)
     or coalesce((v_r->>'idempotent_replay')::boolean, false) then
    return v_r || jsonb_build_object(
      'instalment', true, 'invoice_id', v_inv.id, 'quote_id', v_quote_id,
      'applied', 0, 'invoice_paid', false, 'also_applied', '[]'::jsonb, 'advance_left', 0,
      'overpaid_credit', 0);
  end if;

  v_pay_id := nullif(v_r->>'payment_id', '')::uuid;
  select p.amount into v_settled from public.payments p where p.id = v_pay_id and p.tenant_id = v_tenant;
  if v_settled is null then
    raise exception 'The payment for invoice % was not saved. Nothing was recorded — try again.', v_inv.id;
  end if;

  /* record_payment's over-the-year-total credit, written in THIS call: this money is applied
     to an instalment (or held for the next one) below — keeping the row counts it twice. */
  if coalesce((v_r->>'overpaid_credit')::int, 0) > 0 then
    delete from public.customer_credits c
     where c.tenant_id = v_tenant and c.source_payment_id = v_pay_id
       and c.source = 'overpayment' and c.status = 'open'
    returning c.amount into v_credit_rm;
  end if;

  v_paid_on := coalesce(p_received_on, public.ist_today());

  /* 1. THIS invoice first. */
  v_apply := least(v_settled, v_due);
  update public.invoices i
     set paid_amount = coalesce(i.paid_amount, 0) + v_apply,
         status      = case when coalesce(i.paid_amount, 0) + v_apply >= coalesce(i.net_payable, i.amount)
                            then 'paid'::invoice_status else i.status end,
         paid_date   = case when coalesce(i.paid_amount, 0) + v_apply >= coalesce(i.net_payable, i.amount)
                            then v_paid_on else i.paid_date end
   where i.id = v_inv.id and i.tenant_id = v_tenant
  returning i.status = 'paid' into v_now_paid;
  v_left := v_settled - v_apply;

  /* 2. The rest → this subscription's other raised, open instalments, oldest first. */
  if v_left > 0 then
    for v_other in
      select i.id, i.amount, i.net_payable, i.paid_amount
        from public.subscription_billings b
        join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
       where b.subscription_id = v_sub_id and b.tenant_id = v_tenant
         and i.id <> v_inv.id and i.status::text not in ('paid', 'void', 'draft')
       order by b.term_start, b.period_index, i.id
    loop
      exit when v_left <= 0;
      v_o_due := greatest(0, coalesce(v_other.net_payable, v_other.amount) - coalesce(v_other.paid_amount, 0));
      continue when v_o_due <= 0;
      v_o_apply := least(v_left, v_o_due);
      update public.invoices i
         set paid_amount = coalesce(i.paid_amount, 0) + v_o_apply,
             status      = case when coalesce(i.paid_amount, 0) + v_o_apply >= coalesce(i.net_payable, i.amount)
                                then 'paid'::invoice_status else i.status end,
             paid_date   = case when coalesce(i.paid_amount, 0) + v_o_apply >= coalesce(i.net_payable, i.amount)
                                then v_paid_on else i.paid_date end
       where i.id = v_other.id and i.tenant_id = v_tenant;
      v_also := v_also || jsonb_build_object('invoice_id', v_other.id, 'applied', v_o_apply,
                                             'invoice_paid', v_o_apply >= v_o_due);
      v_left := v_left - v_o_apply;
    end loop;
  end if;

  /* 3. Whatever is left stays received-not-applied on the subscription's quote — the next
     instalment raised takes it as credit (raise_subscription_billing). */
  return v_r || jsonb_build_object(
    'instalment',       true,
    'invoice_id',       v_inv.id,
    'quote_id',         v_quote_id,
    'subscription_id',  v_sub_id,
    'settled',          v_settled,
    'applied',          v_apply,
    'invoice_paid',     coalesce(v_now_paid, false),
    'invoice_due_after', v_due - v_apply,
    'also_applied',     v_also,
    'advance_left',     v_left,
    'overpaid_credit',  0,
    'credit_removed',   coalesce(v_credit_rm, 0));
end;
$function$;

comment on function public.record_instalment_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text) is
  'R-1564: a payment on a subscription instalment invoice — record_desk_payment on the subscription''s quote, then applied to THIS invoice (then other open instalments, oldest first; the rest waits for the next instalment) in one transaction. Owner/manager/accountant/billing; tenant guarded, fail-closed.';

revoke all on function public.record_instalment_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text) from public, anon;
grant execute on function public.record_instalment_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text) to authenticated, service_role;

-- ── record_multi_invoice_payment: R-1525 body, instalment lines added (marked R-1564) ──

create or replace function public.record_multi_invoice_payment(
  p_customer_id      uuid,
  p_received_on      date,
  p_method           text,
  p_bank_account_id  uuid,
  p_reference        text,
  p_received         integer,
  p_allocations      jsonb,
  p_excess_to_credit boolean default true,
  p_notes            text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1525: one receipt → several invoices of one customer, via record_desk_payment per line.
   R-1564: an instalment invoice (no quote of its own) goes through record_instalment_payment. */
declare
  v_inst       boolean;
  v_inst_q     text[] := array[]::text[];
  v_tenant     uuid := public.current_tenant_id();
  v_trusted    boolean;
  v_n          integer;
  v_alloc      jsonb;
  v_ids        text[] := array[]::text[];
  v_inv        record;
  v_quote      record;
  v_received   integer;
  v_inv_due    integer;
  v_q_due      integer;
  v_due        integer;
  v_amt        numeric;
  v_tds        numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_line       jsonb;
  v_sum        integer := 0;
  v_excess     integer;
  v_carrier    integer := null;
  v_replays    integer := 0;
  v_idx        integer;
  v_settle     integer;
  v_r          jsonb;
  v_out        jsonb := '[]'::jsonb;
  v_credit     integer;
  v_credit_inv text := null;
  v_notes      text;
  v_gross      integer;
  v_want       integer;
begin
  /* R-718 role gate — same as record_payment / record_desk_payment. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment. Ask one of them to record it.'
      using errcode = '42501';
  end if;
  /* §17c fail-closed: no company → nothing. */
  if v_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;

  if p_customer_id is null
     or not exists (select 1 from public.customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'That customer is not in your company. Open the customer from Customers and try again.'
      using errcode = '42501';
  end if;
  if p_received is null or p_received <= 0 then
    raise exception 'Enter the amount received (more than ₹0).';
  end if;
  if p_received_on is null then
    raise exception 'Enter the date the money was received.';
  end if;
  if p_method is null or p_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
    raise exception 'Choose how the money came in (UPI, bank transfer, cheque, cash…).';
  end if;
  if p_reference is null or length(trim(p_reference)) = 0 then
    raise exception 'Enter a reference (UTR / cheque no. / receipt no.) so this payment can be matched later.';
  end if;
  if p_bank_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'That bank account is not in your company. Choose one of your bank accounts.' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one invoice to apply this payment to.';
  end if;
  v_n := jsonb_array_length(p_allocations);
  if v_n > 200 then
    raise exception 'Too many invoices in one payment (% — at most 200). Record it in two parts.', v_n;
  end if;

  /* Shape + no duplicates, then lock every invoice in id order before reading any due. */
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_alloc) <> 'object' or coalesce(v_alloc->>'invoice_id', '') = '' then
      raise exception 'Each line needs an invoice. Refresh the list and try again.';
    end if;
    if (v_alloc->>'invoice_id') = any(v_ids) then
      raise exception 'Invoice % is listed twice. Keep it once with the full amount.', v_alloc->>'invoice_id';
    end if;
    v_ids := v_ids || (v_alloc->>'invoice_id');
  end loop;
  perform 1 from public.invoices
   where id = any(v_ids) and tenant_id = v_tenant
   order by id
   for update;

  v_idx := 0;
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    begin
      v_amt := coalesce((v_alloc->>'amount')::numeric, 0);
      v_tds := coalesce((v_alloc->>'tds_amount')::numeric, 0);
    exception when others then
      raise exception 'The amount for invoice % is not a number.', v_alloc->>'invoice_id';
    end;
    if v_amt <> trunc(v_amt) or v_tds <> trunc(v_tds) then
      raise exception 'Use whole rupees for invoice % (no paise).', v_alloc->>'invoice_id';
    end if;
    if v_amt < 0 or v_tds < 0 then
      raise exception 'The amount for invoice % cannot be negative.', v_alloc->>'invoice_id';
    end if;
    if v_amt + v_tds <= 0 then
      raise exception 'Invoice % has ₹0 against it. Enter an amount or remove the line.', v_alloc->>'invoice_id';
    end if;

    select i.id, i.tenant_id, i.customer_id, i.amount, i.net_payable, i.paid_amount, i.status,
           i.quote_id, i.taxable_value
      into v_inv
      from public.invoices i
     where i.id = v_alloc->>'invoice_id' and i.tenant_id = v_tenant;
    if not found then
      raise exception 'Invoice % was not found in your company. Refresh the list and try again.', v_alloc->>'invoice_id'
        using errcode = '42501';
    end if;
    if v_inv.customer_id is distinct from p_customer_id then
      raise exception 'Invoice % belongs to another customer. Record its payment from that customer.', v_inv.id
        using errcode = '42501';
    end if;

    v_inst := false;
    select q.id, q.amount, q.invoice_id
      into v_quote
      from public.quotes q
     where q.id = v_inv.quote_id and q.tenant_id = v_tenant and q.invoice_id = v_inv.id;
    if not found then
      /* R-1564: a subscription instalment — its money is recorded on the subscription's quote
         and applied to this invoice by record_instalment_payment. */
      select q.id, q.amount, q.invoice_id
        into v_quote
        from public.subscription_billings b
        join public.subscriptions s on s.id = b.subscription_id and s.tenant_id = v_tenant
        join public.quotes q on q.id = s.quote_id and q.tenant_id = v_tenant and q.invoice_id is null
       where b.invoice_id = v_inv.id and b.tenant_id = v_tenant
       limit 1;
      if not found then
        raise exception 'Invoice % has no quote of its own (a project invoice). Record its payment from the project.', v_inv.id;
      end if;
      v_inst := true;
      /* Two instalments of one subscription share its quote, and quote + reference is the
         replay key — the second line would read as a retry of the first. */
      if v_quote.id = any(v_inst_q) then
        raise exception 'Invoice % is another instalment of the same subscription as an invoice above. Keep one instalment per subscription here, or record this receipt on the oldest instalment from the invoice page — what is over its due goes to the next instalment of that subscription.', v_inv.id;
      end if;
      v_inst_q := v_inst_q || v_quote.id;
    end if;

    /* Replay: this quote already holds a received payment with this reference. */
    if exists (select 1 from public.payments p
                where p.tenant_id = v_tenant and p.quote_id = v_quote.id
                  and p.reference = p_reference and p.status = 'received') then
      v_replays := v_replays + 1;
      v_due := null;
    else
      if v_inv.status::text in ('paid', 'void') then
        v_inv_due := 0;
      else
        v_inv_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0));
      end if;
      if v_inst then
        /* R-1564: an instalment owes its own due; the year's quote total is not the limit. */
        v_due := v_inv_due;
      else
        select coalesce(sum(amount), 0)::int into v_received
          from public.payments where quote_id = v_quote.id and tenant_id = v_tenant and status = 'received';
        v_q_due := greatest(0, coalesce(v_quote.amount, 0) - v_received);
        v_due := least(v_inv_due, v_q_due);
      end if;
      if v_amt + v_tds > v_due then
        raise exception 'Invoice % has only ₹% due, but ₹% is applied to it. Lower that line; the rest can stay as advance credit.',
          v_inv.id, v_due, (v_amt + v_tds)::int;
      end if;
    end if;

    v_sum := v_sum + v_amt::int;
    v_lines := v_lines || jsonb_build_object(
      'invoice_id', v_inv.id, 'quote_id', v_quote.id, 'instalment', v_inst,
      'amount', v_amt::int, 'tds_amount', v_tds::int, 'due', v_due,
      'tds_gross', coalesce(nullif(v_alloc->>'tds_gross', '')::int, v_inv.taxable_value, v_inv.amount),
      'tds_section', nullif(trim(coalesce(v_alloc->>'tds_section', '')), ''),
      'tds_rate_pct', nullif(v_alloc->>'tds_rate_pct', '')::numeric,
      'customer_tan', nullif(trim(coalesce(v_alloc->>'customer_tan', '')), ''));
    /* The last line that pays its invoice IN FULL carries any excess. R-1564: never an
       instalment — record_instalment_payment keeps its excess for the next instalment,
       not as customer credit. */
    if v_due is not null and v_amt + v_tds = v_due and not v_inst then
      v_carrier := v_idx;
    end if;
    v_idx := v_idx + 1;
  end loop;

  /* Whole retry → nothing new; partial retry → refused. */
  if v_replays = v_n then
    select coalesce(jsonb_agg(jsonb_build_object(
             'invoice_id', l->>'invoice_id', 'quote_id', l->>'quote_id', 'payment_id', p.id,
             'amount', p.amount, 'invoice_paid', null)), '[]'::jsonb)
      into v_out
      from jsonb_array_elements(v_lines) l
      join public.payments p
        on p.tenant_id = v_tenant and p.quote_id = l->>'quote_id'
       and p.reference = p_reference and p.status = 'received';
    return jsonb_build_object('idempotent_replay', true, 'already_recorded', true,
                              'received', p_received, 'allocated', v_sum, 'excess_credit', 0,
                              'credit_invoice_id', null, 'lines', v_out);
  elsif v_replays > 0 then
    raise exception 'Reference % is already recorded on % of these invoices. Use the bank''s own reference for this payment, or leave those invoices out.',
      p_reference, v_replays;
  end if;

  v_excess := p_received - v_sum;
  if v_excess < 0 then
    raise exception 'The invoice lines add up to ₹% but only ₹% was received. Lower a line so they add up to the amount received.',
      v_sum, p_received;
  end if;
  if v_excess > 0 and not coalesce(p_excess_to_credit, false) then
    raise exception '₹% of the ₹% received is not applied to any invoice. Apply it to an invoice, or keep it as advance credit.',
      v_excess, p_received;
  end if;
  if v_excess > 0 and v_carrier is null then
    raise exception '₹% would be left as advance credit while every chosen invoice is still part-paid (a subscription instalment never carries it). Pay at least one regular invoice in full first (oldest first), then keep the rest as advance — or lower the amount received to what the invoices take.',
      v_excess;
  end if;

  v_notes := nullif(concat_ws(' · ',
               nullif(trim(coalesce(p_notes, '')), ''),
               'One payment of ₹' || p_received || ' across ' || v_n || ' invoice' || case when v_n = 1 then '' else 's' end || ' (ref ' || trim(p_reference) || ')'), '');

  v_idx := 0;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_want   := case when v_idx = v_carrier then v_excess else 0 end;
    v_settle := (v_line->>'amount')::int + (v_line->>'tds_amount')::int + v_want;
    v_gross := (v_line->>'tds_gross')::int;

    if coalesce((v_line->>'instalment')::boolean, false) then
      /* R-1564: same arguments, keyed by the instalment invoice. */
      v_r := public.record_instalment_payment(
        v_line->>'invoice_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        public.indian_fiscal_year(p_received_on));
      if not coalesce((v_r->>'already_recorded')::boolean, false)
         and not coalesce((v_r->>'idempotent_replay')::boolean, false)
         and coalesce((v_r->>'applied')::int, -1) <> v_settle then
        raise exception 'Amounts for invoice % are out of step (applied ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
          v_line->>'invoice_id', coalesce((v_r->>'applied')::int, 0), v_settle;
      end if;
    else
      v_r := public.record_desk_payment(
        v_line->>'quote_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        v_line->>'invoice_id',
        public.indian_fiscal_year(p_received_on));
    end if;

    if coalesce((v_r->>'already_recorded')::boolean, false)
       or coalesce((v_r->>'idempotent_replay')::boolean, false) then
      raise exception 'Invoice % already had this reference recorded a moment ago. Nothing was saved — refresh and check before trying again.',
        v_line->>'invoice_id';
    end if;
    v_credit := coalesce((v_r->>'overpaid_credit')::int, 0);
    if v_credit <> v_want then
      raise exception 'Amounts for invoice % are out of step (advance credit ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
        v_line->>'invoice_id', v_credit, v_want;
    end if;
    if v_idx = v_carrier and v_excess > 0 then
      v_credit_inv := v_line->>'invoice_id';
    end if;
    if (v_line->>'tds_amount')::int > 0 and not coalesce((v_r->>'tds_saved')::boolean, false) then
      raise exception 'The TDS for invoice % could not be saved. Nothing was saved — try again.', v_line->>'invoice_id';
    end if;

    v_out := v_out || jsonb_build_object(
      'invoice_id', v_line->>'invoice_id', 'quote_id', v_line->>'quote_id',
      'payment_id', v_r->>'payment_id', 'amount', v_settle,
      'tds_amount', (v_line->>'tds_amount')::int,
      'invoice_paid', coalesce((v_r->>'invoice_paid')::boolean, false));
    v_idx := v_idx + 1;
  end loop;

  return jsonb_build_object(
    'idempotent_replay', false, 'already_recorded', false,
    'received', p_received, 'allocated', v_sum, 'excess_credit', v_excess,
    'credit_invoice_id', v_credit_inv, 'lines', v_out);
end;
$function$;

comment on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) is
  'R-1525: one receipt spread over several of one customer''s invoices — record_desk_payment per invoice in one transaction; excess rides on the last fully-paid invoice and becomes advance credit through record_payment''s overpayment branch. R-1564: a subscription instalment invoice goes through record_instalment_payment (one instalment per subscription per receipt; never carries the excess). Owner/manager/accountant/billing; tenant + customer guarded, fail-closed.';

revoke all on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) from public, anon;
grant execute on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) to authenticated, service_role;

commit;
