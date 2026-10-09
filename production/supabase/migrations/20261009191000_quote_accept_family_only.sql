-- deploy-key: quoteacceptfamily
-- deploy-peek: position('revision_of' in pg_get_functiondef('public.tg_quote_accepted_sync_lead()'::regprocedure)) > 0
-- 20261009191000_quote_accept_family_only
--
-- WHAT THIS CHANGES (R-495 — Pardeep's decision 2B, 9 Oct 2026)
--   R-482 (20261009120000_quote_revisions.sql, trg_quote_accepted_sync_lead) closed the
--   LEAD's older open quotes when any quote was accepted. A lead can carry quotes for
--   different products: accepting the Workspace R2 also closed the separate hosting quote
--   the customer had not answered yet ("replaced by" a quote that did not replace it).
--
--   Now an accepted quote closes only the older open versions of ITS OWN FAMILY — the
--   revision chain: the family key is revision_of (the first quote) or, for the first
--   quote itself, its own id. Other open quotes on the same lead stay open.
--
--   Unchanged: the lead's seats/value still follow the accepted quote; same safety filters
--   (sent/viewed only, not already replaced, no invoice, no money received); only rows of
--   NEW.tenant_id. Still SECURITY DEFINER (a rep may accept a quote but not be allowed to
--   write the lead or a colleague's older version), still revoked from public and anon.
--   A trigger function needs no execute grant (R-401 guard: trigger functions are exempt).

create or replace function public.tg_quote_accepted_sync_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' and new.lead_id is not null then
    update public.leads
       set seats = coalesce(nullif(new.seats, 0), seats),
           value = coalesce(nullif(new.subtotal, 0), value)
     where id = new.lead_id
       and tenant_id = new.tenant_id;

    -- R-495: only this quote's family (revision_of chain), never the lead's other products.
    update public.quotes q
       set status = 'expired', superseded_by = new.id, superseded_at = now()
     where q.tenant_id = new.tenant_id
       and coalesce(q.revision_of, q.id) = coalesce(new.revision_of, new.id)
       and q.id <> new.id
       and q.status in ('sent', 'viewed')
       and q.superseded_by is null
       and q.created_at < new.created_at
       and q.invoice_id is null
       and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting')
       and not exists (select 1 from public.payments p where p.quote_id = q.id and p.status = 'received');
  end if;
  return new;
end;
$$;

revoke all on function public.tg_quote_accepted_sync_lead() from public;
revoke all on function public.tg_quote_accepted_sync_lead() from anon;

notify pgrst, 'reload schema';
