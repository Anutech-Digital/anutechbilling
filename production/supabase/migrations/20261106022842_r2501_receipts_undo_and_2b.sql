-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public._zoho_fy_receipt_bank_line(uuid,uuid,bigint,date,text,uuid)') and prosrc like '%re-review v13%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.remove_zoho_fy_receipts_import(uuid,text)') and prosrc like '%re-review v13%')
-- deploy-key: r2501rereview
--
-- R-2501 re-review (independentReview v13, 6 Nov 2026) — two fixes before the first real receipts import:
--   1. HIGH 2b regression: _zoho_fy_receipt_bank_line ← 20261105192600 (latest). A bank line of the
--      money already reconciled to something else, dated the SAME DAY, refuses the import whatever its
--      narration says (UPI / IMPS lines often carry only a VPA or a number — the reviewer's probe
--      'UPI-9876543210-PAYMENT' was booked twice). Within ±3 days a reconciled line refuses when it
--      names the customer; one carrying Zoho's reference always does. Kept: a FREE line carrying
--      Zoho's reference wins over a same-day reconciled line that does not.
--   2. MEDIUM undo: remove_zoho_fy_receipts_import ← 20261105192600 (latest).
--      - referral commissions its receipts earned (fn_accrue_referral_commission, no FK to payments)
--        are deleted with them; a PAID one (status / paid date / payout line) refuses the undo;
--      - a credit note added to one of its invoices after the import refuses the undo;
--      - LOW: the customer-panel invite the receipts queued (trg_queue_panel_account) is taken back
--        while unsent, made since the import, and the customer has no receipt left.
-- Grants unchanged (create or replace). Test: supabase/tests/r2501_receipts_rereview.test.sql
-- (rolled back; red without this file — the probe books PMT-T).
-- Rollback: re-run the two bodies from 20261105192600_r2501_receipts_import_fixes.sql.

begin;

create or replace function public._zoho_fy_receipt_bank_line(
  p_tenant uuid, p_bank_account_id uuid, p_received_paise bigint, p_received_on date, p_reference text, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 2b / 2c; re-review v13: same-day refusal for any narration). Lines of exactly the money (to the paisa), that account, ±3 days.
     Free = unmatched and on no receipt. Taken = reconciled to something this import did not book. */
  v_ref   text := upper(btrim(coalesce(p_reference, '')));
  v_hits  uuid[];
  v_all   uuid[];
  v_same  uuid[];
  v_taken record;
