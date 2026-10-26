-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.vendor_statement(uuid)') and prosrc like '%R-1921%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.payables_ageing()') and prosrc like '%R-1921%')
-- deploy-key: r1921vendorstatementageing
-- 20261026171338_r1921_vendor_statement_payables_ageing.sql
--
-- R-1921 (26 Oct 2026, p2, goal G-RECON — R-1906 audit F4). Two READ functions, nothing stored:
--
--   vendor_statement(vendor)  the vendor's dated statement — every bill, the TDS withheld, every
--                             payment (bank parts, Bills-page / payment-run lines, bills marked
--                             paid outside the bank), every advance paid, every set-off of an
--                             advance against a bill (no money moves: 0), an advance closed.
--                             amount: + = we owe the vendor more, − = it came off.
--                             The rows ADD UP to what the vendor popup and the Balance Sheet say:
--                                 Σ amount = open COGS bills (total − paid_amount, not paid)
--                                          + open expense bills (amount − tds − advance_applied − paid_amount,
--                                            R-1952 "still due", the popup's isOpenExpenseBill rule)
--                                          − advance left (total − consumed, open advances).
--                             When a document's own events do not explain its balance (an old row
--                             paid some other way) ONE 'adjustment' row says the difference — the
--                             closing balance is never a second opinion. A clean book has none
--                             (supabase/tests/r1921_vendor_statement.test.sql proves it for the
--                             R-1906 six cases).
--   payables_ageing()         what we owe each vendor today, by days past the due date
--                             (due_date, else the bill date): not due, 1–30, 31–60, 61–90, 90+,
--                             net of part payments, TDS and advances applied (the same still-due
--                             as above), plus the advance still with the vendor and the net.
--
-- Sources and the rules they follow (latest definitions read):
--   still due of an expense bill        20261026012117_r1952 (payment_run_outstanding / BS)
--   COGS payables                       report_balance_sheet: vendor_bills total − paid_amount, status <> 'paid'
--   bank parts                          bank_vendor_payment_lines (R-1866/R-1911/R-1914/R-1915)
--   advance set-offs                    vendor_advance_applications (R-1913/R-1914), consume_prepaid_fifo rows
-- Both run as the caller (RLS) and refuse without a tenant. Test: supabase/tests/r1921_vendor_statement.test.sql

begin;

