-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_sale_park_for_approval(uuid,uuid,jsonb,text)') and prosrc like '%R-2397 tenant gate%')
-- R-2397 CI fix (3 Nov 2026): bank_sale_park_for_approval read public.users by auth.uid() (R-1560 rule b,
-- r1560_definer_catalog_guard red). The requester now comes from current_tenant_id(); nothing else changes.

begin;

create or replace function public.bank_sale_park_for_approval(
  p_txn_id        uuid,
  p_customer_id   uuid,
  p_lines         jsonb,
  p_billing_cycle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2397: internal — called by the reconcile RPCs after their own login / company checks. */
declare
  v_txn   record;
  v_open  record;
  v_sale  jsonb;
  v_qid   text;
  v_by    uuid;
begin
  select t.id, t.tenant_id, t.credit, t.matched_to_type into v_txn
    from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a sale.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* One waiting sale per bank line: a second save would only make a second quote. */
  select q.id, q.approval_status::text as approval_status into v_open
    from public.quotes q
   where q.tenant_id = v_txn.tenant_id and q.approval_bank_txn_id = p_txn_id
     and q.status in ('draft', 'sent', 'viewed', 'accepted')
     and q.approval_status::text in ('pending', 'approved')
     and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting')
   order by q.created_at desc nulls last, q.id desc
   limit 1;
  if found then
    if v_open.approval_status = 'approved' then
      raise exception 'Quote % for this bank line is approved. Pick % under this customer''s open items to record the money.', v_open.id, v_open.id
        using errcode = 'check_violation';
    end if;
    raise exception 'Quote % for this bank line already waits for the owner''s approval. Approve it (Quotes → % → Approve), or reject it to book a different price.', v_open.id, v_open.id
      using errcode = 'check_violation';
  end if;

  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);
  v_qid  := v_sale->>'quote_id';
  /* R-2397 tenant gate: the login is the requester only when it belongs to the line's company
     (current_tenant_id() — R-1560 rule b; no users read by auth.uid()). */
  v_by := case when public.current_tenant_id() is not distinct from v_txn.tenant_id then auth.uid() end;

  update public.quotes
     set approval_status       = 'pending',
         approval_tier         = 'owner',
         approval_requested_by = v_by,
         approval_requested_at = now(),
         below_cost            = true,
         approval_bank_txn_id  = p_txn_id,
         notes = concat_ws(E'\n', nullif(notes, ''),
                   'Below cost — waits for the owner''s approval. The bank line stays unmatched until then.')
   where id = v_qid and tenant_id = v_txn.tenant_id;

  return jsonb_build_object(
    'kind',           'new',
    'needs_approval', true,
    'reconciled',     false,
    'new_quote',      true,
    'quote_id',       v_qid,
    'quote_total',    (v_sale->>'quote_total')::int,
    'tax_rate',       (v_sale->>'tax_rate')::int,
    'reason',         public.bank_sale_below_cost_text(v_qid));
end;
$$;
revoke all on function public.bank_sale_park_for_approval(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.bank_sale_park_for_approval(uuid, uuid, jsonb, text) to service_role;

commit;
