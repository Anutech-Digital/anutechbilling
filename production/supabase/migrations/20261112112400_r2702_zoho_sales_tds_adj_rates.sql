-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_sales(text,jsonb,boolean)') and prosrc like '%v_adj_line%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') and prosrc like '%v_inv_tds%')
-- deploy-key: r2702zohosalestdsadjrates
--
-- R-2702 (goal G-FY2526, 12 Nov 2026, p0 money): the FY 2025-26 Zoho SALES import left out 59 of Zoho's
-- own filed invoices on staging Excel (R-2693 fySalesCheck: TDS on the invoice 36, a Zoho adjustment 16,
-- lines at different GST rates 7) — and with them 61 receipts the receipts import could not place.
-- The facts come from normalise.ts (zoho_fy_scan payload, read on the server); this file only books them.
--
-- (1) TDS ON THE INVOICE. Zoho's total is net of the TDS (taxable + GST − TDS). The SALE is the full value
--     (taxable + GST, as filed in GSTR-1) — the TDS is the customer's deduction, an asset (TDS receivable),
--     never a sale reduction. The scan carries tds (₹) and tdsSection. Here: amount = the full value (as
--     the scan has it), and a TDS that is negative or not below the total is refused.
--     The RECEIPTS import (import_zoho_fy_receipts) carries it to the receipt: on a ₹ payment line where
--     Zoho withheld no TDS (Zoho took it on the invoice instead), when the money + the invoice's TDS clears
--     what is due here (±₹1) and no TDS is booked on that invoice yet, the line's TDS = the invoice's TDS
--     (its section from Zoho, else the receipt's 194J default) — the same tds_receivable row a withheld
--     TDS makes (_record_opening_invoice_payment). A part payment stays money only; the payment that
--     closes the invoice in Zoho carries the TDS. A Zoho payment that DOES withhold TDS is unchanged.
-- (2) A ZOHO ADJUSTMENT (above one unit of its currency): kept as a visible line {kind: "adjustment"} with
--     no GST and no HSN, outside the taxable value; taxable and GST stay Zoho's; the total equals Zoho's.
--     The add-up rule (R-2650) is on what is left after it: |total − taxable − GST − adjustment| ≤ the
--     round-off limit; the scan's adjustment must be its adjustment line's amount. lib/gst/gstr1.ts
--     docHsnLines leaves the line out of the HSN table.
-- (3) LINES AT DIFFERENT GST RATES (0% + 18%): one invoice; each line keeps its own rate in line_items
--     (tax_rate); invoices.tax_rate = the highest (normalise.ts checks Zoho's GST is those rates on those
--     lines). Every line rate must be one this app stores.
-- GST-FILED MONTHS (R-2621): unchanged on purpose — these ARE the invoices Zoho filed (import as filed,
--   G-FY2526 D2/D7): taxable and GST are Zoho's figures, never re-computed, so a filed month gets no GST
--   that was not filed. The books lock still refuses (unchanged).
-- Scans read before R-2702 still carry the old "book it by hand" problem: press Read from Zoho again.
-- Test: supabase/tests/r2702_zoho_sales_tds_adj_rates.test.sql (rolled back; red without this file).
-- Rollback: re-run import_zoho_fy_sales from 20261111154423_r2650 and import_zoho_fy_receipts from
--   20261112064956_r2694 (no data moves).

begin;

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
  /* R-2702: Zoho's adjustment (its own no-GST line), the TDS on the invoice, the lines' own rates. */
  v_adj      integer;
  v_adj_line integer;
  v_inv_tds  integer;
  v_bad_rate text;
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
        /* R-2702: absent on a scan read before R-2702 = none. */
        v_adj     := coalesce(nullif(v_p->>'adjustment', '')::integer, 0);
        v_inv_tds := coalesce(nullif(v_p->>'tds', '')::integer, 0);
        select coalesce(sum((l->>'taxable')::integer), 0)::integer
          into v_adj_line
          from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) l
         where l->>'kind' = 'adjustment';
        select string_agg(distinct l->>'taxPercent', ', ') into v_bad_rate
          from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) l
         where coalesce(l->>'kind', '') <> 'adjustment'
           and nullif(l->>'taxPercent', '') is not null
           and (l->>'taxPercent')::numeric not in (0, 3, 5, 12, 18, 28, 40);
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
      elsif v_adj_line <> v_adj then
        -- R-2702: Zoho's adjustment is exactly its own line (never a second figure that could drift).
        v_reason := format('Zoho''s adjustment ₹%s is not its adjustment line ₹%s — read it from Zoho again.', v_adj, v_adj_line);
      elsif abs(v_amount - v_taxable - v_tax - v_adj) > v_round_limit then
        -- R-2650: the figures in the reason, so a refusal can be checked against Zoho.
        -- R-2702: on what is left after Zoho's adjustment (its own no-GST line).
        v_reason := format('Taxable, GST and total do not add up: taxable ₹%s + GST ₹%s%s is ₹%s away from the total ₹%s (Zoho''s round-off may be up to ₹%s).',
                           v_taxable, v_tax, case when v_adj <> 0 then format(' + adjustment ₹%s', v_adj) else '' end,
                           abs(v_amount - v_taxable - v_tax - v_adj), v_amount, v_round_limit);
      elsif v_inv_tds < 0 or v_inv_tds >= v_amount then
        -- R-2702: the TDS on the invoice is the customer's deduction from the full sale, below it.
        v_reason := format('Zoho''s TDS ₹%s on it is not below the sale ₹%s — read it from Zoho again or book it by hand.', v_inv_tds, v_amount);
      elsif v_inv_tds > 0 and upper(coalesce(nullif(btrim(v_p->>'currency'), ''), 'INR')) <> 'INR' then
        v_reason := 'Zoho has TDS on a foreign-currency invoice — book it by hand.';
      elsif v_bad_rate is not null then
        -- R-2702: each line keeps its own rate — every one must be a rate this app stores.
        v_reason := format('GST rate %s%% on a line is not one this app stores on an invoice — book it by hand.', v_bad_rate);
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
             'zoho_item_id', nullif(l->>'zohoItemId', ''),
             /* R-2702: each line's own GST rate (lines at 0% + 18%); Zoho's adjustment line has none
                and says so (kind "adjustment" — no GST, outside the taxable value, not in HSN). */
             'tax_rate',     case when coalesce(l->>'kind', '') <> 'adjustment' then nullif(l->>'taxPercent', '')::numeric end,
             'kind',         case when l->>'kind' = 'adjustment' then 'adjustment' end
           )) order by x.ord), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(case when jsonb_typeof(v_p->'lines') = 'array' then v_p->'lines' else '[]'::jsonb end) with ordinality x(l, ord)
      left join public.items it
        on it.tenant_id = v_tenant
       and coalesce(l->>'kind', '') <> 'adjustment'
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
      'date', v_date, 'taxable', v_taxable, 'tax', v_tax, 'inter_state', (v_p->>'head') = 'igst',
      'amount', v_amount, 'adjustment', v_adj, 'tds', v_inv_tds);
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
  'R-2499 / R-2536 / R-2650 / R-2702: FY sales from Zoho as Zoho''s own invoices (number, date, GST — a total off taxable + GST by Zoho''s round-off, up to one unit of the invoice currency in ₹ + ₹1, is kept as filed; R-2702: Zoho''s adjustment is its own no-GST line, TDS on the invoice leaves the sale at full value (the receipts import books the TDS), each line keeps its own GST rate; buyer GSTIN, place of supply, treatment and billing address as filed — empty stays empty). Money from zoho_fy_scan (server-read), picks = Zoho id + matched customer / items. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_sales(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_sales(text, jsonb, boolean) to authenticated, service_role;