create or replace function public.vendor_statement(p_vendor_id uuid)
returns table (
  entry_date      date,
  seq             integer,   -- order inside one day: bill 1, TDS 2, advance set-off 3, payment 4, advance 5, closed 6, adjustment 9
  kind            text,      -- bill | tds | set_off | payment | advance | advance_closed | adjustment
  doc_id          text,      -- the bill / expense id, or the advance id
  doc_ref         text,      -- the bill no (or the bills a payment paid)
  particulars     text,
  amount          bigint,    -- + we owe more, − came off; set_off rows are 0
  set_off         bigint,    -- set_off rows: the advance used on the bill
  bank_txn_id     uuid,
  bank_account_id uuid
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  /* R-1921: a vendor's running statement — rows add up to the popup's net and the Balance Sheet. */
  v_tenant uuid := public.current_tenant_id();
  v_name   text;
begin
  if v_tenant is null then
    raise exception 'No company context — sign in again' using errcode = 'insufficient_privilege';
  end if;
  select upper(trim(v.name)) into v_name from public.vendors v where v.id = p_vendor_id and v.tenant_id = v_tenant;
  if not found then raise exception 'Vendor not found'; end if;

  return query
  with
  bills as (
    select b.* from public.vendor_bills b where b.tenant_id = v_tenant and b.vendor_id = p_vendor_id
  ),
  exps as (
    -- The vendor's expense bills: not salary / payroll / statutory / EMI / a reimbursement, not a
    -- bank charge the payment step booked, and an 'advance' row only when it IS a bill settled
    -- from the advance (R-1913 advance_applied, or a Prepaid → Book invoice row).
    select e.* from public.expenses e
     where e.tenant_id = v_tenant and e.vendor_id = p_vendor_id
       and coalesce(e.category, '') <> 'Salaries'
       and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'employee_advance')
       and (coalesce(e.payment_method, '') <> 'advance' or e.prepaid_advance_id is not null or coalesce(e.advance_applied, 0) > 0)
       and not exists (select 1 from public.bank_vendor_payment_lines l
                        where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'bank_charge')
  ),
  advs as (
    select a.* from public.prepaid_advances a
     where a.tenant_id = v_tenant and coalesce(a.category, '') <> 'Employee advance'
       and (a.vendor_id = p_vendor_id or (a.vendor_id is null and upper(trim(coalesce(a.vendor_name, ''))) = v_name))
  ),
  legs as (
    select l.*, t.txn_date, t.bank_account_id as acct,
           coalesce(b.bill_no, e.bill_no, l.vendor_bill_id, l.expense_id) as no
      from public.bank_vendor_payment_lines l
      join public.bank_transactions t on t.id = l.bank_txn_id
      left join bills b on b.id = l.vendor_bill_id
      left join exps  e on e.id = l.expense_id
     where l.tenant_id = v_tenant
       and l.kind in ('bill', 'new_bill', 'expense', 'new_expense', 'recorded_payment')
       and (b.id is not null or e.id is not null)
  ),
  ev as (
    -- 1. Bills
    select b.bill_date as d, 1 as s, 'bill'::text as k, b.id as doc, b.bill_no as ref,
           'Bill ' || coalesce(b.bill_no, b.id) || coalesce(' · ' || b.category, '') as txt,
           coalesce(b.total, 0)::bigint as amt, 0::bigint as so, null::uuid as txn, null::uuid as acct
      from bills b
    union all
    select e.expense_date, 1, 'bill', e.id, e.bill_no,
           'Bill ' || coalesce(e.bill_no, e.id) || coalesce(' · ' || e.category, ''),
           coalesce(e.amount, 0)::bigint, 0, null, null
      from exps e
    -- 2. TDS withheld: on an expense bill (its tds_amount, dated when the bank first took it,
    --    else the bill date); on a COGS bill (194Q, on the bank part). A Prepaid → Book invoice
    --    row is settled from the advance in full, so its TDS never reduced what the vendor got.
    union all
    select coalesce((select min(l.txn_date) from legs l where l.expense_id = e.id and l.tds_amount > 0), e.expense_date),
           2, 'tds', e.id, e.bill_no,
           'TDS' || coalesce(' ' || nullif(trim(e.tds_section), ''), '') || ' withheld on bill ' || coalesce(e.bill_no, e.id),
           -e.tds_amount::bigint, 0, null, null
      from exps e where coalesce(e.tds_amount, 0) > 0 and e.prepaid_advance_id is null
    union all
    select l.txn_date, 2, 'tds', l.vendor_bill_id, l.no,
           'TDS' || coalesce(' ' || nullif(trim(l.tds_section), ''), '') || ' withheld on bill ' || l.no,
           -l.tds_amount::bigint, 0, l.bank_txn_id, l.acct
      from legs l where l.kind in ('bill', 'new_bill') and l.tds_amount > 0
    -- 3. Advance set off against a bill — no money moves (the bill goes down, the advance too).
    union all
    select a.applied_on, 3, 'set_off', coalesce(a.expense_id, a.vendor_bill_id),
           coalesce(e.bill_no, b.bill_no),
           'Advance set off against bill ' || coalesce(e.bill_no, b.bill_no, a.expense_id, a.vendor_bill_id),
           0, a.amount::bigint, null, null
      from public.vendor_advance_applications a
      left join exps e on e.id = a.expense_id
      left join bills b on b.id = a.vendor_bill_id
     where a.tenant_id = v_tenant and (e.id is not null or b.id is not null)
    union all
    select e.expense_date, 3, 'set_off', e.id, e.bill_no,
           'Advance set off against bill ' || coalesce(e.bill_no, e.id),
           0, coalesce(e.amount, 0)::bigint, null, null
      from exps e where e.prepaid_advance_id is not null
    -- 4. Payments: the bank parts, one row per bank line
    union all
    select l.txn_date, 4, 'payment', min(coalesce(l.vendor_bill_id, l.expense_id)),
           string_agg(distinct l.no, ', '),
           'Paid from bank · ' || case when count(distinct l.no) = 1 then 'bill ' else 'bills ' end || string_agg(distinct l.no, ', '),
           -sum(l.cash)::bigint, 0, l.bank_txn_id, l.acct
      from legs l group by l.bank_txn_id, l.txn_date, l.acct
    --    a bank line matched straight to a COGS bill (Bills page Pay / payment run = 'manual', or a real line)
    union all
    select t.txn_date, 4, 'payment', b.id, b.bill_no,
           case when t.source = 'manual' then 'Paid (recorded on the Bills page) · bill ' else 'Paid from bank · bill ' end
             || coalesce(b.bill_no, b.id),
           -coalesce(t.debit, 0)::bigint, 0, t.id, t.bank_account_id
      from public.bank_transactions t join bills b on b.id = t.matched_to_id
     where t.tenant_id = v_tenant and t.matched_to_type = 'vendor_bill'
    --    an expense bill paid with no bank part: its bank match, or marked paid (cash, card, UPI)
    union all
    select coalesce(t.txn_date, e.paid_date, e.expense_date), 4, 'payment', e.id, e.bill_no,
           case when t.id is not null then 'Paid from bank · bill ' else 'Paid (' || coalesce(nullif(e.payment_method, ''), 'marked paid') || ') · bill ' end
             || coalesce(e.bill_no, e.id),
           -(coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))::bigint,
           0, t.id, t.bank_account_id
      from exps e
      left join public.bank_transactions t on t.id = e.reconciled_txn_id and t.tenant_id = v_tenant
     where not exists (select 1 from legs l where l.expense_id = e.id)
       and e.prepaid_advance_id is null
       and (e.reconciled_txn_id is not null or (e.paid and coalesce(e.payment_method, '') <> 'advance'))
       and coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
    -- 5. Advances paid
    union all
    select coalesce(a.paid_date, a.created_at::date), 5, 'advance', a.id::text, null,
           'Advance paid' || case when a.bank_txn_id is not null or exists (select 1 from public.bank_vendor_payment_lines l
                                     where l.tenant_id = v_tenant and l.prepaid_advance_id = a.id and l.kind = 'advance')
                                  then ' from bank' else coalesce(' (' || nullif(a.payment_method, '') || ')', '') end,
           -coalesce(a.total_amount, 0)::bigint, 0, a.bank_txn_id, a.bank_account_id
      from advs a
    -- 6. An advance closed with money left on it: that rest is no longer with the vendor.
    union all
    select (a.closed_at at time zone 'Asia/Kolkata')::date, 6, 'advance_closed', a.id::text, null,
           'Advance closed — rest not carried',
           greatest(0, coalesce(a.total_amount, 0) - coalesce(a.consumed_amount, 0))::bigint, 0, null, null
      from advs a where a.closed_at is not null and coalesce(a.total_amount, 0) > coalesce(a.consumed_amount, 0)
  ),
  official as (
    -- What the popup and the Balance Sheet carry for this vendor.
    select
      coalesce((select sum(greatest(0, coalesce(b.total, 0) - coalesce(b.paid_amount, 0))) from bills b
                 where coalesce(b.status, 'unpaid') <> 'paid'), 0)
    + coalesce((select sum(coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))
                  from exps e
                 where e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
                   and coalesce(e.payment_method, '') <> 'advance'
                   and coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0), 0)
    - coalesce((select sum(greatest(0, coalesce(a.total_amount, 0) - coalesce(a.consumed_amount, 0))) from advs a
                 where a.closed_at is null), 0) as net
  )
  select ev.d, ev.s, ev.k, ev.doc, ev.ref, ev.txt, ev.amt, ev.so, ev.txn, ev.acct from ev
  union all
  select public.ist_today(), 9, 'adjustment', null, null,
         'Difference not explained by the entries above (paid or changed some other way)',
         (o.net - coalesce((select sum(ev.amt) from ev), 0))::bigint, 0, null, null
    from official o
   where o.net <> coalesce((select sum(ev.amt) from ev), 0)
  order by 1, 2, 5 nulls last, 4;
