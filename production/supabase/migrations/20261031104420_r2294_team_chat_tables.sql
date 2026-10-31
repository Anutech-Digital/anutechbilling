-- deploy-peek: to_regclass('public.chat_message_edits') is not null and to_regprocedure('public.is_chat_member(uuid)') is not null and to_regprocedure('public.chat_can_read(uuid)') is not null
-- deploy-key: r2294teamchattables
-- 20261031104420_r2294_team_chat_tables.sql
--
-- R-2294 (G-TEAMCHAT TC-01, 31 Oct 2026): team chat tables + membership RLS.
-- Pardeep (31 Oct): "app me team chat ka full management system hona chahiye taki koi problem ho
-- ya suggestion ho to ek doosre ke easily file link share kar sake aur chat kar sake."
-- Plan: Anutech-HQ/drafts/TEAM-CHAT/audit-and-plan.md §2 (data model, security). Pardeep accepted
-- the 9 recommendations: channels by owner/manager, DMs by anyone, the OWNER DOES NOT READ other
-- people's DMs, team chat hidden from partner_agent and personal users.
--
-- WHAT IS HERE
--   tables   chat_channels, chat_members, chat_messages, chat_attachments, chat_message_edits
--   helpers  chat_is_staff()           caller is an active staff login of their tenant
--                                      (not partner_agent / personal / personal workspace)
--            is_chat_member(channel)   caller is staff AND has a member row in that channel of
--                                      their own tenant — the posting rule for R-2295's RPCs
--            chat_can_read(channel)    staff AND (public channel OR member) — the read rule
--            chat_can_read_edits(ch)   owner/manager who can read that channel, never a DM
--            chat_links_ok(jsonb)      links are [{type,id}] only — never amounts or names
--   All helpers: STABLE (links: IMMUTABLE), SECURITY DEFINER, search_path '', FAIL-CLOSED — a
--   NULL channel, user or tenant gives false (CLAUDE.md §17c).
--
-- RLS: SELECT-only policies for authenticated. There is NO insert/update/delete policy or grant
-- for signed-in users: every write goes through SECURITY DEFINER RPCs (R-2295, §17b). The
-- service_role gets zzz_service_role_all (R-450, Cloud SQL has no BYPASSRLS). Every table also
-- carries the G-PERSONAL wall (gp09_personal_wall, RESTRICTIVE) — FOR SELECT only, because a
-- FOR ALL policy would make cloudsql/09 grant authenticated insert/update/delete. cloudsql/09
-- needs no edit: it grants exactly what these policies cover (SELECT).
--
-- Tenant safety: every child row carries tenant_id with a COMPOSITE foreign key to its parent
-- (tenant_id, id), so a row can never point across tenants; a trigger refuses a member / author /
-- uploader / editor whose users.tenant_id differs. Attachment paths must sit in
-- {tenant}/chat/{channel}/ (the storage rule is R-2297).
--
-- No money in these tables, so no books-lock trigger.
-- Test: supabase/tests/team_chat_rls.test.sql. Re-runnable.

begin;

-- ── helper: links hold {type,id} only ───────────────────────────────────────────────
create or replace function public.chat_links_ok(p_links jsonb) returns boolean
  language sql immutable set search_path = ''
as $$
  -- R-2294: a chat message links app records by id ONLY. The reader's own RLS fetches the
  -- preview, so an amount or a name must never be stored in the message.
  select case
    when p_links is null or pg_catalog.jsonb_typeof(p_links) <> 'array' then false
    when pg_catalog.jsonb_array_length(p_links) > 20 then false
    else not exists (
      select 1
        from pg_catalog.jsonb_array_elements(p_links) as e(v)
       where pg_catalog.jsonb_typeof(e.v) <> 'object'
          or (select pg_catalog.array_agg(k.key order by k.key)
                from pg_catalog.jsonb_object_keys(e.v) as k(key)) is distinct from array['id', 'type']::text[]
          or pg_catalog.jsonb_typeof(e.v -> 'type') <> 'string'
          or pg_catalog.jsonb_typeof(e.v -> 'id') <> 'string'
          or (e.v ->> 'type') !~ '^[a-z_]{1,32}$'
          or pg_catalog.char_length(e.v ->> 'id') not between 1 and 64)
  end;
