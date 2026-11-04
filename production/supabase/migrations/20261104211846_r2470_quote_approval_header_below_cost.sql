-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2470%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_insert_approval_guard()') and prosrc like '%R-2470%')
-- deploy-key: r2470quoteapprovalheaderbelowcost
-- 20261104211846_r2470_quote_approval_header_below_cost
--
-- R-2470 (4 Nov 2026) — independent money review 4, R-2447 F1/F2
-- (Anutech-HQ/drafts/REVIEWS/2026-11-04-money-cards-4.md). Both gaps are older than R-2447 and need a
-- direct table write that RLS (quotes_hierarchy_write) lets a rep make on their own quotes.
--
-- F1. generate_invoice invoices from the quote HEADER (amount → gross, subtotal − subtotal × discount_pct
--     → taxable, tax_rate), not from line_items — but trg_quote_approval_not_by_maker did not fire on
--     those columns. A rep could `update quotes set discount_pct = 45` on an approved quote and the
--     bank-receipt path (bank_credit_pay_item → generate_invoice) invoiced the cut price under the old
--     approval. Now the trigger also fires on amount, subtotal, discount_pct and tax_rate, and on an
--     approved quote (same signer, no re-signing) a header change that favours the customer is treated
--     like a stale line edit (R-2447): back to pending, old verdict cleared, activity_log
--     quote.approval_reset. "Favours the customer" = header discount_pct deeper, amount or subtotal
--     lower, one of them blanked, or ANY tax_rate change (a wrong rate is a wrong invoice either way).
--     Raising the price keeps the approval, the same as isStale() keeps it when a rep improves the deal.
--     Decision (recorded on the card): a lower amount from fewer seats also needs a fresh sign-off — the
--     DB cannot tell a smaller order from a header cut, and money is the side we err on. No RPC writes
--     these header columns on an approved quote (grep of every `update quotes` in migrations).
--     The tier the reset asks for: owner when below cost / already owner / the line rule says so (as
--     R-2447) or the header discount is over 20% (MANAGER_MAX_DISCOUNT_BPS 2000); else manager.
--
-- F2. below_cost (the only input of the R-2213 payment guard tg_payments_quote_approval) was only
--     written by the server that builds the quote; the DB merely refused to CLEAR it. Now, for a LOGIN:
--       • insert (tg_quote_insert_approval_guard, PostgREST / gateway roles only): below_cost :=
--         below_cost OR the lines are below cost;
--       • update of line_items that moves the lines' numbers (discount or margin bps differ — the same
--         test R-2447 uses for staleness): below_cost := below_cost OR the new lines are below cost.
--     "Below cost" = linesBelowCost() of src/lib/quotes/payment-approval.ts = marginBps(lineEconomics)
--     < 0 = public.quote_lines_approval_bps(lines).margin_bps < 0 (R-2447, same maths, pinned by its
--     test). A write that only puts dates on lines (the bank-credit RPCs R-1838/R-2044/R-2095/R-2098)
--     does not move the numbers, so it never flips an old quote mid-receipt. The mark is only ever SET
--     here, never cleared (the app's own value is kept when it already says true). The R-2447 refusal
--     to clear the mark now also uses this measure (OR the R-2397 bank_sale_lines_below_cost one).
--     A below_cost turning true on an approved quote then goes back to the owner, as since R-2447.
--     Code review (R-2420) on the first draft: 'pending' alone stops no money (R-2213 item 4: only
--     below_cost does), so a header cut is ALSO measured as below cost: quote_header_below_cost = the
--     taxable generate_invoice would bill from the header (quote_header_taxable) is under the lines'
--     known cost (Σ qty × cost), ₹ quotes only (a ₹ quote switched to another currency in the same
--     write is still checked in ₹). It is checked on a login's insert, and on a login's update whose
--     lines moved or whose header was cut — whatever the approval status, so moving the status off
--     'approved' in the same write does not let the money through. "Header cut" also covers a change
--     that lowers the GST on the invoice (tax = amount − taxable) and an amount set on a quote that had
--     none.
--
-- Everything earlier is kept: R-2367 (signer = login; makers of the quote family refused), R-2383 /
-- R-2426 (the sole active owner may self-approve at any tier with a 10+ char reason), R-2441 (role per
-- tier incl. rejection; current_user_has_role; tier never lowered in the same write), R-2447 (insert
-- guard; re-signing = signing; stale line edit → pending; below_cost cannot be cleared while below).
-- Service paths (no login / service_role / SECURITY DEFINER callers on insert) are unchanged.
--
-- Test: supabase/tests/r2470_quote_approval_header_below_cost.test.sql
-- (+ r2447_quote_approval_insert_and_money_change, r2441_review_fixes, r2426_sole_owner_any_tier,
--  r2213_payment_needs_quote_approval, r2367_quote_chain_self_approval).

begin;

-- generate_invoice's taxable from the quote header (20261030054246_r2095 :146-151 — keep in step):
-- subtotal − round(subtotal × discount_pct / 100), or, with no subtotal, round(amount × 100 / (100 + rate)).
create or replace function public.quote_header_taxable(p_amount numeric, p_subtotal numeric,
                                                       p_discount_pct numeric, p_tax_rate numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_subtotal is not null then p_subtotal - round(p_subtotal * coalesce(p_discount_pct, 0) / 100.0)
              when p_amount is not null then round(p_amount * 100.0 / (100 + coalesce(p_tax_rate, 18))) end
$$;

revoke all on function public.quote_header_taxable(numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.quote_header_taxable(numeric, numeric, numeric, numeric) to authenticated, service_role;   -- pure maths

-- R-2470: the quote is below cost by its HEADER — the taxable generate_invoice would bill is under the
-- lines' known vendor cost (Σ qty × cost, as lineEconomics totalCost). Only ₹ quotes: a foreign quote's
-- header and costs are not in one currency here. Unknown → false (as linesBelowCost).
create or replace function public.quote_header_below_cost(p_amount numeric, p_subtotal numeric, p_discount_pct numeric,
                                                          p_tax_rate numeric, p_currency text, p_lines jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(upper(coalesce(p_currency, 'INR')) = 'INR'
                  and t.taxable is not null
                  and c.cost > 0
                  and t.taxable < c.cost, false)
    from (select public.quote_header_taxable(p_amount, p_subtotal, p_discount_pct, p_tax_rate) as taxable) t,
         (select coalesce(sum(coalesce(public.quote_line_num(li->'qty'), 0) * coalesce(public.quote_line_num(li->'cost'), 0)), 0) as cost
            from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) li
           where jsonb_typeof(li) = 'object') c
$$;

revoke all on function public.quote_header_below_cost(numeric, numeric, numeric, numeric, text, jsonb) from public, anon;
grant execute on function public.quote_header_below_cost(numeric, numeric, numeric, numeric, text, jsonb) to authenticated, service_role;   -- pure maths

create or replace function public.tg_quote_approval_not_by_maker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_tier  text;
  v_note  text;
  v_owner_tier boolean;
  v_in_company boolean;
  v_old_d integer; v_old_m integer;
  v_new_d integer; v_new_m integer;
  v_stale boolean := false;
  v_lines_changed boolean := new.line_items is distinct from old.line_items;
  v_lines_moved boolean := false;
  v_header_changed boolean := new.amount is distinct from old.amount or new.subtotal is distinct from old.subtotal
                              or new.discount_pct is distinct from old.discount_pct or new.tax_rate is distinct from old.tax_rate;
  v_header_cut boolean := false;
  v_old_taxable numeric; v_new_taxable numeric;
begin
  if v_uid is null then return new; end if;

  /* R-2447 / R-2470: the lines' numbers before and after (quote_lines_approval_bps = lineEconomics). */
  if v_lines_changed then
    select b.discount_bps, b.margin_bps into v_old_d, v_old_m from public.quote_lines_approval_bps(old.line_items) b;
    select b.discount_bps, b.margin_bps into v_new_d, v_new_m from public.quote_lines_approval_bps(new.line_items) b;
    v_lines_moved := v_new_d is distinct from v_old_d or v_new_m is distinct from v_old_m;
  end if;

  /* R-2470 (F1): a header change that favours the customer, by the figures generate_invoice takes from
     the header (gross = amount, taxable = subtotal − subtotal × discount_pct, tax = gross − taxable):
     gross or taxable lower, gross newly set or blanked, subtotal lower or blanked, header discount
     deeper, the tax in the invoice lower, or any tax-rate change. Raising the price keeps it. */
  if v_header_changed then
    v_old_taxable := public.quote_header_taxable(old.amount, old.subtotal, old.discount_pct, old.tax_rate);
    v_new_taxable := public.quote_header_taxable(new.amount, new.subtotal, new.discount_pct, new.tax_rate);
    v_header_cut := coalesce(new.discount_pct, 0) > coalesce(old.discount_pct, 0)
                 or new.tax_rate is distinct from old.tax_rate
                 or (new.amount is null) <> (old.amount is null)
                 or new.amount < old.amount
                 or (old.subtotal is not null and (new.subtotal is null or new.subtotal < old.subtotal))
                 or v_new_taxable < v_old_taxable
                 or (new.amount - v_new_taxable) < (old.amount - v_old_taxable);
    v_header_cut := coalesce(v_header_cut, false);
  end if;

  /* R-2470 (F2): a login's write that moves the price sets the below-cost mark when the quote is below
     cost — by its lines (linesBelowCost = marginBps < 0) or by the header the invoice is made from
     (quote_header_below_cost). The R-2213 payment guard reads only this mark, whatever the approval
     status. Only ever set here, never cleared; a date-only line write moves nothing. */
  if (v_lines_moved and v_new_m is not null and v_new_m < 0)
     or ((v_lines_moved or v_header_cut)
         and public.quote_header_below_cost(new.amount, new.subtotal, new.discount_pct, new.tax_rate,
                                            /* a ₹ quote switched to another currency in the same write is still checked in ₹ */
                                            case when upper(coalesce(old.currency, 'INR')) = 'INR' then 'INR' else new.currency end,
                                            new.line_items)) then
    new.below_cost := true;
  end if;

  /* R-2447: the below-cost mark (R-2213 money guard) is not taken off by a login while the lines ARE
     below cost (bank_sale_lines_below_cost = linesBelowCost; R-2470: or marginBps of the lines < 0) —
     the owner approves the quote, or the price is raised first. */
  if coalesce(old.below_cost, false) and not coalesce(new.below_cost, false)
     and (public.bank_sale_lines_below_cost(new.line_items)
          or coalesce(case when v_lines_changed then v_new_m < 0
                           else (select b.margin_bps < 0 from public.quote_lines_approval_bps(new.line_items) b) end, false)) then
    raise exception 'Quote % is below cost — that mark cannot be removed while the price is under cost. The owner approves it, or raise the price first.', new.id
      using errcode = '42501';
  end if;

  /* R-2447: an approved quote that stays approved under the same signer. */
  if old.approval_status::text = 'approved' and new.approval_status::text = 'approved'
     and new.approved_by is not distinct from old.approved_by then
    if new.approved_discount_bps is not distinct from old.approved_discount_bps
       and new.approved_margin_bps is not distinct from old.approved_margin_bps
       and new.approval_tier is not distinct from old.approval_tier
       and new.approved_at is not distinct from old.approved_at then
      /* No re-signing. Below cost now, or a line edit that makes the approval stale (isStale in
         lib/quotes/approval.ts) → it needs a fresh approval. */
      if v_lines_moved then
        v_stale := (old.approved_discount_bps is not null and v_new_d is not null and v_new_d > old.approved_discount_bps)
                or (old.approved_margin_bps is not null and v_new_m is not null and v_new_m < old.approved_margin_bps)
                or (old.approved_margin_bps is not null and v_new_m is null)
                or (old.approved_discount_bps is null and v_new_d is not null and v_new_d > 1000)   -- AUTO_APPROVE_DISCOUNT_BPS
                or (old.approved_margin_bps is null and v_new_m is not null and v_new_m < 1200);    -- OWNER_MARGIN_FLOOR_BPS
      end if;
      /* R-2470 (F1): a header cut (v_header_cut, above) is a stale edit too. */
      if v_stale or v_header_cut or (coalesce(new.below_cost, false) and not coalesce(old.below_cost, false)) then
        new.approval_status := 'pending';
        /* the tier the NEW numbers need (requiredApproval): owner when below cost, already owner, margin
           unknown / under 12% or discount over 20% (lines, or the header discount — R-2470); else manager. */
        new.approval_tier := case when coalesce(new.below_cost, false) or old.approval_tier::text = 'owner'
                                       or (v_stale and (v_new_m is null or v_new_m < 1200 or coalesce(v_new_d, 0) > 2000))
                                       or coalesce(new.discount_pct, 0) > 20
                                  then 'owner' else 'manager' end;
        new.approval_requested_by := v_uid;
        new.approval_requested_at := now();
        new.approved_by := null;
        new.approved_at := null;
        new.approved_discount_bps := null;
        new.approved_margin_bps := null;
        new.approval_rejection_reason := null;
        new.approval_note := null;
        insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
        values (new.tenant_id, v_uid, 'quote.approval_reset', 'quote', new.id,
                case when v_stale then 'Approval cleared: the lines changed after sign-off'
                     when v_header_cut then 'Approval cleared: the price on the quote changed after sign-off'
                     else 'Approval cleared: the quote is now below cost' end,
                jsonb_build_object('was_approved_by', old.approved_by,
                                   'was_discount_bps', old.approved_discount_bps, 'was_margin_bps', old.approved_margin_bps,
                                   'now_discount_bps', v_new_d, 'now_margin_bps', v_new_m,
                                   'below_cost', coalesce(new.below_cost, false),
                                   'was_amount', old.amount, 'now_amount', new.amount,
                                   'was_subtotal', old.subtotal, 'now_subtotal', new.subtotal,
                                   'was_discount_pct', old.discount_pct, 'now_discount_pct', new.discount_pct,
                                   'was_tax_rate', old.tax_rate, 'now_tax_rate', new.tax_rate));
      end if;
      return new;
    end if;
    /* R-2447 (F1): the signed numbers / tier / approved_at change — that is a signing, checked below. */
  end if;

  /* R-2441: the tier this decision is for — owner when the stored tier is 'owner' before OR after
     this update (no lowering it in the same write), or the quote is below cost (R-2213). */
  v_owner_tier := old.approval_tier::text = 'owner' or new.approval_tier::text = 'owner'
                  or coalesce(new.below_cost, false) or coalesce(old.below_cost, false);
  v_in_company := exists (select 1 from public.users u where u.id = v_uid and u.tenant_id = new.tenant_id);

  /* R-2441: a rejection is a decision too — in the signer's own name, by a role that may decide
     that tier (a sales / billing login cannot reject a teammate's quote in the owner's name). */
  if new.approval_status::text = 'rejected'
     and (old.approval_status::text is distinct from 'rejected' or new.approved_by is distinct from old.approved_by) then
    new.approved_by := v_uid;
    if not (v_in_company and (case when v_owner_tier then public.current_user_has_role('owner')
                                   else public.current_user_has_role('owner', 'manager') end)) then
      raise exception 'Only % can reject % — it is their decision.', case when v_owner_tier then 'the owner' else 'a manager or the owner' end, new.id
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.approval_status::text <> 'approved' then return new; end if;
  /* (R-2447: an approved quote re-saved under the same signer with the same signed numbers already
     returned above — from here on every row is a signing.) */

  /* R-2367: the sign-off is in the signer's own name — a login cannot approve as someone else. */
  new.approved_by := v_uid;

  if v_uid = new.created_by
     or v_uid = new.owner_id
     or v_uid = new.approval_requested_by
     or v_uid = any (public.quote_chain_makers(new.id)) then

    /* R-2426: the company's ONLY active owner may clear their own quote, at any tier, with a
       reason. R-2441: "owner" by the app's own rule (current_user_has_role: active, access not
       ended, MFA when enrolled), of THIS quote's company; another owner counts unless switched
       off or past access_ends_on. */
    v_tier := coalesce(old.approval_tier::text, new.approval_tier::text);   -- for the activity log only; the tier no longer decides

    if not (v_in_company and public.current_user_has_role('owner'))
       or exists (select 1 from public.users u
                   where u.tenant_id = new.tenant_id and u.id <> v_uid
                     and u.is_active is not false
                     and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
                     and u.role::text = 'owner') then
      raise exception 'You cannot approve % — you made, revised or asked approval for this quote or an earlier version of it. Another approver must clear it.', new.id
        using errcode = '42501';
    end if;

    v_note := btrim(coalesce(new.approval_note, ''));
    if char_length(v_note) < 10 then
      raise exception 'You are the only owner of this company, so approving % yourself needs a reason — write why this price is OK (at least 10 characters).', new.id
        using errcode = '23514';
    end if;
    new.approval_note := v_note;

    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (new.tenant_id, v_uid, 'quote.self_approved', 'quote', new.id,
            'Self-approved by sole owner: ' || v_note,
            jsonb_build_object('reason', v_note, 'tier', v_tier,
                               'approved_discount_bps', new.approved_discount_bps,
                               'approved_margin_bps', new.approved_margin_bps));
    return new;
  end if;

  /* R-2441: a non-maker needs the role for the tier (lib/quotes/approval.ts OWNER_APPROVERS /
     MANAGER_APPROVERS). Owner when: the stored tier is 'owner' (before or after), below cost, or
     the numbers being signed are owner-tier by the same matrix as requiredApproval() — margin
     unknown or under 12% (OWNER_MARGIN_FLOOR_BPS 1200), discount over 20%
     (MANAGER_MAX_DISCOUNT_BPS 2000). So lowering the stored tier in an EARLIER update does not
     let a manager sign owner-tier numbers; signing numbers that are not the quote's makes the
     approval stale on screen (isStale) and the quote cannot be sent. */
  if v_owner_tier
     or new.approved_margin_bps is null or new.approved_margin_bps < 1200
     or coalesce(new.approved_discount_bps, 0) > 2000 then
    if not (v_in_company and public.current_user_has_role('owner')) then
      raise exception 'Only the owner can approve % — it needs owner sign-off.', new.id
        using errcode = '42501';
    end if;
  elsif not (v_in_company and public.current_user_has_role('owner', 'manager')) then
    raise exception 'Only a manager or the owner can approve % — ask one of them to clear it.', new.id
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_quote_approval_not_by_maker() from public, anon, authenticated;

comment on function public.tg_quote_approval_not_by_maker() is
  'R-2367/R-2383/R-2426/R-2441/R-2447/R-2470: approved_by = the signer; a maker of the quote family is refused unless they are the company''s ONLY owner (current_user_has_role; other owners counted unless switched off or past access_ends_on) and give a reason (min 10 chars), kept in approval_note and activity_log (quote.self_approved). A non-maker needs the owner role for an owner-tier (before or after) or below-cost quote, else owner or manager. R-2447: on an approved quote, a change of the signed numbers / tier / approved_at is a new signing (role checked); below_cost turning true or a line edit that makes the approval stale (isStale) sends it back to pending (activity_log quote.approval_reset). R-2470: so does a header change that favours the customer (discount_pct up, amount / subtotal down or blanked, any tax_rate change); a login''s line edit that moves the numbers sets below_cost when the lines are below cost.';

drop trigger if exists trg_quote_approval_not_by_maker on public.quotes;
create trigger trg_quote_approval_not_by_maker
  before update of approval_status, approved_by, approved_at, approved_discount_bps, approved_margin_bps,
                   approval_tier, below_cost, line_items, amount, subtotal, discount_pct, tax_rate on public.quotes
  for each row execute function public.tg_quote_approval_not_by_maker();

create or replace function public.tg_quote_insert_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  /* R-2447: only a login's DIRECT insert — PostgREST (authenticated / anon) or the Cloud SQL data
     gateway (app_runtime / app_anon, src/server/db/gateway.ts; same list as R-1903). Inside a SECURITY
     DEFINER function (combine_quotes, R-1527, copies its sources' approval) current_user is the
     function's owner; a service / cron path runs as service_role — both unchanged. */
  if current_user::text not in ('authenticated', 'anon', 'authenticator', 'app_runtime', 'app_anon') then return new; end if;
  if new.approval_status::text in ('approved', 'rejected') then
    raise exception 'A new quote cannot be saved already % — save it first, then ask for approval (Review & decide).', new.approval_status
      using errcode = '42501';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  new.approved_discount_bps := null;
  new.approved_margin_bps := null;
  /* R-2470 (F2): the below-cost mark the R-2213 payment guard reads is set from the lines themselves
     (linesBelowCost = marginBps(lineEconomics) < 0 = quote_lines_approval_bps); a mark the app already
     set is kept. */
  new.below_cost := coalesce(new.below_cost, false)
                    or coalesce((select b.margin_bps < 0 from public.quote_lines_approval_bps(new.line_items) b), false)
                    or public.quote_header_below_cost(new.amount, new.subtotal, new.discount_pct, new.tax_rate,
                                                      new.currency, new.line_items);
  return new;
end
$$;

revoke all on function public.tg_quote_insert_approval_guard() from public, anon, authenticated;

comment on function public.tg_quote_insert_approval_guard() is
  'R-2447/R-2470: a login''s direct insert into quotes cannot be approved / rejected already and keeps no signer or signed numbers; below_cost is set when its lines are below cost (R-2470). SECURITY DEFINER functions (combine_quotes) and service paths are not affected.';

drop trigger if exists trg_quote_insert_approval_guard on public.quotes;
create trigger trg_quote_insert_approval_guard
  before insert on public.quotes
  for each row execute function public.tg_quote_insert_approval_guard();

commit;