end
$function$;
revoke all on function public.vendor_statement(uuid) from public, anon;
grant execute on function public.vendor_statement(uuid) to authenticated, service_role;
comment on function public.vendor_statement(uuid) is
  'R-1921: a vendor''s dated statement (bills, TDS, payments, advances, set-offs). Σ amount = open bills − advance left (popup net / Balance Sheet).';

create or replace function public.payables_ageing()
returns table (
  vendor_id   uuid,
  vendor_name text,
  not_due     bigint,
  d1_30       bigint,
  d31_60      bigint,
  d61_90      bigint,
  d90_plus    bigint,
  total       bigint,   -- = not_due + the four buckets: what we owe on open bills
  advance     bigint,   -- advance still with the vendor (not yet set off)
  net         bigint,   -- total − advance = the statement's closing balance
  oldest_days integer,  -- days past due of the oldest open bill (≤ 0: none overdue)
  bills       integer   -- open bills counted
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  /* R-1921: payables by days past due — the same still-due as vendor_statement. */
  v_tenant uuid := public.current_tenant_id();
  v_today  date := public.ist_today();
begin
  if v_tenant is null then
    raise exception 'No company context — sign in again' using errcode = 'insufficient_privilege';
  end if;

  return query
  with
  vn as (select v.id, v.name, upper(trim(v.name)) as uname from public.vendors v where v.tenant_id = v_tenant),
  items as (
    select b.vendor_id as vid, b.vendor_name as vname,
           greatest(0, coalesce(b.total, 0) - coalesce(b.paid_amount, 0))::bigint as due,
           (v_today - coalesce(b.due_date, b.bill_date))::int as days
      from public.vendor_bills b
     where b.tenant_id = v_tenant and coalesce(b.status, 'unpaid') <> 'paid'
       and coalesce(b.total, 0) > coalesce(b.paid_amount, 0)
    union all
    select e.vendor_id, e.vendor_name,
           (coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))::bigint,
           (v_today - coalesce(e.due_date, e.expense_date))::int
      from public.expenses e
     where e.tenant_id = v_tenant and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
       and coalesce(e.category, '') <> 'Salaries'
       and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and coalesce(e.amount, 0) - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
  ),
  advs as (
    select a.vendor_id as vid, a.vendor_name as vname,
           greatest(0, coalesce(a.total_amount, 0) - coalesce(a.consumed_amount, 0))::bigint as left_
      from public.prepaid_advances a
     where a.tenant_id = v_tenant and a.closed_at is null and coalesce(a.category, '') <> 'Employee advance'
       and coalesce(a.total_amount, 0) > coalesce(a.consumed_amount, 0)
  ),
  -- A row with no vendor record goes to the vendor of that name when there is one.
  keyed as (
    select coalesce(i.vid, (select vn.id from vn where vn.uname = upper(trim(coalesce(i.vname, ''))) limit 1)) as vid,
           upper(trim(coalesce(i.vname, 'Vendor'))) as uname, i.vname, i.due, i.days, 0::bigint as adv
      from items i
    union all
    select coalesce(a.vid, (select vn.id from vn where vn.uname = upper(trim(coalesce(a.vname, ''))) limit 1)),
           upper(trim(coalesce(a.vname, 'Vendor'))), a.vname, 0, null, a.left_
      from advs a
  ),
  g as (
    select k.vid, case when k.vid is null then k.uname end as nkey, min(k.vname) as any_name,
           sum(case when k.days is not null and k.days <= 0 then k.due else 0 end)::bigint as nd,
           sum(case when k.days between 1 and 30 then k.due else 0 end)::bigint as b1,
           sum(case when k.days between 31 and 60 then k.due else 0 end)::bigint as b2,
           sum(case when k.days between 61 and 90 then k.due else 0 end)::bigint as b3,
           sum(case when k.days > 90 then k.due else 0 end)::bigint as b4,
           sum(k.due)::bigint as tot, sum(k.adv)::bigint as adv,
           max(k.days)::int as oldest, count(k.days)::int as n
      from keyed k
     group by k.vid, case when k.vid is null then k.uname end
  )
  select g.vid, coalesce(vn.name, g.any_name, 'Vendor'), g.nd, g.b1, g.b2, g.b3, g.b4, g.tot, g.adv, g.tot - g.adv,
         coalesce(g.oldest, 0), g.n
    from g left join vn on vn.id = g.vid
   order by g.tot - g.adv desc, 2;
end
$function$;
revoke all on function public.payables_ageing() from public, anon;
grant execute on function public.payables_ageing() to authenticated, service_role;
comment on function public.payables_ageing() is
  'R-1921: payables by days past due (not due / 1–30 / 31–60 / 61–90 / 90+), net of part payments, TDS and advances applied; advance left and net per vendor.';

commit;