$$;

-- ── tables ──────────────────────────────────────────────────────────────────────────
create table if not exists public.chat_channels (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null check (kind in ('channel', 'dm')),
  name        text check (name is null or char_length(name) between 1 and 80),
  slug        text check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  topic       text check (topic is null or char_length(topic) <= 250),
  is_private  boolean not null default false,
  -- DM: the two user ids sorted, "uidA:uidB" (uidA < uidB) — one DM per pair per tenant
  dm_key      text,
  created_by  uuid references public.users(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint chat_channels_tenant_id_uq unique (tenant_id, id),
  constraint chat_channels_kind_shape check (
    (kind = 'channel' and name is not null and slug is not null and dm_key is null)
    or (kind = 'dm' and is_private and name is null and slug is null and dm_key is not null
        and dm_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
        and split_part(dm_key, ':', 1) < split_part(dm_key, ':', 2)))
);
comment on table public.chat_channels is
  'R-2294: team chat channels (kind channel, public or private) and 1:1 DMs (kind dm, dm_key = sorted "uidA:uidB"). Staff only; writes via RPCs.';
create unique index if not exists chat_channels_slug_uq
  on public.chat_channels (tenant_id, slug) where kind = 'channel';
create unique index if not exists chat_channels_dm_key_uq
  on public.chat_channels (tenant_id, dm_key) where kind = 'dm';

create table if not exists public.chat_members (
  tenant_id    uuid not null,
  channel_id   uuid not null,
  user_id      uuid not null references public.users(id) on delete cascade,
  member_role  text not null default 'member' check (member_role in ('admin', 'member')),
  last_read_at timestamptz,
  notify       text not null default 'all' check (notify in ('all', 'mentions', 'none')),
  joined_at    timestamptz not null default now(),
  primary key (channel_id, user_id),
  constraint chat_members_channel_fk foreign key (tenant_id, channel_id)
    references public.chat_channels (tenant_id, id) on delete cascade
);
comment on table public.chat_members is
  'R-2294: who is in a team chat channel / DM, with their read mark. Private channels and DMs are readable by members only.';
create index if not exists chat_members_user_idx on public.chat_members (user_id, channel_id);
create index if not exists chat_members_tenant_channel_idx on public.chat_members (tenant_id, channel_id);

create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  channel_id  uuid not null,
  author_id   uuid references public.users(id) on delete set null,
  parent_id   uuid,
  body        text not null default '' check (char_length(body) <= 4000),
  kind        text not null default 'text' check (kind in ('text', 'problem', 'suggestion', 'system')),
  post_status text check (post_status in ('open', 'task', 'reported', 'resolved')),
  mentions    uuid[] not null default '{}' check (cardinality(mentions) <= 50),
  links       jsonb not null default '[]'::jsonb check (public.chat_links_ok(links)),
  task_id     uuid references public.tasks(id) on delete set null,
  feedback_id uuid references public.feedback(id) on delete set null,
  pinned_at   timestamptz,
  pinned_by   uuid references public.users(id) on delete set null,
  edited_at   timestamptz,
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint chat_messages_tenant_id_uq unique (tenant_id, id),
  constraint chat_messages_tenant_channel_id_uq unique (tenant_id, channel_id, id),
  constraint chat_messages_channel_fk foreign key (tenant_id, channel_id)
    references public.chat_channels (tenant_id, id) on delete cascade,
  constraint chat_messages_parent_fk foreign key (tenant_id, channel_id, parent_id)
    references public.chat_messages (tenant_id, channel_id, id) on delete cascade,
  constraint chat_messages_status_kind check (post_status is null or kind in ('problem', 'suggestion'))
);
comment on table public.chat_messages is
  'R-2294: team chat messages. links = [{type,id}] only (chat_links_ok) — previews are fetched under the reader''s own access. Soft delete (deleted_at); writes via RPCs.';
comment on column public.chat_messages.links is
  'R-2294: [{type,id}] ids only — never amounts or names (check chat_links_ok).';
