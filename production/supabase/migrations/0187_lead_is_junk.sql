-- 0187 — Mark a lead as JUNK (spam / fake / test enquiry) and keep it out of
-- the working views.
--
-- Website forms + inbound email pull in noise (test entries, gibberish, no real
-- contact). Rather than delete (which loses the audit trail + lets the same spam
-- re-enter), we flag it. Junk leads drop out of every working view (All, Mine,
-- Today, Hot, New…) and live only in a dedicated "Junk" view, where they can be
-- restored or deleted. A partial index keeps the "hide junk" filter fast.

alter table public.leads
  add column if not exists is_junk boolean not null default false;

create index if not exists leads_tenant_active_idx
  on public.leads (tenant_id)
  where is_junk = false;

comment on column public.leads.is_junk is 'true = spam/fake/test lead; hidden from working views, shown only in the Junk view';
