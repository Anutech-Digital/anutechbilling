-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.repair_split_merged_bank_sale(text,jsonb,boolean)') and prosrc like '%R-2518b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.undo_split_merged_bank_sale(uuid,boolean)') and prosrc like '%R-2518b%') and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'bank_sale_split_repairs' and policyname = 'bank_sale_split_repairs_select' and qual like '%accountant%')
-- deploy-key: r2518brepairfypartyguards
--
-- R-2518b (6 Nov 2026, G-RECON): the independent review (v8) of R-2518 said SAFE, with two findings to fix
-- before any real run of the owner-only repair repair_split_merged_bank_sale (20261106043700):
--   MEDIUM 5 — the credit note on the merged invoice is dated today, the new invoices keep the bank date and
--     that year's series: for an older-FY sale taxable value and GST move between financial years.
--     → refused unless the merged invoice AND its bank line are in this financial year (IST).
--   LOW 6 — only the GST rate was compared. → also refused when the place of supply / seller state
--     (CGST+SGST vs IGST), the customer's GSTIN or the GST treatment differ from what the invoice froze.
--   Optional LOW — the backup table (full invoice / receipt rows) was readable by every login of the company.
--     → owner and accountant only.
-- repair_split_merged_bank_sale and undo_split_merged_bank_sale = the R-2518 bodies (20261106043700, their only
-- definition) + these guards (the undo moves documents the same way); nothing else changed.
-- Left (owner's control): tax can still move between MONTHS of this FY — set books_locked_until to the last filed month first.
-- Tests: supabase/tests/r2518b_repair_fy_party_guards.test.sql (+ r2518_zoho_invoice_per_sale.test.sql).

begin;

create or replace function public.repair_split_merged_bank_sale(
  p_invoice_id text,
  p_groups     jsonb,              -- [{external_number, line_ids: [quote line id, …]}, …] — one per Zoho invoice
  p_dry_run    boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_dry     constant text := 'R2518';
  v_caller  uuid;
  v_inv     record;
  v_q       record;
  v_pay     record;
  v_txn     record;
  v_lock    date;
  v_g       jsonb;
  v_ids     text[] := array[]::text[];
  v_all     text[];
  v_num     text;
  v_nums    text[] := array[]::text[];
  v_holder  text;
  v_sales   jsonb := '[]'::jsonb;
  v_lines   jsonb;
  v_plan    jsonb;
  v_back    jsonb;
  v_res     jsonb;
  v_out     jsonb;
  v_rid     uuid;
  v_party   record;
  v_treat   text;
  v_fy_now  text;
begin
  /* R-2518 + R-2518b: OWNER ONLY. Not run by any migration — Pardeep approves each run after the report. */
  v_caller := public.bank_sale_repair_gate();

  select i.* into v_inv from public.invoices i
   where i.id = p_invoice_id and (v_caller is null or i.tenant_id = v_caller) for update;
  if not found then raise exception 'Invoice % was not found in your company.', p_invoice_id using errcode = 'no_data_found'; end if;
  select q.* into v_q from public.quotes q where q.id = v_inv.quote_id and q.tenant_id = v_inv.tenant_id for update;
  if not found or not coalesce(v_q.invoice_on_receipt, false) then
    raise exception 'Invoice % is not a sale booked from a bank receipt — nothing was changed.', p_invoice_id using errcode = 'check_violation';
  end if;
  if v_inv.status not in ('paid', 'pending', 'overdue') then
    raise exception 'Invoice % is % — nothing to split.', p_invoice_id, v_inv.status using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(v_inv.external_number, '')), '') is not null then
    raise exception 'Invoice % already carries Zoho number % — it is one Zoho invoice, not several.', p_invoice_id, v_inv.external_number using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.credit_notes where invoice_id = v_inv.id)
     or exists (select 1 from public.debit_notes where invoice_id = v_inv.id)
     or exists (select 1 from public.tds_receivable where invoice_id = v_inv.id) then
    raise exception 'Invoice % has a credit / debit note or TDS entry — split it by hand.', p_invoice_id using errcode = 'check_violation';
  end if;
  /* R-2518 (review): only the plain shape — the quote's ONE invoice, billed once, at today's GST rule. */
  if v_q.invoice_id is distinct from v_inv.id
     or exists (select 1 from public.invoices o where o.tenant_id = v_q.tenant_id and o.quote_id = v_q.id and o.id <> v_inv.id)
     or exists (select 1 from public.subscription_billings b where b.tenant_id = v_q.tenant_id and b.invoice_id = v_inv.id) then
    raise exception 'Quote % has more than this one invoice (or invoice % is a part of it) — split it by hand.', v_q.id, p_invoice_id using errcode = 'check_violation';
  end if;
  if coalesce(v_q.billing_cycle, 'yearly') in ('monthly', 'quarterly', 'half_yearly') then
    raise exception 'Quote % is billed in parts (%) — split it by hand.', v_q.id, v_q.billing_cycle using errcode = 'check_violation';
  end if;
  if coalesce(v_q.tax_rate, 0) <> (case
       when public.supply_is_zero_rated((select c.country from public.customers c where c.id = v_q.customer_id),
                                        (select c.gst_treatment from public.customers c where c.id = v_q.customer_id)) then 0
       when public.supplier_gst_status(v_q.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
       else 18 end) then
    raise exception 'The GST rate of quote % (% per cent) is not what a new sale would charge today — split it by hand.', v_q.id, v_q.tax_rate
      using errcode = 'check_violation';
  end if;
  if (select count(*) from public.payments p where p.quote_id = v_q.id and p.tenant_id = v_q.tenant_id) <> 1 then
    raise exception 'Quote % has more than one receipt (or none) — split it by hand.', v_q.id using errcode = 'check_violation';
  end if;
  select p.* into v_pay from public.payments p where p.quote_id = v_q.id and p.tenant_id = v_q.tenant_id for update;
  select t.* into v_txn from public.bank_transactions t
   where t.tenant_id = v_q.tenant_id and t.matched_to_type = 'payment' and t.matched_to_id = v_pay.id::text for update;
  if not found then
    raise exception 'Receipt % is not the bank line''s own receipt — split it by hand.', coalesce(v_pay.receipt_voucher_no, v_pay.id::text) using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.payments p where p.tenant_id = v_txn.tenant_id and p.bank_txn_id = v_txn.id and p.id <> v_pay.id)
     or exists (select 1 from public.bank_receipt_round_offs r where r.bank_txn_id = v_txn.id)
     or round(v_txn.credit)::int <> v_pay.amount or v_txn.credit <> round(v_txn.credit) then
    raise exception 'The bank line of % carries more than this one receipt (another receipt, a round-off or paise) — split it by hand.', p_invoice_id using errcode = 'check_violation';
  end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_txn.tenant_id;
  if v_lock is not null and (v_lock >= v_inv.invoice_date or v_lock >= v_txn.txn_date) then
    raise exception 'Books are locked up to % and invoice % (%) / its receipt (%) falls inside. Nothing was changed.',
      to_char(v_lock, 'DD Mon YYYY'), p_invoice_id, to_char(v_inv.invoice_date, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  /* R-2518b (review v8, MEDIUM 5): the credit note on the merged invoice is dated TODAY (issue_credit_note_core)
     while the new invoices keep the bank date and that year's number series. Across a financial-year end that
     moves taxable value and GST between years (old year +, this year −). So only a sale of THIS financial
     year (IST) — both the merged invoice and its bank line. */
  v_fy_now := public.indian_fiscal_year(public.ist_today());
  if public.indian_fiscal_year(v_inv.invoice_date) <> v_fy_now or public.indian_fiscal_year(v_txn.txn_date) <> v_fy_now then
    raise exception 'Invoice % (%) / its bank line (%) is in financial year %, but today is in %: the credit note would be dated today while the new invoices keep the old date, so taxable value and GST would move between financial years. Split it by hand.',
      p_invoice_id, to_char(v_inv.invoice_date, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY'),
      public.indian_fiscal_year(v_inv.invoice_date), v_fy_now
      using errcode = 'check_violation';
  end if;
  /* R-2518b (review v8, LOW 6): the new invoices take the party facts as they are NOW (tg_invoice_snapshot_parties).
     Refuse when they differ from what the merged invoice froze: place of supply / seller state (CGST+SGST vs
     IGST), our GSTIN and the customer's (B2B vs B2C, GSTR-1 party) and the GST treatment (SEZ = IGST). */
  select * into v_party from public.invoice_party_snapshot(v_inv.tenant_id, v_inv.customer_id);
  if v_party.pos_state_code is distinct from v_inv.pos_state_code or v_party.seller_state_code is distinct from v_inv.seller_state_code then
    raise exception 'The place of supply of invoice % has changed since the sale (customer state % → %, our state % → %) — CGST+SGST vs IGST would change. Split it by hand.',
      p_invoice_id, coalesce(v_inv.pos_state_code, '-'), coalesce(v_party.pos_state_code, '-'),
      coalesce(v_inv.seller_state_code, '-'), coalesce(v_party.seller_state_code, '-')
      using errcode = 'check_violation';
  end if;
  if v_party.seller_gstin is distinct from nullif(upper(btrim(coalesce(v_inv.seller_gstin, ''))), '') then
    raise exception 'Our GSTIN on invoice % (%) is not the company''s GSTIN now (%) — the new invoices would be under another registration. Split it by hand.',
      p_invoice_id, coalesce(v_inv.seller_gstin, 'none'), coalesce(v_party.seller_gstin, 'none')
      using errcode = 'check_violation';
  end if;
  if v_party.customer_gstin is distinct from nullif(upper(btrim(coalesce(v_inv.customer_gstin, ''))), '') then
    raise exception 'The customer GSTIN on invoice % (%) is not the customer''s GSTIN now (%). Split it by hand.',
      p_invoice_id, coalesce(v_inv.customer_gstin, 'none'), coalesce(v_party.customer_gstin, 'none')
      using errcode = 'check_violation';
  end if;
  select c.gst_treatment into v_treat from public.customers c where c.id = v_inv.customer_id and c.tenant_id = v_inv.tenant_id;
  /* An invoice from before R-1736 (22 Oct) froze no treatment: then refuse only a move to SEZ (always IGST). */
  if v_treat is distinct from v_inv.gst_treatment
     and (v_inv.gst_treatment is not null or v_treat in ('sez_with_payment', 'sez_without_payment')) then
    raise exception 'The GST treatment of invoice % (%) is not the customer''s now (%). Split it by hand.', p_invoice_id, v_inv.gst_treatment, coalesce(v_treat, 'none')
      using errcode = 'check_violation';
  end if;

  /* The groups: ≥ 2, each a Zoho number + its lines; every line of the quote in exactly one group. */
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) < 2 or jsonb_array_length(p_groups) > 20 then
    raise exception 'Give 2 to 20 groups — one per Zoho invoice.' using errcode = '22023';
  end if;
  select array_agg(li->>'id' order by li->>'id') into v_all
    from jsonb_array_elements(case when jsonb_typeof(v_q.line_items) = 'array' then v_q.line_items else '[]'::jsonb end) li;
  for v_g in select value from jsonb_array_elements(p_groups) loop
    v_num := public.zoho_external_number_clean(v_g->>'external_number');
    if v_num is null then raise exception 'Every group needs its Zoho invoice number.' using errcode = '22023'; end if;
    if upper(v_num) = any(v_nums) then raise exception 'Zoho invoice % is in two groups.', v_num using errcode = '22023'; end if;
    v_nums := v_nums || upper(v_num);
    v_holder := public.invoice_external_number_holder(v_inv.tenant_id, v_num, null);
    if v_holder is not null then
      raise exception 'Zoho invoice % is already in the app as %. Nothing was changed.', v_num, v_holder using errcode = 'unique_violation';
    end if;
    if jsonb_typeof(v_g->'line_ids') is distinct from 'array' or jsonb_array_length(v_g->'line_ids') = 0 then
      raise exception 'Group % has no lines.', v_num using errcode = '22023';
    end if;
    v_ids := v_ids || array(select jsonb_array_elements_text(v_g->'line_ids'));
    select jsonb_agg(li order by ord) into v_lines
      from jsonb_array_elements(v_q.line_items) with ordinality as t(li, ord)
     where li->>'id' in (select jsonb_array_elements_text(v_g->'line_ids'));
    v_lines := public.bank_sale_lines_from_quote(v_lines);
    v_sales := v_sales || jsonb_build_object(
      'lines', v_lines, 'billing_cycle', v_q.billing_cycle, 'create_subscription', false,
      'external_number', v_num, 'amount', public.bank_sale_lines_total(v_lines, v_q.tax_rate));
  end loop;
  if (select array_agg(x order by x) from unnest(v_ids) x) is distinct from v_all then
    raise exception 'The groups must hold every line of quote % exactly once (lines: %).', v_q.id, array_to_string(v_all, ', ') using errcode = '22023';
  end if;
  v_plan := public.bank_sale_split_amounts(v_sales, round(v_txn.credit)::int);

  v_back := jsonb_build_object(
    'invoice', to_jsonb(v_inv), 'quote', to_jsonb(v_q), 'payment', to_jsonb(v_pay),
    'bank_line', jsonb_build_object('id', v_txn.id, 'txn_date', v_txn.txn_date, 'credit', v_txn.credit, 'reference', v_txn.reference),
    'subscriptions', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.subscriptions s
                                where s.tenant_id = v_q.tenant_id and s.quote_id = v_q.id), '[]'::jsonb));

  begin
    insert into public.bank_sale_split_repairs (tenant_id, invoice_id, quote_id, payment_id, bank_txn_id, groups, backup, created_by)
    values (v_inv.tenant_id, v_inv.id, v_q.id, v_pay.id, v_txn.id, p_groups, v_back, auth.uid())
    returning id into v_rid;

    /* 1. Take the merged sale back (line freed first — the one reconcile path). */
    perform public.reconcile_bank_txn(v_txn.id, null, null, 'manual');
    v_out := public.bank_sale_take_back(v_inv.tenant_id, v_q.id, v_pay.id,
               'Merged bank sale split per Zoho invoice (R-2518)', 'repair_split_merged_bank_sale ' || v_rid::text);
    /* 2. The same line again: one sale per Zoho invoice, each with its Zoho number. */
    v_res := public.reconcile_bank_credit_split(v_txn.id, v_q.customer_id, '[]'::jsonb, v_plan->'sales', v_plan->>'rest');
    v_res := jsonb_build_object('repair_id', v_rid, 'taken_back', v_out, 'booked', v_res, 'dry_run', p_dry_run);
    update public.bank_sale_split_repairs set result = v_res where id = v_rid;
    if p_dry_run then
      raise exception using errcode = 'P0001', message = c_dry;
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm <> c_dry then raise; end if;   -- a real refusal: as it is
  end;
  return v_res;
