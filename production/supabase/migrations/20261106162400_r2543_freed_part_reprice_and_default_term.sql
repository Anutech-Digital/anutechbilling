-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reprice_and_bill_part(uuid,integer,integer)') and prosrc like '%R-2543%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_term_follows_line()') and prosrc like '%R-2543%')
-- deploy-key: r2543repricebilldefaultterm
-- 20261106162400_r2543_freed_part_reprice_and_default_term.sql
--
-- R-2543 (6 Nov 2026, independent review rv-train3 — train blockers for R-2541 and R-2533).
--
-- ─── 1. reprice_and_bill_part (R-2541 follow-up) ────────────────────────────────────────────
--   R-2541 moved a freed part (its proforma cancelled) to the subscription's current seats × rate
--   with a PostgREST UPDATE, THEN called bill_subscription_instalment. When the bill failed (no
--   proforma number, a refused invoice …) or billed nothing (waiting, request open) the new amount
--   stayed on the part. And the UPDATE checked only invoice_id is null, not "no proforma linked".
--   This function does both in ONE transaction: under the part's row lock it writes p_to only when
--   the part still has no invoice, no quote linked to it (quotes.subscription_billing_id — the
--   same link bill_subscription_instalment reads) and still holds p_from (what the app priced
--   from); then it bills. A bill that raises rolls the reprice back with it; a bill that makes
--   neither a tax invoice nor a proforma ('invoice' / 'request') puts p_from back. The answer is
--   the bill's own jsonb plus 'reprice': applied | restored | invoiced | proforma_linked |
--   amount_changed. The price itself stays in the app (unbilledPartPrice — the term run's rule).
--   Same caller rules as bill_subscription_instalment (R-2527: trust only the login; owner /
--   manager / accountant / billing; the part must be in the caller's company) — checked here
--   too, because this function writes before it calls that one.
--
-- ─── 2. subscription_term_follows_line: the filer's default on a split-billed row ───────────
--   What renewal date does the filer write? record_payment, activate_quote_on_credit,
--   file_invoiced_quote_subscriptions and the recreate route all file term_months 12 (1 for a
--   monthly commitment) with renewal = start + 1 year (+ 1 month) — for EVERY non-monthly
--   commitment, a multi-year one too (3-year is set later through correct_subscription_commitment,
--   which takes an explicit renewal date). So today no filer row is short. But a row inserted from
--   a quote with a longer split-billed term and that default date (start + 1 year on a 36-month
--   quarterly term), after R-2533 dropped a too-short quote-line date, would be refused by
--   trg_subscriptions_zzz_split_term_covers — and the refusal aborts the whole record_payment /
--   reconcile. The R-1445 trigger now lifts such a default to start + term_months − 1 day (the
--   trigger's own rule, the inclusive last day of the term). A date the caller chose itself (not
--   the default shape) is untouched — the guard still refuses it with its message.
--   Body: 20261106143540 (R-2533, the latest definition) + the lift.

begin;

create or replace function public.reprice_and_bill_part(p_billing_id uuid, p_from integer, p_to integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2543: reprice a freed part and bill it in one transaction (R-2541 follow-up). */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_b       record;
  v_note    text;
  v_res     jsonb;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can bill its part'
      using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill a subscription part' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= 0 then
    raise exception 'A part is repriced to a whole-rupee amount above zero (from %, to %)', p_from, p_to using errcode = '22023';
  end if;

  select b.* into v_b from public.subscription_billings b where b.id = p_billing_id for update;
  if not found then
    raise exception 'Billing part % not found', p_billing_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing part % is not in the caller''s company', p_billing_id using errcode = 'insufficient_privilege';
  end if;

  if v_b.invoice_id is not null then
    v_note := 'invoiced';
  elsif exists (select 1 from public.quotes q where q.subscription_billing_id = v_b.id) then
    v_note := 'proforma_linked';
  elsif v_b.taxable_amount is distinct from p_from then
    v_note := 'amount_changed';
  else
    update public.subscription_billings
       set taxable_amount = p_to, updated_at = now()
     where id = v_b.id;
    v_note := 'applied';
  end if;

  v_res := public.bill_subscription_instalment(p_billing_id, false);

  if v_note = 'applied' and coalesce(v_res->>'action', '') not in ('invoice', 'request') then
    update public.subscription_billings
       set taxable_amount = p_from, updated_at = now()
     where id = v_b.id and invoice_id is null;
    v_note := 'restored';
  end if;
  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('reprice', v_note);
end;
$$;

comment on function public.reprice_and_bill_part(uuid, integer, integer) is
  'R-2543: move a freed part from p_from to p_to (only while it has no invoice, no proforma linked and still holds p_from) and bill it in the same transaction; a failed bill rolls the reprice back, a bill that makes no invoice / proforma restores p_from. Answer = bill_subscription_instalment''s jsonb + reprice.';

revoke all on function public.reprice_and_bill_part(uuid, integer, integer) from public, anon;
grant execute on function public.reprice_and_bill_part(uuid, integer, integer) to authenticated, service_role;

-- ─── 2. R-1445 + R-2533 + R-2543 ────────────────────────────────────────────────────────────
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

  <<from_line>>
  begin
    select q.line_items into v_lines
      from public.quotes q
     where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
      exit from_line;
    end if;

    select t.e into v_line
      from jsonb_array_elements(v_lines) with ordinality as t(e, i)
     where jsonb_typeof(t.e) = 'object'
       and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
     order by (nullif(lower(btrim(coalesce(t.e->>'domain', ''))), '')
                 is not distinct from nullif(lower(btrim(coalesce(new.domain, ''))), '')) desc,
              t.i
     limit 1;
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
        new.mrr := round(coalesce(new.mrr, 0)::numeric / v_years)::int;
      end if;
    end if;
  end from_line;

  -- R-2543: the filer's default (start + 1 year / + 1 month) on a split-billed row whose term is
  -- longer than that would be refused by trg_subscriptions_zzz_split_term_covers and abort the
  -- whole payment — lift it to the last day of the term, the guard's own rule.
  if v_cycle_m is not null and v_cycle_m < v_term and new.renewal_date < v_min then
    raise notice 'R-2543: subscription default renewal % is shorter than its %-month term — set to %',
      new.renewal_date, v_term, v_min;
    new.renewal_date := v_min;
  end if;

  return new;
end;
$function$;

comment on function public.subscription_term_follows_line() is
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept. R-2533: on a split-billed row a line date shorter than one term is not copied. R-2543: on a split-billed row a default shorter than the term becomes start + term_months - 1 day.';

revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;

commit;
