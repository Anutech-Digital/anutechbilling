-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_term_follows_line()') and prosrc like '%app.r2723_quote_line%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%app.r2723_quote_line%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text)') and prosrc like '%app.r2723_quote_line%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.file_invoiced_quote_subscriptions(text,integer)') and prosrc like '%app.r2723_quote_line%')
-- deploy-key: r2723quotelinehint
-- 20261116143715_r2723_quote_line_hint.sql
--
-- R-2723 (follow-up of R-2712's independent review, 13 Nov 2026): a subscription filed from a
-- quote takes its term from ITS quote line — the filer now says which line that is.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   subscription_term_follows_line (R-1445 … R-2712) never knew which quote line a new row came
--   from. It matched by plan name and, when a bulk line listed the row's domain, COUNTED: the
--   normal lines of that name before the bulk line vs the rows already filed. Two shapes still
--   picked the wrong line:
--     a. [Plan X qty 1 ₹1,000, NO commitment] + [bulk Plan X 3 years listing cust.com]. The
--        credit / invoice-now path files the first line (quote_line_is_subscription(…, true)),
--        the count skipped it → the normal row took the bulk line: 2029 / mrr 67 / ₹800
--        instead of 2027 / 83 / ₹1,000.
--     b. [bulk 3y a.com] [normal qty 1 ₹1,000] [bulk 2y cust.com]: the a.com row was counted as
--        the normal line's row → the normal row took the second bulk line (2028 / 67 / ₹800).
--   And a ONE-year bulk row had no exact yearly amount: the filer's pool split (floor, last
--   domain takes the rest) files 3 domains × ₹800 as mrr 66 / 66 / 68 → renewals of ₹792 / ₹792 /
--   ₹816; R-2369's term_amount skips bulk lines and R-2712 priced only years 2..10.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   1. record_payment, activate_quote_on_credit and file_invoiced_quote_subscriptions: at the top
--      of their line loop  set_config('app.r2723_quote_line', '<quote id>|<line index>', true)
--      and, after the loop, clear it. TWO added lines per function (marked R-2723); every other
--      byte is the newest definition (R-2848 20261115134526 / R-2230 20261101184900 / R-2097
--      20261029045403) — tests/r2723-filer-bodies.test.ts proves it.
--   2. subscription_term_follows_line (body: 20261113004902, R-2712, the latest):
--      - when the setting names this row's quote and a line that can be this row's (same plan
--        name; a bulk line must list the row's domain), that line IS the row's line — no count.
--        No setting / another quote / a bad index → the R-2712 pick, byte for byte as before
--        (imports, hand inserts, an older filer).
--      - step 3: a bulk line's own row on a 1-year line is priced like R-2712's multi-year row
--        with years = 1: term_amount = seats × net rate, mrr = round(term_amount ÷ 12).
--   No data is changed: rows filed before this keep their dates, mrr and term_amount.

begin;

-- R-1445 + R-2533 + R-2543 + R-2712 + R-2723
create or replace function public.subscription_term_follows_line()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lines   jsonb;
  v_line    jsonb;
  v_yearly  boolean;
  v_renewal date;
  v_years   int;
  v_term    int;
  v_cycle_m int;
  v_min     date;
  v_dom     text;      -- R-2712
  v_rate    numeric;   -- R-2712
  v_year_amount numeric;  -- R-2712
  v_bulk_i  bigint;    -- R-2712: the bulk line (its position) that lists this row's domain
  v_before  int;       -- R-2712: normal subscription lines of the same name before that bulk line
  v_filed   int;       -- R-2712: rows of this quote + plan already filed on another domain
  v_cost    numeric;   -- R-2712
  v_hint    text;      -- R-2723: '<quote id>|<line index>' the filer set for the row it is inserting
  v_hint_i  int;       -- R-2723
  v_hinted  boolean := false;  -- R-2723: the filer named this row's line — nothing is counted
begin
  -- R-1445
  if new.quote_id is null or new.start_date is null or new.renewal_date is null then
    return new;
  end if;

  v_yearly := new.renewal_date = (new.start_date + interval '1 year')::date;
  if not v_yearly and new.renewal_date <> (new.start_date + interval '1 month')::date then
    return new;   -- the caller chose its own date: keep it
  end if;

  -- R-2533: split-billed = more than one part per term.
  v_term := greatest(1, coalesce(new.term_months, 12));
  v_cycle_m := case coalesce(new.billing_cycle::text, '')
                 when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
  v_min := (new.start_date + make_interval(months => v_term))::date - 1;
  v_dom := nullif(lower(btrim(coalesce(new.domain, ''))), '');

  <<from_line>>
  begin
    select q.line_items into v_lines
      from public.quotes q
     where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
      exit from_line;
    end if;

    /* R-2723: the filer (record_payment / activate_quote_on_credit /
       file_invoiced_quote_subscriptions) names the quote line it is filing, in a transaction-local
       setting: '<quote id>|<0-based line index>'. When it names THIS row's quote and a line that
       can be this row's (same plan name; a bulk line must list the row's domain), that line is
       the row's line. Anything else — no setting (import, hand insert, an older filer), another
       quote, an index past the end, junk — is ignored and the R-2712 pick below decides. */
    v_line := null;
    v_bulk_i := null;
    v_hint := nullif(current_setting('app.r2723_quote_line', true), '');
    if v_hint is not null and v_hint ~ '[|][0-9]{1,6}$'
       and left(v_hint, length(v_hint) - length(substring(v_hint from '[|][0-9]{1,6}$'))) = new.quote_id then
      v_hint_i := substring(v_hint from '[|]([0-9]{1,6})$')::int;
      v_line := v_lines -> v_hint_i;
      if v_line is not null and jsonb_typeof(v_line) = 'object'
         and lower(btrim(coalesce(v_line->>'name', ''))) = lower(btrim(coalesce(new.plan, ''))) then
        if coalesce(v_line->>'bulk', '') <> 'true' then
          v_hinted := true;
        elsif public.r2712_bulk_line_lists_domain(v_line, v_dom, null) then
          v_hinted := true;
          v_bulk_i := v_hint_i + 1;
        end if;
      end if;
      if not v_hinted then
        v_line := null;
      end if;
    end if;

    if not v_hinted then   -- R-2723: the R-2712 pick, unchanged, for a row whose line was not named
    /* R-2712: is this row a bulk line's OWN row? (header, a.) Its domain must be listed by a
       bulk line of its plan name … */
    v_line := null;
    select t.i, t.e into v_bulk_i, v_line
      from jsonb_array_elements(v_lines) with ordinality as t(e, i)
     where jsonb_typeof(t.e) = 'object'
       and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
       and public.r2712_bulk_line_lists_domain(t.e, v_dom, null)
     order by t.i
     limit 1;
    if v_bulk_i is not null then
      /* … and it must come from that bulk loop: the normal subscription lines of the same name
         BEFORE the bulk line are filed first (line order), each with its own row. While one of
         them still has no row, this row is theirs — even when it borrowed a listed domain. */
      select count(*) into v_before
        from jsonb_array_elements(v_lines) with ordinality as t(e, i)
       where t.i < v_bulk_i
         and jsonb_typeof(t.e) = 'object'
         and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
         and coalesce(t.e->>'bulk', '') <> 'true'
         and coalesce(t.e->>'one_time', '') <> 'true'
         and coalesce(t.e->>'commitment', '') not in ('', 'one_time');
      if v_before > 0 then
        select count(*) into v_filed
          from public.subscriptions s
         where s.tenant_id = new.tenant_id and s.quote_id = new.quote_id
           and lower(btrim(coalesce(s.plan, ''))) = lower(btrim(coalesce(new.plan, '')))
           and nullif(lower(btrim(coalesce(s.domain, ''))), '') is distinct from v_dom;
        if v_filed < v_before then
          v_bulk_i := null;
          v_line := null;
        end if;
      end if;
    end if;
    end if;   -- R-2723: not v_hinted

    if v_line is null then
      /* A normal line's row: the pick it always had (same domain, then line order) — among the
         non-bulk lines first, so "bulk" never outranks line order here. */
      select t.e into v_line
        from jsonb_array_elements(v_lines) with ordinality as t(e, i)
       where jsonb_typeof(t.e) = 'object'
         and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
       order by (coalesce(t.e->>'bulk', '') = 'true'),
                (nullif(lower(btrim(coalesce(t.e->>'domain', ''))), '')
                   is not distinct from nullif(lower(btrim(coalesce(new.domain, ''))), '')) desc,
                t.i
       limit 1;
    end if;
    if v_line is null then
      exit from_line;
    end if;

    -- 1. The date the operator saw / typed (Onboard dialog → line.renewal_date).
    if coalesce(v_line->>'renewal_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_renewal := (v_line->>'renewal_date')::date;
      exception when others then
        v_renewal := null;   -- 2026-02-30 and the like: ignore, never fail the payment
      end;
      -- R-2533: split-billed → the line date must cover one whole term, else it is the next
      -- PART's date (Suresh: 19 Dec on a 19 Jun annual half-yearly sale).
      if v_renewal is not null and v_cycle_m is not null and v_cycle_m < v_term and v_renewal < v_min then
        raise notice 'R-2533: quote % line renewal date % is shorter than its %-month term — kept the default',
          new.quote_id, v_renewal, v_term;
        v_renewal := null;
      end if;
      if v_renewal > new.start_date and v_renewal <= (new.start_date + interval '10 years')::date then
        new.renewal_date := v_renewal;
        return new;
      end if;
    end if;

    -- 2. A domain registered for several years (line.years, R-156).
    if v_yearly and coalesce(v_line->>'years', '') ~ '^\d+$' then
      v_years := (v_line->>'years')::int;
      if v_years between 2 and 10 then
        new.renewal_date := (new.start_date + make_interval(years => v_years))::date;
        /* R-2712: the line's cost covers the whole term like its rate, and the filers write
           round(cost / 12). One division from the line's own cost, rounded once; only a line
           with no usable cost falls back to the filer's figure ÷ years. */
        if new.vendor_cost_per_seat_month is not null then
          v_cost := null;
          if jsonb_typeof(v_line->'cost') = 'number' then
            v_cost := (v_line->>'cost')::numeric;
          end if;
          new.vendor_cost_per_seat_month := case
            when v_cost > 0 then round(v_cost / (12.0 * v_years))::int
            else round(new.vendor_cost_per_seat_month::numeric / v_years)::int end;
        end if;

        /* R-2712: a bulk line's row is priced from the line itself — seats × net rate ÷ years is
           the exact price of one year for THIS domain. The filer's mrr is a share of a rounded
           pool; dividing that by the years again drifted (₹800 a year → ₹804). */
        v_year_amount := null;
        if coalesce(v_line->>'bulk', '') = 'true' and coalesce(new.seats, 0) > 0
           and v_bulk_i is not null then   -- this row is that bulk line's own (see the pick above)
          begin
            v_rate := case
              when nullif(v_line->>'renewal_rate', '') is not null then (v_line->>'renewal_rate')::numeric
              else coalesce((v_line->>'rate')::numeric, 0)
                     * (1 - coalesce(nullif(v_line->>'discount_pct', '')::numeric, 0) / 100)
            end;
          exception when others then
            v_rate := null;   -- a non-numeric rate: never fail the payment
          end;
          if v_rate > 0 then
            v_year_amount := round(new.seats * v_rate / v_years, 2);
          end if;
        end if;

        if v_year_amount is not null and round(v_year_amount / 12.0) >= 1 then
          new.mrr := round(v_year_amount / 12.0)::int;
          if new.term_amount is null and v_term = 12
             and public.subscription_term_amount_agrees(v_year_amount, new.mrr, 12, new.seats) then
            new.term_amount := v_year_amount;
          end if;
        else
          new.mrr := round(coalesce(new.mrr, 0)::numeric / v_years)::int;
        end if;
      end if;
    end if;

    /* 3. R-2723: a bulk line's own row on a ONE-year line — the R-2712 rule with years = 1.
       The filer's mrr is a share of a rounded pool (floor, the last domain takes the rest):
       3 domains × ₹800 a year → 66 / 66 / 68 → renewals of ₹792 / ₹792 / ₹816, and R-2369's exact
       term_amount skips bulk lines. Priced from the line itself: seats × net rate = the exact
       price of the year, mrr = that ÷ 12 rounded once. Only a yearly row (a Flexible bulk row
       renews + 1 month), a 12-month term, and when the caller gave no term_amount; anything
       unusable (0 seats, a rate of 0 or not a number) keeps the filer's figures. */
    if v_yearly and v_bulk_i is not null and coalesce(v_line->>'bulk', '') = 'true'
       and coalesce(v_years, 1) not between 2 and 10
       and v_term = 12 and coalesce(new.seats, 0) > 0 and new.term_amount is null then
      begin
        v_rate := case
          when nullif(v_line->>'renewal_rate', '') is not null then (v_line->>'renewal_rate')::numeric
          else coalesce((v_line->>'rate')::numeric, 0)
                 * (1 - coalesce(nullif(v_line->>'discount_pct', '')::numeric, 0) / 100)
        end;
      exception when others then
        v_rate := null;   -- a non-numeric rate: never fail the payment
      end;
      if v_rate > 0 then
        v_year_amount := round(new.seats * v_rate, 2);
        if round(v_year_amount / 12.0) >= 1
           and public.subscription_term_amount_agrees(v_year_amount, round(v_year_amount / 12.0)::int, 12, new.seats) then
          new.mrr := round(v_year_amount / 12.0)::int;
          new.term_amount := v_year_amount;
        end if;
      end if;
    end if;
  end from_line;

  -- R-2543: the filer's default (start + 1 year / + 1 month) on a split-billed row whose term is
  -- longer than that would be refused by trg_subscriptions_zzz_split_term_covers and abort the
  -- whole payment — lift it to the last day of the term, the guard's own rule.
  -- Only the default itself: a multi-year domain line (step 2) already set its own date and mrr.
  if v_cycle_m is not null and v_cycle_m < v_term and new.renewal_date < v_min
     and (new.renewal_date = (new.start_date + interval '1 year')::date
          or new.renewal_date = (new.start_date + interval '1 month')::date) then
    raise notice 'R-2543: subscription default renewal % is shorter than its %-month term — set to %',
      new.renewal_date, v_term, v_min;
    new.renewal_date := v_min;
  end if;

  return new;
end;
$function$;

-- record_payment: body of 20261115134526_r2848_renewal_together_payment.sql + the two R-2723 lines
CREATE OR REPLACE FUNCTION public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-2848: a renewal quote billed together renews every linked subscription once, by its own term (r2848_roll_together). */
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_overpaid_credit       integer := 0;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_is_monthly            boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_r1574_link_lost       boolean := false;  -- R-1574
  v_renewal_rolled_forward boolean := false;
  v_r2073_upgrade         boolean := false;  -- R-2073: mid-term support plan upgrade
  v_r2073_item_id         text;
  v_r2073_item_name       text;
  v_r2073_item_msrp       integer;
  v_r2073_item_prices     jsonb;
  v_r2073_mrr             integer;
  v_r2227_change          jsonb := null;  -- R-2227: licence plan change (quote line plan_change)
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
  v_has_bulk              boolean := false;
  v_bulk_total_seats      integer;
  v_bulk_pool             integer;
  v_running_mrr           integer;
  v_dom_mrr               integer;
  v_dom_seats             integer;
  v_dom                   text;
  v_idx                   integer;
  v_n                     integer;
  v_d                     jsonb;
  v_bulk_count            integer := 0;
  v_start                 date;
  -- 0172: multi-line-item support
  v_line_idx              integer;
  v_line_amount           integer;
  -- R-329: what the line's subscription renews at (qty x renewal_rate), else v_line_amount.
  v_renew_amount          integer;
  v_first_sub_in_quote    boolean := true;
  -- Only domain/Workspace-type products are meaningfully tied to a single
  -- domain; a quote mixing e.g. a support plan + a hosting plan has no
  -- per-line domain of its own, so both would otherwise fall back to the
  -- SAME customer domain and collide against
  -- subscriptions_tenant_quote_domain_unique (tenant_id, quote_id,
  -- lower(domain)). Track domains already used THIS call and null out any
  -- repeat instead of erroring or silently dropping the subscription.
  v_used_domains          text[] := array[]::text[];
  v_sub_domain            text;
  -- R-829: a line's OWN typed domain is kept even when another line of the quote has it
  -- (Starter + Business Standard on one domain). Only the same domain AND the same plan
  -- clash; such a line is listed in domain_conflicts in the result, never dropped silently.
  v_own_domain            boolean;
  v_used_domain_plans     text[] := array[]::text[];
  v_domain_conflicts      jsonb := '[]'::jsonb;
  -- R-346: the quote already has its subscriptions (activated on credit, or recreated).
  v_quote_subs_exist      boolean := false;
  -- R-378: the line's cost as ₹/seat/month → subscriptions.vendor_cost_per_seat_month.
  v_cost_pm               integer;
  -- R-1573: debit notes on the quote's invoice (owed on top of quotes.amount), and the
  -- overpayment credit this quote's payments already made.
  v_r1573_debits          integer := 0;
  v_r1573_credited        integer := 0;
  -- R-1703: what the subscription's OTHER quotes still owe, and their oldest due date.
  v_r1703_prior_open      integer := 0;
  v_r1703_prior_due       date;
  -- R-2848: a renewal quote billed together (renewal_quote_subscriptions)
  v_r2848_together        boolean := false;
  v_r2848_bad             text;
  v_r2848_n               integer := 0;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  v_is_service_role := public.current_request_role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal, q.is_one_off, q.is_extension,
         q.prospect_state_code, q.prospect_state, q.prospect_country,
         q.renewal_subscription_id, q.renewal_term_date  -- R-1574
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  /* Default to the TERM of the subscription being renewed, not a hard 12. A monthly
     subscription renewed with a plain renewal quote was being pushed a YEAR forward, so
     it would never be chased again and its MRR would keep counting for twelve months of
     service nobody had sold. Falls back to 12 when there is no subscription in hand
     (a new sale), which is where the old constant was right. */
  /* Left deliberately NULL when the quote does not say. The term of the subscription
     being renewed is not known yet — v_renewal_sub is selected below — and reading an
     unassigned RECORD raises 55000 for every payment, renewal or not. Resolved right
     after that select. */
  v_extension_months     := v_quote.extension_months;
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);
  v_has_bulk := exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce((li->>'bulk')::boolean, false)
  );

  /* R-2848: a renewal quote billed together renews EVERY subscription on its link rows, each by its own term
     (r2848_roll_together, after the invoice update below) — never the one-subscription path. Refused, nothing
     recorded: its links were released (the quote was closed), or a member's renewal date moved since the quote. */
  v_r2848_together := exists (select 1 from public.renewal_quote_subscriptions l
                               where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id);
  if v_r2848_together then
    if not exists (select 1 from public.renewal_quote_subscriptions l
                    where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null) then
      raise exception 'Renewal quote % renewed several subscriptions together but was closed, so its subscriptions were freed. Nothing was recorded. Make the renewal quote together again from Renewals, or record the money as customer credit.',
        p_quote_id using errcode = 'P0001';
    end if;
    perform 1 from public.subscriptions s
     where s.id in (select l.subscription_id from public.renewal_quote_subscriptions l
                     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null)
     order by s.id for update;
    select string_agg(format('%s (quoted for the term due %s, now due %s)', s.plan, to_char(l.renewal_term_date, 'DD Mon YYYY'),
                             coalesce(to_char(s.renewal_date, 'DD Mon YYYY'), 'no date')), ', ' order by s.plan)
      into v_r2848_bad
      from public.renewal_quote_subscriptions l
      join public.subscriptions s on s.id = l.subscription_id
     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null and l.renewed_at is null
       and s.renewal_date is distinct from l.renewal_term_date;
    if v_r2848_bad is not null then
      raise exception 'Renewal quote % renews several subscriptions together, but the renewal date of % changed since the quote was made — this payment would not renew it. Nothing was recorded. Set that renewal date back to the date the quote was made for (Correct details on the subscription), then record the payment again.',
        p_quote_id, v_r2848_bad using errcode = 'P0001';
    end if;
    v_is_renewal_quote := true;
    v_extension_months := coalesce(v_extension_months, 12);
  else
  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;
  end if;

  /* R-1574: a renewal quote whose link was lost (a second quote overwrote it, or the link was
     never written) used to fall through to the NEW-SALE path below — a second subscription
     was created and the subscription it was made for was not renewed. A quote made by
     create_renewal_quote names the subscription term it renews: while that term is still the
     open one it IS that renewal. When the term has moved on, the first payment is refused
     with the next step rather than opening a duplicate subscription. Quotes made before
     R-1574 carry no term and behave exactly as before. */
  /* R-2227: a plan-change quote whose link to its subscription was lost (renewal_quote_id cleared or
     overwritten) must never fall through to the NEW-SALE path below — that would open a second
     subscription from its net line. Refuse with the next step instead. */
  if not v_is_renewal_quote and coalesce(v_quote.extension_months, -1) = 0
     and jsonb_typeof(v_quote.line_items) = 'array'
     and jsonb_typeof(v_quote.line_items->0->'plan_change') = 'object' then
    raise exception 'R-2227: plan change quote % is no longer linked to its subscription, so this payment would change nothing. Nothing was recorded. Delete the quote and make it again from the subscription (Change plan).',
      p_quote_id using errcode = 'P0001';
  end if;

  /* R-2589: a plan-change quote is priced on the subscription as Change plan read it — plan_change
     from_seats / from_mrr / from_plan. If the seats, monthly amount or plan changed since (Reduce
     seats, Add seats, Correct details), its price is wrong; and a seat cut already credited the
     removed seats, so letting the quote put its seat count back would credit those seats twice.
     Refused on every payment (part or full); a quote without from_seats / from_mrr was made before
     this check and is refused the same way — the owner makes a new plan-change quote. A quote naming
     another subscription (R-2227's own message) and a subscription no longer active (cancelled with
     credit, paused, expired) are refused here too, so not even a part payment is taken. */
  if v_is_renewal_quote and coalesce(v_quote.extension_months, -1) = 0
     and jsonb_typeof(v_quote.line_items) = 'array'
     and jsonb_typeof(v_quote.line_items->0->'plan_change') = 'object' then
    if (v_quote.line_items->0->'plan_change'->>'subscription_id') is distinct from v_renewal_sub.id::text then
      raise exception 'R-2227: plan change quote % was made for another subscription. Nothing was recorded.',
        p_quote_id using errcode = 'P0001';
    end if;
    if (select s.status::text from public.subscriptions s where s.id = v_renewal_sub.id) is distinct from 'active' then
      raise exception 'R-2589: plan change quote % is for a subscription that is no longer active (%). Nothing was recorded. Delete this quote; a plan can be changed only on an active subscription.',
        p_quote_id, (select s.status::text from public.subscriptions s where s.id = v_renewal_sub.id) using errcode = 'P0001';
    end if;
    if (v_quote.line_items->0->'plan_change'->>'from_seats') is null
       or (v_quote.line_items->0->'plan_change'->>'from_mrr') is null
       or (v_quote.line_items->0->'plan_change'->>'from_seats')::numeric is distinct from v_renewal_sub.seats::numeric
       or (v_quote.line_items->0->'plan_change'->>'from_mrr')::numeric is distinct from v_renewal_sub.mrr::numeric
       or ((v_quote.line_items->0->'plan_change') ? 'from_plan'
           and nullif(trim(v_quote.line_items->0->'plan_change'->>'from_plan'), '') is distinct from nullif(trim(v_renewal_sub.plan), '')) then
      raise exception 'R-2589: plan/seats changed since this quote % was made (priced on % seats at ₹%/month, %; the subscription now has % seats at ₹%/month, %). Nothing was recorded. Delete this quote and make a new plan-change quote from Change plan.',
        p_quote_id,
        coalesce(v_quote.line_items->0->'plan_change'->>'from_seats', '?'),
        coalesce(v_quote.line_items->0->'plan_change'->>'from_mrr', '?'),
        coalesce(v_quote.line_items->0->'plan_change'->>'from_plan', 'plan not stored'),
        v_renewal_sub.seats, v_renewal_sub.mrr, coalesce(v_renewal_sub.plan, 'no plan')
        using errcode = 'P0001';
    end if;
  end if;

  if not v_is_renewal_quote and v_quote.renewal_subscription_id is not null then
    select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
      into v_renewal_sub
      from public.subscriptions s
     where s.tenant_id = v_tenant_id
       and s.id = v_quote.renewal_subscription_id
     for update;
    if found then
      if v_renewal_sub.renewal_date is not distinct from v_quote.renewal_term_date then
        v_is_renewal_quote := true;
        v_r1574_link_lost  := true;
      elsif not exists (select 1 from public.payments
                         where quote_id = p_quote_id and status = 'received') then
        raise exception 'Renewal quote % was made for the term of subscription "%" due on %, but that subscription now renews on % — that term was already renewed (or its date was changed), so this payment would renew nothing. Nothing was recorded. Open the subscription and record the money on its current renewal quote%, or record it as customer credit.',
          p_quote_id, v_renewal_sub.plan, v_quote.renewal_term_date, v_renewal_sub.renewal_date,
          coalesce(' (' || (select s2.renewal_quote_id from public.subscriptions s2 where s2.id = v_renewal_sub.id) || ')', '')
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  /* Now the term IS known. Default to the term of the subscription being renewed rather
     than a hard 12: renewing a MONTHLY subscription used to push its renewal date twelve
     months out, so it was never chased again and its MRR counted for a year of service
     nobody had sold. Falls back to 12 for a new sale, where no subscription exists and the
     old constant was right. */
  if v_extension_months is null then
    v_extension_months := coalesce(case when v_is_renewal_quote then v_renewal_sub.term_months end, 12);
  end if;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  /* #27 (migrations 0060/0061), lost from this function and re-added 22 Aug 2026.
     A quote with no amount has nothing to pay. Without this, paying ₹5,000 against a
     ₹0 quote recorded the payment, marked the quote received, and created an mrr=0
     subscription — a live customer with a subscription worth nothing, which then
     enters the renewal cadence and is invoiced for ₹0.

     Placed AFTER the idempotency replay above, deliberately: a quote that WAS priced,
     was paid, and was later edited to 0 must still replay idempotently rather than
     start throwing at a webhook that already succeeded. Only a NEW payment is refused. */
  if coalesce(v_quote.amount, 0) <= 0 then
    raise exception 'Quote % has no amount, so a payment cannot be recorded against it. Set the quote total first, then record the payment.', p_quote_id;
  end if;

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    /* Dedup (migrations 0064/0065), lost from this function and re-added 22 Aug 2026.
       The lead is a fresh row but the company may already be a customer — the same
       business enquiring a second time, or a renewal that came in as a new lead. This
       used to insert unconditionally, so that company got a SECOND customer row, and
       then a second subscription and a second invoice series against the same buyer.

       Matched on contact_email, case-insensitively and tenant-scoped. Email only:
       company NAME is not an identity (a short trade name vs the full registered name)
       and matching on it would merge two genuinely different customers, which is the
       worse error of the two — a wrongly-merged customer is far harder to unpick than
       a duplicate. No email on the lead means no match, and a new customer is created. */
    /* R-137 (3 Oct 2026): email alone merged different businesses that shared one
       inbox — every test quote on the owner's own address landed on one customer
       (one customer collected 64 quotes, Rs 3.9L of payments). Now: same GSTIN, or
       same email AND a matching name (match_existing_customer). The rule above still
       holds — when unsure, a duplicate is the lesser error. */
    v_customer_id := public.match_existing_customer(v_tenant_id, v_lead.contact_email, v_lead.gstin, v_lead.company);

    if v_customer_id is null then
      insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
      values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, public.ist_today(),
              case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
      returning id into v_customer_id;
    else
      /* Reused. The quote must point at the customer that actually exists, or the
         invoice and the subscription below hang off a different row than the payment. */
      update public.quotes set customer_id = v_customer_id
       where id = p_quote_id and tenant_id = v_tenant_id;

      /* R-373 (7 Oct 2026): the reused customer may have no state (149/160 locally),
         and generate_invoice refuses an invoice without one. The lead in hand carries
         the state the buyer gave (or a GSTIN whose first two digits are the code), so
         fill a BLANK customer state from it — never overwrite one already set. Same
         rule as fillBlankCustomerState on the online path. */
      update public.customers c
         set state_code = case
                            when btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$' then btrim(v_lead.state_code)
                            else substring(btrim(v_lead.gstin) from 1 for 2)
                          end,
             state      = case
                            when nullif(btrim(coalesce(c.state, '')), '') is null then v_lead.state
                            else c.state
                          end
       where c.id = v_customer_id
         and c.tenant_id = v_tenant_id
         and nullif(btrim(coalesce(c.state_code, '')), '') is null
         and (btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$'
              or btrim(coalesce(v_lead.gstin, '')) ~ '^[0-9]{2}');
    end if;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_is_first_payment and v_quote.customer_id is null and v_quote.lead_id is null then
    insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
    values (v_tenant_id, coalesce(nullif(trim(v_quote.customer_name), ''), 'Customer'),
            v_domain, public.ist_today(), case when p_amount >= v_expected then 85 else 75 end,
            v_quote.prospect_state_code, v_quote.prospect_state,
            coalesce(nullif(trim(v_quote.prospect_country), ''), 'India'))
    returning id into v_customer_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id, public.ist_today());
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, public.current_user_id())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  /* 0157: a ONE-OFF sale creates no subscription. Lost from this function and re-added
     22 Aug 2026 — and this is the costliest of the three, because it does not just
     record something wrong, it goes on to CHARGE for it. A direct invoice (is_one_off)
     is a single sale; the guard's absence gave it a recurring subscription, which the
     renewal cron then bills again on its next cycle. The customer is invoiced for a
     subscription nobody sold them. */
  /* R-346: a quote activated on credit already has its subscriptions (and draft POs). The
     first payment used to file them all AGAIN — two active subscriptions per line, both
     renewing. Existing rows for this quote_id mean "already filed": the payment goes down the
     elsif below, which only brings the outstanding down. */
  v_quote_subs_exist := exists (
    select 1 from public.subscriptions s
     where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id
  );

  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats
     and not coalesce(v_quote.is_one_off, false)
     and not v_quote_subs_exist then  -- R-346
    if jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0 then
      for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
        v_first_line := v_quote.line_items -> v_line_idx;
        perform set_config('app.r2723_quote_line', p_quote_id || '|' || v_line_idx, true);  -- R-2723: this row's quote line, for subscription_term_follows_line
        v_commitment := v_first_line->>'commitment';
        v_plan_name  := coalesce(v_first_line->>'name',
                          case when v_commitment = 'monthly' then 'Monthly subscription'
                               else 'Annual subscription' end);
        /* R-1688: the one rule for "does this line become a subscription"
           (quote_line_is_subscription): a line marked one-time ({"one_time": true}, the builder),
           commitment 'one_time', or a one-time catalogue item never does. A line with no
           commitment keeps this path's old meaning: paid first files nothing for it (false). */
        v_is_monthly := coalesce(v_commitment = 'monthly', false)
                        and public.quote_line_is_subscription(v_first_line, v_tenant_id, false);
        v_is_annual  := not v_is_monthly
                        and public.quote_line_is_subscription(v_first_line, v_tenant_id, false);
        v_po_sub_id  := null;

        if (v_is_annual or v_is_monthly) and v_customer_id is not null then
          -- 0172: exact vendor via the catalog item itself; name-guess only
          -- for lines with no item_id (hand-typed, no catalog link).
          v_vendor := null;
          if v_first_line->>'item_id' is not null then
            select i.vendor into v_vendor from public.items i
             where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
          end if;
          if v_vendor is null then
            v_plan_lower := lower(v_plan_name);
            v_vendor := case
              when v_plan_lower like '%google%'    then 'google'::public.vendor
              when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
              when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
              when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
              when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
              else 'other'::public.vendor end;
          end if;

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, public.ist_today());
          v_line_amount := round(
            coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
              * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
          )::int;
          /* R-329: a cart coupon discounts the first payment only. The line then says what it
             renews at; the subscription's mrr (and so every renewal) is filed from that. */
          v_renew_amount := case
            when nullif(v_first_line->>'renewal_rate', '') is not null
              then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
            else v_line_amount end;

          /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
          v_cost_pm := case
            when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
              then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
            else null end;

          if coalesce((v_first_line->>'bulk')::boolean, false)
             and jsonb_typeof(v_first_line->'domains') = 'array'
             and jsonb_array_length(v_first_line->'domains') > 0 then
            select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
              from jsonb_array_elements(v_first_line->'domains') e;
            if v_bulk_total_seats <= 0 then
              raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
            end if;
            v_bulk_pool := greatest(0, round(
                             coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end  -- R-329
                           ))::int;
            v_running_mrr := 0;
            v_idx := 0;
            v_n := jsonb_array_length(v_first_line->'domains');
            for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
              v_idx := v_idx + 1;
              v_dom := lower(trim(v_d->>'domain'));
              v_dom_seats := coalesce((v_d->>'seats')::int, 0);
              if v_dom = '' then continue; end if;
              if v_idx < v_n then
                v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
              else
                v_dom_mrr := v_bulk_pool - v_running_mrr;
              end if;
              v_running_mrr := v_running_mrr + v_dom_mrr;

              insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                start_date, renewal_date, status, outstanding_amount, domain, quote_id,
                term_months, vendor_cost_per_seat_month)  -- R-378
              values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
                v_start,
                (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
                'active', 0, v_dom, p_quote_id,
                case when v_is_monthly then 1 else 12 end,
                v_cost_pm)  -- R-378
              on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
                do nothing
              returning id into v_new_sub_id;

              insert into public.customer_domains (tenant_id, customer_id, domain)
              values (v_tenant_id, v_customer_id, v_dom)
              on conflict (tenant_id, lower(domain)) do nothing;

              v_bulk_count := v_bulk_count + 1;
              v_used_domains := array_append(v_used_domains, v_dom);
              v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
            end loop;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_bulk_total_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          else
            v_seats := coalesce((v_first_line->>'qty')::int, 0);
            -- 0172: prefer THIS line's own domain (the quote builder now lets
            -- staff type a distinct domain per product line) over the
            -- whole-quote/customer fallback below, which was the only source
            -- before per-line domains existed.
            v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
            v_own_domain := v_sub_domain is not null;  -- R-829
            if v_sub_domain is null then
              if v_domain is null and v_customer_id is not null then
                select domain into v_domain from public.customers where id = v_customer_id;
              end if;
              v_sub_domain := lower(nullif(trim(v_domain), ''));
            end if;
            /* R-829: the line's own domain stays unless THIS plan already has it on this quote
               (the unique index is per quote + domain + plan). A borrowed quote/customer
               domain still goes on one subscription only, as before (a support line next to
               Workspace does not take the Workspace domain). */
            if v_sub_domain is not null then
              if v_own_domain then
                if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
                  v_domain_conflicts := v_domain_conflicts || jsonb_build_object(
                    'line', v_line_idx + 1, 'plan', v_plan_name, 'domain', v_sub_domain);
                  v_sub_domain := null;
                end if;
              elsif v_sub_domain = any(v_used_domains) then
                v_sub_domain := null;
              end if;
            end if;
            insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
              start_date, renewal_date, status, outstanding_amount, domain, quote_id,
              term_months, vendor_cost_per_seat_month)  -- R-378
            values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
              greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,  -- R-329
              (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
              case when v_first_sub_in_quote then v_outstanding else 0 end,
              v_sub_domain, p_quote_id,
              case when v_is_monthly then 1 else 12 end,
              v_cost_pm)  -- R-378
            returning id into v_new_sub_id;
            if v_sub_domain is not null then
              v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
              v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
            end if;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          end if;

          if v_po_sub_id is not null then
            select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
              into v_unit_wholesale_pm from public.items
             where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
            if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
              v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
            end if;
            v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
            v_po_id := public.next_document_number('purchase_order', v_tenant_id);
            insert into public.purchase_orders (
              id, tenant_id, subscription_id, customer_id, customer_name, domain,
              vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
            ) values (
              v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
              v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
              'Auto-created from quote ' || p_quote_id ||
              case when coalesce((v_first_line->>'bulk')::boolean, false) then ' (bulk order - ' || v_bulk_count || ' domains)'
                   else ' (new sub)' end,
              public.current_user_id()
            );
            v_po_created := true;
          end if;
        end if;
      end loop;
      perform set_config('app.r2723_quote_line', '', true);  -- R-2723
    end if;
    v_po_sub_id := null;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats and not v_has_bulk then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid and not v_r2848_together then  -- R-2848: together → r2848_roll_together below
    /* R-1703: paying the NEW term does not pay the old one. Keep what the subscription's
       other quotes (its own quote + its other renewal quotes) still owe, and their oldest
       due date, instead of writing 0. */
    select coalesce(sum(o.open_amt), 0)::int, min(o.due)
      into v_r1703_prior_open, v_r1703_prior_due
      from (
        select public.quote_open_balance(q.id) as open_amt,
               coalesce(
                 (select min(i.due_date)::date from public.invoices i
                   where i.tenant_id = q.tenant_id and i.quote_id = q.id
                     and i.status in ('pending', 'overdue')
                     and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0),
                 q.credit_due_date::date,
                 case when q.id = s.quote_id then s.payment_due_date::date end) as due
          from public.subscriptions s
          join public.quotes q
            on q.tenant_id = s.tenant_id
           and (q.id = s.quote_id or q.renewal_subscription_id = s.id
                or exists (select 1 from public.renewal_quote_subscriptions l2   -- R-2848: a together quote it is on
                            where l2.quote_id = q.id and l2.subscription_id = s.id))
         where s.id = v_renewal_sub.id and s.tenant_id = v_tenant_id
           and q.id <> p_quote_id
           and (exists (select 1 from public.invoices i2
                         where i2.tenant_id = q.tenant_id and i2.quote_id = q.id and i2.status <> 'void')
                or (q.status = 'accepted' and q.superseded_at is null))
      ) o
     where o.open_amt > 0;
    v_r1703_prior_open := coalesce(v_r1703_prior_open, 0);
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    /* R-812: the subscription keeps ITS OWN plan. The line name is quote text — an
       extension line reads "<plan> · 3-month extension" — and writing it here renamed the
       subscription on every extension payment. The line name is only a fallback for a
       subscription that has no plan at all. */
    v_plan_name := coalesce(nullif(trim(v_renewal_sub.plan), ''), v_first_line->>'name');
    /* R-2073: a SUPPORT plan upgrade quote (lib/support/create-upgrade-quote.ts) is linked like an
       extension (renewal_quote_id) but buys NO time: extension_months = 0 and its one line is the
       new tier's catalogue row (SUP-…). Paid in full → the subscription moves to that row's plan
       and full-term MRR; renewal date, seats, renewal state, reminders and status stay as they
       are, and no vendor PO is drafted (support is our own service). Every other quote — any
       non-SUP line, or a support renewal/extension with months > 0 — takes the path below
       exactly as before. */
    v_r2073_upgrade := v_extension_months = 0
                       and coalesce(v_first_line->>'item_id', '') like 'SUP-%';
    /* R-2227: a LICENCE plan change quote (api/subscriptions/[id]/change-plan) has the same shape —
       renewal-linked, extension_months = 0 — and its first line carries plan_change {seats, new_mrr,
       cost_per_seat_month, subscription_id}. Paid in full → the subscription takes the new plan,
       item, seats, MRR and licence cost; renewal date, renewal state, reminders and status stay; no
       vendor PO (exactly the R-2073 path below). */
    if v_extension_months = 0 and jsonb_typeof(v_first_line->'plan_change') = 'object' then
      v_r2227_change := v_first_line->'plan_change';
      if v_r2227_change->>'subscription_id' is distinct from v_renewal_sub.id::text then
        raise exception 'R-2227: plan change quote % was made for another subscription. Nothing was recorded.',
          p_quote_id using errcode = 'P0001';
      end if;
      if coalesce((v_r2227_change->>'seats')::int, 0) < coalesce(v_renewal_sub.seats, 0)
         or coalesce((v_r2227_change->>'new_mrr')::int, 0) <= 0 then
        raise exception 'R-2227: plan change quote % has seats or a monthly amount that cannot be right (seats %, monthly %). Nothing was recorded. Delete the quote and make it again from Change plan.',
          p_quote_id, v_r2227_change->>'seats', v_r2227_change->>'new_mrr' using errcode = 'P0001';
      end if;
      v_r2073_upgrade := true;
    end if;
    if v_r2073_upgrade then
      select i.id, i.name, i.msrp, i.prices
        into v_r2073_item_id, v_r2073_item_name, v_r2073_item_msrp, v_r2073_item_prices
        from public.items i
       where i.tenant_id = v_tenant_id and i.id = v_first_line->>'item_id';
      if not found then
        raise exception 'R-2073: upgrade quote % names plan %, which is no longer in the catalogue. Nothing was recorded. Add the plan back under Products, then record the payment again.',
          p_quote_id, v_first_line->>'item_id' using errcode = 'P0001';
      end if;
      v_plan_name := v_r2073_item_name;
      v_r2073_mrr := case
        when v_r2227_change is not null then (v_r2227_change->>'new_mrr')::int  -- R-2227
        when coalesce(v_renewal_sub.term_months, 12) = 1 then nullif(v_r2073_item_msrp, 0)
        else round(nullif((v_r2073_item_prices->'annual_total'->>'msrp')::numeric, 0) / 12)::int
      end;
    end if;
    if v_first_line is not null then
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_seats := v_renewal_sub.seats;
    end if;
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       /* A full TERM, not a fixed twelve months. On a monthly subscription one month IS
          the whole term, and the old test left renewal_state stuck at whatever step the
          cadence had reached — so the ladder never re-armed and the next month went
          unchased. */
       set renewal_state = case when v_r2073_upgrade then renewal_state  -- R-2073
                                when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                                then 'renewed'
                                /* R-805: a part-year extension moved the date — start the
                                   reminder ladder again rather than keep a stale step. */
                                when coalesce(v_quote.is_extension, false) then 'pending'
                                else renewal_state end,
           /* R-805: an extension by MONTHS (not whole years) sets the new INCLUSIVE last day
              = (first day of the following term + N months) - 1 day, reading both stored
              shapes like followingTermStart() in subscription-schedule.ts: an ANNIVERSARY row
              (renewal_date = start_date + whole terms) is followed by renewal_date itself, an
              inclusive row by the day after it. Renewals and whole-year extensions roll
              exactly as before. */
           renewal_date  = case
             when v_r2073_upgrade then renewal_date  -- R-2073: same renewal date
             when coalesce(v_quote.is_extension, false) and v_extension_months % 12 <> 0 then
               ((case when v_renewal_sub.start_date is not null and exists (
                         select 1 from generate_series(1, 100) n
                          where (v_renewal_sub.start_date
                                 + make_interval(months => n * greatest(coalesce(v_renewal_sub.term_months, 12), 1)))::date
                                = v_renewal_sub.renewal_date)
                      then v_renewal_sub.renewal_date
                      else v_renewal_sub.renewal_date + 1 end)
                + make_interval(months => v_extension_months))::date - 1
             else (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date
           end,
           seats = case when v_r2227_change is not null then (v_r2227_change->>'seats')::int  -- R-2227
                        when v_r2073_upgrade then seats else v_seats end, plan = v_plan_name,
           vendor_cost_per_seat_month = case                                                 -- R-2227
             when v_r2227_change is not null and coalesce((v_r2227_change->>'cost_per_seat_month')::numeric, 0) > 0
               then round((v_r2227_change->>'cost_per_seat_month')::numeric)::int
             else vendor_cost_per_seat_month end,
           item_id = case when v_r2073_upgrade then v_r2073_item_id else item_id end,  -- R-2073
           mrr   = case when v_r2073_upgrade then coalesce(v_r2073_mrr, mrr)          -- R-2073
                        when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = v_r1703_prior_open,  -- R-1703: was 0
           payment_due_date = case when v_r1703_prior_open > 0
                                   then coalesce(v_r1703_prior_due, payment_due_date) end,
           renewal_quote_id = null,
           reminder_count = case when v_r2073_upgrade then reminder_count else 0 end,
           last_reminder_sent_at_v2 = case when v_r2073_upgrade then last_reminder_sent_at_v2 end,
           status = case when v_r2073_upgrade then status else 'active' end
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    if v_r2073_upgrade then v_renewal_rolled_forward := false; end if;  -- R-2073: nothing rolled
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor;
    v_po_sub_id := case when v_r2073_upgrade then null else v_renewal_sub.id end;  -- R-2073: no PO
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)'
           when v_bulk_count > 0    then ' (bulk order - ' || v_bulk_count || ' domains)'
           else ' (new sub)' end,
      public.current_user_id()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      /* R-015 (Pardeep, 29 Sep 2026). This wrote NOTHING unless the invoice was settled
         in full, so `invoices.paid_amount` stayed 0 on every part-paid invoice — and
         Aging and the Balance Sheet both count the whole `net_payable`. A Rs 1,00,000
         invoice with Rs 40,000 received showed Rs 1,00,000 outstanding while the same
         Rs 40,000 was also counted as cash: wrong on both sides of the books at once.
         (Only `sync_project_invoice_paid`, on the project side, ever filled the column,
         which is why it looks populated to anybody who checks a project invoice.)

         paid_amount is written on EVERY payment now. `greatest(0, ...)` because
         v_post_invoice_received is net of advances already adjusted onto the invoice and
         can legitimately go negative; a negative paid_amount would flatter the aging
         rather than merely be wrong.

         status and paid_date still move only on full settlement. invoice_status has no
         'partial' value, and adding one reaches every screen that switches on status —
         that is a change to ask for, not to take. Aging reads net_payable - paid_amount,
         which needs no new status.

         paid_date uses ist_today(): current_date is the UTC day on this server (R-015
         part 1), so an invoice settled at 01:00 IST was stamped yesterday. It is still
         the SETTLEMENT day and not the payment's own received date — record_payment has
         no received-date parameter to read, so the dialog patches that in afterwards. */
      update public.invoices
         set paid_amount = greatest(0, v_post_invoice_received),
             status      = case when v_post_invoice_received >= v_net_due
                                then 'paid'::invoice_status else status end,
             paid_date   = case when v_post_invoice_received >= v_net_due
                                then public.ist_today() else paid_date end
       where id = v_quote.invoice_id and tenant_id = v_tenant_id;
      v_invoice_paid := v_post_invoice_received >= v_net_due;
    end if;
  end if;

  /* R-346: paid in full → the credit reminders ("Credit: send payment link", "Credit: payment
     not in — stop service?") have nothing left to chase. Only those two; the set-up task stays. */
  if v_invoice_paid then
    update public.tasks
       set status = 'cancelled'
     where tenant_id = v_tenant_id
       and quote_id  = p_quote_id
       and status in ('pending', 'snoozed')
       and title like 'Credit:%';
  end if;

  /* R-2848: a together quote, paid (an invoice raised before the payment is 'paid' by now) → every member renews once
     by its own term and gets its own draft PO (r2848_roll_together; it may already have run from the payment / invoice
     triggers in this transaction — renewed_at = now() counts those too). */
  if v_r2848_together then
    perform public.r2848_roll_together(p_quote_id);
    select count(*)::int into v_r2848_n
      from public.renewal_quote_subscriptions l
     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null and l.renewed_at = now();
    v_po_created := v_po_created or v_r2848_n > 0;
    v_renewal_rolled_forward := v_r2848_n > 0;
  end if;

  /* ─── Overpayment → customer credit, ISI transaction me (audit A5, 1 Sep 2026) ───
     Outstanding upar 0 par floor hota hai, to expected se zyada aaya paisa yahan
     record na ho to KAHIN record nahi hota. Ye insert pehle client-side tha
     (record-payment-dialog.tsx), RPC ke commit ke BAAD — network/RLS ki ek hichki
     aur customer ka extra rupaya hamesha ke liye be-hisaab. Incremental hi jodta
     hai (is payment ne jitna naya excess banaya), taki kai kishton me double na gine —
     wahi ganit jo client me tha. */
  /* R-1573: a debit note (late interest, extra charge) on the quote's invoice is owed on top
     of quotes.amount — money paid for it settles the invoice above, it is not credit. Only
     what goes past quote + debit notes is, less the overpayment credit this quote's payments
     already made (an overpayment made BEFORE the note was credited against the smaller
     total — the incremental formula would credit part of it twice). Same rows as the
     balance sheet's advances_from_customers (2). No debit note → the old formula, unchanged. */
  if v_has_existing_invoice then
    select coalesce(sum(d.amount), 0)::int into v_r1573_debits
      from public.debit_notes d
     where d.tenant_id = v_tenant_id and d.invoice_id = v_quote.invoice_id;
  end if;
  if v_r1573_debits > 0 then
    select coalesce(sum(cc.amount), 0)::int into v_r1573_credited
      from public.customer_credits cc
      join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant_id
     where cc.tenant_id = v_tenant_id
       and cc.source in ('overpayment', 'redeemed_split')
       and p.quote_id = p_quote_id and p.status = 'received'
       and p.id <> v_payment_id;
    v_overpaid_credit := least(p_amount, greatest(0,
                           greatest(0, v_total_received - (v_expected + v_r1573_debits)) - v_r1573_credited));
  else
    v_overpaid_credit := greatest(0, v_total_received - v_expected)
                       - greatest(0, v_prior_received - v_expected);
  end if;
  if v_overpaid_credit > 0 and v_customer_id is not null then
    insert into public.customer_credits
      (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
    values
      (v_tenant_id, v_customer_id, v_overpaid_credit, 'overpayment', v_payment_id, p_quote_id,
       'Excess over quote ' || p_quote_id, 'open');
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'bulk_domains_created', v_bulk_count,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_link_lost', v_r1574_link_lost,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'support_upgrade', v_r2073_upgrade and v_r2227_change is null,  -- R-2073
    'plan_change', v_r2227_change is not null,  -- R-2227
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'overpaid_credit', v_overpaid_credit,
    'domain_conflicts', v_domain_conflicts,  -- R-829
    'together', v_r2848_together,  -- R-2848
    'together_renewed', v_r2848_n,  -- R-2848: members renewed by this payment
    'idempotent_replay', false
  );