end;
$$;
revoke all on function public.repair_split_merged_bank_sale(text, jsonb, boolean) from public, anon;
grant execute on function public.repair_split_merged_bank_sale(text, jsonb, boolean) to authenticated, service_role;
comment on function public.repair_split_merged_bank_sale(text, jsonb, boolean) is
  'R-2518 DATA REPAIR (owner only; dry run by default; this financial year only and the same place of supply / GSTIN / GST treatment as at the sale, R-2518b): a bank-receipt sale that merged several Zoho invoices → credit note on it + one sale per Zoho invoice on the same bank line, each with its Zoho number. Backup in bank_sale_split_repairs; undo_split_merged_bank_sale takes it back.';

create or replace function public.undo_split_merged_bank_sale(p_repair_id uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_dry     constant text := 'R2518';
  v_caller  uuid;
  v_r       record;
  v_txn     record;
  v_part    jsonb;
  v_pays    uuid[] := array[]::uuid[];
  v_adv_id  uuid;
  v_adv     public.payments;
  v_open    integer;
  v_taken   jsonb := '[]'::jsonb;
  v_q       jsonb;
  v_lines   jsonb;
  v_plan    jsonb;
  v_res     jsonb;
  v_lock    date;
  v_fy_now  text;
  v_party   record;
  v_orig    jsonb;
  v_treat   text;
begin
  /* R-2518 + R-2518b: OWNER ONLY. */
  v_caller := public.bank_sale_repair_gate();
  select r.* into v_r from public.bank_sale_split_repairs r
   where r.id = p_repair_id and (v_caller is null or r.tenant_id = v_caller) for update;
  if not found then raise exception 'Repair % was not found in your company.', p_repair_id using errcode = 'no_data_found'; end if;
  if v_r.undone_at is not null then
    raise exception 'Repair % was already undone on %.', p_repair_id, to_char(v_r.undone_at, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;
  if v_r.result is null or coalesce((v_r.result->>'dry_run')::boolean, false) then
    raise exception 'Repair % was never booked — nothing to undo.', p_repair_id using errcode = 'check_violation';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = v_r.bank_txn_id and t.tenant_id = v_r.tenant_id for update;
  if not found then raise exception 'The bank line of repair % is gone — undo it by hand.', p_repair_id; end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_r.tenant_id;
  if v_lock is not null and v_lock >= v_txn.txn_date then
    raise exception 'Books are locked up to % and this receipt (%) falls inside. Nothing was changed.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  /* R-2518b (review v8, MEDIUM 5 — the undo moves documents the same way): credit notes dated today, the
     merged sale booked again at the bank date. Only within the bank line's financial year (IST). */
  v_fy_now := public.indian_fiscal_year(public.ist_today());
  if public.indian_fiscal_year(v_txn.txn_date) <> v_fy_now then
    raise exception 'The bank line of repair % (%) is in financial year %, but today is in %: the credit notes would be dated today while the sale is booked again at the old date, so taxable value and GST would move between financial years. Undo it by hand.',
      p_repair_id, to_char(v_txn.txn_date, 'DD Mon YYYY'), public.indian_fiscal_year(v_txn.txn_date), v_fy_now
      using errcode = 'check_violation';
  end if;
  /* R-2518b (LOW 6): the sale booked again takes today's party facts — they must be the merged invoice's. */
  v_orig := v_r.backup->'invoice';
  select * into v_party from public.invoice_party_snapshot(v_r.tenant_id, (v_orig->>'customer_id')::uuid);
  select c.gst_treatment into v_treat from public.customers c where c.id = (v_orig->>'customer_id')::uuid and c.tenant_id = v_r.tenant_id;
  if v_party.pos_state_code is distinct from v_orig->>'pos_state_code' or v_party.seller_state_code is distinct from v_orig->>'seller_state_code'
     or v_party.seller_gstin is distinct from nullif(upper(btrim(coalesce(v_orig->>'seller_gstin', ''))), '')
     or v_party.customer_gstin is distinct from nullif(upper(btrim(coalesce(v_orig->>'customer_gstin', ''))), '')
     or (v_treat is distinct from v_orig->>'gst_treatment'
         and (v_orig->>'gst_treatment' is not null or v_treat in ('sez_with_payment', 'sez_without_payment'))) then
    raise exception 'The place of supply, a GSTIN or the GST treatment has changed since invoice % — undo repair % by hand.', v_orig->>'id', p_repair_id
      using errcode = 'check_violation';
  end if;

  /* What the repair booked: each new sale's receipt (+ an advance) — still exactly that on the line. */
  for v_part in select value from jsonb_array_elements(coalesce(v_r.result->'booked'->'parts', '[]'::jsonb)) loop
    v_pays := v_pays || (v_part->>'payment_id')::uuid;
    if exists (select 1 from public.credit_notes where invoice_id = v_part->>'invoice_id')
       or exists (select 1 from public.debit_notes where invoice_id = v_part->>'invoice_id')
       or exists (select 1 from public.tds_receivable where invoice_id = v_part->>'invoice_id')
       or (select count(*) from public.payments p where p.quote_id = v_part->>'quote_id') <> 1 then
      raise exception 'Invoice % (from this repair) has changed since (a note, TDS or another receipt) — undo it by hand.', v_part->>'invoice_id'
        using errcode = 'check_violation';
    end if;
  end loop;
  v_adv_id := (select p.id from public.payments p where p.tenant_id = v_r.tenant_id and p.bank_txn_id = v_txn.id
                  and public.bank_advance_payment(p.id) limit 1);
  if exists (select 1 from public.payments p where p.tenant_id = v_r.tenant_id and p.bank_txn_id = v_txn.id
                and p.id <> all(v_pays) and p.id is distinct from v_adv_id)
     or v_txn.matched_to_type is distinct from 'payment' or not (v_txn.matched_to_id::uuid = any(v_pays)) then
    raise exception 'The bank line has changed since the repair — undo it by hand.' using errcode = 'check_violation';
  end if;
  if v_adv_id is not null then
    select * into v_adv from public.payments where id = v_adv_id for update;
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int into v_open
      from public.customer_credits cc where cc.tenant_id = v_r.tenant_id and cc.source_payment_id = v_adv_id;
    if v_open <> v_adv.amount then
      raise exception 'The ₹% advance this repair kept is already used or refunded — undo it by hand.', v_adv.amount using errcode = 'check_violation';
    end if;
  end if;

  begin
    perform public.reconcile_bank_txn(v_txn.id, null, null, 'manual');
    if v_adv_id is not null then
      perform public.delete_payment(v_adv_id);
      update public.quotes
         set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
             payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
       where id = v_adv.quote_id and tenant_id = v_r.tenant_id;
    end if;
    for v_part in select value from jsonb_array_elements(v_r.result->'booked'->'parts') loop
      v_taken := v_taken || public.bank_sale_take_back(v_r.tenant_id, v_part->>'quote_id', (v_part->>'payment_id')::uuid,
                              'Split per Zoho invoice undone (R-2518)', 'undo_split_merged_bank_sale ' || p_repair_id::text);
    end loop;
    /* The original lines again as ONE sale (an issued invoice is never deleted — a new number). */
    v_q := v_r.backup->'quote';
    v_lines := public.bank_sale_lines_from_quote(v_q->'line_items');
    v_plan := public.bank_sale_split_amounts(
                jsonb_build_array(jsonb_build_object('lines', v_lines, 'billing_cycle', v_q->>'billing_cycle', 'create_subscription', false,
                                                     'amount', public.bank_sale_lines_total(v_lines, (v_q->>'tax_rate')::int))),
                round(v_txn.credit)::int);
    v_res := public.reconcile_bank_credit_split(v_txn.id, (v_q->>'customer_id')::uuid, '[]'::jsonb, v_plan->'sales', v_plan->>'rest');
    v_res := jsonb_build_object('repair_id', p_repair_id, 'taken_back', v_taken, 'booked', v_res, 'dry_run', p_dry_run);
    update public.bank_sale_split_repairs set undone_at = now(), undone_by = auth.uid(), undo_result = v_res where id = p_repair_id;
    if p_dry_run then
      raise exception using errcode = 'P0001', message = c_dry;
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm <> c_dry then raise; end if;
  end;
  return v_res;
end;
$$;
revoke all on function public.undo_split_merged_bank_sale(uuid, boolean) from public, anon;
grant execute on function public.undo_split_merged_bank_sale(uuid, boolean) to authenticated, service_role;
comment on function public.undo_split_merged_bank_sale(uuid, boolean) is
  'R-2518 DATA REPAIR undo (owner only; dry run by default; the bank line''s financial year only and the same party facts as the merged invoice, R-2518b): credit notes the per-Zoho sales of a repair and books the original lines on the same bank line again as one sale.';

drop policy if exists bank_sale_split_repairs_select on public.bank_sale_split_repairs;
create policy bank_sale_split_repairs_select on public.bank_sale_split_repairs as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ) and ( select public.current_user_has_role('owner', 'accountant') ));   -- R-2518b

commit;

notify pgrst, 'reload schema';
