-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.create_renewal_quote(uuid,uuid,jsonb)') and prosrc like '%R-2710%') and exists(select 1 from pg_trigger where tgname = 'quotes_r2710_renewal_term_follows_years' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r2710renewalreviewdraftyears
-- 20261112123439_r2710_renewal_review_draft_and_years.sql
--
-- R-2710 (12 Nov 2026, Pratik — Excel renewals: "renewal button daba ne pr editable usme khul na
-- chahiye"). Two database halves of "Review renewal quote → edit → Save & send":
--
-- 1. create_renewal_quote ALWAYS stored the new quote as 'sent' (R-1574), so a renewal quote made
--    for review could never open in the draft editor (lib/quotes/editable.ts: only a draft is
--    edited in place). p_quote.status = 'draft' now makes the NEW quote a draft — the Renewals row's
--    "Review renewal quote" asks for that and opens /quotes/<id>/edit; the editor's
--    "Save & send to customer" flips it to 'sent' only after the email went (R-408). No status (the
--    renewals cron, Send now, Create quote) → 'sent' exactly as before. An existing or re-linked
--    quote comes back unchanged. Body = the latest definition (20261108142224_r2613_seat_cut_quote_
--    link_race.sql) verbatim + the three R-2710 lines.
--
-- 2. A renewal quote whose domain line is changed to N years (the editor's "Register for 1–10
--    years", R-1445 — the line rate becomes N × the yearly price) kept extension_months = 12, and
--    record_payment's renewal path rolls renewal_date by extension_months and sets
--    mrr = subtotal / extension_months: the customer paid for 3 years, the subscription came up for
--    renewal after ONE, with 3x the MRR. (subscription_term_follows_line, R-1445, is BEFORE INSERT
--    on subscriptions — a renewal UPDATES the row, so it never ran here.)
--    quotes_r2710_renewal_term_follows_years (BEFORE UPDATE OF line_items): on a DRAFT renewal quote
--    (is_renewal, not an extension, whole-year extension_months > 0; the save may also mark it sent)
--    whose FIRST line's `years`
--    changes and whose caller did not set extension_months itself, extension_months follows:
--    old months / old years × new years (12 → 36 for 1 → 3 years; 36 → 12 back). The quote PDF,
--    email and accept page read the period from extension_months (lib/quotes/service-period.ts), so
--    they say "3 Years" too. Sent quotes are never edited in place (a Revise copies the row, then
--    its draft is edited here); plan-change / support-upgrade quotes (extension_months 0), month
--    terms and extension quotes are left alone.
--
-- Same signature, SECURITY DEFINER, search_path, grants. Stored rows are NOT changed.
-- Test: supabase/tests/r2710_renewal_review.test.sql (begin … rollback; red without this file).
begin;

-- ─── create_renewal_quote ───────────────────────────────────────────────────
create or replace function public.create_renewal_quote(
  p_subscription_id uuid,
  p_tenant_id       uuid,
  p_quote           jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1574: ONE transaction — lock the subscription, reuse its quote or make one and link it.
   R-2613: a scheduled end-of-term seat cut is re-read under that lock — a quote (new or re-linked)
   at other seats than the cut's is refused (rule N5).
   R-2710: p_quote.status = 'draft' makes the NEW quote a draft ("Review renewal quote" opens it in
   the editor; nothing is emailed). Anything else — the cron, Send now, old callers — 'sent' as before.
   An existing / re-linked quote is returned as it is (its status is never changed here). */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_sub      record;
  v_q        record;
  v_id       text;
  v_amount   integer;
  v_subtotal integer;
  v_tax      integer;
  v_lines    jsonb;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_seats    integer;
  v_status   public.quote_status;   -- R-2710
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company context — sign in again, then generate the renewal quote.' using errcode = '28000';
  end if;
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote. Ask one of them to press "Generate renewal quote" on the subscription.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_tenant_id is null then
    raise exception 'A renewal quote needs its subscription and company. Open the subscription and press "Generate renewal quote" again.' using errcode = '22004';
  end if;

  select s.id, s.tenant_id, s.renewal_date, s.renewal_quote_id, s.customer_id, s.customer_name, s.seats
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found then
    raise exception 'Subscription % was not found, so no renewal quote was made. Refresh the Renewals page and try again.', p_subscription_id using errcode = 'P0002';
  end if;
  if v_sub.tenant_id <> p_tenant_id or (v_caller is not null and v_sub.tenant_id <> v_caller) then
    raise exception 'Subscription % belongs to another company, so no renewal quote was made. Open it from your own Renewals page.', p_subscription_id using errcode = '42501';
  end if;
  if v_sub.renewal_date is null then
    raise exception 'Subscription % has no renewal date, so its renewal quote cannot be made. Set the renewal date on the subscription first.', p_subscription_id using errcode = '22004';
  end if;

  -- 1. Already linked → that quote (also an extension quote: one open renewal at a time).
  if v_sub.renewal_quote_id is not null then
    select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items
      into v_q
      from public.quotes q
     where q.id = v_sub.renewal_quote_id and q.tenant_id = v_sub.tenant_id;
    if found then
      return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', false,
        'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
        'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
    end if;
  end if;

  /* R-2613: the cut scheduled for this renewal, read AFTER the row lock above — a cut saved while
     the app was pricing this quote is seen here (reduce_subscription_seats locks the same row). */
  v_cut := public.r2613_applying_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date);

  -- 2. A quote already made for THIS term that lost its link → link it again, make nothing.
  select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items, q.seats
    into v_q
    from public.quotes q
   where q.tenant_id = v_sub.tenant_id
     and q.renewal_subscription_id = v_sub.id
     and q.renewal_term_date = v_sub.renewal_date
   limit 1;
  if found then
    if v_cut.id is not null and v_q.seats is distinct from v_cut.seats_after then
      raise exception 'Renewal quote % for this term is for % seats, but a seat cut to % seats is scheduled for % — so it was not linked. Delete that quote, then generate the renewal quote again (it is made with the cut).',
        v_q.id, coalesce(v_q.seats::text, 'unknown'), v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY')
        using errcode = 'check_violation';
    end if;
    update public.subscriptions set renewal_quote_id = v_q.id
     where id = v_sub.id and tenant_id = v_sub.tenant_id;
    return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', true,
      'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
      'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
  end if;

  -- 3. Make it. Refuse a quote with nothing to pay rather than store one.
  v_amount   := nullif(p_quote->>'amount', '')::integer;
  v_subtotal := nullif(p_quote->>'subtotal', '')::integer;
  v_tax      := coalesce(nullif(p_quote->>'tax_rate', '')::integer, 18);
  v_lines    := p_quote->'line_items';
  v_status   := case when p_quote->>'status' = 'draft' then 'draft' else 'sent' end;   -- R-2710
  if v_amount is null or v_amount <= 0 or v_subtotal is null or v_subtotal <= 0 then
    raise exception 'The renewal quote for subscription % has no price, so it was not made. Check the plan price in Items, then generate it again.', p_subscription_id using errcode = '22023';
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'The renewal quote for subscription % has no line, so it was not made. Generate it again from the subscription.', p_subscription_id using errcode = '22023';
  end if;
  /* R-2613: priced before the cut was saved → refused before a quote number is taken. */
  v_seats := nullif(p_quote->>'seats', '')::integer;
  if v_cut.id is not null and v_seats is distinct from v_cut.seats_after then
    raise exception 'A seat cut to % seats was scheduled for % while this renewal quote was being made for % seats, so it was not made. Generate the renewal quote again — it is made with the cut.',
      v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), coalesce(v_seats::text, 'unknown')
      using errcode = 'check_violation';
  end if;
  /* R-2613 (the other way round): priced WITH a cut that was removed meanwhile → it would bill
     fewer seats than the customer keeps, and paying it would drop the seats (rule N1). */
  if v_cut.id is null and public.r2613_removed_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date, v_seats) then
    raise exception 'The seat cut to % seats for % was removed while this renewal quote was being made, so it was not made. Generate the renewal quote again — it is made for % seats.',
      v_seats, to_char(v_sub.renewal_date, 'DD Mon YYYY'), v_sub.seats
      using errcode = 'check_violation';
  end if;

  v_id := public.next_document_number('quote', v_sub.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_sub.tenant_id, v_sub.customer_id,
    coalesce(nullif(p_quote->>'customer_name', ''), v_sub.customer_name),
    p_quote->>'plan',
    nullif(p_quote->>'seats', '')::integer,
    v_amount, v_status, 'awaiting',  -- R-2710: 'draft' only when asked (Review renewal quote)
    null,
    nullif(p_quote->>'domain', ''),
    coalesce(nullif(p_quote->>'created_date', '')::date, (now() at time zone 'Asia/Kolkata')::date),
    nullif(p_quote->>'expires_date', '')::date,
    v_lines,
    v_subtotal,
    coalesce(nullif(p_quote->>'total_cost', '')::integer, 0),
    0,
    v_tax,
    true,
    coalesce(nullif(p_quote->>'extension_months', '')::integer, 12),
    p_quote->>'notes',
    v_sub.id, v_sub.renewal_date
  );

  update public.subscriptions set renewal_quote_id = v_id
   where id = v_sub.id and tenant_id = v_sub.tenant_id;

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'discount_pct', 0,
    'tax_rate', v_tax, 'line_items', v_lines);
