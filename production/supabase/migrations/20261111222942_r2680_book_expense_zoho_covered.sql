-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_expense(uuid,text,text,integer,text)') and prosrc like '%R-2680 zoho-covered guard%')
-- deploy-key: r2680bookexpensezohocovered
--
-- R-2680 (11 Nov 2026, p0 paisa, G-RECON plan N6 — found in R-2676's review). The Zoho FY purchase import
-- writes a Zoho expense as PAID from its paid-through account with no bank line (R-2502; R-2676 adds the
-- ~727 with no vendor), and Zoho bills as unpaid expenses / COGS bills. Their real debits are still open on
-- the statement. R-2657 made the bulk "No-vendor lines" sheet and its route leave such a line out (money
-- rule S7, src/lib/banking/zoho-covered.ts) — but the function they all end in, book_bank_txn_as_expense,
-- still booked it: the single "Book as expense" on a line (the browser calls the function itself), or any
-- direct call, wrote a SECOND expense. R-1917 guarded only a vendor that was typed.
--
-- THE FIX: started from the NEWEST body (20261108160059_r2611_book_expense_row_lock.sql — R-718 role gate,
-- R-1917 open-bill guards and the R-2611 row lock unchanged), ONE block after the R-1917 guards and before
-- the insert: the "R-2680 zoho-covered guard" (its comment in the body says exactly what one debit can be).
--   · same amount ±₹1 as an imported Zoho purchase with no bank line yet — a paid Zoho expense document of
--     this account (7 days), what ONE Zoho vendor payment paid (the payment's own amount, else the sum of
--     its open documents), an unpaid Zoho bill or COGS bill (−7 / +120 days, S7's window);
--   · one document covers at most one line (S7): only the nearest open debit(s) are refused;
--   · a later posting, up to 60 days, when the line's own UTR / RRN is Zoho's reference for the payment;
--   · two sentences (hint R-2680): a PAID purchase → "… Match the line to it in Reconcile …"; an UNPAID bill
--     → "… Pay that bill with "Record payment" on this line …" (matching a line does not pay a bill). With a
--     vendor typed, R-1917's own sentence answers first.
-- SPEED (independent review, 12 Nov): the first version looked up the payment links per document
-- (target_ids && …, no index) — ~1.8 s a call with 4,000 open documents. Now each bill's payment is one
-- probe of the links' (tenant_id, zoho_bill_id) index and Zoho's reference is looked up only for the
-- documents that fit the amount; numbers on the card.
-- STILL NOT COVERED (listed on the card):
--   · a later debit (8–60 days after a PAID Zoho expense) whose narration has no UTR — a POS / card line has
--     none, a cheque number is under 10 characters: the amount alone is not proof that far away (R-2655's
--     preview lists it as "no bank line"); and a debit whose UTR is Zoho's but whose amount is ₹2+ off;
--   · one debit for several Zoho expenses that Zoho did NOT pay with one vendor payment (a card bill settling
--     many card expenses, a batch transfer) — nothing ties them together;
--   · a paid Zoho expense with no paid-from account, or paid from another account than the line's; a
--     document whose rows were changed by hand so they are not all open the same way (compared at the open
--     rows' sum only — R-2655 shows it as "check by hand");
--   · the gross / GST-added amount variants of S7's sheet rule (this guard compares the cash after TDS);
--   · the other booking doors: reconcile_bank_debit_to_vendor's "new expense" / advance for a NAMED vendor
--     (R-1911 refuses that vendor's own recorded payments), book_bank_txn_as_vendor_bill, bank-charge /
--     salary / government-payment bookings;
--   · a ₹1-apart line is refused here but the match doors want the exact amount for a multi-row / TDS
--     document — it waits for R-2677 (book the clean matches) or a hand correction.
-- Signature unchanged → grants and comments are kept. Stored data is not changed.
-- Test: supabase/tests/r2680_book_expense_zoho_covered.test.sql (rolled back); r2611 + r1917 tests stay green.

begin;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_expense(p_txn_id uuid, p_category text, p_vendor text, p_gst integer, p_notes text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_exp_id text;
  v_vendor text := nullif(trim(coalesce(p_vendor, '')), '');
  v_vid    uuid;
  v_vname  text;
  v_found  boolean := false;
  v_item   record;
  v_z_who  text;
  v_z_what text;
  v_z_on   date;
  v_z_cash integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;
  /* R-2611: locked — a second booking of the same line waits here, then sees it reconciled. */
  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant
    for update;
  if not found then raise exception 'Transaction not found'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) line can be booked as an expense';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  /* R-1917 (B8): the vendor's open item of this amount is PAID with this line (Record payment),
     never booked a second time as a new expense. */
  if v_vendor is not null then
    for v_vid, v_vname in
      select v.id, v.name from public.vendors v
       where v.tenant_id = v_txn.tenant_id and upper(trim(v.name)) = upper(v_vendor)
    loop
      v_found := true;
      select i.* into v_item
        from public.bank_debit_vendor_open_items(v_vid) i
       where i.amount_due = v_txn.debit
          or (i.source <> 'recorded_payment' and i.amount_due - coalesce(i.tds_amount, 0) = v_txn.debit)
       order by (i.source = 'recorded_payment') desc, i.doc_date, i.doc_id
       limit 1;
      if v_item.doc_id is not null then
        if v_item.source = 'recorded_payment' then
          raise exception '% bill % — ₹% is already recorded as paid (%). Match this bank line to that payment with "Record payment" instead of booking a new expense, or the cost is counted twice.',
            v_vname, coalesce(v_item.bill_no, v_item.pays_doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999'), to_char(v_item.paid_on, 'DD Mon YYYY')
            using errcode = 'P0001', hint = 'R-1917';
        end if;
        raise exception '% has an open bill % for ₹%. Pay it with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
          v_vname, coalesce(v_item.bill_no, v_item.doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999')
          using errcode = 'P0001', hint = 'R-1917';
      end if;
    end loop;

    /* A bill typed only as a name (no vendor record): same rule, by the name. */
    if not v_found then
      select x.bill_no, x.doc_id, x.amount_due into v_item from (
        select e.bill_no, e.id as doc_id, e.amount as amount_due, e.expense_date as d
          from public.expenses e
         where e.tenant_id = v_txn.tenant_id and e.vendor_id is null
           and upper(trim(coalesce(e.vendor_name, ''))) = upper(v_vendor)
           and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
           and (e.amount = v_txn.debit or e.amount - coalesce(e.tds_amount, 0) = v_txn.debit)
        union all
        select b.bill_no, b.id, b.total - coalesce(b.paid_amount, 0), b.bill_date
          from public.vendor_bills b
         where b.tenant_id = v_txn.tenant_id and b.vendor_id is null
           and upper(trim(b.vendor_name)) = upper(v_vendor)
           and coalesce(b.status, 'unpaid') <> 'paid'
           and b.total - coalesce(b.paid_amount, 0) = v_txn.debit
      ) x order by x.d, x.doc_id limit 1;
      if v_item.doc_id is not null then
        raise exception '% has an open bill % for ₹%. Pay it with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
          v_vendor, coalesce(v_item.bill_no, v_item.doc_id), to_char(v_item.amount_due, 'FM99,99,99,99,999')
          using errcode = 'P0001', hint = 'R-1917';
      end if;
    end if;
  end if;

  /* R-2680 zoho-covered guard (money rule S9 — S7's sheet rule on the server). Runs AFTER R-1917: when a
     vendor is typed and R-1917 knows the open bill / recorded payment, its sentence answers first.
     A purchase imported from Zoho that has no bank line yet is tied to its debit, never booked as a
     new expense — the cost (and its GST) would be counted twice. What ONE debit can be:
       paid    — a Zoho expense document paid from THIS account that no Zoho vendor payment is linked
                 to (all its category rows; cash = Σ amount − TDS − advance applied − bank parts paid;
                 the R-1911 "recorded payment" list, as R-2655's preview reads it), within 7 days of
                 its paid date;
       payment — the document(s) one Zoho vendor payment paid, as ONE debit: the payment's own amount
                 in Zoho when the scan has it (it may carry an advance or a bill kept elsewhere), else
                 the sum of its open documents. A bill inside a payment is never a unit by itself —
                 refusing an unrelated debit of the bill's amount would send the user to tie the wrong
                 line and free the payment's real debit;
       bill    — an UNPAID Zoho bill kept as expense rows, or an unpaid / part-paid Zoho COGS bill (what
                 is still due, with and without its Zoho TDS): from 7 days before the bill date to 120
                 days after it (S7's window), from any account. Its own sentence: a bill is PAID with
                 "Record payment" — matching a line to it does not pay it.
     Same amount ±₹1 (S1). ONE document covers at most ONE line (S7): this line is refused only while it
     is among the nearest open debits of this account for the documents it fits (as many lines as there
     are such documents; ties by line id). A later posting: up to 60 days after a paid document when the
     line's own UTR / RRN (10+ characters) is the reference Zoho has for that payment. NULL is never a
     match. Live state only. Speed: the documents (±60 days) are read once, each bill's payment is one
     index probe, and Zoho's reference is looked up only for the few that fit the amount. */
  with open_paid as (
    select e.id, e.zoho_doc_id as zdoc, e.zoho_leg, e.vendor_name, e.category,
           coalesce(e.paid_date, e.expense_date) as paid_on,
           e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) as cash
      from public.expenses e
     where e.tenant_id = v_txn.tenant_id
       and e.zoho_doc_id is not null
       and e.bank_account_id = v_txn.bank_account_id
       and e.paid = true and e.reconciled_txn_id is null
       and coalesce(e.paid_date, e.expense_date) between v_txn.txn_date - 60 and v_txn.txn_date + 60
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.category <> 'Salaries'
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
  ),
  docs0 as (
    select o.zdoc,
           coalesce(nullif(btrim((array_agg(o.vendor_name order by o.zoho_leg))[1]), ''), (array_agg(o.category order by o.zoho_leg))[1]) as who,
           min(o.paid_on) as paid_on, sum(o.cash)::integer as cash
      from open_paid o
     group by o.zdoc
  ),
  docs as (
    /* which Zoho vendor payment paid the bill (R-2502 links: one row per payment + Zoho bill id; an
       imported bill's zoho_doc_id is 'bills:<that id>') — one index probe per document
       (zoho_vendor_payment_links_bill_idx: tenant_id, zoho_bill_id) */
    select d.*,
           case when d.zdoc like 'bills:%' then
             (select min(lk.zoho_payment_id) from public.zoho_vendor_payment_links lk
               where lk.tenant_id = v_txn.tenant_id and lk.zoho_bill_id = substr(d.zdoc, 7) and lk.target_type = 'expense')
           end as pay_id
      from docs0 d
  ),
  pays as (
    select d.pay_id, (array_agg(d.who order by d.zdoc))[1] as who, min(d.paid_on) as paid_on,
           sum(d.cash)::integer as open_sum, count(*)::integer as n
      from docs d
     where d.pay_id is not null
     group by d.pay_id
  ),
  units as (
    /* paid: a document no Zoho vendor payment is linked to */
    select d.zdoc as k, d.who, 'paid'::text as what, d.paid_on as anchor, d.cash,
           d.paid_on - 7 as d_from, d.paid_on + 7 as d_to,
           case when d.zdoc like 'expenses:%' then 'expenses' end as ref_kind, substr(d.zdoc, 10) as ref_id
      from docs d
     where d.pay_id is null
    union all
    /* payment: what one Zoho vendor payment paid, as one debit */
    select 'payment:' || p.pay_id,
           p.who || case when p.n > 1 then ' and ' || (p.n - 1) || ' more bill' || case when p.n > 2 then 's' else '' end else '' end
                 || case when pa.amount is distinct from p.open_sum and pa.amount is not null then ' (one Zoho payment)' else '' end,
           'paid', p.paid_on, coalesce(pa.amount, p.open_sum), p.paid_on - 7, p.paid_on + 7, 'vendorpayments', p.pay_id
      from pays p
      left join public.zoho_fy_scan sc on sc.tenant_id = v_txn.tenant_id and sc.kind = 'vendorpayments' and sc.zoho_id = p.pay_id
      cross join lateral (select case when coalesce(sc.payload->>'amount', '') ~ '^[0-9]+(\.[0-9]+)?$'
                                      then round((sc.payload->>'amount')::numeric)::integer end as amount) pa
    union all
    /* bill: an unpaid Zoho bill kept as expense rows */
    select e.zoho_doc_id, coalesce(nullif(btrim((array_agg(e.vendor_name order by e.zoho_leg))[1]), ''), (array_agg(e.category order by e.zoho_leg))[1]),
           'bill', min(e.expense_date),
           sum(e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))::integer,
           min(e.expense_date) - 7, min(e.expense_date) + 120, null::text, null::text
      from public.expenses e
     where e.tenant_id = v_txn.tenant_id and e.zoho_doc_id like 'bills:%'
       and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.expense_date between v_txn.txn_date - 120 and v_txn.txn_date + 7
     group by e.zoho_doc_id
    union all
    /* bill: an unpaid / part-paid Zoho COGS bill — what is due, with and without its Zoho TDS */
    select vb.zoho_doc_id || t.tag, coalesce(nullif(btrim(vb.vendor_name), ''), vb.category), 'bill', vb.bill_date,
           (vb.total - coalesce(vb.paid_amount, 0) - t.tds)::integer, vb.bill_date - 7, vb.bill_date + 120, null::text, null::text
      from public.vendor_bills vb
      cross join lateral (
        select ''::text as tag, 0 as tds
        union all
        select ':tds', coalesce(vb.zoho_tds_amount, 0) where coalesce(vb.zoho_tds_amount, 0) > 0 and coalesce(vb.paid_amount, 0) = 0
      ) t
     where vb.tenant_id = v_txn.tenant_id and vb.zoho_doc_id is not null
       and coalesce(vb.status, 'unpaid') <> 'paid'
       and upper(coalesce(vb.currency, 'INR')) = 'INR'
       and vb.total - coalesce(vb.paid_amount, 0) > 0
       and vb.bill_date between v_txn.txn_date - 120 and v_txn.txn_date + 7
  ),
  mine as materialized (
    /* the few documents with this line's amount — only for these is Zoho's reference looked up */
    select u.*, abs(u.anchor - v_txn.txn_date) as gap,
           coalesce(u.what = 'paid' and u.ref_kind is not null and abs(u.anchor - v_txn.txn_date) <= 60
                    and length(public.bank_ref_norm(v_txn.ref_key)) >= 10
                    and public.bank_ref_matches(
                          (select nullif(btrim(sc.payload->>'reference'), '') from public.zoho_fy_scan sc
                            where sc.tenant_id = v_txn.tenant_id and sc.kind = u.ref_kind and sc.zoho_id = u.ref_id),
                          v_txn.ref_key), false) as by_ref
      from units u
     where u.cash > 0 and abs(u.cash - v_txn.debit) <= 1
  ),
  fit as (
    select m.* from mine m
     where m.by_ref or v_txn.txn_date between m.d_from and m.d_to
  ),
  better as (
    /* other OPEN debits of this account that fit one of those documents and are nearer to it */
    select count(distinct o.id) as n
      from public.bank_transactions o
      join fit m on abs(m.cash - o.debit) <= 1 and o.txn_date between m.d_from and m.d_to
     where o.tenant_id = v_txn.tenant_id and o.bank_account_id = v_txn.bank_account_id and o.id <> v_txn.id
       and o.debit between v_txn.debit - 2 and v_txn.debit + 2
       and coalesce(o.credit, 0) = 0 and o.matched_to_type is null
       and (abs(m.anchor - o.txn_date), o.id) < ((select min(f.gap) from fit f), v_txn.id)
  )
  select f.who, f.what, f.anchor, f.cash
    into v_z_who, v_z_what, v_z_on, v_z_cash
    from fit f
   where f.by_ref
      or (select b.n from better b) < (select count(*) from fit)
   order by f.by_ref desc, f.gap, (f.what = 'paid') desc, f.k
   limit 1;
  if v_z_cash is not null and v_z_what = 'bill' then
    raise exception 'This debit looks like the payment of a bill already imported from Zoho (%, bill dated %, ₹%). Pay that bill with "Record payment" on this line instead of booking a new expense, or the cost is counted twice.',
      v_z_who, to_char(v_z_on, 'DD Mon YYYY'), to_char(v_z_cash, 'FM99,99,99,99,999')
      using errcode = 'P0001', hint = 'R-2680';
  elsif v_z_cash is not null then
    raise exception 'This debit looks like a purchase already imported from Zoho (%, paid %, ₹%). Match the line to it in Reconcile instead of booking a new expense, or the cost is counted twice.',
      v_z_who, to_char(v_z_on, 'DD Mon YYYY'), to_char(v_z_cash, 'FM99,99,99,99,999')
      using errcode = 'P0001', hint = 'R-2680';
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description,
     paid, paid_date, bank_account_id, reconciled_txn_id)
  values
    (v_exp_id, v_tenant, trim(p_category), v_vendor,
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description),
     true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id and tenant_id = v_tenant
     and matched_to_type is null;   -- R-2611: never over another booking
  if not found then
    raise exception 'This line is already reconciled' using errcode = 'P0001', hint = 'R-2611';
  end if;
  return v_exp_id;
end;
$function$
;

commit;