end;
$function$;

-- activate_quote_on_credit: body of 20261101184900_r2230_part_due_dates.sql + the two R-2723 lines
create or replace function public.activate_quote_on_credit(
  p_quote_id text,
  p_credit_days integer,
  p_approve_over_limit boolean default false,
  p_annual_override_reason text default null   -- R-368
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
  v_uid              uuid := auth.uid();
  v_caller_tenant    uuid;
  v_is_owner         boolean;
  v_quote            record;
  v_cust             record;
  v_lead             record;
  v_tenant_id        uuid;
  v_customer_id      uuid;
  v_received         integer;
  v_limit            integer;
  v_owed             integer;
  v_this             integer;
  v_exposure         integer;
  v_over             boolean;
  v_today            date := public.ist_today();
  v_due              date;
  v_invoice_id       text;
  v_balance          integer;
  v_owner            uuid;
  v_who              text;
  v_t1               timestamptz;
  v_t2               timestamptz;
  v_t3               timestamptz;
  v_expected         integer;
  v_domain           text;
  v_subs_created     integer := 0;
  v_pos              text[] := array[]::text[];
  -- subscription loop (same names/rules as record_payment)
  v_line_idx         integer;
  v_first_line       jsonb;
  v_commitment       text;
  v_plan_name        text;
  v_plan_lower       text;
  v_is_annual        boolean;
  v_is_monthly       boolean;
  v_vendor           public.vendor;
  v_start            date;
  v_line_amount      integer;
  v_renew_amount     integer;
  v_bulk_total_seats integer;
  v_bulk_pool        integer;
  v_running_mrr      integer;
  v_idx              integer;
  v_n                integer;
  v_d                jsonb;
  v_dom              text;
  v_dom_seats        integer;
  v_dom_mrr          integer;
  v_bulk_count       integer := 0;
  v_seats            integer;
  v_sub_domain       text;
  v_used_domains     text[] := array[]::text[];
  v_own_domain       boolean;                       -- R-829
  v_used_domain_plans text[] := array[]::text[];    -- R-829
  v_domain_conflicts jsonb := '[]'::jsonb;          -- R-829
  v_new_sub_id       uuid;
  v_po_sub_id        uuid;
  v_po_seats         integer;
  v_po_plan          text;
  v_po_vendor        public.vendor;
  v_unit_wholesale_pm integer;
  v_total_wholesale  integer;
  v_po_id            text;
  v_first_sub        boolean := true;
  v_annual_reason    text := nullif(btrim(coalesce(p_annual_override_reason, '')), '');  -- R-368
  v_has_annual       boolean;                                                              -- R-368
  v_cost_pm          integer;                                                              -- R-378
begin
  if v_uid is null then
    raise exception 'Sign in to activate a quote on credit.' using errcode = 'insufficient_privilege';
  end if;
  v_caller_tenant := public.current_tenant_id();
  if v_caller_tenant is null then
    raise exception 'No tenant context';
  end if;
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active) then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;
  v_is_owner := public.current_user_is_owner();

  if p_credit_days is null or p_credit_days < 1 or p_credit_days > 180 then
    raise exception 'Credit days must be 1 to 180.' using errcode = 'check_violation';
  end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status, q.payment_status,
         q.amount, q.line_items, q.invoice_id, q.domain, q.is_add_seats, q.is_one_off,
         q.credit_activated_at, q.credit_due_date,
         q.billing_cycle   -- R-370
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_quote.tenant_id <> v_caller_tenant then
    raise exception 'Quote % does not belong to your tenant', p_quote_id using errcode = 'insufficient_privilege';
  end if;
  v_tenant_id   := v_quote.tenant_id;
  v_customer_id := v_quote.customer_id;
  v_expected    := coalesce(v_quote.amount, 0);

  -- Double click / second tab: report what is already there instead of a second invoice.
  if v_quote.credit_activated_at is not null then
    return jsonb_build_object(
      'already_active', true,
      'invoice_id', v_quote.invoice_id,
      'due_date', v_quote.credit_due_date,
      'subscriptions_created', 0,
      'tasks_created', 0
    );
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be activated on credit. Mark % accepted first.', p_quote_id
      using errcode = 'check_violation';
  end if;
  -- ── R-370: split billing is invoiced one period at a time by raise_subscription_billing.
  -- A whole-term credit invoice here would be billed a second time by the instalments.
  -- Same test as lib/payments/record-payment-invoice.ts isSplitBilled.
  if v_quote.billing_cycle is not null and v_quote.billing_cycle::text <> 'yearly' then
    raise exception 'This quote is billed in instalments (%) — record the first instalment instead, or switch billing to yearly.',
      replace(v_quote.billing_cycle::text, '_', '-')
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_one_off, false) then
    raise exception 'Quote % is a one-off sale: there is no subscription to activate. Issue the invoice instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_add_seats, false) then
    raise exception 'Quote % adds seats to an existing subscription. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.renewal_quote_id = p_quote_id) then
    raise exception 'Quote % renews an existing subscription, which is already active. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id) then
    raise exception 'Quote % already has subscriptions.', p_quote_id using errcode = 'check_violation';
  end if;

  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p where p.quote_id = p_quote_id and p.status = 'received';
  if v_received > 0 or v_quote.payment_status in ('received', 'partial') then
    raise exception 'Payment is already recorded on quote %, so it is not a credit sale.', p_quote_id
      using errcode = 'check_violation';
  end if;

  if v_quote.lead_id is not null then
    select l.trial_started_at, l.trial_converted_at into v_lead
      from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if found and v_lead.trial_started_at is not null and v_lead.trial_converted_at is null then
      raise exception 'Quote % is on a trial. Convert or stop the trial first.', p_quote_id
        using errcode = 'check_violation';
    end if;
  end if;

  if v_customer_id is null then
    raise exception 'Quote % has no customer yet. Accept it from the quote page so the customer is created.', p_quote_id
      using errcode = 'check_violation';
  end if;
  select c.id, c.name, c.domain, c.allow_pay_later, c.credit_limit into v_cust
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id;
  if not found then
    raise exception 'Customer of quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if not v_cust.allow_pay_later then
    raise exception 'Pay later is off for %. Turn it on in the customer''s Pay later settings, or record the payment first.', v_cust.name
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where li->>'commitment' is not null
  ) then
    raise exception 'Quote % has no subscription line (monthly or annual), so there is nothing to activate.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Credit limit ──
  v_limit := coalesce(v_cust.credit_limit, 50000);
  select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::int
    into v_owed
    from public.invoices i
   where i.tenant_id = v_tenant_id and i.customer_id = v_customer_id
     and i.status in ('pending', 'overdue');
  /* R-2230: what the customer's open part payment requests still owe counts too — the same rule
     as the customer page's "Unpaid now" (public.open_part_requests, one row per request = is_lead). */
  v_owed := v_owed + coalesce((select sum(r.still_due) from public.open_part_requests(v_customer_id, null) r
                                where r.is_lead), 0)::int;
  -- An invoice already raised on this quote is inside v_owed; do not count it twice.
  v_this     := case when v_quote.invoice_id is null then v_expected else 0 end;
  v_exposure := v_owed + v_this;
  v_over     := v_exposure > v_limit;
  if v_over and not v_is_owner then
    raise exception 'Over the credit limit: % already owes Rs %, this invoice is Rs %, total Rs % against a limit of Rs %. Only the owner can approve this.',
      v_cust.name, v_owed, v_this, v_exposure, v_limit
      using errcode = 'insufficient_privilege';
  end if;
  if v_over and not coalesce(p_approve_over_limit, false) then
    raise exception 'Over the credit limit: total Rs % against a limit of Rs %. Tick "Approve over limit" to go ahead.',
      v_exposure, v_limit
      using errcode = 'check_violation';
  end if;

  -- ── R-368: annual plans need payment first; only the owner overrides, with a reason ──
  -- After the credit-limit checks so their messages stay as they were. Same test as the app
  -- (lib/credit/activate-on-credit.ts annualLineNames): a commitment that is not monthly and
  -- not one_time.
  select exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce(li->>'commitment', '') not in ('', 'monthly', 'one_time')
  ) into v_has_annual;
  if v_has_annual and not v_is_owner then
    raise exception 'Annual plans need payment first. Only the owner can activate an annual plan on credit (quote %).', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_has_annual and (v_annual_reason is null or length(v_annual_reason) < 5) then
    raise exception 'Annual plans need payment first. To activate quote % on credit anyway, write the reason for the override.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Invoice (tax maths untouched: generate_invoice) ──
  -- An issued invoice is frozen (tg_invoices_freeze_issued: no due_date edits), so the due
  -- date goes in through generate_invoice's own rule: due = today + quotes.payment_terms_days.
  -- The credit days ARE the agreed terms of this sale, so the quote carries them.
  if v_quote.invoice_id is null then
    update public.quotes set payment_terms_days = p_credit_days
     where id = p_quote_id and tenant_id = v_tenant_id;
    select g.invoice_id into v_invoice_id from public.generate_invoice(p_quote_id) g;
  else
    -- Invoice raised before this: its due date stands (an issued invoice cannot be edited).
    v_invoice_id := v_quote.invoice_id;
    if exists (select 1 from public.invoices i where i.id = v_invoice_id and i.status in ('paid', 'void')) then
      raise exception 'Invoice % on quote % is % — nothing to give credit on.', v_invoice_id, p_quote_id,
        (select i.status from public.invoices i where i.id = v_invoice_id)
        using errcode = 'check_violation';
    end if;
  end if;
  select coalesce(i.due_date, v_today + p_credit_days) into v_due
    from public.invoices i where i.id = v_invoice_id;
  select greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))::int into v_balance
    from public.invoices i where i.id = v_invoice_id;

  -- ── Subscriptions: record_payment's rules, line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    perform set_config('app.r2723_quote_line', p_quote_id || '|' || v_line_idx, true);  -- R-2723: this row's quote line, for subscription_term_follows_line
    v_commitment := v_first_line->>'commitment';
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    /* R-1688: the one rule (quote_line_is_subscription). This read
       `v_is_monthly := v_commitment = 'monthly'`, which is NULL for a line with no commitment, so
       `continue when not (false or NULL)` did NOT continue and a One-time line was filed as an
       Annual subscription (and a commitment 'one_time' line was filed as annual outright). A line
       marked one-time, commitment 'one_time' or a one-time catalogue item is never filed; a line
       with no commitment keeps this path's old meaning (filed: true) so legacy quotes do not change. */
    v_is_monthly := coalesce(v_commitment = 'monthly', false)
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_is_annual  := not v_is_monthly
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_po_sub_id  := null;
    continue when not (v_is_annual or v_is_monthly);

    v_vendor := null;
    if v_first_line->>'item_id' is not null then
      select i.vendor into v_vendor from public.items i
       where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
    end if;
    if v_vendor is null then
      v_plan_lower := lower(v_plan_name);
      v_vendor := case
        when v_plan_lower like '%google%'    then 'google'::public.vendor
        when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
        when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
        when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
        when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
        else 'other'::public.vendor end;
    end if;

    v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, public.ist_today());
    v_line_amount := round(
      coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
        * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
    )::int;
    v_renew_amount := case
      when nullif(v_first_line->>'renewal_rate', '') is not null
        then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
      else v_line_amount end;

    /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
    v_cost_pm := case
      when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
        then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
      else null end;

    if coalesce((v_first_line->>'bulk')::boolean, false)
       and jsonb_typeof(v_first_line->'domains') = 'array'
       and jsonb_array_length(v_first_line->'domains') > 0 then
      select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
        from jsonb_array_elements(v_first_line->'domains') e;
      if v_bulk_total_seats <= 0 then
        raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
      end if;
      v_bulk_pool := greatest(0, round(
                       coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end
                     ))::int;
      v_running_mrr := 0;
      v_idx := 0;
      v_n := jsonb_array_length(v_first_line->'domains');
      for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
        v_idx := v_idx + 1;
        v_dom := lower(trim(v_d->>'domain'));
        v_dom_seats := coalesce((v_d->>'seats')::int, 0);
        if v_dom = '' then continue; end if;
        if v_idx < v_n then
          v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
        else
          v_dom_mrr := v_bulk_pool - v_running_mrr;
        end if;
        v_running_mrr := v_running_mrr + v_dom_mrr;

        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)  -- R-378
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', 0, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end,
          v_cost_pm)  -- R-378
        on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_bulk_count := v_bulk_count + 1;
        v_used_domains := array_append(v_used_domains, v_dom);
        v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      v_own_domain := v_sub_domain is not null;  -- R-829
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := lower(nullif(trim(v_domain), ''));
      end if;
      -- R-829: same rule as record_payment — own domain kept unless this plan already has it.
      if v_sub_domain is not null then
        if v_own_domain then
          if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
            v_domain_conflicts := v_domain_conflicts || jsonb_build_object(
              'line', v_line_idx + 1, 'plan', v_plan_name, 'domain', v_sub_domain);
            v_sub_domain := null;
          end if;
        elsif v_sub_domain = any(v_used_domains) then
          v_sub_domain := null;
        end if;
      end if;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)  -- R-378
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- Nothing is paid yet: the whole quote is outstanding, carried on the first subscription
        -- exactly as record_payment does for a part payment.
        case when v_first_sub then v_expected else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end,
        v_cost_pm)  -- R-378
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
        v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;
    v_first_sub := false;

    -- Draft PO for the vendor seats, same as record_payment (the seats go live now).
    if v_po_sub_id is not null then
      select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
        into v_unit_wholesale_pm from public.items
       where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
      if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
        v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * 12, 1)))::int;
      end if;
      v_total_wholesale := v_unit_wholesale_pm * v_po_seats * 12;
      v_po_id := public.next_document_number('purchase_order', v_tenant_id);
      insert into public.purchase_orders (
        id, tenant_id, subscription_id, customer_id, customer_name, domain,
        vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
      ) values (
        v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
        v_po_vendor, v_po_plan, v_po_seats, 12, v_unit_wholesale_pm, v_total_wholesale, 'draft',
        'Auto-created from quote ' || p_quote_id || ' (activated on credit)',
        v_uid
      );
      v_pos := array_append(v_pos, v_po_id);
    end if;
  end loop;
  perform set_config('app.r2723_quote_line', '', true);  -- R-2723

  if v_subs_created = 0 then
    raise exception 'No subscription could be created from quote % — check its lines.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Tasks for the owner. Tasks only: nothing is sent, nothing is suspended. ──
  select u.id into v_owner from public.users u
   where u.tenant_id = v_tenant_id and u.role = 'owner' and u.is_active
   order by u.created_at limit 1;
  v_owner := coalesce(v_owner, v_uid);
  v_who := coalesce(nullif(trim(v_quote.customer_name), ''), p_quote_id);

  -- 10:00 IST on the day; never in the past.
  v_t1 := greatest(now(), (v_today + time '10:00') at time zone 'Asia/Kolkata');
  v_t2 := greatest(v_t1, ((v_due - 3) + time '10:00') at time zone 'Asia/Kolkata');
  v_t3 := ((v_due + 15) + time '10:00') at time zone 'Asia/Kolkata';

  insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, quote_id) values
    (v_tenant_id, v_owner,
     'Set up seats (DNS, users) · ' || v_who,
     'Quote ' || p_quote_id || ' is active on credit. Verify the domain (DNS) and create the users. Invoice '
       || v_invoice_id || ', Rs ' || v_balance || ' due ' || to_char(v_due, 'DD Mon YYYY') || '.',
     'custom', v_t1, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: send payment link · ' || v_who,
     'Invoice ' || v_invoice_id || ' (Rs ' || v_balance || ') is due ' || to_char(v_due, 'DD Mon YYYY')
       || '. Send the payment link. Reminder only — nothing is sent to the customer automatically.',
     'followup', v_t2, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: payment not in — stop service? · ' || v_who,
     'Invoice ' || v_invoice_id || ' was due ' || to_char(v_due, 'DD Mon YYYY')
       || ' and is 15 days late. Decide: wait, chase or stop the service. Nothing is suspended automatically.',
     'followup', v_t3, p_quote_id);

  update public.quotes
     set credit_activated_at = now(),
         credit_activated_by = v_uid,
         credit_due_date     = v_due,
         credit_over_limit_approved_by = case when v_over then v_uid else null end,
         credit_annual_override_reason = case when v_has_annual then v_annual_reason else null end,  -- R-368
         credit_annual_override_by     = case when v_has_annual then v_uid else null end             -- R-368
   where id = p_quote_id and tenant_id = v_tenant_id;

  return jsonb_build_object(
    'already_active', false,
    'invoice_id', v_invoice_id,
    'due_date', v_due,
    'amount_due', v_balance,
    'subscriptions_created', v_subs_created,
    'purchase_orders', to_jsonb(v_pos),
    'tasks_created', 3,
    'over_limit', v_over,
    'owed_before', v_owed,
    'credit_limit', v_limit,
    'domain_conflicts', v_domain_conflicts  -- R-829
  );