end;
$function$;

revoke all on function public.create_renewal_quote(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote(uuid, uuid, jsonb) to authenticated, service_role;


-- ─── a draft renewal quote's term follows its first line's years ────────────────
create or replace function public.r2710_renewal_term_follows_years()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2710: see the file header. Only the draft of a whole-year renewal quote, only when the first
   line's years changed and the caller left extension_months alone. */
declare
  v_old_years int;
  v_new_years int;
begin
  if not coalesce(new.is_renewal, false) or coalesce(new.is_extension, false) then
    return new;
  end if;
  -- the row edited was a draft; the same save may mark it sent ("Save & mark sent", no customer email)
  if old.status is distinct from 'draft' or new.status::text not in ('draft', 'sent') then
    return new;
  end if;
  if coalesce(old.extension_months, 0) <= 0 or old.extension_months % 12 <> 0 then
    return new;   -- plan change / support upgrade (0) or a month term: not a yearly renewal
  end if;
  if new.extension_months is distinct from old.extension_months then
    return new;   -- the caller chose the months itself
  end if;
  v_old_years := public.r2710_line_years(old.line_items);
  v_new_years := public.r2710_line_years(new.line_items);
  if v_old_years = v_new_years or old.extension_months % v_old_years <> 0 then
    return new;
  end if;
  new.extension_months := old.extension_months / v_old_years * v_new_years;
  return new;
end;
$function$;

/* R-2710: the first line's registration years — its `years` when a whole number 1–10, else 1
   (domainLineYears in lib/provisioning/products.ts). */
create or replace function public.r2710_line_years(p_lines jsonb)
returns int
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0
         and jsonb_typeof(p_lines->0) = 'object'
         and coalesce(p_lines->0->>'years', '') ~ '^\d{1,2}$'
         and (p_lines->0->>'years')::int between 1 and 10
      then (p_lines->0->>'years')::int
    else 1
  end;
$function$;

-- Trigger function / helper only: nobody calls them over the API.
revoke all on function public.r2710_renewal_term_follows_years() from public, anon, authenticated;
revoke all on function public.r2710_line_years(jsonb) from public, anon;   -- pure (reads only its argument)
grant execute on function public.r2710_line_years(jsonb) to authenticated, service_role;

drop trigger if exists quotes_r2710_renewal_term_follows_years on public.quotes;
create trigger quotes_r2710_renewal_term_follows_years
  before update of line_items on public.quotes
  for each row
  execute function public.r2710_renewal_term_follows_years();

commit;