create index if not exists chat_messages_channel_created_idx
  on public.chat_messages (channel_id, created_at desc, id);
create index if not exists chat_messages_parent_idx
  on public.chat_messages (parent_id) where parent_id is not null;
create index if not exists chat_messages_tenant_author_idx
  on public.chat_messages (tenant_id, author_id);

create table if not exists public.chat_attachments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  message_id  uuid not null,
  channel_id  uuid not null,
  file_path   text not null,
  file_name   text not null check (char_length(file_name) between 1 and 255),
  mime        text not null check (char_length(mime) between 1 and 127),
  size_bytes  bigint not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint chat_attachments_message_fk foreign key (tenant_id, channel_id, message_id)
    references public.chat_messages (tenant_id, channel_id, id) on delete cascade,
  constraint chat_attachments_path_ok check (
    file_path like tenant_id::text || '/chat/' || channel_id::text || '/_%'
    and position('..' in file_path) = 0)
);
comment on table public.chat_attachments is
  'R-2294: files on a team chat message — documents bucket, path {tenant}/chat/{channel}/… (storage rule: R-2297). 10 MB max.';
create index if not exists chat_attachments_message_idx on public.chat_attachments (message_id);
create index if not exists chat_attachments_channel_idx on public.chat_attachments (tenant_id, channel_id);

create table if not exists public.chat_message_edits (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  message_id uuid not null,
  channel_id uuid not null,
  old_body   text not null,
  edited_by  uuid references public.users(id) on delete set null,
  edited_at  timestamptz not null default now(),
  constraint chat_message_edits_message_fk foreign key (tenant_id, channel_id, message_id)
    references public.chat_messages (tenant_id, channel_id, id) on delete cascade
);
comment on table public.chat_message_edits is
  'R-2294: old text of an edited team chat message — readable by owner/manager in channels they can read, never in DMs.';
create index if not exists chat_message_edits_message_idx on public.chat_message_edits (message_id);
create index if not exists chat_message_edits_channel_idx on public.chat_message_edits (tenant_id, channel_id);

-- ── trigger: a referenced user must be of the row's tenant ──────────────────────────
create or replace function public.tg_chat_user_same_tenant() returns trigger
  language plpgsql security definer set search_path = ''