end;
$function$;

-- file_invoiced_quote_subscriptions: body of 20261029045403_r2097_opening_sub_fractional_tier.sql + the two R-2723 lines
create or replace function public.file_invoiced_quote_subscriptions(p_quote_id text, p_outstanding integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
  v_quote            record;
  v_cust             record;
  v_tenant_id        uuid;
  v_customer_id      uuid;
  v_expected         integer;
  v_outstanding      integer := greatest(0, coalesce(p_outstanding, 0));
  v_domain           text;
  v_subs_created     integer := 0;
  v_line_idx         integer;
  v_first_line       jsonb;
  v_commitment       text;
  v_plan_name        text;
  v_plan_lower       text;
  v_is_annual        boolean;
  v_is_monthly       boolean;
  v_vendor           public.vendor;
  v_start            date;
  v_line_amount      integer;
  v_renew_amount     integer;
  v_bulk_total_seats integer;
  v_bulk_pool        integer;
  v_running_mrr      integer;
  v_idx              integer;
  v_n                integer;
  v_d                jsonb;
  v_dom              text;
  v_dom_seats        integer;
  v_dom_mrr          integer;
  v_seats            integer;
  v_sub_domain       text;
  v_used_domains     text[] := array[]::text[];
  v_own_domain       boolean;
  v_used_domain_plans text[] := array[]::text[];
  v_new_sub_id       uuid;
  v_po_sub_id        uuid;
  v_po_seats         integer;
  v_po_plan          text;
  v_po_vendor        public.vendor;
  v_unit_wholesale_pm integer;
  v_total_wholesale  integer;
  v_po_id            text;
  v_first_sub        boolean := true;
  v_cost_pm          integer;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status, q.amount,
         q.line_items, q.domain, q.is_add_seats, q.is_one_off, q.is_renewal, q.is_extension,
         q.renewal_subscription_id, q.billing_cycle
    into v_quote
    from public.quotes q
   where q.id = p_quote_id;
  if not found then return 0; end if;

  v_tenant_id   := v_quote.tenant_id;
  v_customer_id := v_quote.customer_id;
  v_expected    := coalesce(v_quote.amount, 0);

  if v_quote.status <> 'accepted' or v_customer_id is null then return 0; end if;
  if coalesce(v_quote.is_one_off, false) or coalesce(v_quote.is_add_seats, false)
     or coalesce(v_quote.is_renewal, false) or coalesce(v_quote.is_extension, false)
     or v_quote.renewal_subscription_id is not null then
    return 0;
  end if;
  -- R-370: split billing is invoiced period by period; never a whole-term filing here.
  if v_quote.billing_cycle is not null and v_quote.billing_cycle::text <> 'yearly' then return 0; end if;
  if jsonb_typeof(v_quote.line_items) is distinct from 'array' or jsonb_array_length(v_quote.line_items) = 0 then
    return 0;
  end if;
  -- Already filed (paid first, activated on credit, rebuilt) — or this quote renews one.
  if exists (select 1 from public.subscriptions s
              where s.tenant_id = v_tenant_id
                and (s.quote_id = p_quote_id or s.renewal_quote_id = p_quote_id)) then
    return 0;
  end if;
  -- A running trial converts on payment, as before.
  if v_quote.lead_id is not null and exists (
       select 1 from public.leads l
        where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id
          and l.trial_started_at is not null and l.trial_converted_at is null) then
    return 0;
  end if;

  select c.id, c.domain into v_cust
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id;
  if not found then return 0; end if;

  -- ── activate_quote_on_credit's loop (record_payment's rules), line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    perform set_config('app.r2723_quote_line', p_quote_id || '|' || v_line_idx, true);  -- R-2723: this row's quote line, for subscription_term_follows_line
    v_commitment := nullif(btrim(coalesce(v_first_line->>'commitment', '')), '');
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    /* R-1668 / R-1688: the one rule (quote_line_is_subscription). The R-1686 version computed
       `v_is_monthly := v_commitment = 'monthly'` = NULL for a line with no commitment, so
       `continue when not (false or NULL)` did not continue and the builder's One-time line
       ("T-M5 Email migration (one-time)", Q-F588-27-0024) was filed as Annual, MRR 417.
       A line with no commitment and no one-time marker keeps the pay-later meaning (true). */
    v_is_monthly := coalesce(v_commitment = 'monthly', false)
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_is_annual  := not v_is_monthly
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_po_sub_id  := null;
    continue when not (v_is_annual or v_is_monthly);

    v_vendor := null;
    if v_first_line->>'item_id' is not null then
      select i.vendor into v_vendor from public.items i
       where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
    end if;
    if v_vendor is null then
      v_plan_lower := lower(v_plan_name);
      v_vendor := case
        when v_plan_lower like '%google%'    then 'google'::public.vendor
        when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
        when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
        when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
        when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
        else 'other'::public.vendor end;
    end if;

    v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, public.ist_today());
    v_line_amount := round(
      coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
        * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
    )::int;
    v_renew_amount := case
      when nullif(v_first_line->>'renewal_rate', '') is not null
        then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
      else v_line_amount end;

    /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
    v_cost_pm := case
      when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
        then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
      else null end;

    if coalesce((v_first_line->>'bulk')::boolean, false)
       and jsonb_typeof(v_first_line->'domains') = 'array'
       and jsonb_array_length(v_first_line->'domains') > 0 then
      select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
        from jsonb_array_elements(v_first_line->'domains') e;
      if v_bulk_total_seats <= 0 then
        raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
      end if;
      v_bulk_pool := greatest(0, round(
                       coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end
                     ))::int;
      v_running_mrr := 0;
      v_idx := 0;
      v_n := jsonb_array_length(v_first_line->'domains');
      for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
        v_idx := v_idx + 1;
        v_dom := lower(trim(v_d->>'domain'));
        v_dom_seats := coalesce((v_d->>'seats')::int, 0);
        if v_dom = '' then continue; end if;
        if v_idx < v_n then
          v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
        else
          v_dom_mrr := v_bulk_pool - v_running_mrr;
        end if;
        v_running_mrr := v_running_mrr + v_dom_mrr;

        -- Bulk rows carry 0 outstanding, as in activate_quote_on_credit / record_payment.
        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', 0, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end,
          v_cost_pm)
        on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_used_domains := array_append(v_used_domains, v_dom);
        v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      v_own_domain := v_sub_domain is not null;
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := lower(nullif(trim(v_domain), ''));
      end if;
      -- R-829: own domain kept unless this plan already has it.
      if v_sub_domain is not null then
        if v_own_domain then
          if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
            v_sub_domain := null;
          end if;
        elsif v_sub_domain = any(v_used_domains) then
          v_sub_domain := null;
        end if;
      end if;
      insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
        vendor_cost_per_seat_month)
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- The unpaid invoice balance rides on the first subscription (as activate_quote_on_credit
        -- and record_payment's part payment do) → Payments → Subscription dues.
        case when v_first_sub then v_outstanding else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end,
        v_cost_pm)
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      v_first_sub := false;
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
        v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;

    -- Draft PO for the vendor seats, same as record_payment / activate_quote_on_credit.
    if v_po_sub_id is not null then
      select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
        into v_unit_wholesale_pm from public.items
       where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
      if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
        v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * 12, 1)))::int;
      end if;
      v_total_wholesale := v_unit_wholesale_pm * v_po_seats * 12;
      v_po_id := public.next_document_number('purchase_order', v_tenant_id);
      insert into public.purchase_orders (
        id, tenant_id, subscription_id, customer_id, customer_name, domain,
        vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
      ) values (
        v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
        v_po_vendor, v_po_plan, v_po_seats, 12, v_unit_wholesale_pm, v_total_wholesale, 'draft',
        'Auto-created from quote ' || p_quote_id || ' (invoiced before payment)',
        auth.uid()
      );
    end if;
  end loop;
  perform set_config('app.r2723_quote_line', '', true);  -- R-2723

  return v_subs_created;
end;
$$;

comment on function public.subscription_term_follows_line() is
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept. R-2533: on a split-billed row a line date shorter than one term is not copied. R-2543: on a split-billed row a default shorter than the term becomes start + term_months - 1 day. R-2712: a row of a multi-year BULK line is priced from the line (seats x net rate / years = term_amount, mrr = that / 12); a multi-year line''s vendor_cost_per_seat_month is round(line cost / (12 x years)). R-2723: the row''s line is the one the filer names in app.r2723_quote_line (''<quote id>|<line index>''); without it the R-2712 count decides; a 1-year bulk row is priced from the line too (seats x net rate).';

-- The trigger function: nobody calls it directly (as R-2712). The three filers keep their grants
-- (create or replace does not change them).
revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;

commit;
