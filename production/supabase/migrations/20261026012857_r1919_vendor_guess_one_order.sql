-- deploy-peek: to_regclass('public.vendor_narration_aliases') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'bank_debit_vendor_guess' and p.prosrc like '%R-1919%')
-- deploy-key: r1919vendorguess
-- 20261026012857_r1919_vendor_guess_one_order.sql
--
-- R-1919 (26 Oct 2026, p2 — R-1906 audit F2): two vendor guesses on the same money-out sheet could
-- disagree — guessVendor / bank_debit_vendor_guess (UPI id, account no, name words; used by the
-- "Paying a vendor?" section and by auto-reconcile, R-1867) ignored Category Rules, while the
-- expense form's payee came from Category Rules. And neither learned from a save: FACEBK → Facebook
-- had to be picked again on every line.
--
-- Fix — ONE order, here and in src/lib/banking/debit-pay-for.ts guessVendor (kept in step by
-- supabase/tests/r1919_vendor_guess_one_order.test.sql + src/lib/banking/vendor-guess-one-order.test.ts,
-- the same cases in both):
--   1. UPI id → 2. account no (2b: its masked tail, R-1918 parser) → 3. Category Rule's vendor → 4. learned alias → 5. name words.
--   A step answers only when exactly one vendor fits (a tie → that step says nothing).
-- * vendor_narration_aliases (per company): narration key → vendor, written by a trigger on every
--   vendor-payment save from a bank line (bank_vendor_payment_lines insert — the sheet's "Record
--   payment" and auto-reconcile alike), forgotten when the last such payment is un-reconciled.
--   Users can read their company's rows, never write them.
-- * bank_narration_key(text): the payee part of a narration (twin of narration-key.ts).
-- * bank_narration_account_tail(text): the masked account digits (twin of R-1918 narration-bank-details.ts).
-- * bank_debit_vendor_guess: body from its latest definition (R-1934, 20261025151940) plus steps 3–4.
-- * Backfill: aliases from the vendor payments already saved.
begin;

/* ── 1. The learned aliases ── */
create table if not exists public.vendor_narration_aliases (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  narration_key text        not null check (length(narration_key) >= 3),
  vendor_id     uuid        not null references public.vendors(id) on delete cascade,
  uses          integer     not null default 1,
  last_txn_id   uuid        references public.bank_transactions(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, narration_key, vendor_id)
);
comment on table public.vendor_narration_aliases is
  'R-1919: a bank narration key (bank_narration_key) learned to mean this vendor — written by the vendor-payment save trigger on bank_vendor_payment_lines; read by bank_debit_vendor_guess and the Reconcile sheet.';
create index if not exists vendor_narration_aliases_vendor_idx on public.vendor_narration_aliases (vendor_id);

alter table public.vendor_narration_aliases enable row level security;
drop policy if exists "tenant isolation read" on public.vendor_narration_aliases;
drop policy if exists zzz_service_role_all on public.vendor_narration_aliases;
create policy "tenant isolation read" on public.vendor_narration_aliases for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.vendor_narration_aliases as permissive for all to service_role
  using (true) with check (true);
revoke all on public.vendor_narration_aliases from anon;
grant select on public.vendor_narration_aliases to authenticated;
grant select, insert, update, delete on public.vendor_narration_aliases to service_role;

/* ── 2. The narration key — twin of src/lib/banking/narration-key.ts ── */
create or replace function public.bank_narration_is_name(p text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(trim(p) ~ '^[A-Za-z][A-Za-z .&'']*[A-Za-z.]$' and length(trim(p)) >= 3, false);
$$;

create or replace function public.bank_narration_key(p_description text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  t    text := trim(coalesce(p_description, ''));
  d    text[];
  s    text[];
  raw  text := null;
  k    text;
  -- credit-match.ts NARRATION_NOISE — keep in step (same list as bank_debit_vendor_guess).
  c_narr_noise constant text[] := array[
    'upi','imps','neft','rtgs','tpt','ift','ach','ecs','emi','chq','cheque',
    'cr','dr','ref','txn','api','banking','transfer','payment','paid','from',
    'hdfc','icic','icici','sbin','sbi','axis','axl','barb','pnb','kkbk','utib',
    'yesb','idib','cnrb','ubin','iob','bkid','mahb','nesf','okhdfcbank','oksbi',
    'okaxis','okicici','ybl','paytm','ptm','ptyes','gpay','phonepe','apl','airtel',
    'collect','reversal','refund','charges','interest','given','loan','self'];
begin
  if t = '' then return null; end if;
  d := array(select trim(x) from unnest(string_to_array(t, '-')) with ordinality u(x, i) order by i);
  s := array(select trim(x) from unnest(string_to_array(t, '/')) with ordinality u(x, i) order by i);

  if coalesce(d[1], '') ~* '^(IMPS|NEFT|RTGS)(\s+(DR|CR))?$' and public.bank_narration_is_name(d[3]) then
    raw := d[3];
  elsif coalesce(s[1], '') ~* '^UPI$' and public.bank_narration_is_name(s[3]) then
    raw := s[3];
  elsif coalesce(d[1], '') ~* '^UPI$' and public.bank_narration_is_name(d[3]) then
    raw := d[3];
  elsif coalesce(d[1], '') ~* '^UPI$' and strpos(coalesce(d[3], ''), '@') > 0 and public.bank_narration_is_name(d[2]) then
    raw := d[2];
  elsif coalesce(d[2], '') ~* '^TPT$' and public.bank_narration_is_name(d[array_length(d, 1)]) then
    raw := d[array_length(d, 1)];
  elsif array_length(s, 1) > 1 and s[array_length(s, 1)] ~ '^[A-Za-z]{4,}$' then
    raw := s[array_length(s, 1)];
  else
    select string_agg(lower(w), ' ' order by i) into raw
      from regexp_split_to_table(t, '[^A-Za-z0-9]+') with ordinality r(w, i)
     where w ~ '^[A-Za-z]{3,}$' and lower(w) <> all (c_narr_noise) and lower(w) !~ '^x+$';
  end if;

  k := trim(regexp_replace(lower(coalesce(raw, '')), '[^a-z]+', ' ', 'g'));
  return case when length(k) >= 3 then k end;
end;
$$;

/* The masked account tail ("XXXXXX4521" → 4521) — twin of narration-bank-details.ts
   bankDetailsFromNarration().accountTail (R-1918): none when the line shows the full account in
   its slot (TPT first part, IMPS fifth part). */
create or replace function public.bank_narration_account_tail(p_description text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  t    text := trim(coalesce(p_description, ''));
  d    text[];
  acc  text := null;
  seg  text;
  m    text;
begin
  if t = '' then return null; end if;
  d := array(select trim(x) from unnest(string_to_array(t, '-')) with ordinality u(x, i) order by i);
  if coalesce(d[2], '') ~* '^TPT$' then
    acc := regexp_replace(coalesce(d[1], ''), '[[:space:]-]', '', 'g');
  elsif coalesce(d[1], '') ~* '^IMPS$' then
    acc := regexp_replace(coalesce(d[5], ''), '[[:space:]-]', '', 'g');
  end if;
  if acc ~ '^[0-9]{6,18}$' then return null; end if;
  for seg in
    select x from (
      select x, 1 as part, i from unnest(d) with ordinality u(x, i)
      union all
      select x, 2, i from regexp_split_to_table(t, '[-/,[:space:]]+') with ordinality r(x, i) where x <> ''
    ) q order by part, i
  loop
    m := substring(trim(seg) from '^[Xx*•.…]+[[:space:]]*([0-9]{3,6})$');
    if m is not null then return m; end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.bank_narration_account_tail(text) from public, anon;
grant execute on function public.bank_narration_account_tail(text) to authenticated, service_role;
revoke all on function public.bank_narration_is_name(text) from public, anon;
revoke all on function public.bank_narration_key(text) from public, anon;
grant execute on function public.bank_narration_is_name(text) to authenticated, service_role;
grant execute on function public.bank_narration_key(text) to authenticated, service_role;

/* ── 3. The one guess (R-1934 body + Category Rule + learned alias) ── */
create or replace function public.bank_debit_vendor_guess(p_txn_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     public.bank_transactions;
  v_text    text;
  v_id      uuid;
  v_n       integer;
  v_top     record;
  v_next    record;
  v_pat     text;   -- R-1919: the Category Rule's pattern, letters only
  v_key     text;   -- R-1919: the narration key
  v_tail    text;   -- R-1919: the masked account tail
  -- credit-match.ts NARRATION_NOISE / NAME_NOISE — keep in step.
  c_narr_noise constant text[] := array[
    'upi','imps','neft','rtgs','tpt','ift','ach','ecs','emi','chq','cheque',
    'cr','dr','ref','txn','api','banking','transfer','payment','paid','from',
    'hdfc','icic','icici','sbin','sbi','axis','axl','barb','pnb','kkbk','utib',
    'yesb','idib','cnrb','ubin','iob','bkid','mahb','nesf','okhdfcbank','oksbi',
    'okaxis','okicici','ybl','paytm','ptm','ptyes','gpay','phonepe','apl','airtel',
    'collect','reversal','refund','charges','interest','given','loan','self'];
  c_name_noise constant text[] := array[
    'pvt','private','ltd','limited','llp','inc','co','company','corp',
    'corporation','corprotion','and','the','enterprises','enterprise','solutions',
    'technologies','technology','services','service','systems','digital'];
begin
  /* §17c fail-closed + money roles (the guess reads the vendor list). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match bank lines' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found or (v_caller is not null and v_txn.tenant_id is distinct from v_caller) then
    return null;
  end if;
  v_text := coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.reference, '');

  -- (1) UPI id in the narration — exactly one vendor.
  select count(*), min(v.id::text)::uuid into v_n, v_id
    from public.vendors v
   where v.tenant_id = v_txn.tenant_id
     and nullif(trim(coalesce(v.upi_id, '')), '') is not null
     and strpos(lower(v_text), lower(trim(v.upi_id))) > 0;
  if v_n = 1 then return v_id; end if;

  -- (2) Account number: a 6+ digit run in the narration that is the end of the vendor's number
  --     (masked statements show the tail) or ends with it.
  select count(*), min(v.id::text)::uuid into v_n, v_id
    from public.vendors v
   where v.tenant_id = v_txn.tenant_id
     and length(regexp_replace(coalesce(v.bank_account_no, ''), '[^0-9]', '', 'g')) >= 6
     and exists (
       select 1
         from regexp_split_to_table(regexp_replace(v_text, '[^0-9]', ' ', 'g'), '\s+') d
        where length(d) >= 6
          and (right(regexp_replace(v.bank_account_no, '[^0-9]', '', 'g'), length(d)) = d
               or right(d, length(regexp_replace(v.bank_account_no, '[^0-9]', '', 'g'))) = regexp_replace(v.bank_account_no, '[^0-9]', '', 'g')));
  if v_n = 1 then return v_id; end if;

  -- (2b) R-1919: a masked account ("XXXXXX4521") — exactly one vendor whose saved account ends
  --      with its 4+ digits.
  v_tail := public.bank_narration_account_tail(v_txn.description);
  if length(coalesce(v_tail, '')) >= 4 then
    select count(*), min(v.id::text)::uuid into v_n, v_id
      from public.vendors v
     where v.tenant_id = v_txn.tenant_id
       and length(regexp_replace(coalesce(v.bank_account_no, ''), '[^0-9]', '', 'g')) >= 6
       and right(regexp_replace(v.bank_account_no, '[^0-9]', '', 'g'), length(v_tail)) = v_tail;
    if v_n = 1 then return v_id; end if;
  end if;

  -- (3) R-1919: the Category Rule that matches the line (categorise.ts categoriseByRules: this
  --     side or 'any', a direction-specific rule first, then the longest pattern, then lowest id)
  --     names the vendor — its first five letters start the vendor's name ("FACEBK" → Facebook…),
  --     or the vendor's first name word (4+ letters) is inside it ("PAYUFACEBOOK").
  select regexp_replace(upper(r.pattern), '[^A-Z]', '', 'g') into v_pat
    from public.txn_category_rules r
   where r.tenant_id = v_txn.tenant_id
     and r.direction in ('any', case when coalesce(v_txn.debit, 0) > 0 then 'debit' else 'credit' end)
     and length(trim(r.pattern)) > 0
     and strpos(upper(regexp_replace(trim(coalesce(v_txn.description, '')), '\s+', ' ', 'g')),
                upper(regexp_replace(trim(r.pattern), '\s+', ' ', 'g'))) > 0
   order by (r.direction <> 'any') desc, length(regexp_replace(trim(r.pattern), '\s+', ' ', 'g')) desc, r.id::text collate "C"
   limit 1;
  if length(coalesce(v_pat, '')) >= 4 then
    select count(*), min(v.id::text)::uuid into v_n, v_id
      from public.vendors v
      left join lateral (
        select t as first_word
          from regexp_split_to_table(lower(coalesce(v.name, '')), '[^a-z]+') with ordinality s(t, n)
         where length(t) >= 3 and t <> all (c_name_noise)
         order by n limit 1
      ) fw on true
     where v.tenant_id = v_txn.tenant_id
       and (regexp_replace(upper(coalesce(v.name, '')), '[^A-Z]', '', 'g') like left(v_pat, 5) || '%'
            or (length(fw.first_word) >= 4 and strpos(v_pat, upper(fw.first_word)) > 0));
    if v_n = 1 then return v_id; end if;
  end if;

  -- (4) R-1919: learned alias — this narration key was paid to exactly one vendor before.
  v_key := public.bank_narration_key(v_txn.description);
  if v_key is not null then
    select count(distinct a.vendor_id), min(a.vendor_id::text)::uuid into v_n, v_id
      from public.vendor_narration_aliases a
      join public.vendors v on v.id = a.vendor_id and v.tenant_id = v_txn.tenant_id
     where a.tenant_id = v_txn.tenant_id and a.narration_key = v_key;
    if v_n = 1 then return v_id; end if;
  end if;

  -- (5) Name words: the vendor sharing the most distinctive words, only when no one else shares as many.
  --     The narration side reads the description only (as guessVendor does).
  v_n := 0;
  for v_next in
    with words as (
      select distinct w
        from regexp_split_to_table(lower(coalesce(v_txn.description, '')), '[^a-z]+') w
       where length(w) >= 3 and w <> all (c_narr_noise) and w !~ '^x+$'
    )
    select v.id, count(distinct t) as shared
      from public.vendors v
      cross join lateral regexp_split_to_table(lower(coalesce(v.name, '')), '[^a-z]+') t
     where v.tenant_id = v_txn.tenant_id
       and length(t) >= 3 and t <> all (c_name_noise)
       and t in (select w from words)
     group by v.id
     order by 2 desc
     limit 2
  loop
    v_n := v_n + 1;
    if v_n = 1 then v_top := v_next; end if;
  end loop;
  -- R-1934: v_top is unassigned when no vendor shares a word — never read it then.
  if v_n = 0 then
    return null;
  end if;
  if v_n = 1 or v_top.shared > v_next.shared then
    return v_top.id;
  end if;
  return null;
end;
$$;

revoke all on function public.bank_debit_vendor_guess(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_guess(uuid) to authenticated, service_role;

/* ── 4. Learn on every vendor-payment save; forget when the last one is un-reconciled ── */
create or replace function public.tg_vendor_payment_line_learn_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  -- R-1919
  if new.vendor_id is null then return new; end if;
  select public.bank_narration_key(t.description) into v_key from public.bank_transactions t where t.id = new.bank_txn_id;
  if v_key is null then return new; end if;
  insert into public.vendor_narration_aliases (tenant_id, narration_key, vendor_id, last_txn_id)
  values (new.tenant_id, v_key, new.vendor_id, new.bank_txn_id)
  on conflict (tenant_id, narration_key, vendor_id) do update
     set uses        = public.vendor_narration_aliases.uses
                       + case when public.vendor_narration_aliases.last_txn_id is distinct from excluded.last_txn_id then 1 else 0 end,
         last_txn_id = excluded.last_txn_id,
         updated_at  = now();
  return new;
end;
$$;

create or replace function public.tg_vendor_payment_line_forget_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  -- R-1919: the alias stays only while another saved payment to this vendor taught the same key.
  if old.vendor_id is null then return old; end if;
  select public.bank_narration_key(t.description) into v_key from public.bank_transactions t where t.id = old.bank_txn_id;
  if v_key is null then return old; end if;
  if not exists (
    select 1
      from public.bank_vendor_payment_lines l
      join public.bank_transactions t on t.id = l.bank_txn_id
     where l.tenant_id = old.tenant_id and l.vendor_id = old.vendor_id and l.id <> old.id
       and public.bank_narration_key(t.description) = v_key
  ) then
    delete from public.vendor_narration_aliases
     where tenant_id = old.tenant_id and narration_key = v_key and vendor_id = old.vendor_id;
  end if;
  return old;
end;
$$;

revoke all on function public.tg_vendor_payment_line_learn_alias() from public, anon, authenticated;
revoke all on function public.tg_vendor_payment_line_forget_alias() from public, anon, authenticated;

drop trigger if exists trg_vendor_payment_line_learn_alias on public.bank_vendor_payment_lines;
create trigger trg_vendor_payment_line_learn_alias
  after insert on public.bank_vendor_payment_lines
  for each row execute function public.tg_vendor_payment_line_learn_alias();

drop trigger if exists trg_vendor_payment_line_forget_alias on public.bank_vendor_payment_lines;
create trigger trg_vendor_payment_line_forget_alias
  after delete on public.bank_vendor_payment_lines
  for each row execute function public.tg_vendor_payment_line_forget_alias();

/* ── 5. Backfill from the vendor payments already saved ── */
insert into public.vendor_narration_aliases (tenant_id, narration_key, vendor_id, uses, last_txn_id)
select l.tenant_id, public.bank_narration_key(t.description), l.vendor_id,
       count(distinct l.bank_txn_id), (array_agg(l.bank_txn_id order by l.created_at desc))[1]
  from public.bank_vendor_payment_lines l
  join public.bank_transactions t on t.id = l.bank_txn_id
  join public.vendors v on v.id = l.vendor_id and v.tenant_id = l.tenant_id
 where l.vendor_id is not null and public.bank_narration_key(t.description) is not null
 group by l.tenant_id, public.bank_narration_key(t.description), l.vendor_id
on conflict (tenant_id, narration_key, vendor_id) do nothing;

commit;
