-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_sales(text,jsonb,boolean)') and prosrc like '%v_round_limit%')
-- deploy-key: r2650zohosalesfxroundoff
--
-- R-2650 (goal G-FY2526, 10 Nov 2026): the FY 2025-26 Zoho SALES import refused 22 of Zoho's own
-- filed invoices on staging Excel with "Taxable, GST and total do not add up" (INV/25-26/0949, 1459,
-- 1498 … 2505; 294 imported).
--
-- WHY: normalise.ts makes taxable = Zoho total − Zoho GST − Zoho's round-off/adjustment, so a ₹
-- invoice is off by at most ₹1 after rounding each figure once. Zoho allows a round-off/adjustment
-- up to ONE UNIT OF THE INVOICE'S CURRENCY: on a USD invoice that is up to $1, i.e. up to ~₹85 once
-- multiplied by the rate. This function refused any gap above ₹1 — so every foreign-currency
-- invoice with a round-off was refused, although Zoho filed it exactly so (G-FY2526 D2: import as
-- filed; D7: filed GST is read-only — never re-computed).
--
-- WHAT CHANGES (only the add-up rule; the rest is R-2536's body unchanged):
--   gap = total − taxable − GST may be up to one unit of the invoice's currency in ₹ (rounded up)
--   + ₹1 for rounding: ₹ invoice 2, USD at 85.12 → 87 (same rule as normalise.ts roundOffLimit).
--   A scan saved after R-2650 also carries roundOff = that gap; it must match exactly.
--   Taxable, GST and total are stored exactly as the scan has them — never re-computed.
--   Still refused: negative taxable / GST, total ₹0, a gap above the limit (with the figures in the
--   reason), a roundOff that does not match. A 0% export with no LUT for its FY is still refused by
--   the LUT trigger (R-2444) — not changed here.
--   Scans saved before R-2650 (staging today) need no new read: the rule uses the payload's
--   currency and fxRate, which every scan has.
create or replace function public.import_zoho_fy_sales(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2499; R-2536: the buyer facts (GSTIN — also when empty —, place of supply, treatment,
     billing address) are written AS FILED in Zoho and the party-snapshot trigger keeps them. */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_code     text;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_due      date;
  v_status   text;
  v_cust     record;
  v_id       text;
  v_lines    jsonb;
  v_taxable  integer;
  v_tax      integer;
  v_amount   integer;
  v_rate     numeric;
  v_fx       numeric;
  v_round    integer;
  v_round_limit integer;
  v_reason   text;
  v_clash    record;
  v_seen     text[] := array[]::text[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_n        integer := 0;
  v_sum_tx   bigint := 0;
  v_sum_tax  bigint := 0;
  v_sum_amt  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing sales needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY sales from Zoho. Ask one of them.'
      using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
     or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There are no invoices to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many invoices in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until,
         coalesce(nullif(btrim(t.doc_code), ''), upper(left(replace(t.id::text, '-', ''), 4)))
    into v_lock, v_code
    from public.tenants t where t.id = v_tenant;

  /* The whole run sits in one block: a dry run raises R2499 at the end, so the batch row, every
     invoice and every trigger's work (activity log, …) roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'invoices', p_fy, auth.uid())
  returning id into v_batch;
  perform set_config('app.zoho_sale_import', 'on', true);

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_invoice_id', ''));
    v_reason := null;
    v_scan := null;
    v_num := v_zid;

    if v_zid = '' or v_zid = any (v_seen) then
      v_reason := 'Listed twice or with no Zoho id.';
    elsif exists (select 1 from public.invoices i where i.tenant_id = v_tenant and i.zoho_invoice_id = v_zid) then
      -- Already here (a rerun) — before any other rule, so a later lock or a Zoho change never
      -- reports a booked sale as "refused".
      v_seen := v_seen || v_zid;
      v_already := v_already + 1;
      continue;
    else
      v_seen := v_seen || v_zid;
      select * into v_scan from public.zoho_fy_scan s
       where s.tenant_id = v_tenant and s.kind = 'invoices' and s.zoho_id = v_zid and s.fy = p_fy;
      if not found or v_scan.payload is null then
        v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
      end if;
    end if;

    if v_reason is null then
      v_p      := v_scan.payload;
      v_num    := btrim(coalesce(v_p->>'number', ''));
      v_status := lower(coalesce(v_p->>'status', ''));
      begin
        v_date    := (v_p->>'date')::date;
        v_due     := nullif(v_p->>'dueDate', '')::date;
        v_taxable := (v_p->>'taxable')::integer;
        v_tax     := (v_p->>'tax')::integer;
        v_amount  := (v_p->>'amount')::integer;
        v_rate    := nullif(v_p->>'taxRate', '')::numeric;
        /* R-2650: Zoho allows a round-off / adjustment up to one unit of the invoice's currency —
           in ₹ that is the rate (rounded up) for a foreign-currency invoice, ₹1 for a ₹ one — plus
           ₹1 for rounding each figure once. Same rule as normalise.ts roundOffLimit. */
        v_fx      := nullif(v_p->>'fxRate', '')::numeric;
        v_round_limit := case when upper(coalesce(nullif(btrim(v_p->>'currency'), ''), 'INR')) = 'INR'
                                or v_fx is null or v_fx <= 0 then 1 else ceil(v_fx)::integer end + 1;
        v_round   := nullif(v_p->>'roundOff', '')::integer;
      exception when others then
        v_reason := 'Its date or amounts could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      if v_status = 'void' then v_reason := 'Void in Zoho — not a sale, not in revenue or GST.';
      elsif v_status = 'draft' then v_reason := 'Draft in Zoho — never issued, not in revenue or GST.';
      elsif jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif v_num = '' or char_length(v_num) > 40 then v_reason := 'The Zoho number is empty or longer than 40 characters.';
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_taxable is null or v_tax is null or v_amount is null
         or v_taxable < 0 or v_tax < 0 or v_amount <= 0 then
        v_reason := 'Taxable, GST and total do not add up.';
      elsif abs(v_amount - v_taxable - v_tax) > v_round_limit then
        -- R-2650: the figures in the reason, so a refusal can be checked against Zoho.
        v_reason := format('Taxable, GST and total do not add up: taxable ₹%s + GST ₹%s is ₹%s away from the total ₹%s (Zoho''s round-off may be up to ₹%s).',
                           v_taxable, v_tax, abs(v_amount - v_taxable - v_tax), v_amount, v_round_limit);
      elsif v_round is not null and v_round <> v_amount - v_taxable - v_tax then
        v_reason := format('Taxable, GST and total do not add up: the round-off on the Zoho read (₹%s) is not total − taxable − GST (₹%s) — read it from Zoho again.',
                           v_round, v_amount - v_taxable - v_tax);
      elsif v_rate is null or v_rate not in (0, 3, 5, 12, 18, 28, 40) or (v_tax > 0 and v_rate = 0) then
        -- invoices.tax_rate is a whole number: a 0.25 / 1.5 % rate is not rounded into it.
        v_reason := format('GST rate %s%% is not one this app stores on an invoice — book it by hand.', coalesce(v_rate::text, '?'));
      end if;
    end if;

    -- The same number on another invoice → skipped (an opening invoice is R-2504's).
    if v_reason is null then
      select i.id, i.document_kind into v_clash from public.invoices i
       where i.tenant_id = v_tenant
         and (upper(i.external_number) = upper(v_num) or upper(i.id) = upper(v_num))
       order by (i.document_kind = 'opening_invoice') desc
       limit 1;
      if found then
        if v_clash.document_kind = 'opening_invoice' then
          v_reason := format('%s is already an opening invoice — the data repair (R-2504) converts it; it is not imported twice.', v_num);
        else
          v_reason := format('%s is already on invoice %s.', v_num, v_clash.id);
        end if;
      end if;
    end if;

    if v_reason is null then
      select c.id, c.name into v_cust from public.customers c
       where c.id = nullif(v_pick->>'customer_id', '')::uuid and c.tenant_id = v_tenant;
      if not found then
        v_reason := format('No customer for "%s" in your company — import customers from Zoho first.', coalesce(v_p->>'customerName', ''));
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    -- Lines as stored on our invoices (name, hsn, qty, rate, amount, item_id when it is this company's).
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'name',         left(coalesce(nullif(btrim(l->>'name'), ''), 'Item'), 300),
             'description',  nullif(left(btrim(coalesce(l->>'description', '')), 1000), ''),
             'hsn',          nullif(left(btrim(coalesce(l->>'hsn', '')), 12), ''),
             'qty',          coalesce((l->>'qty')::numeric, 1),
             'rate',         coalesce((l->>'rate')::numeric, 0),
             'amount',       coalesce((l->>'taxable')::integer, 0),
             'item_id',      it.id,
             'zoho_item_id', nullif(l->>'zohoItemId', '')
           )) order by x.ord), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
      left join public.items it
        on it.tenant_id = v_tenant
       and it.id = (case when jsonb_typeof(v_pick->'item_ids') = 'array' then v_pick->'item_ids'->>(x.ord::int - 1) end);

    v_id := v_num;
    /* R-2536: "as filed" only for a scan whose Zoho DETAIL was read (detailed_at) — that is where
       GSTIN / place of supply / treatment / address come from. A row without the detail has them
       EMPTY because they were never read, not because Zoho had none: it keeps the customer
       snapshot as before (never turns a B2B sale into B2C on missing data). */
    perform set_config('app.zoho_sale_party_as_filed', case when v_scan.detailed_at is not null then 'on' else '' end, true);
    if exists (select 1 from public.invoices i where i.id = v_id) then
      v_id := left(v_num, 40) || '-' || v_code;
    end if;

    begin
      insert into public.invoices (
        id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
        invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items,
        customer_gstin, pos_state_code, gst_treatment, billing_address, customer_country, currency, fx_rate,
        external_number, zoho_invoice_id, sale_import_batch_id)
      values (
        v_id, v_tenant, v_cust.id, v_cust.name, v_amount, v_amount, 0,
        case when coalesce(v_due, v_date) < public.ist_today() then 'overdue' else 'pending' end::public.invoice_status,
        v_date, coalesce(v_due, v_date), v_taxable, v_tax, v_rate, (v_p->>'head') = 'igst', v_lines,
        nullif(upper(btrim(coalesce(v_p->>'gstin', ''))), ''),
        nullif(btrim(coalesce(v_p->>'posStateCode', '')), ''),
        nullif(v_p->>'appGstTreatment', ''),
        nullif(left(btrim(coalesce(v_p->>'billingAddress', '')), 500), ''),
        nullif(left(btrim(coalesce(v_p->>'billingCountry', '')), 60), ''),
        nullif(upper(btrim(coalesce(v_p->>'currency', ''))), 'INR'),
        case when upper(coalesce(v_p->>'currency', 'INR')) <> 'INR' then nullif(v_p->>'fxRate', '')::numeric end,
        v_num, v_zid, v_batch);
    exception
      when others then
        v_skipped := v_skipped || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'reason', sqlerrm);
        continue;
    end;

    v_n := v_n + 1;
    v_sum_tx := v_sum_tx + v_taxable;
    v_sum_tax := v_sum_tax + v_tax;
    v_sum_amt := v_sum_amt + v_amount;
    v_done := v_done || jsonb_build_object('zoho_invoice_id', v_zid, 'number', v_num, 'invoice_id', v_id,
      'date', v_date, 'taxable', v_taxable, 'tax', v_tax, 'inter_state', (v_p->>'head') = 'igst');
  end loop;

  perform set_config('app.zoho_sale_import', '', true);
  perform set_config('app.zoho_sale_party_as_filed', '', true);
  update public.zoho_fy_import_batches
       set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
           taxable_total = v_sum_tx, tax_total = v_sum_tax, amount_total = v_sum_amt, skipped = v_skipped
     where id = v_batch;
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (v_tenant, auth.uid(), 'zoho_fy_sales.imported', 'zoho_fy_import_batch', v_batch::text,
            left(format('Imported %s FY %s sales from Zoho (taxable ₹%s, GST ₹%s); %s skipped', v_n, p_fy, v_sum_tx, v_sum_tax, jsonb_array_length(v_skipped)), 120),
            jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already,
                               'skipped', jsonb_array_length(v_skipped), 'taxable', v_sum_tx, 'tax', v_sum_tax, 'amount', v_sum_amt));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2499', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2499' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'skipped', v_skipped, 'done', v_done,
    'taxable', v_sum_tx, 'tax', v_sum_tax, 'amount', v_sum_amt);
end;
$function$;

comment on function public.import_zoho_fy_sales(text, jsonb, boolean) is
  'R-2499 / R-2536 / R-2650: FY sales from Zoho as Zoho''s own invoices (number, date, GST — a total off taxable + GST by Zoho''s round-off, up to one unit of the invoice currency in ₹ + ₹1, is kept as filed; buyer GSTIN, place of supply, treatment and billing address as filed — empty stays empty). Money from zoho_fy_scan (server-read), picks = Zoho id + matched customer / items. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_sales(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_sales(text, jsonb, boolean) to authenticated, service_role;