as $$
-- R-2294: TG_ARGV[0] names the user column (user_id / author_id / uploaded_by / edited_by).
declare
  v_user uuid := (pg_catalog.to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  if v_user is not null and not exists (
       select 1 from public.users u where u.id = v_user and u.tenant_id = new.tenant_id) then
    raise exception 'R-2294: % % is not a user of this company', tg_table_name, tg_argv[0]
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_chat_user_same_tenant() from public, anon, authenticated;

drop trigger if exists trg_chat_members_user_tenant on public.chat_members;
create trigger trg_chat_members_user_tenant before insert or update of user_id, tenant_id
  on public.chat_members for each row execute function public.tg_chat_user_same_tenant('user_id');
drop trigger if exists trg_chat_messages_author_tenant on public.chat_messages;
create trigger trg_chat_messages_author_tenant before insert or update of author_id, tenant_id
  on public.chat_messages for each row execute function public.tg_chat_user_same_tenant('author_id');
drop trigger if exists trg_chat_attachments_uploader_tenant on public.chat_attachments;
create trigger trg_chat_attachments_uploader_tenant before insert or update of uploaded_by, tenant_id
  on public.chat_attachments for each row execute function public.tg_chat_user_same_tenant('uploaded_by');
drop trigger if exists trg_chat_message_edits_editor_tenant on public.chat_message_edits;
create trigger trg_chat_message_edits_editor_tenant before insert or update of edited_by, tenant_id
  on public.chat_message_edits for each row execute function public.tg_chat_user_same_tenant('edited_by');

-- ── access helpers (fail-closed) ────────────────────────────────────────────────────
create or replace function public.chat_is_staff() returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2294: an active staff login of its own tenant. partner_agent (external) and personal
  -- users, a personal workspace, a deactivated or expired login (current_tenant_id() is NULL
  -- then) and no login at all → false.
  select coalesce(
    (select u.is_active and u.role::text not in ('partner_agent', 'personal')
       from public.users u
      where u.id = public.current_user_id()
        and u.tenant_id = public.current_tenant_id()
      limit 1), false)
    and not coalesce(public.is_personal_session(), true);
$$;

create or replace function public.is_chat_member(p_channel_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2294: the caller is staff AND has a member row in this channel of their own tenant.
  -- NULL channel / user / tenant → false.
  select p_channel_id is not null
     and public.chat_is_staff()
     and exists (
       select 1
         from public.chat_members m
        where m.channel_id = p_channel_id
          and m.user_id = public.current_user_id()
          and m.tenant_id = public.current_tenant_id());
$$;

create or replace function public.chat_can_read(p_channel_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2294: staff of the channel's tenant may read a PUBLIC channel; a private channel or a DM
  -- only its members — the owner included (decision 2: the owner does not read others' DMs).
  select p_channel_id is not null
     and public.chat_is_staff()
     and exists (
       select 1
         from public.chat_channels c
        where c.id = p_channel_id
          and c.tenant_id = public.current_tenant_id()
          and ((c.kind = 'channel' and not c.is_private)
               or exists (select 1 from public.chat_members m
                           where m.channel_id = c.id
                             and m.tenant_id = c.tenant_id
                             and m.user_id = public.current_user_id())));
$$;

create or replace function public.chat_can_read_edits(p_channel_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  -- R-2294: edit history — owner/manager, in a channel they can read, never a DM.
  select public.chat_can_read(p_channel_id)
     and exists (select 1 from public.chat_channels c
                  where c.id = p_channel_id and c.kind = 'channel')
     and exists (select 1 from public.users u
                  where u.id = public.current_user_id()
                    and u.tenant_id = public.current_tenant_id()
                    and u.role::text in ('owner', 'manager'));
$$;

revoke all on function public.chat_links_ok(jsonb), public.chat_is_staff(), public.is_chat_member(uuid),
  public.chat_can_read(uuid), public.chat_can_read_edits(uuid) from public, anon;
grant execute on function public.chat_links_ok(jsonb), public.chat_is_staff(), public.is_chat_member(uuid),
  public.chat_can_read(uuid), public.chat_can_read_edits(uuid) to authenticated, service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_t text;
begin
  if to_regprocedure('public.is_personal_session()') is null then
    raise exception 'R-2294: public.is_personal_session() is missing — apply gp09a (R-2122) first';
  end if;
  foreach v_t in array array['chat_channels', 'chat_members', 'chat_messages', 'chat_attachments',
                             'chat_message_edits'] loop
    execute format('alter table public.%I enable row level security', v_t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', v_t);
    execute format('create policy zzz_service_role_all on public.%I for all to service_role using (true) with check (true)', v_t);
    -- G-PERSONAL wall, SELECT only (see header)
    execute format('drop policy if exists gp09_personal_wall on public.%I', v_t);
    execute format('create policy gp09_personal_wall on public.%I as restrictive for select to authenticated using (not (select public.is_personal_session()))', v_t);
    execute format('revoke all on public.%I from public, anon, authenticated', v_t);
    execute format('grant select on public.%I to authenticated', v_t);
    execute format('grant all on public.%I to service_role', v_t);
  end loop;
end $$;

drop policy if exists chat_channels_read on public.chat_channels;
create policy chat_channels_read on public.chat_channels for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and public.chat_can_read(id));

drop policy if exists chat_members_read on public.chat_members;
create policy chat_members_read on public.chat_members for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and public.chat_can_read(channel_id));

drop policy if exists chat_messages_read on public.chat_messages;
create policy chat_messages_read on public.chat_messages for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and public.chat_can_read(channel_id));

drop policy if exists chat_attachments_read on public.chat_attachments;
create policy chat_attachments_read on public.chat_attachments for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and public.chat_can_read(channel_id));

drop policy if exists chat_message_edits_read on public.chat_message_edits;
create policy chat_message_edits_read on public.chat_message_edits for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and public.chat_can_read_edits(channel_id));

commit;