create or replace function public.import_zoho_fy_receipts(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 6 Nov: vouchers, 2b / 2c matching safety, round-off, TDS gross)
     R-2565: Razorpay fee (Zoho bank_charges) booked as the Bank Charges expense EXP-RZPFEE-<receipt>
     R-2694 foreign receipt: USD (any foreign) payments — ₹ at the invoices' rates, exchange gain / loss
     and the remitting bank's charges as EXP-ZFXD / EXP-ZFXC-<first receipt id> */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_acct     uuid;
  v_paise    bigint;
  v_excess   integer;
  v_ref      text;
  v_method   text;
  v_line     jsonb;
  v_inv      record;
  v_cust     uuid;
  v_settle   integer;
  v_tds      integer;
  v_cash     integer;
  v_due      integer;
  /* R-2702: TDS Zoho shows on the INVOICE (its sale scan), carried to the payment that closes it. */
  v_inv_tds  integer;
  v_inv_sec  text;
  v_alloc    jsonb;
  v_sum_cash integer;
  v_sum_tds  integer;
  v_r        jsonb;
  v_adv      jsonb;
  v_pays     uuid[];
  v_bank     jsonb;
  v_txn      uuid;
  v_done_row public.zoho_fy_receipts;
  v_reason   text;
  v_hand     timestamptz;
  v_seen     text[] := array[]::text[];
  v_used     uuid[] := array[]::uuid[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_banked   integer := 0;
  v_later    integer := 0;
  v_n        integer := 0;
  v_tot_cash bigint := 0;
  v_tot_tds  bigint := 0;
  v_tot_adv  bigint := 0;
  /* R-2565 */
  v_fee      integer;
  v_fee_gst  integer;
  v_fee_pay  uuid;
  v_fee_amt  integer;
  v_fee_exp  text;
  v_vendor   record;
  v_own_st   text;
  v_v_st     text;
  v_igst     integer;
  v_cgst     integer;
  v_sgst     integer;
  v_fees     integer := 0;
  v_tot_fee  bigint := 0;
  v_via      boolean;
  v_fee_ctx  boolean := false;
  /* R-2694 foreign receipt (USD …): Zoho's own figures in its currency, the ₹ at the invoices' rates */
  v_cur      text;
  v_zrate    numeric;
  v_famt     numeric;
  v_fchg     numeric;
  v_flines   jsonb;
  v_fline    numeric;
  v_fsum     numeric;
  v_fall     numeric;
  v_icur     text;
  v_part     integer;
  v_fxd      integer;
  v_fxc      integer;
  v_fxd_id   text;
  v_fxc_id   text;
  v_fx_n     integer := 0;
  v_tot_fxd  bigint := 0;
  v_tot_fxc  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing receipts needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY receipts from Zoho. Ask one of them.'
      using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
     or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There are no payments to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2501 at the end, so every receipt, TDS row, advance, bank match,
     the batch row and the log roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'customerpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_payment_id', ''));
    v_reason := null;
    v_num := v_zid;
    v_scan := null;
    v_fee := 0;
    v_fee_gst := 0;
    v_via := false;
    v_cur := null;
    v_zrate := null;
    v_famt := null;
    v_fchg := 0;
    v_flines := null;
    v_fsum := 0;
    v_fall := 0;
    v_fxd := 0;
    v_fxc := 0;

    if v_zid = '' or v_zid = any (v_seen) then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', 'Listed twice or with no Zoho id.');
      continue;
    end if;
    v_seen := v_seen || v_zid;

    /* Already booked (a rerun) — first, so a later lock or Zoho change never calls it "refused".
       Review: bank_txn_id follows the books — the line its receipts are on NOW (matched by hand, or
       un-reconciled since) — and a receipt on no line is matched if its line has come in since. */
    select * into v_done_row from public.zoho_fy_receipts r where r.tenant_id = v_tenant and r.zoho_payment_id = v_zid for update;
    if found then
      v_already := v_already + 1;
      select coalesce(
               (select p.bank_txn_id from public.payments p
                 where p.tenant_id = v_tenant and p.id = any (v_done_row.payment_ids) and p.bank_txn_id is not null limit 1),
               (select t.id from public.bank_transactions t
                 where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                   and t.matched_to_id = any (v_done_row.payment_ids::text[]) limit 1))
        into v_txn;
      if v_txn is distinct from v_done_row.bank_txn_id then
        update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = case when v_txn is not null then now() end,
                                           bank_matched_by_import = false
         where tenant_id = v_tenant and zoho_payment_id = v_zid;
      end if;
      /* R-2565: a Razorpay fee payment reaches the bank inside a Razorpay settlement — matched there
         (Banking → Reconcile → Razorpay settlement, R-2099), never alone by its own amount. */
      if v_txn is null and not v_done_row.via_settlement then
        v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_done_row.bank_account_id, v_done_row.received_paise,
                                                    v_done_row.received_on, v_done_row.reference, v_done_row.customer_id);
        v_txn := nullif(v_bank->>'txn_id', '')::uuid;
        if v_txn is not null and not (v_txn = any (v_used)) then
          begin
            if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_done_row.payment_ids, v_bank->>'confidence') then
              update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now(), bank_matched_by_import = true
               where tenant_id = v_tenant and zoho_payment_id = v_zid;
              v_used := v_used || v_txn;
              v_banked := v_banked + 1;
              v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_done_row.reference,
                                                     'bank_txn_id', v_txn, 'matched_later', true);
            end if;
          exception when others then
            v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_zid,
              'reason', 'Booked earlier; its bank line could not be matched: ' || sqlerrm);
          end;
        end if;
      end if;
      continue;
    end if;

    select * into v_scan from public.zoho_fy_scan s
     where s.tenant_id = v_tenant and s.kind = 'customerpayments' and s.zoho_id = v_zid and s.fy = p_fy;
    if not found or v_scan.payload is null then
      v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
    else
      v_p   := v_scan.payload;
      v_num := btrim(coalesce(v_p->>'number', v_zid));
      begin
        v_date   := (v_p->>'date')::date;
        v_paise  := (v_p->>'receivedPaise')::bigint;
        v_excess := coalesce((v_p->>'excess')::integer, 0);
        v_acct   := nullif(v_pick->>'bank_account_id', '')::uuid;
        v_fee    := coalesce((v_p->>'fee')::integer, 0);
        v_fee_gst := coalesce((v_p->>'feeGst')::integer, 0);
        v_via    := coalesce((v_p->>'viaSettlement')::boolean, false) or v_fee > 0;
        /* R-2694 foreign receipt: the payment's own currency figures (facts from R-2694's normaliser):
           foreignAmount, fxRate (Zoho's ₹ per unit), foreignCharges (Zoho's bank_charges, same currency),
           foreignLines [{zohoInvoiceId, foreign}] (applied per invoice; their sum vs the money = the unused
           part — never trusted from a field of its own). What reaches the bank — and so finds its line — is
           (money − charges) × Zoho's rate, worked out HERE. Every cast is inside this handler (review). */
        v_cur := upper(nullif(btrim(coalesce(v_p->>'currency', '')), ''));
        if v_cur = 'INR' then v_cur := null; end if;
        if v_cur is not null then
          v_zrate  := nullif(v_p->>'fxRate', '')::numeric;
          v_famt   := nullif(v_p->>'foreignAmount', '')::numeric;
          v_fchg   := coalesce(nullif(v_p->>'foreignCharges', '')::numeric, 0);
          v_flines := v_p->'foreignLines';
          v_fee    := 0;            -- a foreign payment's bank_charges are booked below, never as a Razorpay fee
          v_fee_gst := 0;
          v_via    := false;
          v_excess := 0;
          v_paise  := case when v_zrate > 0 and v_famt > 0 then round((v_famt - v_fchg) * v_zrate * 100)::bigint end;
          select coalesce(sum(nullif(x->>'foreign', '')::numeric), 0) into v_fall
            from jsonb_array_elements(case when jsonb_typeof(v_flines) = 'array' then v_flines else '[]'::jsonb end) x;
        end if;
      exception when others then
        v_reason := 'Its date, amount or account could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      v_method := coalesce(nullif(v_p->>'method', ''), 'other');
      v_ref := left(coalesce(nullif(btrim(v_p->>'reference'), ''), 'ZOHO-PAY-' || v_num), 100);
      if jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      /* R-2694 foreign receipt: Zoho's figures must be all there and add up — else a person books it. */
      elsif v_cur is not null and coalesce(jsonb_typeof(v_flines), '') <> 'array' then
        v_reason := format('Received in %s — read it from Zoho again (read before foreign-currency payments could be imported).', v_cur);
      elsif v_cur is not null and (coalesce(v_zrate, 0) <= 0 or coalesce(v_famt, 0) <= 0) then
        v_reason := format('Received in %s in Zoho with no exchange rate or amount — book it from its bank line (Banking → Reconcile).', v_cur);
      elsif v_cur is not null and v_famt - v_fall > 0.01 then
        v_reason := format('%s %s of it is not applied to any invoice in Zoho (an advance in %s) — book it from its bank line (Banking → Reconcile).',
                           v_cur, trim_scale(v_famt - v_fall), v_cur);
      elsif v_cur is not null and v_fall - v_famt > 0.01 then
        v_reason := format('Zoho applies %s %s to its invoices, but the payment is %s %s — its amounts do not add up; book it by hand.',
                           v_cur, trim_scale(v_fall), v_cur, trim_scale(v_famt));
      elsif v_cur is not null and (v_fchg < 0 or v_fchg >= v_famt) then
        v_reason := format('Zoho''s bank charges (%s %s) on this payment of %s %s could not be booked — book it by hand.', v_cur, trim_scale(v_fchg), v_cur, trim_scale(v_famt));
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_paise is null or v_paise <= 0 or v_excess < 0 then
        v_reason := 'Zoho shows no money received on this payment.';
      elsif v_fee < 0 or v_fee_gst < 0 or v_fee_gst > v_fee or v_fee::bigint * 100 >= v_paise then
        v_reason := 'Zoho''s Razorpay fee on this payment could not be booked — read it from Zoho again.';
      elsif v_fee > 0 and v_method <> 'razorpay' then
        v_reason := 'Zoho took bank charges off this payment and it is not a Razorpay payment — book it by hand.';
      /* review: 'razorpay' has no one-credit-once key (payment_ref_key) — the same Razorpay payment already
         in the app (the webhook on a quote, or by hand) would be booked twice and block its settlement. */
      elsif v_via and v_ref ~ '^pay_[A-Za-z0-9]+$'
            and exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.reference = v_ref
                          and p.status in ('received', 'refunded')) then
        v_reason := format('Razorpay payment %s is already in the app (recorded on a quote or by hand) — check it before importing this payment.', v_ref);
      elsif v_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
        v_reason := 'Its payment mode could not be read — read it from Zoho again.';
      elsif jsonb_typeof(v_p->'lines') <> 'array' or jsonb_array_length(v_p->'lines') = 0 then
        v_reason := 'Not applied to any invoice in Zoho (an advance) — record it by hand on the right customer.';
      elsif v_acct is null or not exists (select 1 from public.bank_accounts b where b.id = v_acct and b.tenant_id = v_tenant) then
        v_reason := format('Choose the app account for Zoho''s "%s".', coalesce(nullif(v_p->>'depositAccountName', ''), 'no account'));
      end if;
    end if;

    /* Each line: an FY sale imported from Zoho, of one customer, with the money due. */
    v_alloc := '[]'::jsonb;
    v_cust := null;
    v_sum_cash := 0;
    v_sum_tds := 0;
    if v_reason is null then
      for v_line in select value from jsonb_array_elements(v_p->'lines') loop
        select i.id, i.customer_id, i.status, i.amount, i.net_payable, i.paid_amount, i.document_kind, i.taxable_value,
               i.currency, i.fx_rate into v_inv
          from public.invoices i
         where i.tenant_id = v_tenant and i.zoho_invoice_id = v_line->>'zohoInvoiceId';
        if not found then
          if exists (select 1 from public.invoices i where i.tenant_id = v_tenant and i.document_kind = 'opening_invoice'
                      and upper(i.external_number) = upper(btrim(coalesce(v_line->>'invoiceNumber', '')))) then
            v_reason := format('%s is an opening invoice here — its balance already leaves this receipt out (re-stated by R-2504 first).', v_line->>'invoiceNumber');
          else
            v_reason := format('%s is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).', coalesce(v_line->>'invoiceNumber', '?'));
          end if;
          exit;
        end if;
        if v_cust is not null and v_inv.customer_id is distinct from v_cust then
          v_reason := 'Its invoices belong to different customers here.';
          exit;
        end if;
        v_cust := v_inv.customer_id;
        if v_inv.status::text = 'void' then
          v_reason := format('%s is void here.', v_inv.id);
          exit;
        end if;
        begin
          v_settle := (v_line->>'settle')::integer;
          v_tds    := coalesce((v_line->>'tds')::integer, 0);
        exception when others then
          v_reason := 'Its amounts could not be read — read it from Zoho again.';
          exit;
        end;
        v_due := case when v_inv.status::text = 'paid' then 0
                      else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
        if v_cur is not null then
          /* R-2694 foreign receipt: the line's ₹ is its applied foreign money at the INVOICE's own rate
             (R-2427: the invoice keeps its rate); the whole ₹ due when it pays what is left (2 cents of
             rounding — a rupee-rounded due is never "charges"), so the invoice is Paid exactly when Zoho
             settles it in full. Zoho's rate only makes the exchange difference (below). */
          v_icur := upper(coalesce(nullif(btrim(v_inv.currency), ''), 'INR'));
          select nullif(x->>'foreign', '')::numeric into v_fline
            from jsonb_array_elements(v_flines) x
           where x->>'zohoInvoiceId' = v_line->>'zohoInvoiceId'
           limit 1;
          /* review: TDS first — a TDS-only line has no foreign money and must not loop on "read again" */
          if v_tds <> 0 then
            v_reason := format('%s: Zoho shows TDS on a %s payment — a foreign customer deducts no Indian TDS; book it by hand.', v_inv.id, v_cur);
            exit;
          end if;
          if coalesce(v_fline, 0) <= 0 then
            v_reason := format('%s: the %s applied to it could not be read — read it from Zoho again.', v_inv.id, v_cur);
            exit;
          end if;
          if v_icur <> v_cur or coalesce(v_inv.fx_rate, 0) <= 0 then
            v_reason := format('%s is in %s here, but this payment is in %s — book it by hand.', v_inv.id,
                               case when v_icur = 'INR' then '₹' else v_icur end, v_cur);
            exit;
          end if;
          if abs(v_zrate / v_inv.fx_rate - 1) > 0.25 then
            v_reason := format('Zoho''s rate on this payment (₹%s) is more than 25%% away from %s''s rate (₹%s) — check it in Zoho, or book it from its bank line.',
                               trim_scale(v_zrate), v_inv.id, trim_scale(v_inv.fx_rate));
            exit;
          end if;
          v_part := round(v_fline * v_inv.fx_rate)::integer;
          v_settle := case when v_due > 0 and abs(v_part - v_due) <= greatest(1, ceil(v_inv.fx_rate * 0.02)) then v_due else v_part end;
          if v_settle > v_due then
            v_reason := format('%s has only %s %s due here (₹%s at its rate ₹%s), but Zoho applies %s %s with this payment.',
                               v_inv.id, v_cur, trim_scale(round(v_due / v_inv.fx_rate, 2)), v_due, trim_scale(v_inv.fx_rate), v_cur, trim_scale(v_fline));
            exit;
          end if;
          v_fsum := v_fsum + v_fline;
        end if;
        /* ₹1 over is the two roundings (invoice total, this payment): capped at the due. Follow-up: no
           ₹1 advance (holder quote + voucher + credit) — the rupee is a round-off on the bank line when
           it is matched (_zoho_fy_receipt_link_line, bank_receipt_round_offs as R-2098 does). */
        if v_settle > v_due and v_settle - v_due <= 1 and v_due > 0 then
          v_settle := v_due;
        end if;
        if v_settle is null or v_settle <= 0 or v_tds < 0 or v_tds > v_settle then
          v_reason := format('%s: Zoho''s amounts on it could not be booked (settles ₹%s, TDS ₹%s, due ₹%s).', v_inv.id, coalesce(v_settle, 0), v_tds, v_due);
          exit;
        end if;
        if v_settle > v_due then
          v_reason := format('%s has only ₹%s due here, but Zoho settles ₹%s with this payment.', v_inv.id, v_due, v_settle);
          exit;
        end if;
        /* Follow-up (2b): a receipt of the same money on this invoice within 3 days that this import did not
           make (Record payment by hand, any reference) — the money is in the books already: refused. */
        select p.received_at into v_hand
          from public.payments p
         where p.tenant_id = v_tenant and p.invoice_id = v_inv.id and p.quote_id is null and p.status = 'received'
           and p.amount = v_settle
           and (p.received_at at time zone 'Asia/Kolkata')::date between v_date - 3 and v_date + 3
           and not exists (select 1 from public.zoho_fy_receipts r where r.tenant_id = v_tenant and p.id = any (r.payment_ids))
         limit 1;
        if found then
          v_reason := format('%s already has a ₹%s receipt of %s that this import did not make (recorded by hand?) — check it before importing this payment.',
                             v_inv.id, v_settle, to_char((v_hand at time zone 'Asia/Kolkata')::date, 'DD Mon YYYY'));
          exit;
        end if;
        /* R-2702: TDS Zoho took on the INVOICE (its total net of TDS; the sale here is the full value). Zoho's
           payment then withholds nothing — the payment that clears what is due here once the invoice's TDS
           is added (±₹1 of rounding) carries that TDS, exactly Zoho's figure, when none is booked on the
           invoice yet. A part payment stays money only. A ₹ payment only (foreign TDS is refused above and
           by the sales import). */
        v_inv_sec := null;
        if v_cur is null and v_tds = 0 then
          select nullif(s.payload->>'tds', '')::integer, nullif(btrim(coalesce(s.payload->>'tdsSection', '')), '')
            into v_inv_tds, v_inv_sec
            from public.zoho_fy_scan s
           where s.tenant_id = v_tenant and s.kind = 'invoices' and s.zoho_id = v_line->>'zohoInvoiceId'
           order by s.fy desc
           limit 1;
          if coalesce(v_inv_tds, 0) > 0 and abs(v_settle + v_inv_tds - v_due) <= 1
             and not exists (select 1 from public.tds_receivable t where t.tenant_id = v_tenant and t.invoice_id = v_inv.id) then
            v_tds := v_inv_tds;
            v_settle := least(v_settle + v_inv_tds, v_due);
          else
            v_inv_sec := null;
          end if;
        end if;
        v_cash := v_settle - v_tds;
        v_sum_cash := v_sum_cash + v_cash;
        v_sum_tds := v_sum_tds + v_tds;
        /* Follow-up (low): TDS gross = what this payment settles on the invoice (money + TDS), not the whole
           invoice — so a part payment's rate is right. */
        v_alloc := v_alloc || jsonb_strip_nulls(jsonb_build_object('invoice_id', v_inv.id, 'amount', v_cash, 'tds_amount', v_tds,
                                                 'tds_gross', case when v_tds > 0 then
                                                   round(coalesce(nullif(v_inv.taxable_value, 0), v_inv.amount)::numeric * v_settle
                                                         / nullif(coalesce(v_inv.net_payable, v_inv.amount), 0))::integer end,
                                                 'tds_section', case when v_tds > 0 then v_inv_sec end));
      end loop;
      if v_reason is null and v_sum_cash <= 0 then
        v_reason := 'Zoho booked only TDS on this payment, no money — record it by hand.';
      end if;
      /* R-2694 foreign receipt: what Zoho applies must be the whole payment (no unused money); then
           forex   = receipts (₹ at the invoices' rates) − applied money × Zoho's rate (< 0 = a gain),
           charges = Zoho's bank_charges × Zoho's rate,
         so receipts − forex − charges = (money − charges) × Zoho's rate = the bank line (±₹1 rounding). */
      if v_reason is null and v_cur is not null then
        if abs(v_fsum - v_famt) > 0.01 then
          v_reason := format('Zoho applies %s %s to its invoices, but the payment is %s %s — its amounts do not add up; book it by hand.',
                             v_cur, trim_scale(v_fsum), v_cur, trim_scale(v_famt));
        else
          v_fxd := v_sum_cash - round(v_famt * v_zrate)::integer;
          v_fxc := round(v_fchg * v_zrate)::integer;
        end if;
      end if;
    end if;

    /* Its bank line, looked up BEFORE booking: already reconciled to something else → the money is in
       the books already (an advance / sale on the Reconcile sheet) — refused, never a second receipt. */
    /* R-2565: a Razorpay fee payment has no bank line of its own (only amount − fee reached Razorpay's
       settlement, with other payments): it waits for its settlement line (R-2099). */
    v_bank := '{}'::jsonb;
    if v_reason is null and not v_via then
      v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_acct, v_paise, v_date, v_p->>'reference', v_cust);
      if nullif(v_bank->>'taken_txn', '') is not null then
        v_reason := format('Its bank line (%s, ₹%s) is already reconciled as %s — check that line before importing this payment.',
                           to_char((v_bank->>'taken_on')::date, 'DD Mon YYYY'), round(v_paise / 100.0, 2), replace(v_bank->>'taken_as', '_', ' '));
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    /* Book it — its own sub-transaction: any refusal undoes only this payment. */
    begin
      /* Follow-up: vouchers = Zoho's payment number (else the payment date's series) — read by
         _record_opening_invoice_payment / _zoho_fy_receipt_advance; cleared right after. */
      perform set_config('app.zoho_fy_receipt_on', v_date::text, true);
      perform set_config('app.zoho_fy_receipt_no', coalesce(nullif(btrim(v_p->>'number'), ''), ''), true);
      v_r := public.record_multi_invoice_payment(
        v_cust, v_date, v_method, v_acct, v_ref, v_sum_cash, v_alloc, false,
        'FY ' || p_fy || ' receipt from Zoho (payment ' || v_num || ')');
      if coalesce((v_r->>'idempotent_replay')::boolean, false) then
        raise exception 'Reference % is already recorded on these invoices — booked by hand already?', v_ref;
      end if;
      select coalesce(array_agg((l->>'payment_id')::uuid), '{}') into v_pays
        from jsonb_array_elements(v_r->'lines') l where nullif(l->>'payment_id', '') is not null;

      v_adv := null;
      if v_excess > 0 then
        perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(v_method, v_ref), ''), true);
        v_adv := public._zoho_fy_receipt_advance(v_tenant, v_cust, v_excess, v_date, v_method, v_ref, v_acct, v_num);
        perform set_config('app.payment_ref_batch', '', true);
        v_pays := v_pays || (v_adv->>'payment_id')::uuid;
      end if;
      perform set_config('app.zoho_fy_receipt_on', '', true);
      perform set_config('app.zoho_fy_receipt_no', '', true);

      /* R-2565: Razorpay's fee — on the largest receipt of this payment, as R-045 does for a captured
         payment: payments.gateway_fee / _gst (the business bore it: fee_bearer 'business') and ONE
         "Bank Charges" expense EXP-RZPFEE-<receipt>, vendor Razorpay, GST heads from Razorpay's GSTIN
         state vs ours (unknown → none, no guess). The receipt stays the full amount on the invoice.
         R-2099's settlement takes this booked fee off its own (never twice); the balance sheet keeps
         amount − fee as "not yet in bank" until that settlement line is reconciled. */
      v_fee_exp := null;
      if v_fee > 0 then
        select p.id, p.amount into v_fee_pay, v_fee_amt
          from public.payments p
         where p.tenant_id = v_tenant and p.id = any (v_pays)
         order by p.amount desc, p.id
         limit 1;
        if v_fee_pay is null or v_fee_amt < v_fee then
          raise exception 'Zoho''s Razorpay fee ₹% is more than its receipt — book it by hand.', v_fee;
        end if;
        update public.payments
           set gateway_fee = v_fee, gateway_fee_gst = v_fee_gst, fee_bearer = 'business'
         where tenant_id = v_tenant and id = v_fee_pay;
        if not v_fee_ctx then   -- once per call (review): the Razorpay vendor and our state do not change
          select v.id, v.gstin into v_vendor
            from public.vendors v
           where v.tenant_id = v_tenant and v.name ilike '%razorpay%'
           order by (coalesce(btrim(v.gstin), '') <> '') desc, v.created_at asc
           limit 1;
          select coalesce(nullif(btrim(t.state_code), ''), case when length(btrim(coalesce(t.gstin, ''))) = 15 then left(btrim(t.gstin), 2) end)
            into v_own_st from public.tenants t where t.id = v_tenant;
          v_v_st := case when length(btrim(coalesce(v_vendor.gstin, ''))) = 15 then left(btrim(v_vendor.gstin), 2) end;
          v_fee_ctx := true;
        end if;
        if v_fee_gst = 0 then
          v_igst := 0; v_cgst := 0; v_sgst := 0;
        elsif v_own_st is null or v_v_st is null then
          v_igst := null; v_cgst := null; v_sgst := null;
        elsif v_own_st = v_v_st then
          v_cgst := round(v_fee_gst / 2.0); v_sgst := v_fee_gst - v_cgst; v_igst := 0;
        else
          v_igst := v_fee_gst; v_cgst := 0; v_sgst := 0;
        end if;
        v_fee_exp := 'EXP-RZPFEE-' || v_fee_pay::text;
        insert into public.expenses
          (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, igst, cgst, sgst,
           bill_type, paid, paid_date, payment_method, description, notes)
        values
          (v_fee_exp, v_tenant, 'Bank Charges', 'Razorpay', v_vendor.id, v_date, v_fee, v_fee_gst,
           v_igst, v_cgst, v_sgst, 'gst', true, v_date, 'razorpay',
           left('Razorpay fee on ' || v_ref || ' (Zoho payment ' || v_num || ')', 200),
           format('FY %s receipt from Zoho (R-2565): Razorpay kept ₹%s (GST ₹%s inside, 18%%) before settling; the receipt is the full ₹%s on the invoice. Razorpay''s monthly tax invoice is the bill for this GST.',
                  p_fy, v_fee, v_fee_gst, v_sum_cash + v_excess));
      end if;

      /* R-2694 foreign receipt: the exchange difference and the remitting bank's charges — R-2427 /
         R-1678's two paid expense rows, keyed by the Zoho payment (no bank line yet): on the deposit
         account, Zoho's date, reconciled_txn_id set by _zoho_fy_fx_line_sync when a line holds the
         receipts (never deleted on un-reconcile — they belong to this payment). */
      v_fxd_id := null;
      v_fxc_id := null;
      if v_cur is not null and v_fxd <> 0 then
        v_fxd_id := 'EXP-ZFXD-' || v_pays[1]::text;   -- review: a receipt uuid (expenses.id is global, a Zoho id is not)
        insert into public.expenses
          (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
           paid, paid_date, bank_account_id, notes)
        values
          (v_fxd_id, v_tenant, 'Exchange gain / loss (realised)', null, v_date, v_fxd, 0, 'none', 'bank',
           left(case when v_fxd < 0 then 'Exchange gain' else 'Exchange loss' end || ' on realisation — Zoho payment ' || v_num || ': '
                || v_cur || ' ' || trim_scale(v_famt) || ' @ ₹' || trim_scale(v_zrate) || ' received, booked at the invoices'' rates', 200),
           true, v_date, v_acct,
           format('FY %s receipt from Zoho (R-2694): receipts ₹%s at the invoices'' own rates − %s %s × Zoho''s ₹%s = ₹%s.',
                  p_fy, v_sum_cash, v_cur, trim_scale(v_famt), trim_scale(v_zrate), v_fxd));
      end if;
      if v_cur is not null and v_fxc <> 0 then
        v_fxc_id := 'EXP-ZFXC-' || v_pays[1]::text;
        insert into public.expenses
          (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
           paid, paid_date, bank_account_id, notes)
        values
          (v_fxc_id, v_tenant, 'Bank Charges', null, v_date, v_fxc, 0, 'none', 'bank',
           left('Remitting bank''s charges kept abroad — Zoho payment ' || v_num || ': ' || v_cur || ' ' || trim_scale(v_fchg)
                || ' @ ₹' || trim_scale(v_zrate), 200),
           true, v_date, v_acct,
           format('FY %s receipt from Zoho (R-2694): Zoho''s bank charges %s %s × ₹%s.', p_fy, v_cur, trim_scale(v_fchg), trim_scale(v_zrate)));
      end if;

      /* R-2694: the row first — the line link below (and its sync trigger) reads it. */
      insert into public.zoho_fy_receipts (tenant_id, zoho_payment_id, fy, batch_id, customer_id, received_on, bank_account_id,
                                           received_paise, cash, tds, advance, reference, payment_ids, bank_txn_id, banked_at, bank_matched_by_import,
                                           fee, fee_gst, fee_expense_id, via_settlement,
                                           currency, foreign_amount, fx_rate, foreign_charges, fx_difference, fx_charges, fx_expense_id, fx_charges_expense_id)
      values (v_tenant, v_zid, p_fy, v_batch, v_cust, v_date, v_acct, v_paise, v_sum_cash + v_excess, v_sum_tds, v_excess,
              v_ref, v_pays, null, null, false,
              v_fee, v_fee_gst, v_fee_exp, v_via,
              v_cur, case when v_cur is not null then v_famt end, case when v_cur is not null then v_zrate end,
              case when v_cur is not null then v_fchg else 0 end, v_fxd, v_fxc, v_fxd_id, v_fxc_id);

      v_txn := null;
      if nullif(v_bank->>'txn_id', '') is not null and not ((v_bank->>'txn_id')::uuid = any (v_used)) then
        v_txn := (v_bank->>'txn_id')::uuid;
        /* Locked, then checked again — matched meanwhile → left for a later run (_zoho_fy_receipt_link_line). */
        if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_pays, v_bank->>'confidence') then
          v_used := v_used || v_txn;
          update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now(), bank_matched_by_import = true
           where tenant_id = v_tenant and zoho_payment_id = v_zid;
        else
          v_txn := null;
        end if;
      end if;
    exception when others then
      perform set_config('app.payment_ref_batch', '', true);
      perform set_config('app.zoho_fy_receipt_on', '', true);
      perform set_config('app.zoho_fy_receipt_no', '', true);
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', sqlerrm);
      continue;
    end;

    v_n := v_n + 1;
    if v_txn is not null then v_banked := v_banked + 1; else v_later := v_later + 1; end if;
    v_tot_cash := v_tot_cash + v_sum_cash + v_excess;
    v_tot_tds := v_tot_tds + v_sum_tds;
    v_tot_adv := v_tot_adv + v_excess;
    if v_fee > 0 then v_fees := v_fees + 1; v_tot_fee := v_tot_fee + v_fee; end if;
    if v_cur is not null then v_fx_n := v_fx_n + 1; v_tot_fxd := v_tot_fxd + v_fxd; v_tot_fxc := v_tot_fxc + v_fxc; end if;
    v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'date', v_date, 'customer_id', v_cust,
      'cash', v_sum_cash + v_excess, 'tds', v_sum_tds, 'advance', v_excess, 'payment_ids', to_jsonb(v_pays), 'bank_txn_id', v_txn,
      'fee', v_fee, 'fee_gst', v_fee_gst, 'fee_expense_id', v_fee_exp,
      'currency', v_cur, 'foreign_amount', case when v_cur is not null then v_famt end,
      'fx_difference', v_fxd, 'fx_charges', v_fxc, 'fx_expense_id', v_fxd_id, 'fx_charges_expense_id', v_fxc_id);
  end loop;

  /* Batch totals: amount = money received, tax = TDS booked, taxable = the part kept as advance. */
  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_tot_adv, tax_total = v_tot_tds, amount_total = v_tot_cash, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_receipts.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s receipts from Zoho (₹%s, TDS ₹%s, %s on bank lines); %s skipped', v_n, p_fy, v_tot_cash, v_tot_tds, v_banked, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'banked', v_banked,
                             'bank_later', v_later, 'skipped', jsonb_array_length(v_skipped),
                             'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv,
                             'with_fee', v_fees, 'fee', v_tot_fee,
                             'foreign', v_fx_n, 'fx_difference', v_tot_fxd, 'fx_charges', v_tot_fxc));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2501', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2501' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'banked', v_banked, 'bank_later', v_later,
    'skipped', v_skipped, 'done', v_done,
    'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv,
    'with_fee', v_fees, 'fee', v_tot_fee,
    'foreign', v_fx_n, 'fx_difference', v_tot_fxd, 'fx_charges', v_tot_fxc);
end;
$function$;

comment on function public.import_zoho_fy_receipts(text, jsonb, boolean) is
  'R-2501 + R-2565 + R-2694: FY customer payments from Zoho as receipts (+ Zoho''s TDS, excess → advance; a Razorpay payment''s fee (Zoho bank_charges) → Bank Charges expense EXP-RZPFEE-<receipt>, banked by its Razorpay settlement; a foreign-currency payment → ₹ at each invoice''s own rate + exchange gain / loss EXP-ZFXD-<receipt id> + remitting bank charges EXP-ZFXC-<receipt id>) on the FY sales imported from Zoho, matched to the bank line when it is in (else on a later run). Money from zoho_fy_scan; picks = Zoho id + app account. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_receipts(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_receipts(text, jsonb, boolean) to authenticated, service_role;

commit;
