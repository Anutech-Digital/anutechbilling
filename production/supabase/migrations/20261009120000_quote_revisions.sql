-- deploy-key: quoterevise
-- deploy-peek: exists(select 1 from pg_trigger where tgname='trg_quote_revision_sent') and exists(select 1 from pg_trigger where tgname='trg_quote_accepted_sync_lead')
-- 20261009120000_quote_revisions
--
-- WHAT THIS CHANGES (R-482 / board R-448 + R-452, 9 Oct 2026 — Abhishek's Scenarios 5, 6, 8)
--   A SENT quote could not be revised. "Duplicate & edit" made a second quote and the
--   first stayed 'sent', so the customer's old link still said "Accept this quote · ₹57,348"
--   and a payment recorded on it created a second subscription (proved locally: Mehta
--   Consultants ended up with 12 + 15 seats).
--
--   1. quotes.revision_of / revision_no — a revision keeps the family: Q-…-0005 → Q-…-0005-R2.
--      revision_of is the FIRST quote of the family, revision_no counts from 1.
--   2. quotes.superseded_by / superseded_at — the old quote points at the one that replaced
--      it. Its status becomes 'expired' (no new enum value: every status switch in the app
--      already treats expired as closed), and the app shows "Replaced by …".
--   3. trg_quote_revision_sent — when a revision goes out (inserted as sent, or moved from
--      draft to sent by ANY path: builder, Mark as sent, the email route), the family's other
--      open quotes (sent/viewed, no money, no invoice) are marked replaced by it. A revision
--      still in draft replaces nothing — the customer has not seen it yet.
--   4. trg_quote_superseded_guard — a replaced quote can never be accepted again, by any
--      path (public accept, Mark accepted, record_payment).
--   5. trg_quote_accepted_sync_lead — when a quote is accepted: the lead's seats/value
--      follow THAT quote (value is the ex-GST subtotal, as the leads board already stores
--      it), and the lead's OLDER open quotes (sent/viewed, no money, no invoice) are closed
--      as replaced by it — so an old link cannot be accepted after the deal is won.
--   6. quotes.rejected_reason / rejected_note (board R-452) — "Mark rejected" now asks why,
--      with the same reason codes as a lost lead (lib/leads/loss-reasons.ts).
--
--   (3) and (5) are SECURITY DEFINER: a rep whose RLS lets them send/accept a quote may not
--   be allowed to write the lead or a colleague's older quote. Both only touch rows of
--   NEW.tenant_id, and only the family / lead named on NEW.

alter table public.quotes
  add column if not exists revision_of     text,
  add column if not exists revision_no     integer not null default 1,
  add column if not exists superseded_by   text,
  add column if not exists superseded_at   timestamptz,
  add column if not exists rejected_reason text,
  add column if not exists rejected_note   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_superseded_by_fkey') then
    alter table public.quotes
      add constraint quotes_superseded_by_fkey foreign key (superseded_by)
      references public.quotes(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_revision_of_fkey') then
    alter table public.quotes
      add constraint quotes_revision_of_fkey foreign key (revision_of)
      references public.quotes(id) on delete set null;
  end if;
end $$;

create index if not exists quotes_revision_of_idx on public.quotes(revision_of) where revision_of is not null;

-- ── 3. a revision that goes out replaces the family's open quotes ─────────
create or replace function public.tg_quote_revision_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revision_of is not null
     and new.status in ('sent', 'viewed')
     and (tg_op = 'INSERT' or old.status = 'draft') then
    update public.quotes q
       set status = 'expired', superseded_by = new.id, superseded_at = now()
     where q.tenant_id = new.tenant_id
       and (q.id = new.revision_of or q.revision_of = new.revision_of)
       and q.id <> new.id
       and q.status in ('sent', 'viewed')
       and q.superseded_by is null
       and q.invoice_id is null
       and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting')
       and not exists (select 1 from public.payments p where p.quote_id = q.id and p.status = 'received');
  end if;
  return new;
end;
$$;

revoke all on function public.tg_quote_revision_sent() from public;
revoke all on function public.tg_quote_revision_sent() from anon;

drop trigger if exists trg_quote_revision_sent on public.quotes;
create trigger trg_quote_revision_sent
  after insert or update of status on public.quotes
  for each row execute function public.tg_quote_revision_sent();

-- ── 4. a replaced quote cannot be accepted ─────────────────────────────────
create or replace function public.tg_quote_superseded_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.superseded_by is not null
     and new.status = 'accepted' and old.status is distinct from 'accepted' then
    raise exception 'Quote % was replaced by % — use the new quote.', old.id, old.superseded_by
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quote_superseded_guard on public.quotes;
create trigger trg_quote_superseded_guard
  before update of status on public.quotes
  for each row execute function public.tg_quote_superseded_guard();

-- ── 5. accepted → lead follows this quote; older open quotes close ─────────
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

    update public.quotes q
       set status = 'expired', superseded_by = new.id, superseded_at = now()
     where q.tenant_id = new.tenant_id
       and q.lead_id = new.lead_id
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

drop trigger if exists trg_quote_accepted_sync_lead on public.quotes;
create trigger trg_quote_accepted_sync_lead
  after update of status on public.quotes
  for each row execute function public.tg_quote_accepted_sync_lead();

notify pgrst, 'reload schema';
