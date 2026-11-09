-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.correct_invoice_date(text,date,text)') and prosrc like '%R-2173%')
-- deploy-key: r2173correctinvoicedate
-- 20261109132649_r2173_correct_invoice_date.sql
--
-- R-2173 (9 Nov 2026, p1 money, slice 1): the owner (or accountant) corrects an ISSUED invoice's date while
-- its GST month is not filed yet. Why: 88 staging invoices were dated 29-30 Oct because they were raised
-- before "invoice date = receipt date" reached staging; under CGST s.34 a filed invoice is fixed with a
-- credit note, but while the month is NOT filed the date can still be corrected on the same document.
--
--   correct_invoice_date(p_invoice_id, p_new_date, p_reason) - SECURITY DEFINER, owner/accountant of the
--   invoice's own company (current_tenant_id()). Refuses, with a plain reason and nothing changed, when:
--     * the old OR the new date is GST-filed by R-2621's ONE rule gst_filed_why (GST returns filed up to /
--       books lock / GSTR-1 mark) - a filed return never changes;
--     * the invoice has an IRN (e-invoice) - its date is on the IRP;
--     * it is not an issued sale document (draft / void / opening balance), came from the Zoho import (as filed
--       there), is in a foreign currency (the Rule 34 rate is the invoice date's rate), has a credit or debit
--       note, was sent on the business network or mirrored to a child company's bills (the buyer holds the date);
--     * the new date is in the future, the same as now, or in another financial year - the number series is
--       per FY and the number is the invoice id (R-2632 builds the cross-FY move);
--     * no reason (5+ characters).
--     * the supplier's GST status on the new day differs from the document's (tax invoice vs bill of supply);
--     * the new date is LATER and after money already received against it (that receipt would be an advance).
--   Then invoice_date and due_date move by the same number of days (same payment terms; an unpaid invoice moved
--   earlier keeps at least its old due date - no sudden overdue reminder) under a
--   transaction-local app.invoice_amend_reason (the freeze trigger's reviewed-override path), and ONE
--   activity_log row 'invoice.date_corrected' keeps old -> new and the reason. A post-check proves no other
--   column moved under the override. Signed-in owner/accountant only (no service_role grant). Receipts, TDS rows and bank
--   links keep their own dates. A login still cannot UPDATE invoice_date directly (freeze trigger unchanged).
-- Test: supabase/tests/r2173_correct_invoice_date.test.sql

begin;

create or replace function public.correct_invoice_date(p_invoice_id text, p_new_date date, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  /* R-2173 */
  v_tenant  uuid := public.current_tenant_id();
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_inv     public.invoices;
  v_why     text;
  v_new_due date;
  v_old_fy  text;
  v_new_fy  text;
  v_money   date;
  v_after   jsonb;
  v_before  jsonb;
begin
  if v_tenant is null then
    raise exception 'Sign in to your company to correct an invoice date.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can correct an issued invoice''s date.' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = v_tenant
   for update;
  if v_inv.id is null then
    raise exception 'Invoice % was not found in your company.', p_invoice_id using errcode = '42501';
  end if;

  if p_new_date is null then
    raise exception 'Pick the correct date for invoice %.', v_inv.id using errcode = '22023';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'Write why the date of invoice % is being corrected (at least 5 characters) - it is kept in the log.', v_inv.id
      using errcode = '22023';
  end if;

  if v_inv.status in ('draft', 'void') or not public.invoice_is_sale(v_inv.document_kind) then
    raise exception 'Invoice % is %, not an issued invoice - there is no issued date to correct.',
      v_inv.id, case when v_inv.status = 'draft' then 'a draft (change its date while editing it)'
                     when v_inv.status = 'void' then 'void'
                     else 'an opening balance' end
      using errcode = '22023';
  end if;
  if v_inv.zoho_invoice_id is not null or v_inv.sale_import_batch_id is not null then
    raise exception 'Invoice % was imported from Zoho Books as filed there - correct its date in Zoho, not here.', v_inv.id
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_inv.gst_irn, '')), '') is not null then
    raise exception 'Invoice % has an IRN (e-invoice), so its date is registered on the IRP and cannot be changed here. Cancel the IRN on the IRP within 24 hours, or issue a credit note and a fresh invoice.', v_inv.id
      using errcode = '22023';
  end if;
  if v_inv.fx_rate is not null or coalesce(v_inv.currency, 'INR') <> 'INR' then
    raise exception 'Invoice % is in % at the exchange rate of %, so a new date needs a new rate. Issue a credit note and a fresh invoice instead.',
      v_inv.id, coalesce(v_inv.currency, 'a foreign currency'), to_char(v_inv.invoice_date, 'FMDD Mon YYYY')
      using errcode = '22023';
  end if;
  if exists (select 1 from public.credit_notes c where c.tenant_id = v_tenant and c.invoice_id = v_inv.id)
     or exists (select 1 from public.debit_notes d where d.tenant_id = v_tenant and d.invoice_id = v_inv.id) then
    raise exception 'Invoice % has a credit or debit note against it, which refers to this date in the GST return. Its date cannot be corrected.', v_inv.id
      using errcode = '22023';
  end if;
  if exists (select 1 from public.network_documents n
              where n.seller_tenant_id = v_tenant and n.seller_invoice_id = v_inv.id and n.cancelled_at is null)
     or exists (select 1 from public.vendor_bills b where b.source_tenant_invoice_id = v_inv.id) then
    raise exception 'Invoice % was already sent to your customer''s books (business network), so they hold this date. Correct it with a credit note and a fresh invoice.', v_inv.id
      using errcode = '22023';
  end if;

  if p_new_date = v_inv.invoice_date then
    raise exception 'Invoice % is already dated %.', v_inv.id, to_char(p_new_date, 'FMDD Mon YYYY') using errcode = '22023';
  end if;
  if p_new_date > public.ist_today() then
    raise exception 'An invoice cannot be dated in the future (% is after today).', to_char(p_new_date, 'FMDD Mon YYYY')
      using errcode = '22023';
  end if;

  v_why := public.gst_filed_why(v_tenant, v_inv.invoice_date);
  if v_why is not null then
    raise exception 'GST for % is already filed (%), so invoice % dated % cannot be re-dated. Correct it with a credit note and a fresh invoice.',
      to_char(v_inv.invoice_date, 'FMMon YYYY'), v_why, v_inv.id, to_char(v_inv.invoice_date, 'FMDD Mon YYYY')
      using errcode = '22023';
  end if;
  v_why := public.gst_filed_why(v_tenant, p_new_date);
  if v_why is not null then
    raise exception 'GST for % is already filed (%), so invoice % cannot be moved to %. A filed return is not changed.',
      to_char(p_new_date, 'FMMon YYYY'), v_why, v_inv.id, to_char(p_new_date, 'FMDD Mon YYYY')
      using errcode = '22023';
  end if;

  v_old_fy := public.indian_fiscal_year(v_inv.invoice_date);
  v_new_fy := public.indian_fiscal_year(p_new_date);
  if v_old_fy is distinct from v_new_fy then
    raise exception 'Invoice % is numbered in financial year %; % is in %, which needs a new number from that year''s series. That move is not available yet (R-2632) - pick a date in the same financial year.',
      v_inv.id, v_old_fy, to_char(p_new_date, 'FMDD Mon YYYY'), v_new_fy
      using errcode = '22023';
  end if;

  /* The supplier's GST status on the new day must be the one the document was issued under (a tax
     invoice cannot move to a day the business was not registered, nor a bill of supply into a registered one). */
  if v_inv.supplier_gst_status is not null
     and public.supplier_gst_status(v_tenant, p_new_date) is distinct from v_inv.supplier_gst_status then
    raise exception 'On % your business''s GST status was % - invoice % was issued as %, so it cannot be dated then. Issue a credit note and a fresh document instead.',
      to_char(p_new_date, 'FMDD Mon YYYY'), coalesce(public.supplier_gst_status(v_tenant, p_new_date), 'not known'), v_inv.id, v_inv.supplier_gst_status
      using errcode = '22023';
  end if;

  /* Moving LATER must not pass money already received against it - that receipt would become an
     un-taxed advance (GSTR-1 11A). Earliest of: paid date, first advance adjusted, receipts on the
     invoice or its quote (refunded ones ignored). Moving earlier (towards the receipt) is the usual fix. */
  if p_new_date > v_inv.invoice_date then
    select min(d) into v_money from (
      select v_inv.paid_date as d
      union all select (v_inv.first_advance_at at time zone 'Asia/Kolkata')::date
      union all select (p.received_at at time zone 'Asia/Kolkata')::date
        from public.payments p
       where p.tenant_id = v_tenant and coalesce(p.status, 'received') <> 'refunded'
         and (p.invoice_id = v_inv.id or (v_inv.quote_id is not null and p.quote_id = v_inv.quote_id))
    ) m;
    if v_money is not null and p_new_date > v_money then
      raise exception 'Money against invoice % was received on %, so the invoice cannot be dated after it (%). Pick % or earlier.',
        v_inv.id, to_char(v_money, 'FMDD Mon YYYY'), to_char(p_new_date, 'FMDD Mon YYYY'), to_char(greatest(v_money, v_inv.invoice_date), 'FMDD Mon YYYY')
        using errcode = '22023';
    end if;
  end if;

  /* Same payment terms: the due date moves by the same days. But an UNPAID invoice moved earlier never
     gets a due date earlier than it had (no sudden "overdue" reminder for a customer who was never late). */
  v_new_due := case when v_inv.due_date is null then null
                    else v_inv.due_date + (p_new_date - v_inv.invoice_date) end;
  if v_new_due is not null and v_inv.status <> 'paid' and v_new_due < v_inv.due_date then
    v_new_due := greatest(v_inv.due_date, p_new_date);
  end if;
  if v_new_due is not null and v_new_due < p_new_date then
    v_new_due := p_new_date;
  end if;

  v_before := to_jsonb(v_inv) - array['invoice_date', 'due_date', 'updated_at'];

  perform set_config('app.invoice_amend_reason', 'R-2173 correct_invoice_date: ' || v_reason, true);
  update public.invoices
     set invoice_date = p_new_date,
         due_date     = v_new_due
   where id = v_inv.id and tenant_id = v_tenant;
  perform set_config('app.invoice_amend_reason', '', true);

  /* The amend override is the freeze trigger's general one, so prove only the two dates moved: any other
     column a BEFORE UPDATE trigger might have changed under it undoes the whole call. */
  select to_jsonb(i) - array['invoice_date', 'due_date', 'updated_at'] into v_after from public.invoices i where i.id = v_inv.id;
  if v_after is distinct from v_before then
    raise exception 'Correcting the date of invoice % would also change other fields (%) - nothing was saved.', v_inv.id,
      (select string_agg(k, ', ') from jsonb_object_keys(v_after) k where v_after->k is distinct from v_before->k)
      using errcode = '22023';
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'invoice.date_corrected', 'invoice', v_inv.id,
          'Invoice ' || v_inv.id || ' date corrected ' || to_char(v_inv.invoice_date, 'FMDD Mon YYYY') || ' -> '
            || to_char(p_new_date, 'FMDD Mon YYYY') || ': ' || v_reason,
          jsonb_build_object('invoice_date', jsonb_build_object('old', v_inv.invoice_date, 'new', p_new_date),
                             'due_date', jsonb_build_object('old', v_inv.due_date, 'new', v_new_due),
                             'reason', v_reason));

  return jsonb_build_object('invoice_id', v_inv.id, 'old_date', v_inv.invoice_date, 'new_date', p_new_date,
                            'old_due_date', v_inv.due_date, 'new_due_date', v_new_due);
end;
$function$;

comment on function public.correct_invoice_date(text, date, text) is
  'R-2173: owner/accountant corrects an issued tax invoice''s date (and due date by the same days) inside the same FY while neither month is GST-filed (gst_filed_why); refuses IRN, Zoho-imported, foreign currency, credit/debit noted, network-sent invoices; logs invoice.date_corrected with the reason.';

revoke all on function public.correct_invoice_date(text, date, text) from public, anon;
grant execute on function public.correct_invoice_date(text, date, text) to authenticated;

commit;
