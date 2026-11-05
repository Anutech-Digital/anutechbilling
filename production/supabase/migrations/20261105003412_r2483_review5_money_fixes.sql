-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2483%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_salary_with_owed_back(uuid,uuid,uuid)') and prosrc like '%R-2483%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.release_stale_team_invite(text)') and prosrc like '%R-2483%') and to_regprocedure('public.quote_lines_cost_floor(jsonb,jsonb)') is not null
-- deploy-key: r2483review5moneyfixes
-- 20261105003412_r2483_review5_money_fixes
--
-- R-2483 (5 Nov 2026) — independent money review 5 (Anutech-HQ/drafts/REVIEWS/2026-11-05-money-cards-5.md).
-- Each function below starts from its LATEST body and keeps every earlier fix and marker:
--   tg_quote_approval_not_by_maker  ← 20261105000100_r2470 (R-2367/R-2383/R-2426/R-2441/R-2447/R-2470)
--   reconcile_salary_with_owed_back ← 20261105000500_r2407
--   release_stale_team_invite       ← 20261104090100_r2469 (R-2471/R-2481 changed only the tenant helpers it calls)
--
-- F-1 (p2, R-2470). The below-cost measure took the cost from the line_items the rep writes. One login write
--   "header discount 60% + line cost 0" on an approved quote went back to pending with below_cost = false, and
--   'pending' alone stops no money (R-2213), so a bank receipt invoiced ₹1,29,600 taxable against ₹1,86,000
--   cost (reviewer's Q-1111-27-0001). Choice (recorded on the card): the reviewer's (a), made sticky —
--     • for a login's update, every money measure uses each line's cost floored at the cost that line had
--       before (quote_lines_cost_floor: same line id, else same item_id, else same name — so a line swapped for
--       a new id keeps its cost). A rep can still type a lower cost; it simply is not believed for below-cost;
--       Costs are compared per year (a 'monthly' flex line's cost is per month), in whole rupees;
--     • a login that lowers a known line cost on a quote that is or was signed off (approved before this
--       write, or an approval_reset row names who had approved it) sets below_cost: the owner approves it
--       again before any money (R-2213's single rule, so no new money rule and the screen's "Needs
--       approval" / payment refusal stay one story). Logged as quote.cost_lowered; until a LATER
--       approval_reset proves the quote was approved again, a login cannot take that mark off — so the
--       two-write variant (cost first, header second) fails too;
--     • a login moving an approved quote off 'approved' (not a rejection) is now logged as an
--       approval_reset ("Approval withdrawn") naming the approver — so "un-approve first, then cut the
--       cost" is still a cost cut on a signed quote;
--     • the R-2447 refusal to clear below_cost now also measures the HEADER (quote_header_below_cost, R-2470).
--       Before, a header-cut mark could be removed by the next plain write `below_cost = false` (found while
--       building this card).
--   Not chosen: (b) "pending after a reset waits for money" — it changes Pardeep's R-2213 rule (thin margins
--   and discounts are paid while waiting) for every quote, and its refusal would have to say something other
--   than "below cost". Residual (on the card, follow-up): the cost a rep types is still trusted on a quote
--   that was never signed off (a new quote, a revision) and on a line re-added under a new id AND a new
--   name with no item_id — the root fix is a cost the rep cannot type (catalogue cost by item_id, or a
--   snapshot of line costs at sign-off).
--
-- F-2 (p3, R-2407). reconcile_salary_with_owed_back measured only net − paid_amount; R-885
--   (reconcile_salaries_to_bank_txn) marks salaries 'paid' with paid_amount 0. Now a salary whose paid_status is
--   'paid', or that is reconciled to a line with nothing in paid_amount, is refused as already paid.
--
-- F-3 (p3, R-2469). release_stale_team_invite answers whether an address belongs to a real company, and its
--   30/hour cap lived only in the route. Now the function itself counts each call per login (across all its
--   workspaces) in activity_log (action team_invite.address_checked, written in the caller's workspace; partial
--   index activity_log_invite_check_idx) and refuses the 31st in an hour (54000). The route keeps its own cap
--   in front and now answers 429 when the SQL cap refuses, instead of inviting without the check.
--
-- Test: supabase/tests/r2483_review5_money_fixes.test.sql (+ r2470, r2447, r2407, r2469 tests stay green).

begin;

-- R-2483 (F-1): the lines as the money measures must see them — each line's cost is at least the cost the
-- same line had before (same id; else same item_id; else same name). Lines with no earlier match keep theirs.
create or replace function public.quote_lines_cost_floor(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when jsonb_typeof(p_new) is distinct from 'array' then p_new else (
    select coalesce(jsonb_agg(case when f.floor is not null and f.floor > coalesce(public.quote_line_num(n.li->'cost'), 0)
                                   then n.li || jsonb_build_object('cost', f.floor) else n.li end order by n.ord), '[]'::jsonb)
      from jsonb_array_elements(p_new) with ordinality n(li, ord)
      left join lateral (
        /* cost is per seat per YEAR on an annual line and per MONTH on a 'monthly' (flex) line
           (QuoteLineItem.cost, same unit as rate) — compared per year, floored in the new line's unit.
           Flex costs more per year than annual, so a switch to monthly is never read as a cut; a switch
           from monthly to annual may be (the owner then approves it again — the money side). */
        with o as (
          select x.li, floor(coalesce(public.quote_line_num(x.li->'cost'), 0)
                               * case when x.li->>'commitment' = 'monthly' then 12 else 1 end
                               / case when n.li->>'commitment' = 'monthly' then 12 else 1 end) as c   -- whole ₹: no paisa "cut"
            from jsonb_array_elements(case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end) x(li)
           where jsonb_typeof(x.li) = 'object')
        select case when jsonb_typeof(n.li) <> 'object' then null
                    else coalesce(
                      (select max(o.c) from o where nullif(n.li->>'id', '') is not null and o.li->>'id' = n.li->>'id'),
                      (select max(o.c) from o where nullif(n.li->>'item_id', '') is not null and o.li->>'item_id' = n.li->>'item_id'),
                      (select max(o.c) from o where nullif(btrim(n.li->>'name'), '') is not null
                                                and lower(btrim(o.li->>'name')) = lower(btrim(n.li->>'name')))) end as floor
      ) f on true) end
$$;

revoke all on function public.quote_lines_cost_floor(jsonb, jsonb) from public, anon;
grant execute on function public.quote_lines_cost_floor(jsonb, jsonb) to authenticated, service_role;   -- pure maths

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
  v_floor jsonb := new.line_items;        -- R-2483: the lines with each cost floored at its earlier cost
  v_floor_m integer;
  v_cost_lowered boolean := false;
  v_check_cur text := case when upper(coalesce(old.currency, 'INR')) = 'INR' then 'INR' else new.currency end;
begin
  if v_uid is null then return new; end if;

  /* R-2447 / R-2470: the lines' numbers before and after (quote_lines_approval_bps = lineEconomics). */
  if v_lines_changed then
    select b.discount_bps, b.margin_bps into v_old_d, v_old_m from public.quote_lines_approval_bps(old.line_items) b;
    select b.discount_bps, b.margin_bps into v_new_d, v_new_m from public.quote_lines_approval_bps(new.line_items) b;
    v_lines_moved := v_new_d is distinct from v_old_d or v_new_m is distinct from v_old_m;
    /* R-2483 (F-1): the cost on a line is written by the rep. For the money measures a login's write
       cannot lower it: each line keeps at least the cost it had (same id / item / name). */
    v_floor := public.quote_lines_cost_floor(old.line_items, new.line_items);
    v_cost_lowered := v_floor is distinct from new.line_items;
    if v_cost_lowered then
      select b.margin_bps into v_floor_m from public.quote_lines_approval_bps(v_floor) b;
    else
      v_floor_m := v_new_m;
    end if;
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
     status. Only ever set here, never cleared; a date-only line write moves nothing.
     R-2483 (F-1): measured on the floored lines (v_floor), so zeroing a line's cost in the same write
     does not hide a cut. */
  if (v_lines_moved and v_floor_m is not null and v_floor_m < 0)
     or ((v_lines_moved or v_header_cut)
         and public.quote_header_below_cost(new.amount, new.subtotal, new.discount_pct, new.tax_rate,
                                            /* a ₹ quote switched to another currency in the same write is still checked in ₹ */
                                            v_check_cur, v_floor)) then
    new.below_cost := true;
  end if;

  /* R-2483 (F-1): a login lowered a known line cost on a quote that is or was signed off (approved now,
     or an earlier approval_reset names who had approved it — moving the status off 'approved' first is
     logged too, below) → below cost until the owner approves it again (R-2213: the owner clears it
     before any money). Logged so the mark stays while the quote is not approved — even when a later
     write has the lowered cost as its "before". */
  if v_cost_lowered
     and (old.approval_status::text = 'approved'
          or exists (select 1 from public.activity_log r
                      where r.tenant_id = new.tenant_id and r.entity = 'quote' and r.entity_id = new.id
                        and r.action = 'quote.approval_reset' and r.changes->>'was_approved_by' is not null)) then
    new.below_cost := true;
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (new.tenant_id, v_uid, 'quote.cost_lowered', 'quote', new.id,
            'A line''s cost was lowered after sign-off — the owner approves it again before any money',
            jsonb_build_object('was_lines', old.line_items, 'now_lines', new.line_items));
  end if;

  /* R-2447: the below-cost mark (R-2213 money guard) is not taken off by a login while the lines ARE
     below cost (bank_sale_lines_below_cost = linesBelowCost; R-2470: or marginBps of the lines < 0) —
     the owner approves the quote, or the price is raised first.
     R-2483: also while the HEADER is under cost (quote_header_below_cost — a header-cut mark could be
     taken off by the next plain write), on the floored lines, and while a cost lowered after sign-off
     (quote.cost_lowered) waits for the owner's approval — "waits" = no approval_reset AFTER it that
     names an approver (that row proves the quote was approved again since). */
  if coalesce(old.below_cost, false) and not coalesce(new.below_cost, false) then
    if not v_lines_changed then
      select b.margin_bps into v_floor_m from public.quote_lines_approval_bps(new.line_items) b;
    end if;
    if public.bank_sale_lines_below_cost(new.line_items)
       or coalesce(v_floor_m < 0, false)
       or public.quote_header_below_cost(new.amount, new.subtotal, new.discount_pct, new.tax_rate, v_check_cur, v_floor)
       or (new.approval_status::text is distinct from 'approved'
           and exists (select 1 from public.activity_log c
                        where c.tenant_id = new.tenant_id and c.entity = 'quote' and c.entity_id = new.id
                          and c.action = 'quote.cost_lowered'
                          and not exists (select 1 from public.activity_log r
                                           where r.tenant_id = c.tenant_id and r.entity = 'quote' and r.entity_id = c.entity_id
                                             and r.action = 'quote.approval_reset' and r.created_at > c.created_at
                                             and r.changes->>'was_approved_by' is not null))) then
      raise exception 'Quote % is below cost — that mark cannot be removed while the price is under cost. The owner approves it, or raise the price first.', new.id
        using errcode = '42501';
    end if;
  end if;

  /* R-2483 (F-1): a login moving an approved quote off 'approved' (not a rejection — that is a decision,
     checked below) is logged like a reset, naming who had approved it — so the quote's history keeps
     that it was signed off and a later cost cut is still caught. */
  if old.approval_status::text = 'approved' and new.approval_status::text not in ('approved', 'rejected') then
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (new.tenant_id, v_uid, 'quote.approval_reset', 'quote', new.id,
            'Approval withdrawn: the quote was moved off Approved',
            jsonb_build_object('was_approved_by', old.approved_by, 'withdrawn', true,
                               'was_discount_bps', old.approved_discount_bps, 'was_margin_bps', old.approved_margin_bps));
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
                case when v_cost_lowered then 'Approval cleared: a line''s cost was lowered after sign-off' /* R-2483 */
                     when v_stale then 'Approval cleared: the lines changed after sign-off'
                     when v_header_cut then 'Approval cleared: the price on the quote changed after sign-off'
                     else 'Approval cleared: the quote is now below cost' end,
                jsonb_build_object('was_approved_by', old.approved_by,
                                   'was_discount_bps', old.approved_discount_bps, 'was_margin_bps', old.approved_margin_bps,
                                   'now_discount_bps', v_new_d, 'now_margin_bps', v_new_m,
                                   'below_cost', coalesce(new.below_cost, false),
                                   'was_amount', old.amount, 'now_amount', new.amount,
                                   'was_subtotal', old.subtotal, 'now_subtotal', new.subtotal,
                                   'was_discount_pct', old.discount_pct, 'now_discount_pct', new.discount_pct,
                                   'was_tax_rate', old.tax_rate, 'now_tax_rate', new.tax_rate,
                                   'cost_lowered', v_cost_lowered));   -- R-2483
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
  'R-2367/R-2383/R-2426/R-2441/R-2447/R-2470/R-2483: approved_by = the signer; a maker of the quote family is refused unless they are the company''s ONLY owner (current_user_has_role; other owners counted unless switched off or past access_ends_on) and give a reason (min 10 chars), kept in approval_note and activity_log (quote.self_approved). A non-maker needs the owner role for an owner-tier (before or after) or below-cost quote, else owner or manager. R-2447: on an approved quote, a change of the signed numbers / tier / approved_at is a new signing (role checked); below_cost turning true or a line edit that makes the approval stale (isStale) sends it back to pending (activity_log quote.approval_reset). R-2470: so does a header change that favours the customer (discount_pct up, amount / subtotal down or blanked, any tax_rate change); a login''s line edit that moves the numbers sets below_cost when the lines are below cost. R-2483: a login''s write is measured with each line cost floored at its earlier cost (quote_lines_cost_floor); a cost lowered by a login on an approved quote sets below_cost (activity_log quote.cost_lowered) and that mark stays until approved; the mark is also kept while the header is under cost.';

drop trigger if exists trg_quote_approval_not_by_maker on public.quotes;
create trigger trg_quote_approval_not_by_maker
  before update of approval_status, approved_by, approved_at, approved_discount_bps, approved_margin_bps,
                   approval_tier, below_cost, line_items, amount, subtotal, discount_pct, tax_rate on public.quotes
  for each row execute function public.tg_quote_approval_not_by_maker();

-- ═══ F-2 (R-2407 body, 20261105000500) ═══
create or replace function public.reconcile_salary_with_owed_back(
  p_txn_id            uuid,
  p_salary_id         uuid,
  p_reimbursement_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_sal      public.salary_payments;
  v_emp      public.employees;
  v_reimb    public.reimbursements;
  v_due      integer;
  v_part     integer;
begin
  /* R-2407: same guard + roles as the R-1871 bank choices; fail closed with no company. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can reconcile a salary with money owed back' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A salary payout must be a money-out line.'; end if;

  select * into v_sal from public.salary_payments where id = p_salary_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Salary not found in your company.'; end if;
  select * into v_emp from public.employees where id = v_sal.employee_id and tenant_id = v_tenant;

  select * into v_reimb from public.reimbursements where id = p_reimbursement_id and tenant_id = v_tenant for update;
  if not found then raise exception 'What is owed to the employee was not found in your company.'; end if;
  if v_reimb.status <> 'pending' then
    raise exception 'The ₹% owed to % is already paid (%).', v_reimb.amount, v_reimb.person_name, coalesce(to_char(v_reimb.settled_on, 'DD Mon YYYY'), 'settled');
  end if;
  -- The payable must be the salary's own employee (by id; by name for an old row with no id).
  if not (v_reimb.employee_id = v_sal.employee_id
          or (v_reimb.employee_id is null and lower(trim(v_reimb.person_name)) = lower(trim(coalesce(v_emp.name, ''))))) then
    raise exception 'That ₹% is owed to %, not to %. Pick the salary of the same employee.',
      v_reimb.amount, v_reimb.person_name, coalesce(v_emp.name, 'this employee');
  end if;

  /* R-2483 (F-2): a salary already paid is refused — R-885 (reconcile_salaries_to_bank_txn) marks
     salaries 'paid' and links the line without touching paid_amount, so net − paid_amount alone
     would let this pay it a second time. */
  if v_sal.paid_status = 'paid'
     or (v_sal.reconciled_txn_id is not null and coalesce(v_sal.paid_amount, 0) = 0) then
    raise exception '% · % is already paid (reconciled to another bank line) — pick a salary that is still due.',
      coalesce(v_emp.name, 'This salary'), v_sal.period;
  end if;

  v_due  := v_sal.net - coalesce(v_sal.paid_amount, 0);
  v_part := v_txn.debit - v_reimb.amount;
  if v_part <= 0 then
    raise exception 'This line (₹%) is not more than the ₹% owed — book it as the reimbursement alone.', v_txn.debit, v_reimb.amount;
  end if;
  if v_part > v_due then
    raise exception 'The salary part (₹% = ₹% − ₹% owed back) is more than the ₹% still due on % · %.',
      v_part, v_txn.debit, v_reimb.amount, v_due, coalesce(v_emp.name, 'this salary'), v_sal.period;
  end if;

  -- 1. The salary part pays the salary (no new salary expense — it was booked for its month).
  update public.salary_payments
     set paid_amount = coalesce(paid_amount, 0) + v_part,
         paid_status = case when coalesce(paid_amount, 0) + v_part >= net then 'paid' else 'partial' end,
         reconciled_txn_id = p_txn_id
   where id = v_sal.id and tenant_id = v_tenant;

  -- 2. The rest settles what was owed back (the payable goes to 0).
  update public.reimbursements
     set status = 'settled', settled_on = v_txn.txn_date,
         settled_notes = 'Paid back with ' || coalesce(v_emp.name, 'the employee') || '''s salary ' || v_sal.period
                         || ' · bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
   where id = v_reimb.id and tenant_id = v_tenant;
  if v_reimb.expense_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = v_reimb.expense_id and tenant_id = v_tenant;
  end if;

  -- 3. The line is a split (salary + payable). 'salary' would add the WHOLE debit to the salary.
  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  -- 4. Un-reconcile / delete → the payable is pending again and exactly the salary part is taken
  --    back from the salary (R-1871 trigger, kind 'reimburse' + salary_payment_id).
  insert into public.employee_advance_bank_links
    (tenant_id, bank_txn_id, kind, advance_id, reimbursement_id, amount, salary_payment_id, salary_amount, created_by)
  values (v_tenant, p_txn_id, 'reimburse', null, v_reimb.id, v_reimb.amount, v_sal.id, v_part, auth.uid());

  return jsonb_build_object('salary_id', v_sal.id, 'salary_part', v_part, 'reimbursement_id', v_reimb.id,
                            'owed_back', v_reimb.amount, 'employee', coalesce(v_emp.name, v_reimb.person_name),
                            'salary_left', v_due - v_part);
end;
$$;

revoke all on function public.reconcile_salary_with_owed_back(uuid, uuid, uuid) from public, anon;
grant execute on function public.reconcile_salary_with_owed_back(uuid, uuid, uuid) to authenticated, service_role;

-- ═══ F-3 (R-2469 body, 20261104090100) ═══
-- R-2483: the per-login count reads only these rows (a few per owner per hour).
create index if not exists activity_log_invite_check_idx
  on public.activity_log (user_id, created_at) where action = 'team_invite.address_checked';

create or replace function public.release_stale_team_invite(p_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tid   uuid;
  v_inv   record;
  v_why   text;
  v_uid   uuid := auth.uid();
begin
  /* R-2469: caller must be an active owner who has finished sign-in. */
  v_tid := public.current_tenant_id();
  if v_tid is null or not public.current_user_has_role('owner') then
    raise exception 'Only an active workspace owner can do this.' using errcode = '42501';
  end if;

  /* R-2483 (F-3): the answer says whether an address belongs to a real company, so it is capped
     here and not only in the invite route (a login can call this RPC straight from the browser):
     each call is counted per LOGIN across every workspace it owns (R-2471 memberships), at most 30 an
     hour (the route's INVITE_CHECK_RATE); the row sits in the caller's own workspace. The lock makes
     two parallel calls count one after the other. */
  if v_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('r2483-invite-check:' || v_uid::text, 0));
    if (select count(*) from public.activity_log a
         where a.user_id = v_uid and a.action = 'team_invite.address_checked'
           and a.created_at > now() - interval '1 hour') >= 30 then
      raise exception 'Too many address checks in the last hour. Try again later.' using errcode = '54000';
    end if;
    insert into public.activity_log (tenant_id, user_id, action, entity, label)
    values (v_tid, v_uid, 'team_invite.address_checked', 'team_invite', 'Checked an address before inviting it');
  end if;

  if v_email = '' then
    return 'none';
  end if;

  /* A member of another REAL company stays where they are. A workspace is "real" when it has
     anyone besides this person, or any business record. */
  if exists (
       select 1 from public.users u
        where lower(u.email) = v_email
          and u.tenant_id <> v_tid
          and (exists (select 1 from public.users o
                        where o.tenant_id = u.tenant_id and o.id <> u.id)
               or public.tenant_holds_business_records(u.tenant_id))) then
    return 'member_elsewhere';
  end if;

  select i.id, i.tenant_id, i.accepted_at, i.expires_at
    into v_inv
    from public.team_invites i
   where lower(i.email) = v_email
   for update;

  if not found or v_inv.tenant_id = v_tid then
    return 'none';
  end if;

  if v_inv.accepted_at is null and v_inv.expires_at is not null and v_inv.expires_at <= now() then
    v_why := 'expired';
  elsif v_inv.accepted_at is not null
        and not exists (select 1 from public.users u
                         where u.tenant_id = v_inv.tenant_id and lower(u.email) = v_email) then
    v_why := 'already used';
  elsif not exists (select 1 from public.users u
                     where u.tenant_id = v_inv.tenant_id and lower(coalesce(u.email, '')) <> v_email)
        and not public.tenant_holds_business_records(v_inv.tenant_id) then
    v_why := 'empty workspace';
  end if;

  if v_why is null then
    return 'in_use';
  end if;

  delete from public.team_invites where id = v_inv.id;

  /* Both workspaces get a line; neither names the other, and the caller's line does not say
     what state the other workspace was in (R-721). The owner who lost the invite sees why. */
  insert into public.activity_log (tenant_id, user_id, action, entity, label)
  values (v_tid, auth.uid(), 'stale_invite_released', 'team_invite',
          format('Cleared an old invite for %s from another workspace so it could be invited here', v_email)),
         (v_inv.tenant_id, null, 'stale_invite_released', 'team_invite',
          format('Your invite for %s (%s) was removed because another company invited them', v_email, v_why));

  return 'released';
end;
$$;

comment on function public.release_stale_team_invite(text) is
  'R-2469: before an owner invites an address — member_elsewhere (real company, untouched) | released (another workspace''s expired / used / blank-workspace invite deleted) | in_use | none. Never names the other workspace. R-2483: at most 30 calls an hour per login (activity_log team_invite.address_checked).';

revoke all on function public.release_stale_team_invite(text) from public, anon;
grant execute on function public.release_stale_team_invite(text) to authenticated, service_role;

commit;