begin
  select coalesce(array_agg(t.id order by t.txn_date, t.id), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (where t.txn_date = p_received_on), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (
           where char_length(v_ref) >= 6
             and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0), '{}')
    into v_all, v_same, v_hits
    from public.bank_transactions t
   where t.tenant_id = p_tenant
     and t.bank_account_id = p_bank_account_id
     and coalesce(t.credit, 0) > 0
     and round(t.credit * 100)::bigint = p_received_paise
     and t.txn_date between p_received_on - 3 and p_received_on + 3
     and t.matched_to_type is null
     and not exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id);

  /* 2b, always: a line of this money already reconciled to something else. Carrying Zoho's reference →
     refused; the same day → refused unless a free line carries Zoho's reference. */
  select t.id, coalesce(t.matched_to_type, 'split receipt') as matched_to_type, t.txn_date,
         (char_length(v_ref) >= 6 and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0) as ref_hit
    into v_taken
    from public.bank_transactions t
   where t.tenant_id = p_tenant
     and t.bank_account_id = p_bank_account_id
     and coalesce(t.credit, 0) > 0
     and round(t.credit * 100)::bigint = p_received_paise
     and t.txn_date between p_received_on - 3 and p_received_on + 3
     and (t.matched_to_type is not null
          or exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id))
     and not exists (select 1 from public.zoho_fy_receipts r
                      where r.tenant_id = p_tenant
                        and (r.bank_txn_id = t.id or t.matched_to_id = any (r.payment_ids::text[])))
     and ((char_length(v_ref) >= 6 and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0)
          -- re-review (v13): the SAME DAY refuses whatever the narration says — a UPI / IMPS line often
          -- carries only a VPA or a number (the reviewer's probe: 'UPI-9876543210-PAYMENT'); within ±3
          -- days a reconciled line refuses when it names this customer.
          or t.txn_date = p_received_on
          or public._zoho_fy_line_names_customer(p_tenant, p_customer_id, coalesce(t.description, '') || ' ' || coalesce(t.reference, '')))
   order by 4 desc, t.txn_date, t.id
   limit 1;
  if found and (v_taken.ref_hit or cardinality(v_hits) = 0) then
    return jsonb_build_object('txn_id', null, 'taken_txn', v_taken.id, 'taken_as', v_taken.matched_to_type, 'taken_on', v_taken.txn_date);
  end if;

  if cardinality(v_hits) = 1 then
    return jsonb_build_object('txn_id', v_hits[1], 'confidence', 'exact');
  end if;
  /* 2c: the only line, that day, no reference — only when its narration names this customer. */
  if cardinality(v_hits) = 0 and cardinality(v_all) = 1 and cardinality(v_same) = 1
     and exists (select 1 from public.bank_transactions t
                  where t.id = v_same[1]
                    and public._zoho_fy_line_names_customer(p_tenant, p_customer_id, coalesce(t.description, '') || ' ' || coalesce(t.reference, ''))) then
    return jsonb_build_object('txn_id', v_same[1], 'confidence', 'high');
  end if;
  return jsonb_build_object('txn_id', null, 'candidates', cardinality(v_all));
end;
$function$;
revoke all on function public._zoho_fy_receipt_bank_line(uuid, uuid, bigint, date, text, uuid) from public, anon, authenticated;

create or replace function public.remove_zoho_fy_receipts_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 follow-up — mirrors remove_zoho_fy_sales_import (R-2499). OWNER only.
     Re-review v13: a PAID referral commission on its receipts, or a credit note added to one of its
     invoices after the import, refuses it; EARNED commissions and the unsent customer-panel invite the
     receipts queued are taken back with them. */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.zoho_fy_import_batches;
  v_pays   uuid[];
  v_quotes text[];
  v_lines  uuid[];
  v_bad    text;
  v_txn    uuid;
  v_n      integer;
  v_rows   integer;
  v_custs  uuid[];
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can remove an FY receipts import.' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are removing this import (at least 3 characters) — it goes in the activity log.' using errcode = '22023';
  end if;
  select * into v_batch from public.zoho_fy_import_batches
   where id = p_batch_id and tenant_id = v_tenant and kind = 'customerpayments' for update;
  if not found then
    raise exception 'That import was not found. Refresh and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %.', to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  perform 1 from public.zoho_fy_receipts r where r.tenant_id = v_tenant and r.batch_id = p_batch_id for update;
  select coalesce(array_agg(x.pid), '{}'), count(distinct x.zid)::int
    into v_pays, v_rows
    from (select r.zoho_payment_id as zid, unnest(r.payment_ids) as pid
            from public.zoho_fy_receipts r
           where r.tenant_id = v_tenant and r.batch_id = p_batch_id) x;
  perform 1 from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) order by p.id for update;
  /* The bank lines its receipts are on NOW (review: never the stored id alone — it can be stale). */
  select coalesce(array_agg(distinct t.id), '{}') into v_lines
    from public.bank_transactions t
   where t.tenant_id = v_tenant
     and (t.matched_to_id = any (v_pays::text[])
          or t.id in (select p.bank_txn_id from public.payments p
                       where p.tenant_id = v_tenant and p.id = any (v_pays) and p.bank_txn_id is not null));
  perform 1 from public.bank_transactions t where t.id = any (v_lines) order by t.id for update;

  /* Untouched since the import? */
  select string_agg(w, '; ') into v_bad from (
    select format('receipt %s is %s', coalesce(p.receipt_voucher_no, p.id::text), p.status) as w
      from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) and p.status <> 'received'
    union all
    select format('%s receipt(s) are no longer there', cardinality(v_pays) - (select count(*) from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays)))
     where (select count(*) from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays)) <> cardinality(v_pays)
    union all
    select format('TDS on %s is %s', x.invoice_id, x.status)
      from public.tds_receivable x where x.tenant_id = v_tenant and x.payment_id = any (v_pays) and x.status <> 'pending_cert'
    union all
    select format('the advance of ₹%s is %s', c.amount, c.status)
      from public.customer_credits c where c.tenant_id = v_tenant and c.source_payment_id = any (v_pays) and c.status <> 'open'
    union all
    /* a line matched by a person (not by this import), shared with a receipt this import did not make,
       or no longer pointing at this import's receipt — left alone: the undo is refused */
    select format('the bank line of %s was matched by hand', to_char(t.txn_date, 'DD Mon YYYY'))
      from public.bank_transactions t
     where t.id = any (v_lines)
       and (not exists (select 1 from public.zoho_fy_receipts r
                         where r.tenant_id = v_tenant and r.batch_id = p_batch_id
                           and r.bank_txn_id = t.id and r.bank_matched_by_import)
            or exists (select 1 from public.payments p
                        where p.tenant_id = v_tenant and p.bank_txn_id = t.id and not (p.id = any (v_pays)))
            or t.matched_to_type is distinct from 'payment'
            or not (t.matched_to_id = any (v_pays::text[])))
    union all
    /* re-review v13: the partner was paid on one of its receipts */
    select format('a referral commission of ₹%s on receipt %s is %s', c.gross_commission,
                  coalesce((select p.receipt_voucher_no from public.payments p where p.id = c.payment_id), c.payment_id::text), c.status)
      from public.referral_commissions c
     where c.tenant_id = v_tenant and c.payment_id = any (v_pays)
       and (c.status not in ('earned', 'cancelled') or c.pay_txn_id is not null or c.paid_date is not null)
    union all
    /* re-review v13: a credit note on one of its invoices made after the import */
    select format('credit note %s was added to %s after the import', cn.id, cn.invoice_id)
      from public.credit_notes cn
     where cn.tenant_id = v_tenant
       and cn.invoice_id in (select p.invoice_id from public.payments p
                              where p.tenant_id = v_tenant and p.id = any (v_pays) and p.invoice_id is not null)
       and cn.created_at >= v_batch.created_at
    limit 10) z;
  if v_bad is not null then
    raise exception 'This import cannot be removed — it was used since: %. Take that back first, then remove the import.', v_bad using errcode = 'P0001';
  end if;

  /* Un-reconcile the lines this import matched (R-2098's trigger clears payments.bank_txn_id and
     the round-off), then take the rest back. */
  foreach v_txn in array v_lines loop
    perform public.reconcile_bank_txn(v_txn, null, null, null);
  end loop;
  update public.payments set bank_txn_id = null where tenant_id = v_tenant and id = any (v_pays) and bank_txn_id is not null;

  select coalesce(array_agg(distinct p.quote_id), '{}') into v_quotes
    from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) and p.quote_id is not null;

  select coalesce(array_agg(distinct p.customer_id), '{}') into v_custs
    from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) and p.customer_id is not null;

  /* re-review v13: the commissions its receipts earned (none paid — checked above). */
  delete from public.referral_commissions where tenant_id = v_tenant and payment_id = any (v_pays);
  delete from public.tds_receivable where tenant_id = v_tenant and payment_id = any (v_pays);
  delete from public.customer_credits where tenant_id = v_tenant and source_payment_id = any (v_pays);
  delete from public.zoho_fy_receipts where tenant_id = v_tenant and batch_id = p_batch_id;
  delete from public.payments where tenant_id = v_tenant and id = any (v_pays);
  get diagnostics v_n = row_count;
  /* re-review v13: the customer-panel invite these receipts queued (trg_queue_panel_account) — only
     while unsent, made since the import, and the customer has no other receipt left. */
  delete from public.panel_account_outbox o
   where o.tenant_id = v_tenant and o.customer_id = any (v_custs)
     and o.source = 'payment' and o.status in ('pending', 'needs_email') and o.done_at is null and o.dms_user_id is null
     and o.created_at >= v_batch.created_at
     and not exists (select 1 from public.payments p
                      where p.tenant_id = v_tenant and p.customer_id = o.customer_id and p.status = 'received');
  /* The ₹0 "Advance on account" holder quotes this import made (nothing else hangs on them). */
  delete from public.quotes q
   where q.tenant_id = v_tenant and q.id = any (v_quotes) and q.plan = 'Advance on account' and q.amount = 0
     and not exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.quote_id = q.id);

  update public.zoho_fy_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_rows
   where id = p_batch_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_receipts.import_removed', 'zoho_fy_import_batch', p_batch_id::text,
          left(format('Removed FY %s receipts import: %s Zoho payments (%s receipts) — %s', v_batch.fy, v_rows, v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'payments', v_rows, 'receipts', v_n, 'reason', v_reason, 'fy', v_batch.fy));

  return jsonb_build_object('removed', v_rows, 'receipts', v_n, 'batch_id', p_batch_id);
end;
$function$;

comment on function public.remove_zoho_fy_receipts_import(uuid, text) is
  'R-2501 follow-up: takes one FY receipts import batch back while untouched (every receipt received, TDS not certified, advance unused, bank lines matched only by the import). Owner only; un-reconciles its lines; activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_zoho_fy_receipts_import(uuid, text) from public, anon;
grant execute on function public.remove_zoho_fy_receipts_import(uuid, text) to authenticated, service_role;

commit;
