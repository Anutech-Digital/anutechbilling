-- 0184 — Keep a PROJECT invoice's paid_amount + status in sync with its receipts
--
-- Project milestone receipts live in project_payments (not the `payments` table),
-- so an invoice raised from a milestone never learned it was (part-)paid — it sat
-- at status='pending' for the full amount, overstating receivables and showing
-- "Pending" in the Invoices list even after money came in.
--
-- Fix: track invoices.paid_amount and recompute it (+ flip status paid/pending)
-- from a trigger on project_payments, so EVERY path (record_project_payment RPC,
-- bank-reconcile link, manual) keeps the invoice honest. "Partially paid" is a
-- display state derived from 0 < paid_amount < amount — no new status enum value.

alter table public.invoices
  add column if not exists paid_amount integer not null default 0;

create or replace function public.sync_project_invoice_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ms   uuid[];
  v_inv  text;
  v_amt  integer;
  v_paid integer;
begin
  -- Milestone(s) touched by this change (INSERT → NEW, DELETE → OLD, UPDATE → both).
  v_ms := array_remove(array[
    case when tg_op <> 'INSERT' then old.milestone_id end,
    case when tg_op <> 'DELETE' then new.milestone_id end
  ], null);

  for v_inv in
    select distinct m.invoice_id
      from public.project_milestones m
     where m.id = any(v_ms) and m.invoice_id is not null
  loop
    select amount into v_amt from public.invoices where id = v_inv;
    select coalesce(sum(pp.amount), 0) into v_paid
      from public.project_payments pp
      join public.project_milestones m on m.id = pp.milestone_id
     where m.invoice_id = v_inv;
    update public.invoices
       set paid_amount = v_paid,
           status      = (case when v_paid >= coalesce(v_amt, 0) then 'paid' else 'pending' end)::invoice_status
     where id = v_inv;
  end loop;

  return null;
end
$$;

drop trigger if exists trg_project_payment_sync_invoice on public.project_payments;
create trigger trg_project_payment_sync_invoice
  after insert or update or delete on public.project_payments
  for each row execute function public.sync_project_invoice_paid();

-- Backfill every existing project invoice from its current receipts.
update public.invoices i
   set paid_amount = sub.paid,
       status      = (case when sub.paid >= i.amount then 'paid' else 'pending' end)::invoice_status
  from (
    select m.invoice_id, coalesce(sum(pp.amount), 0) as paid
      from public.project_milestones m
      join public.project_payments pp on pp.milestone_id = m.id
     where m.invoice_id is not null
     group by m.invoice_id
  ) sub
 where i.id = sub.invoice_id;

comment on column public.invoices.paid_amount is 'Total received against this invoice (maintained for project invoices by trg_project_payment_sync_invoice). Outstanding = amount - paid_amount unless status=paid.';
