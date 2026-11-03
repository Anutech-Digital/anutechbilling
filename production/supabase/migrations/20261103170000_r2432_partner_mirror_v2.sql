-- deploy-peek: exists (select 1 from pg_proc where proname = 'tg_mirror_invoice_to_child_vendor_bill' and prosrc like '%R-2432%') and to_regprocedure('public.tg_partner_credit_note_to_child_bill()') is not null
-- deploy-key: r2432partnermirrorv2
-- 20261103170000_r2432_partner_mirror_v2.sql
--
-- R-2432 (G-NETWORK N0, 3 Nov 2026): fix today's distributor → reseller invoice mirror.
--
-- THE BUG (NETWORK-AUDIT app-audit.md §5): tg_mirror_invoice_to_child_vendor_bill ran AFTER
-- INSERT on invoices with no status check (a draft or a void invoice became an unpaid bill in
-- the reseller), guessed the tax as amount / 1.18 (wrong for any other rate), left
-- vendor_bills.document_type NULL (read as a tax invoice → ITC even on a draft), set no
-- vendor_id, and never followed a void or a credit note.
--
-- NOW (body redefined from the latest one, r1739 20261022013149 — opening invoices still skipped):
--   * the bill is made when the invoice is ISSUED: inserted as pending/paid/overdue, or updated
--     from draft to one of those. A draft or void invoice makes no bill. A bill the OLD trigger
--     made for a draft is rebuilt on issue if the reseller has not touched it.
--   * amounts come from the GST split frozen on the invoice (taxable_value, tax_amount,
--     inter_state; CGST = round(tax/2), SGST = the rest — same rule as lib/gst/tax-split).
--     An old invoice without a frozen split is booked as 'other' with no GST (no ITC) and a note.
--   * document_type follows the invoice's document_kind (tax_invoice / bill_of_supply), so ITC
--     follows the issued tax invoice only.
--   * vendor_id: the reseller's vendor with the distributor's GSTIN, else one with the same name
--     and no other GSTIN, else a new vendor (name + GSTIN + PAN from the GSTIN; the name gets the
--     GSTIN added when another vendor already has it).
--   * void: an untouched mirrored bill (nothing paid, no advance, no bank / payment-run / PO
--     link) is removed — vendor bills have no cancelled status, and a removed bill takes its
--     cost and ITC out of every report. A touched bill stays and gets a flag in its notes.
--   * credit note (AFTER INSERT on credit_notes, only for the invoice's own company): an
--     untouched mirrored bill is reduced by the note's frozen taxable value and tax, on the
--     bill's own heads (IGST bill → IGST); a full credit removes it, like a void. A touched bill,
--     or one whose heads are smaller than the note's, gets a flag in its notes.
--   * the reseller's locked books are never written: a void / credit note on a bill dated on or
--     before the reseller's books_locked_until is skipped (a new bill is dated the day after).
-- Not here (R-2434 N2 replaces this for connected pairs; kept small on purpose): debit notes,
-- invoice amendments, dated reversal documents instead of in-place changes, repair of old
-- mirrored bills whose draft invoice was deleted.

-- Is a mirrored bill still untouched (safe to remove or reduce)?
CREATE OR REPLACE FUNCTION public.r2432_partner_bill_untouched(p_bill public.vendor_bills)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* R-2432 */
  if coalesce(p_bill.paid_amount, 0) <> 0 or coalesce(p_bill.advance_applied, 0) <> 0
     or coalesce(p_bill.status, 'unpaid') <> 'unpaid' then
    return false;
  end if;
  if exists (select 1 from public.bank_vendor_payment_lines where vendor_bill_id = p_bill.id)
     or exists (select 1 from public.vendor_advance_applications where vendor_bill_id = p_bill.id)
     or exists (select 1 from public.po_bill_allocations where vendor_bill_id = p_bill.id) then
    return false;
  end if;
  if (select o_msg from public.vendor_bill_delete_blocker(p_bill.tenant_id, p_bill.id)) is not null
     or (select o_msg from public.matched_bank_line_blocker(p_bill.tenant_id, 'vendor_bill', p_bill.id)) is not null then
    return false;
  end if;
  return true;
end $function$;

REVOKE ALL ON FUNCTION public.r2432_partner_bill_untouched(public.vendor_bills) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_mirror_invoice_to_child_vendor_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-2432: mirror on issue, frozen GST split, document_type, vendor_id, void follow-through. */
  v_linked_tenant uuid;
  v_parent        tenants%rowtype;
  v_child_lock    date;
  v_bill          vendor_bills%rowtype;
  v_vendor        uuid;
  v_gstin         text;
  v_subtotal      integer;
  v_tax           integer;
  v_igst          integer := 0;
  v_cgst          integer := 0;
  v_sgst          integer := 0;
  v_inter_state   boolean;
  v_doc_type      text;
  v_bill_date     date;
  v_note          text;
  v_vname         text;
begin
  -- The bill this invoice already made (found by the invoice, not by today's link — a link
  -- changed since must not stop a void from reaching it).
  select * into v_bill from public.vendor_bills
   where id = 'VB-PARTNER-' || NEW.id and source_tenant_invoice_id = NEW.id;

  -- Void: take the mirrored bill back.
  if TG_OP = 'UPDATE' and NEW.status = 'void' and OLD.status is distinct from 'void' then
    if v_bill.id is null then return NEW; end if;
    select books_locked_until into v_child_lock from public.tenants where id = v_bill.tenant_id;
    if v_child_lock is not null and v_bill.bill_date <= v_child_lock then return NEW; end if;
    if public.r2432_partner_bill_untouched(v_bill) then
      delete from public.vendor_bills where id = v_bill.id;
    else
      update public.vendor_bills
         set notes = concat_ws(E'\n', nullif(notes, ''),
               format('Distributor voided invoice %s on %s — this bill is already paid/linked, so it was kept. Ask the distributor for a refund or credit note.',
                      NEW.id, to_char(public.ist_today(), 'DD Mon YYYY')))
       where id = v_bill.id;
    end if;
    return NEW;
  end if;

  -- Only an issued invoice becomes a bill: inserted issued, or draft → issued.
  if NEW.status not in ('pending', 'paid', 'overdue') then return NEW; end if;
  if TG_OP = 'UPDATE' and OLD.status is distinct from 'draft' then return NEW; end if;
  if NEW.customer_id is null then return NEW; end if;
  /* R-1739: an imported Zoho opening invoice is no new sale — the child's bill (and its ITC)
     was already booked in Zoho / by the child. */
  if NEW.document_kind = 'opening_invoice' then return NEW; end if;

  select linked_tenant_id into v_linked_tenant
  from public.customers
  where id = NEW.customer_id and tenant_id = NEW.tenant_id;
  if v_linked_tenant is null then return NEW; end if;

  if not exists (
    select 1 from public.tenants
    where id = v_linked_tenant and parent_tenant_id = NEW.tenant_id
  ) then return NEW; end if;

  select books_locked_until into v_child_lock from public.tenants where id = v_linked_tenant;

  if v_bill.id is not null then
    -- A bill the OLD trigger made while this invoice was a draft (no document_type, /1.18 guess):
    -- rebuild it from the issued invoice if the reseller has not touched it; else keep it.
    if TG_OP = 'UPDATE' and v_bill.document_type is null and v_bill.tenant_id = v_linked_tenant
       and (v_child_lock is null or v_bill.bill_date > v_child_lock)
       and public.r2432_partner_bill_untouched(v_bill) then
      delete from public.vendor_bills where id = v_bill.id;
    else
      return NEW;
    end if;
  end if;

  select * into v_parent from public.tenants where id = NEW.tenant_id;
  v_gstin := upper(coalesce(nullif(btrim(NEW.seller_gstin), ''), nullif(btrim(v_parent.gstin), '')));

  -- GST split frozen on the invoice — never a guess.
  if NEW.taxable_value is not null and NEW.tax_amount is not null then
    v_subtotal := NEW.taxable_value;
    v_tax := NEW.tax_amount;
    v_inter_state := coalesce(NEW.inter_state,
      NEW.seller_state_code is distinct from NEW.pos_state_code);
    if v_inter_state then
      v_igst := v_tax;
    else
      v_cgst := round(v_tax::numeric / 2)::integer;
      v_sgst := v_tax - v_cgst;
    end if;
    v_doc_type := case NEW.document_kind when 'bill_of_supply' then 'bill_of_supply' else 'tax_invoice' end;
  else
    v_subtotal := NEW.amount;
    v_doc_type := 'other';
    v_note := 'The distributor invoice carries no frozen GST split — booked without GST (no ITC). Check the invoice and correct this bill.';
  end if;

  -- The reseller's vendor for this distributor: by GSTIN, else by name, else a new one.
  select id into v_vendor from public.vendors
   where tenant_id = v_linked_tenant and v_gstin is not null and upper(btrim(gstin)) = v_gstin
   order by created_at limit 1;
  if v_vendor is null then
    -- same name, but never a vendor carrying a DIFFERENT GSTIN
    select id into v_vendor from public.vendors
     where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(btrim(v_parent.name))
       and (v_gstin is null or nullif(btrim(gstin), '') is null or upper(btrim(gstin)) = v_gstin)
     order by created_at limit 1;
  end if;
  if v_vendor is null then
    v_vname := btrim(v_parent.name);
    if exists (select 1 from public.vendors
                where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(v_vname)) then
      v_vname := v_vname || ' (' || coalesce(v_gstin, 'distributor') || ')';
    end if;
    insert into public.vendors (tenant_id, name, gstin, pan, default_category, notes)
    values (v_linked_tenant, v_vname, v_gstin,
            case when substr(v_gstin, 3, 10) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then substr(v_gstin, 3, 10) end,
            'cloud_subscriptions', 'Your distributor — added automatically from its invoices.')
    on conflict do nothing
    returning id into v_vendor;
    if v_vendor is null then   -- made by a parallel issue a moment ago
      select id into v_vendor from public.vendors
       where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(v_vname);
    end if;
  end if;

  v_bill_date := NEW.invoice_date;
  if v_child_lock is not null and v_bill_date <= v_child_lock then
    v_bill_date := v_child_lock + 1;
    v_note := concat_ws(E'\n', v_note, format('Invoice dated %s; your books are locked till %s, so this bill is dated %s.',
      to_char(NEW.invoice_date, 'DD Mon YYYY'), to_char(v_child_lock, 'DD Mon YYYY'), to_char(v_bill_date, 'DD Mon YYYY')));
  end if;

  insert into public.vendor_bills (
    id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
    category, line_items, subtotal, cgst, sgst, igst, total, status,
    paid_amount, notes, source_tenant_invoice_id, document_type, currency, fx_rate
  ) values (
    'VB-PARTNER-' || NEW.id,
    v_linked_tenant,
    v_vendor,
    v_parent.name,
    v_gstin,
    NEW.id,
    v_bill_date,
    NEW.due_date,
    'cloud_subscriptions',
    jsonb_build_array(jsonb_build_object(
      'description', 'Wholesale supply against invoice ' || NEW.id,
      'quantity',    1,
      'rate',        v_subtotal,
      'amount',      v_subtotal
    )),
    v_subtotal, v_cgst, v_sgst, v_igst, v_subtotal + v_cgst + v_sgst + v_igst,
    'unpaid', 0,
    concat_ws(E'\n', 'Auto-imported from ' || v_parent.name || ' (your distributor).', v_note),
    NEW.id,
    v_doc_type,
    coalesce(NEW.currency, 'INR'),
    coalesce(NEW.fx_rate, 1)
  );

  return NEW;
end $function$;

DROP TRIGGER IF EXISTS trg_mirror_invoice_to_child ON public.invoices;
CREATE TRIGGER trg_mirror_invoice_to_child
  AFTER INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_invoice_to_child_vendor_bill();

-- Credit note on a mirrored invoice → the reseller's bill comes down by the same amounts.
CREATE OR REPLACE FUNCTION public.tg_partner_credit_note_to_child_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-2432 */
  v_bill  vendor_bills%rowtype;
  v_lock  date;
  v_tax   integer := coalesce(NEW.tax_amount, 0);
  v_taxable integer := NEW.taxable_value;
  v_igst  integer := 0;
  v_cgst  integer := 0;
  v_sgst  integer := 0;
begin
  -- Only the invoice's own company can move its bill.
  if not exists (select 1 from public.invoices where id = NEW.invoice_id and tenant_id = NEW.tenant_id) then
    return NEW;
  end if;
  -- The bill this invoice made (by the invoice, like the void path).
  select * into v_bill from public.vendor_bills
   where id = 'VB-PARTNER-' || NEW.invoice_id and source_tenant_invoice_id = NEW.invoice_id;
  if v_bill.id is null then return NEW; end if;

  select books_locked_until into v_lock from public.tenants where id = v_bill.tenant_id;
  if v_lock is not null and v_bill.bill_date <= v_lock then return NEW; end if;

  if v_bill.cgst + v_bill.sgst + v_bill.igst = 0 then
    -- Bill booked without GST (old invoice without a frozen split): reduce the value only.
    v_taxable := NEW.amount;
    v_tax := 0;
  end if;

  -- The heads follow the BILL (how its ITC was booked), not the note's flag.
  if v_tax = 0 then
    null;
  elsif v_bill.igst > 0 then
    v_igst := v_tax;
  else
    v_cgst := round(v_tax::numeric / 2)::integer;
    v_sgst := v_tax - v_cgst;
  end if;

  if public.r2432_partner_bill_untouched(v_bill) and NEW.amount >= v_bill.total then
    -- Fully credited: the bill goes, like a void.
    delete from public.vendor_bills where id = v_bill.id;
    return NEW;
  end if;

  if not public.r2432_partner_bill_untouched(v_bill)
     or v_bill.subtotal < v_taxable or v_bill.cgst < v_cgst or v_bill.sgst < v_sgst or v_bill.igst < v_igst then
    update public.vendor_bills
       set notes = concat_ws(E'\n', nullif(notes, ''),
             format('Distributor issued credit note %s for ₹%s on invoice %s — this bill is already paid/linked (or its amounts do not match the note), so it was not changed. Ask the distributor for the refund, or reduce this bill yourself.',
                    NEW.id, NEW.amount, NEW.invoice_id))
     where id = v_bill.id;
    return NEW;
  end if;

  update public.vendor_bills
     set subtotal = subtotal - v_taxable,
         cgst = cgst - v_cgst,
         sgst = sgst - v_sgst,
         igst = igst - v_igst,
         total = total - (v_taxable + v_cgst + v_sgst + v_igst),
         line_items = line_items || jsonb_build_array(jsonb_build_object(
           'description', 'Less: credit note ' || NEW.id,
           'quantity',    1,
           'rate',        -v_taxable,
           'amount',      -v_taxable)),
         notes = concat_ws(E'\n', nullif(notes, ''),
           format('Reduced by distributor credit note %s (₹%s).', NEW.id, NEW.amount))
   where id = v_bill.id;
  return NEW;
end $function$;

REVOKE ALL ON FUNCTION public.tg_partner_credit_note_to_child_bill() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_credit_note_to_child_bill ON public.credit_notes;
CREATE TRIGGER trg_partner_credit_note_to_child_bill
  AFTER INSERT ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_partner_credit_note_to_child_bill();
