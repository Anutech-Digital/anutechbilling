-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_payments_ref_once' and tgrelid = to_regclass('public.payments')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_multi_invoice_payment(uuid,date,text,uuid,text,integer,jsonb,boolean,text)') and prosrc like '%R-1676%') and to_regprocedure('public.payment_reference_duplicates()') is not null
-- deploy-key: r1676paymentrefonce
--
-- R-1676 (P1 money, 19 Oct 2026) — one bank credit was counted twice.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Staging release check, story 9: NEFT UTR TUTR7A19OCTTEST was already on T-7's payment and
--   was accepted again on INV-5F40-27-0070 (T-9) — no warning, invoice Paid, a ₹22,939 bank
--   credit counted again as ₹38,232. The only "unique" rule on payments is
--   payments_idempotency_uq (tenant, QUOTE, reference): the same UTR on ANOTHER quote, or the
--   same UTR typed in another case / with spaces, went straight in.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   * payment_ref_key(method, reference): the bank reference as the bank prints it — spaces
--     and hyphens dropped, upper-case — for UPI and bank transfer (one family: a UTR/RRN is
--     one credit on the statement). NULL for cash (auto "Cash <date> <time>" refs), cheque
--     (cheque numbers repeat across banks), razorpay (gateway ids; one cart payment is split
--     over several quotes on purpose) and other, and for refs under 6 characters ("NA").
--   * trg_payments_ref_once (BEFORE INSERT / UPDATE OF reference, method, status): a
--     'received' payment whose key is already on another 'received' payment of the SAME tenant
--     is refused, naming the existing receipt. Refunded payments do not block (status <>
--     'received'). Every write path goes through it — record_payment, desk, instalment,
--     multi-invoice, bank match, webhooks, a direct row edit — not only the UI.
--   * record_multi_invoice_payment is the ONE legitimate way to put one UTR on several invoices
--     (one transfer that paid several invoices). It now marks its own loop with the
--     transaction-local setting app.payment_ref_batch = the key, so its lines pass, and clears
--     it right after. Body otherwise unchanged from 20261018033137_r1564.
--   * Existing duplicates: a trigger checks only NEW writes, so old duplicate rows cannot make
--     this migration fail and are left as they are (fixing them is a money decision: refund,
--     delete or re-reference — the owner's call). payment_reference_duplicates() lists them
--     per tenant so they can be cleaned up; a multi-invoice receipt counts as one.
--   * Index payments_ref_key_idx keeps the check an index lookup.
--
-- Test: supabase/tests/r1676_payment_ref_once.test.sql

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
    then 'BANK:' || upper(regexp_replace(p_reference, '[[:space:]-]', '', 'g'))
  end
$$;

comment on function public.payment_ref_key(text, text) is
  'R-1676: the bank reference a payment is keyed on for the one-credit-once rule — UPI/bank transfer only, spaces/hyphens dropped, upper-case; NULL when the rule does not apply.';

revoke all on function public.payment_ref_key(text, text) from public, anon;
grant execute on function public.payment_ref_key(text, text) to authenticated, service_role;

create index if not exists payments_ref_key_idx
  on public.payments (tenant_id, public.payment_ref_key(method, reference))
  where status = 'received';

/* Raises when the reference is already on a received payment of this tenant (other than
   p_exclude). Called by the trigger (every write) and by record_multi_invoice_payment before
   its loop (whose own lines are then let through). Not granted to app roles: it is only
   reached from these SECURITY DEFINER functions, so a caller cannot probe another company. */
create or replace function public.assert_payment_ref_unused(
  p_tenant_id uuid, p_method text, p_reference text, p_exclude uuid default null)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_key   text := public.payment_ref_key(p_method, p_reference);
  v_old   record;
  v_label text;
begin
  if v_key is null or p_tenant_id is null then
    return;
  end if;
  select p.id, p.customer_id, p.amount, p.received_at, p.receipt_voucher_no, p.quote_id,
         q.invoice_id, coalesce(c.name, q.customer_name) as customer_name
    into v_old
    from public.payments p
    left join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
    left join public.customers c on c.id = p.customer_id and c.tenant_id = p.tenant_id
   where p.tenant_id = p_tenant_id
     and p.status = 'received'
     and p.id is distinct from p_exclude
     and public.payment_ref_key(p.method, p.reference) = v_key
   order by p.received_at, p.id
   limit 1;
  if not found then
    return;
  end if;

  v_label := coalesce(v_old.receipt_voucher_no, v_old.invoice_id, v_old.quote_id);
  raise exception using
    errcode = 'P0001',
    message = format(
      'Ye UTR pehle se %s par hai — reference %s is already recorded (%s%s, ₹%s, %s). One bank credit cannot be counted twice. If one transfer paid several invoices, record it once with Payments → Record payment → Several invoices; if this is a different transfer, enter its own UTR from the bank statement.',
      v_label,
      trim(p_reference),
      coalesce(v_old.customer_name, 'customer'),
      case when v_old.invoice_id is not null and v_old.invoice_id <> v_label then ', invoice ' || v_old.invoice_id else '' end,
      v_old.amount,
      to_char(v_old.received_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')),
    detail = format('duplicate_payment_reference payment_id=%s customer_id=%s', v_old.id, coalesce(v_old.customer_id::text, '')),
    hint = 'Open Payments and search for this reference to see the existing receipt.';
end;
$function$;

comment on function public.assert_payment_ref_unused(uuid, text, text, uuid) is
  'R-1676: raises (naming the existing receipt) when a UPI/bank-transfer reference is already on a received payment of the tenant.';

revoke all on function public.assert_payment_ref_unused(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.tg_payments_ref_once()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1676: one bank credit (UTR / UPI ref) is recorded once per company. */
declare
  v_key   text;
  v_batch text;
begin
  if new.status is distinct from 'received' then
    return new;
  end if;
  v_key := public.payment_ref_key(new.method, new.reference);
  if v_key is null then
    return new;
  end if;
  /* An edit that keeps the same key on a received payment is not a new credit. */
  if tg_op = 'UPDATE' and old.status = 'received'
     and public.payment_ref_key(old.method, old.reference) is not distinct from v_key then
    return new;
  end if;
  /* record_multi_invoice_payment: one transfer spread over several invoices. It checked the
     reference against earlier payments itself before its loop; these are its own lines. */
  v_batch := nullif(current_setting('app.payment_ref_batch', true), '');
  if v_batch is not null and v_batch = v_key then
    return new;
  end if;

  perform public.assert_payment_ref_unused(new.tenant_id, new.method, new.reference, new.id);
  return new;
end;
$function$;

comment on function public.tg_payments_ref_once() is
  'R-1676: refuses a received UPI/bank-transfer payment whose normalised reference is already on another received payment of the same tenant (one bank credit counted once). record_multi_invoice_payment passes via app.payment_ref_batch.';

revoke all on function public.tg_payments_ref_once() from public, anon;

drop trigger if exists trg_payments_ref_once on public.payments;
create trigger trg_payments_ref_once
  before insert or update of reference, method, status on public.payments
  for each row execute function public.tg_payments_ref_once();

/* The duplicates already in the books before this rule — for the owner to clean up. A
   multi-invoice receipt (lines written in one call, notes "… across N invoices (ref …)")
   counts as ONE credit. Security invoker: RLS decides which tenant's rows are seen. */
create or replace function public.payment_reference_duplicates()
returns table (
  tenant_id     uuid,
  reference_key text,
  credits       bigint,
  payments      bigint,
  total_amount  bigint,
  receipts      text,
  first_at      timestamptz,
  last_at       timestamptz
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  with k as (
    select p.tenant_id, p.amount, p.received_at, p.receipt_voucher_no, p.quote_id,
           public.payment_ref_key(p.method, p.reference) as key,
           case when p.notes ~ 'across [0-9]+ invoices? \(ref '
                then 'batch:' || coalesce(p.customer_id::text, '') || ':' || p.received_at::text
                else p.id::text end as credit
      from public.payments p
     where p.status = 'received'
       and (public.current_tenant_id() is null or p.tenant_id = public.current_tenant_id())
  )
  select k.tenant_id, substr(k.key, 6), count(distinct k.credit), count(*), sum(k.amount)::bigint,
         string_agg(coalesce(k.receipt_voucher_no, q.invoice_id, k.quote_id), ', ' order by k.received_at),
         min(k.received_at), max(k.received_at)
    from k
    left join public.quotes q on q.id = k.quote_id and q.tenant_id = k.tenant_id
   where k.key is not null
   group by k.tenant_id, k.key
  having count(distinct k.credit) > 1
   order by min(k.received_at)
$$;

comment on function public.payment_reference_duplicates() is
  'R-1676: UPI/bank-transfer references recorded on more than one separate received payment (one bank credit counted more than once). A multi-invoice receipt counts once.';

revoke all on function public.payment_reference_duplicates() from public, anon;
grant execute on function public.payment_reference_duplicates() to authenticated, service_role;

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
   R-1564: an instalment invoice (no quote of its own) goes through record_instalment_payment.
   R-1676: its lines share one UTR on purpose — app.payment_ref_batch lets them past
   trg_payments_ref_once for the loop only. */
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

  /* R-1676: one transfer → several invoices is the one place a UTR may repeat — but only
     among THIS call's lines: the reference must not already be on an earlier payment. */
  perform public.assert_payment_ref_unused(v_tenant, p_method, p_reference);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(p_method, p_reference), ''), true);

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
  perform set_config('app.payment_ref_batch', '', true);

  return jsonb_build_object(
    'idempotent_replay', false, 'already_recorded', false,
    'received', p_received, 'allocated', v_sum, 'excess_credit', v_excess,
    'credit_invoice_id', v_credit_inv, 'lines', v_out);
end;
$function$;

comment on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) is
  'R-1525: one receipt spread over several of one customer''s invoices — record_desk_payment per invoice in one transaction; excess rides on the last fully-paid invoice and becomes advance credit through record_payment''s overpayment branch. R-1564: a subscription instalment invoice goes through record_instalment_payment (one instalment per subscription per receipt; never carries the excess). R-1676: the only path allowed to put one UTR on several invoices (app.payment_ref_batch). Owner/manager/accountant/billing; tenant + customer guarded, fail-closed.';

revoke all on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) from public, anon;
grant execute on function public.record_multi_invoice_payment(uuid, date, text, uuid, text, integer, jsonb, boolean, text) to authenticated, service_role;
