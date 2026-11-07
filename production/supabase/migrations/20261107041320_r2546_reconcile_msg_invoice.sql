-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_to_item(uuid,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2546%')
-- deploy-key: r2546reconcilemsginvoice
--
-- R-2546 (7 Nov 2026, p0 money — R-2542 review note): reconcile_bank_credit_to_item's refusal
-- "A payment with reference % is already recorded on % and reconciled to another bank line" printed
-- the quote id — for a quote-less receipt (a Zoho-imported invoice, R-2466 / R-2542) that is null, so
-- the owner read "already recorded on <NULL>". Now: the quote, else the invoice.
--
-- From 20261103200938_r2430_placeholder_ref_bank_line (latest definition) — that one message changes,
-- and the trusted-server check reads public.current_request_role() instead of auth.role() (the R-2487
-- rule every re-created function follows, as R-2542 did). Same signature: create or replace (grants
-- re-stated).
-- Test: supabase/tests/r2546_reconcile_msg_invoice.test.sql (begin … rollback; red without this file).

begin;

create or replace function public.reconcile_bank_credit_to_item(
  p_txn_id              uuid,
  p_quote_id            text    default null,
  p_invoice_id          text    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_create_subscription boolean default null,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid;
  v_trusted    boolean;
  v_txn        record;
  v_ref        text;
  v_core       jsonb;
  v_pay_id     uuid;
  v_quote_id   text;
begin
  /* §17c fail-closed + R-718 money roles. R-2044: no whole invoice for a part request.
     R-2098: the payment itself is bank_credit_pay_item (shared with the split).
     R-2546: current_request_role() (R-2487 rule — the raw auth.role() list may only shrink). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a quote or invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* The line's UTR is the payment reference (record_payment replays on quote + reference). */
  /* R-2430: a placeholder reference (000000000000000) is not this line's UTR — BANK-<line id> instead;
     but a receipt already on this quote with that placeholder, the same amount and on no bank line
     (typed by hand, or kept from before R-2430) is THIS money: keep its reference so it replays. */
  v_ref := coalesce(
    public.bank_line_kept_receipt_ref(v_txn.tenant_id, v_txn.reference, p_quote_id, p_invoice_id,
                                      v_txn.credit::int + greatest(0, coalesce(p_tds_amount, 0))),
    public.bank_line_payment_reference(v_txn.reference, v_txn.id));
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_txn.credit, v_ref, p_quote_id, p_invoice_id, p_tds_amount, p_tds_rate_pct, p_tds_section,
    p_create_subscription, p_sub_start, p_sub_renewal);
  v_pay_id := (v_core->>'payment_id')::uuid;
  v_quote_id := v_core->>'quote_id';

  /* Already recorded by hand with this UTR: reconcile this line to THAT payment, never a second
     one — unless another bank line already carries it.
     R-2546: a quote-less receipt (Zoho-imported invoice) has no quote — name the invoice, not <NULL>. */
  if coalesce((v_core->>'replay')::boolean, false)
     and exists (select 1 from public.bank_transactions t
                  where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
                    and t.matched_to_type = 'payment' and t.matched_to_id = v_pay_id::text) then
    raise exception 'A payment with reference % is already recorded on % and reconciled to another bank line. Nothing was changed.', v_ref, coalesce(v_quote_id, p_invoice_id)
      using errcode = 'unique_violation';
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, p_invoice_id, v_txn.credit, greatest(0, coalesce(p_tds_amount, 0)));
end;
$$;
revoke all on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) from public, anon;
grant execute on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) to authenticated, service_role;

commit;
