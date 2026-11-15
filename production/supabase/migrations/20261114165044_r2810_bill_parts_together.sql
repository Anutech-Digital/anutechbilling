-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_parts_together(uuid[])')) and exists(select 1 from pg_trigger where tgname = 'trg_quotes_one_live_request_per_part' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_trigger where tgname = 'trg_quotes_part_request_lines_guarded' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_quote(text,text)') and prosrc like '%Cancel never clears a bill group%')
-- deploy-key: r2810billpartstogether
-- 20261114165044_r2810_bill_parts_together.sql
--
-- R-2810 (14 Nov 2026, p1 money) — part 2 of R-2805 "Bill together" (Pratik, report 8b70e37f: ITBUZZ Technologies,
-- Business Standard 161 seats + Business Starter 49 seats, both "Part not billed (Oct)" — last cycle ONE bill, now
-- two "Bill next part" buttons). R-2806 (20261114161903) taught the money pool and the part group about a bill group;
-- this file adds the RPC that makes the together proforma, and the guards its reviews asked for.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * public.bill_parts_together(p_billing_ids uuid[]) — owner / manager / accountant / billing of the parts' company
--   (or server code). 2+ laid, unpaid parts of 2+ subscriptions of ONE customer at ONE GST rate → ONE Proforma
--   Invoice (PI series), one line per part (billing_id, seats × per-seat rate when exact, its own period, the R-2423
--   name), linked to the first part (subscription_billing_id). The subscriptions — and their sale-quote siblings of
--   the same customer, and any group one of them was already in — get ONE bill_group_id (it is the only writer;
--   R-2806's trigger refuses a browser login). Same parts again → the same proforma (alreadyExisted). Two calls at
--   once → one proforma: a per-customer advisory lock + the parts' row locks (the lock Bill next part takes), and
--   the "same parts" check runs after them. An "Invoice on due date" customer's started group, like a group the
--   merged pool already covers, gets its tax invoice at once (Bill next part's rule; the proforma closes itself —
--   anything else rolls the whole call back). Amounts are in INR, like every part request (parts are laid in INR); an
--   export customer pays 0% GST (as Bill next part). Money already in the merged pool that covers a started group
--   → its tax invoice at once (as Bill next part does), never a proforma asking for paid money.
--   Refused in plain words: one part / unknown part / other company / other customer / two parts of one subscription
--   / an invoiced part / a part already on a live request ("cancel PI-x first", rev-r2806 F4) / parts at different
--   GST rates / a part not begun mixed with a begun one (R-2519b) / the first part of a sale (its sale quote bills it
--   with the one-time lines) / an R-2092 sale-quote sibling of the same period left out / an inactive subscription
--   / a not-begun group already paid for / a Won't renew subscription or one with an open renewal quote (the R-808
--   holds the screen checks, read again here under a row lock) / a subscription with no customer ("link it to a customer first" — never
--   grouped, R-2806 re-review) / a yearly subscription. Another company's part and an unknown id get the SAME answer
--   ("not found" — no existence oracle). bill_group_id is set or merged here (a group joins a bigger group of the
--   SAME customer); R-2806's trigger refuses a browser login changing it; nothing un-groups it (see cancel_quote below).
-- * trg_quotes_one_live_request_per_part (rev-r2806 F4, HIGH) — a part is named (subscription_billing_id or a line's
--   billing_id) by at most ONE live request: not cancelled, not rejected / expired / superseded, no tax invoice yet.
--   Before, a part with its own live proforma could also be on a together proforma: paying the own one raised ONE
--   invoice for both parts, half unpaid, and paying the together one afterwards changed nothing (money stuck).
--   Per-part advisory lock, so two writers at once cannot both pass. "Live" is defined once:
--   public.part_live_request(tenant, part) (server-only), read by the guard and by Bill together; it compares a line's
--   billing_id by the part's uuid, and the guard stores every billing_id in its canonical lowercase form (rev-r2810:
--   an UPPERCASE copy slipped past the old text match). A request already live naming the same parts is
--   not re-judged on a status step, so rows written before the guard never stop an ordinary update.
--   Also refused: an R-2092 sale-quote sibling whose parts are not laid yet (Bill next part's siblings_not_laid).
-- * trg_quotes_part_request_lines_guarded (rev-r2810) — a browser login cannot change the lines / amount / subtotal /
--   tax rate of a part request (or insert a quote naming a part): only server code writes them (no screen edits
--   them — the quote editor opens drafts only; seats / rate go through set_part_request_terms).
-- * cancel_quote (body of 20261106120956 R-2527) — rev-r2806 F6: the "a later period is already billed" check
--   (R-2519b) now looks at EVERY part the request names (a together proforma's members), not only its lead, and at
--   a later part named as a line of another LIVE request (a dead one never blocks: it could not be cancelled).
--   It takes Bill together's per-customer lock right after the quote's row lock, before any part row (the same order
--   as Bill together). Cancel NEVER clears a bill group (coordinator, 15 Nov: reviews rev2–rev4 each found money used
--   twice in an automatic un-group; all members are one customer, so a shared pool is never money-wrong).
--   Only those lines change.
--   Bill together links its request to the first ticked part WITHOUT an old (spent) proforma link (a part freed by a
--   credit note keeps one; the link is unique) — all of them carrying one → refused in plain words.
-- R-2735 renews marks stay per part (not touched). Test: supabase/tests/r2810_bill_parts_together.test.sql
-- (one transaction, rolled back); concurrency: scripts/dev/r2810-concurrency-check.mjs (local DB only).

begin;

-- ── 1. One live request per part (rev-r2806 F4) ───────────────────────────────────────────────────
/* R-2810: the ONE definition of "a live request naming this part" — the guard and Bill together read it. */
create or replace function public.part_live_request(p_tenant uuid, p_part uuid, p_except text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  /* R-2810: the open payment request (proforma) naming this part — as its lead (subscription_billing_id) or on a
     line (billing_id): not cancelled, not rejected / expired / superseded, no tax invoice yet. Oldest first. */
  select q.id
    from public.quotes q
   where q.tenant_id = p_tenant and q.id is distinct from p_except
     and q.subscription_billing_id is not null and q.cancelled_at is null and q.invoice_id is null
     and q.superseded_by is null and q.status::text not in ('rejected', 'expired')
     and (q.subscription_billing_id = p_part
          /* rev-r2810: by the part's uuid, whatever the spelling of the line's billing_id (an UPPERCASE copy was a
             way round the guard) */
          or (jsonb_typeof(q.line_items) = 'array'
              and exists (select 1 from jsonb_array_elements(q.line_items) l
                           where l ? 'billing_id' and lower(btrim(l->>'billing_id')) = p_part::text)))
   order by q.created_at, q.id
   limit 1;
$$;
revoke all on function public.part_live_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.part_live_request(uuid, uuid, text) to service_role;

create or replace function public.tg_quotes_one_live_request_per_part()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2810 (rev-r2806 F4): a subscription part is named by at most ONE live request — else paying one of two
   requests bills both parts and the other's money is stuck. Live = linked to a part, not cancelled, not
   rejected / expired / superseded, no tax invoice yet. A per-part advisory lock makes two writers wait in turn;
   each statement then sees what the other committed. */
declare
  v_part  uuid;
  v_other text;
  v_name  text;
begin
  /* rev-r2810: a line's billing_id is stored in ONE spelling (the canonical lowercase uuid) — so every
     line_items @> {billing_id} lookup (Bill next part, the R-2092 / R-2806 group, cancel) sees it. A value that is
     not a part id is refused. Only when the lines are written (an untouched old row is never rewritten). */
  if jsonb_typeof(new.line_items) = 'array'
     and (tg_op = 'INSERT' or new.line_items is distinct from old.line_items)
     and exists (select 1 from jsonb_array_elements(new.line_items) l where l ? 'billing_id') then
    begin
      new.line_items := (select jsonb_agg(case when l ? 'billing_id' and jsonb_typeof(l->'billing_id') <> 'null'
                                               then l || jsonb_build_object('billing_id', (btrim(l->>'billing_id'))::uuid::text)
                                               else l end order by n)
                           from jsonb_array_elements(new.line_items) with ordinality x(l, n));
    exception when invalid_text_representation then
      raise exception 'A line of % names a part that does not exist (billing_id is not a part id).', new.id using errcode = '22023';
    end;
  end if;
  if new.subscription_billing_id is null or new.cancelled_at is not null or new.invoice_id is not null
     or new.superseded_by is not null or new.status::text in ('rejected', 'expired') then
    return new;
  end if;
  /* A request that was already live and names the same parts (a status step, a payment-status change) is not
     re-judged — only a request that becomes live or names a part anew. So rows written before this guard never
     stop an ordinary update. */
  if tg_op = 'UPDATE'
     and old.subscription_billing_id is not null and old.cancelled_at is null and old.invoice_id is null
     and old.superseded_by is null and old.status::text not in ('rejected', 'expired')
     and old.subscription_billing_id is not distinct from new.subscription_billing_id
     and (select array_agg(distinct lower(btrim(l->>'billing_id')) order by lower(btrim(l->>'billing_id')))
            from jsonb_array_elements(case when jsonb_typeof(old.line_items) = 'array' then old.line_items else '[]'::jsonb end) l
           where l ? 'billing_id')
         is not distinct from
         (select array_agg(distinct l->>'billing_id' order by l->>'billing_id')
            from jsonb_array_elements(case when jsonb_typeof(new.line_items) = 'array' then new.line_items else '[]'::jsonb end) l
           where l ? 'billing_id') then
    return new;
  end if;
  for v_part in
    select distinct x.id from (
      select new.subscription_billing_id as id
      union all
      select (l->>'billing_id')::uuid
        from jsonb_array_elements(case when jsonb_typeof(new.line_items) = 'array' then new.line_items else '[]'::jsonb end) l
       where l ? 'billing_id' and nullif(l->>'billing_id', '') is not null) x
     order by x.id
  loop
    perform pg_advisory_xact_lock(hashtextextended('r2810:part-request:' || v_part::text, 0));
    v_other := public.part_live_request(new.tenant_id, v_part, new.id);
    if v_other is not null then
      select s.plan || ' (' || to_char(b.period_start, 'FMDD Mon YYYY') || ')' into v_name
        from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id where b.id = v_part;
      raise exception 'The part % is already on proforma % — cancel % first. A part is billed by one open proforma at a time.',
        coalesce(v_name, v_part::text), v_other, v_other using errcode = '23505';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_quotes_one_live_request_per_part() from public, anon, authenticated;
drop trigger if exists trg_quotes_one_live_request_per_part on public.quotes;
create trigger trg_quotes_one_live_request_per_part
  before insert or update of subscription_billing_id, line_items, status, cancelled_at, invoice_id, superseded_by
  on public.quotes
  for each row execute function public.tg_quotes_one_live_request_per_part();

/* rev-r2810 (MEDIUM): a part request's lines and money are written only by server code (Bill next part, Bill
   together, set_part_request_terms …) — a browser login editing them could add another part (a way round the
   one-live-request guard) or change what the tax invoice bills (billing_part_group reads qty × rate from the
   lines). No screen edits them: the quote editor opens drafts only, and a proforma's seats / rate change through
   set_part_request_terms. Same login rule as trg_quotes_proforma_columns_guarded (R-2519c / R-2485). */
create or replace function public.tg_quotes_part_request_lines_guarded()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2810: the login decides (is_direct_request_login), never a settable flag or a role claim. */
  if not public.is_direct_request_login() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if jsonb_typeof(new.line_items) = 'array'
       and exists (select 1 from jsonb_array_elements(new.line_items) l where l ? 'billing_id') then
      raise exception 'A proforma for a subscription part is made only by Bill next part or Bill together — its lines cannot be edited by hand.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if (old.subscription_billing_id is not null or new.subscription_billing_id is not null
      or (jsonb_typeof(old.line_items) = 'array'
          and exists (select 1 from jsonb_array_elements(old.line_items) l where l ? 'billing_id'))
      or (jsonb_typeof(new.line_items) = 'array'
          and exists (select 1 from jsonb_array_elements(new.line_items) l where l ? 'billing_id')))
     and (new.line_items is distinct from old.line_items or new.amount is distinct from old.amount
          or new.subtotal is distinct from old.subtotal or new.tax_rate is distinct from old.tax_rate) then
    raise exception 'Quote % is a proforma for a subscription part — its lines and amounts cannot be edited by hand. Cancel it and bill the part again (Bill next part / Bill together), or change seats from the proforma.', new.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_quotes_part_request_lines_guarded() from public, anon, authenticated;
drop trigger if exists trg_quotes_part_request_lines_guarded on public.quotes;
create trigger trg_quotes_part_request_lines_guarded
  before insert or update of line_items, amount, subtotal, tax_rate on public.quotes
  for each row execute function public.tg_quotes_part_request_lines_guarded();

-- ── 2. Bill together ──────────────────────────────────────────────────────────────────────────────
create or replace function public.bill_parts_together(p_billing_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2810: ONE proforma (PI series) for the laid unpaid parts of 2+ subscriptions of ONE customer — a line per part,
   each its own seats × rate and period; the subscriptions get one bill_group_id (R-2806 pool). Same parts again →
   the same proforma. Refusals in plain words. */
declare
  v_trusted  boolean;
  v_caller   uuid := public.current_tenant_id();
  v_ids      uuid[];
  v_sorted   uuid[];
  v_tenant   uuid;
  v_ntenant  integer;
  v_customer uuid;
  v_ncust    integer;
  v_custname text;
  v_q        record;
  v_p        record;
  v_g        record;
  v_other    text;
  v_sib      text;
  v_today    date := public.ist_today();
  v_rates    integer[];
  v_rate     integer;
  v_country  text;
  v_taxable  integer := 0;
  v_tax      integer;
  v_gross    integer;
  v_seats    integer := 0;
  v_part_tax integer;
  v_subs     uuid[] := '{}'::uuid[];
  v_plans    text[] := '{}'::text[];
  v_lines    jsonb := '[]'::jsonb;
  v_begun    text;
  v_ahead    text;
  v_first_start date;
  v_lead     uuid;
  v_lead_sub record;
  v_group    uuid;
  v_terms    integer;
  v_due      date;
  v_id       text;
  v_period   text;
  v_label    text;
  v_n        integer := 0;
  v_credit   integer;
  v_on_due   boolean := false;
  v_inv      jsonb;
begin
  /* R-2527's rule: trust only the login, never a JWT role claim — the service key through PostgREST runs as role
     service_role; app_service / psql / scripts are not request logins. */
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill subscriptions together.' using errcode = '42501';
  end if;

  /* The parts, each once, in the order asked (the first leads). */
  select array_agg(t.id order by t.n) into v_ids
    from (select u.id, min(u.n) as n from unnest(p_billing_ids) with ordinality u(id, n) where u.id is not null group by u.id) t;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Pick at least two subscriptions to bill together.' using errcode = '22023';
  end if;
  /* rev-r2810: ONE check and ONE answer — a part of another company reads exactly like an id that does not exist
     (no "is this id real?" oracle). A trusted server caller with no company: all parts in one company. */
  select count(*), count(distinct b.tenant_id), min(b.tenant_id::text)::uuid into v_n, v_ntenant, v_tenant
    from public.subscription_billings b
   where b.id = any(v_ids) and (v_caller is null or b.tenant_id = v_caller);
  if v_n < cardinality(v_ids) or v_ntenant <> 1 then
    raise exception 'A part to bill was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  v_n := 0;

  /* A subscription with no customer is never grouped (R-2806 re-review: its money would join nobody's pool). */
  select string_agg(s.plan, ', ' order by s.plan) into v_custname
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
   where b.id = any(v_ids) and s.customer_id is null;
  if v_custname is not null then
    raise exception '% is not linked to a customer — link this subscription to a customer first, then bill together.', v_custname
      using errcode = '22023';
  end if;
  /* ONE customer (R-2806 keeps two customers' money apart; say so here). */
  select count(distinct coalesce(s.customer_id::text, '-')), min(s.customer_id::text)::uuid,
         string_agg(distinct coalesce(s.customer_name, 'no customer'), ', ')
    into v_ncust, v_customer, v_custname
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
   where b.id = any(v_ids);
  if v_ncust <> 1 or v_customer is null then
    raise exception 'Parts of different customers cannot be on one bill (%) — bill together only one customer''s subscriptions.', v_custname
      using errcode = '22023';
  end if;

  /* Two calls at once: one at a time per customer, then the parts' rows (the lock Bill next part takes), id order. */
  perform pg_advisory_xact_lock(hashtextextended('r2810:bill-together:' || v_tenant::text || ':' || v_customer::text, 0));
  perform 1 from public.subscription_billings b where b.id = any(v_ids) order by b.id for update;
  select array_agg(x order by x) into v_sorted from unnest(v_ids) x;

  /* Same parts again → the same proforma (a retry, a second click, a second tab). */
  select q.id, q.amount, q.subscription_billing_id, q.currency, q.tax_rate, q.subtotal into v_q
    from public.quotes q
   where q.tenant_id = v_tenant and q.subscription_billing_id = any(v_ids)
     and q.cancelled_at is null and q.superseded_by is null and q.status::text not in ('rejected', 'expired')
     and (q.invoice_id is null
          or not exists (select 1 from public.subscription_billings bx where bx.id = any(v_ids) and bx.invoice_id is distinct from q.invoice_id))
     and v_sorted = (select array_agg(distinct n.id order by n.id) from (
                        select q.subscription_billing_id as id
                        union all
                        select (l->>'billing_id')::uuid
                          from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) l
                         where l ? 'billing_id' and nullif(l->>'billing_id', '') is not null) n)
   order by q.created_at desc, q.id
   limit 1;
  if found then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'already_existed', true,
      'subscription_ids', (select to_jsonb(array_agg(b.subscription_id order by u.n)) from unnest(v_ids) with ordinality u(id, n)
                             join public.subscription_billings b on b.id = u.id),
      'billing_ids', to_jsonb(v_ids),
      'bill_group_id', (select s.bill_group_id from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id
                         where b.id = v_q.subscription_billing_id),
      'taxable', v_q.subtotal, 'tax_rate', v_q.tax_rate, 'gross', v_q.amount, 'currency', upper(coalesce(v_q.currency, 'INR')));
  end if;

  /* Each part. */
  for v_p in
    select b.id, b.subscription_id, b.invoice_id, b.period_start, b.period_end, b.period_index, b.taxable_amount,
           b.tax_rate, b.term_start, b.credited_invoice_ids, s.plan, s.seats, s.domain, s.quote_id as sale_quote,
           s.status::text as sub_status, s.billing_cycle::text as cycle, s.term_months, u.n,
           s.auto_renew, s.renewal_quote_id
      from unnest(v_ids) with ordinality u(id, n)
      join public.subscription_billings b on b.id = u.id
      join public.subscriptions s on s.id = b.subscription_id
     order by u.n
     /* R-2807 review: the holds below are read under a row lock — a Won't renew / renewal quote set while this runs
        waits for it, and one set before is seen here (the route's own re-read can be a moment old). */
     for share of s
  loop
    v_period := to_char(v_p.period_start, 'FMDD Mon') || '–' || to_char(v_p.period_end - 1, 'FMDD Mon YYYY');
    if v_p.invoice_id is not null then
      raise exception 'The % part for % already has tax invoice % — it cannot be billed again.', v_p.plan, v_period, v_p.invoice_id
        using errcode = '22023';
    end if;
    if v_p.cycle = 'yearly' then
      raise exception '% is billed yearly — Bill together is only for subscriptions billed in parts (monthly, quarterly, half-yearly).', v_p.plan
        using errcode = '22023';
    end if;
    if v_p.sub_status <> 'active' then
      raise exception '% is % — only an active subscription can be billed together.', v_p.plan, v_p.sub_status using errcode = '22023';
    end if;
    /* R-2807 review: the same holds the Bill together screen checks (R-808) — Won't renew, an open renewal quote. */
    if v_p.auto_renew is false then
      raise exception '% is marked Won''t renew — press Undo Won''t renew on the subscription first.', v_p.plan using errcode = '22023';
    end if;
    if v_p.renewal_quote_id is not null then
      raise exception 'Renewal quote % is still open for % — paying it would bill the new term twice. Cancel it first.',
        v_p.renewal_quote_id, v_p.plan using errcode = '22023';
    end if;
    if v_p.subscription_id = any(v_subs) then
      raise exception 'Two parts of % were picked — pick one part of each subscription.', v_p.plan using errcode = '22023';
    end if;
    /* rev-r2806 F4: a part already on a live request (its own proforma, or a line of another one). */
    v_other := public.part_live_request(v_tenant, v_p.id);
    if v_other is not null then
      raise exception 'The % part for % is already on proforma % — cancel % first, then bill them together.',
        v_p.plan, v_period, v_other, v_other using errcode = '22023';
    end if;
    /* The first part of a sale: its sale quote bills it, with the sale's one-time lines and payment terms. */
    if v_p.sale_quote is not null and cardinality(coalesce(v_p.credited_invoice_ids, '{}'::text[])) = 0 and v_p.period_index = 1
       and v_p.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = v_p.subscription_id) then
      raise exception 'The first part of % is billed by its sale quote % — bill it from there; later parts can be billed together.',
        v_p.plan, v_p.sale_quote using errcode = '22023';
    end if;
    /* R-2092: parts of one sale quote for one period are ONE bill — none may be left out, and none may be billed
       while a sibling of the sale (same cycle) has no parts laid yet (Bill next part's 'siblings_not_laid'). */
    select string_agg(s2.plan, ', ' order by s2.plan) into v_sib
      from public.subscriptions s2
      join public.subscriptions me on me.id = v_p.subscription_id
     where me.quote_id is not null
       and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
       and s2.status = 'active' and s2.billing_cycle = me.billing_cycle
       and s2.billing_cycle is distinct from 'yearly'::billing_cycle
       and s2.start_date is not null and coalesce(s2.mrr, 0) > 0
       and (s2.billed_externally_until is null or s2.billed_externally_until < v_p.period_start)
       and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
    if v_sib is not null then
      raise exception '% is sold with % on one sale quote, whose parts are not laid yet — wait for the next billing run, then bill them together.',
        v_p.plan, v_sib using errcode = '22023';
    end if;
    /* Only the R-2092 sale-quote group counts here (rows of the SAME sale quote): a request that is no longer live
       never decides a part's amount or which parts belong together. */
    v_part_tax := null;
    if v_p.sale_quote is not null then
      for v_g in select g.* from public.billing_part_group(v_p.id) g
                   join public.subscriptions sg on sg.id = g.subscription_id
                  where sg.quote_id = v_p.sale_quote loop
        if v_g.billing_id = v_p.id then
          v_part_tax := v_g.taxable;
        elsif not (v_g.billing_id = any(v_ids)) then
          select s.plan into v_sib from public.subscriptions s where s.id = v_g.subscription_id;
          raise exception '% is billed with % (same sale quote, same period) — tick % too.', v_p.plan, v_sib, v_sib
            using errcode = '22023';
        end if;
      end loop;
    end if;
    v_part_tax := coalesce(v_part_tax, v_p.taxable_amount);

    if v_p.period_start > v_today then
      v_ahead := coalesce(v_ahead, v_p.plan || ' (from ' || to_char(v_p.period_start, 'FMDD Mon YYYY') || ')');
    else
      v_begun := coalesce(v_begun, v_p.plan);
    end if;
    v_rates := v_rates || v_p.tax_rate;
    v_subs := v_subs || v_p.subscription_id;
    v_plans := v_plans || v_p.plan;
    v_taxable := v_taxable + v_part_tax;
    v_seats := v_seats + coalesce(v_p.seats, 0);
    v_first_start := least(coalesce(v_first_start, v_p.period_start), v_p.period_start);
    v_n := v_n + 1;
    v_label := 'Advance payment for '
               || case v_p.cycle when 'quarterly' then 'Q' || v_p.period_index::text
                                 when 'half_yearly' then 'H' || v_p.period_index::text
                                 else 'month ' || v_p.period_index::text end
               || ' · ' || v_period;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',           'part-' || v_p.period_index::text || '-' || v_n::text,
      'name',         public.part_request_line_name(v_p.plan, v_p.domain, coalesce(v_p.seats, 0), v_period, v_p.period_index,
                                                    public.part_request_parts_in_term(v_p.term_months, v_p.cycle)),
      'description',  v_label,
      'qty',          case when public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax) then v_p.seats else 1 end,
      'rate',         case when public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax) then v_part_tax / v_p.seats else v_part_tax end,
      'per_seat',     public.r2519_per_seat(coalesce(v_p.seats, 0), v_part_tax),
      'period_start', v_p.period_start,
      'period_end',   v_p.period_end - 1,
      'cost',         0,
      'one_time',     true,
      'billing_id',   v_p.id::text));
  end loop;

  if (select count(distinct r) from unnest(v_rates) r) > 1 then
    raise exception 'Parts with different GST rates cannot be on one bill (%) — bill them separately.',
      (select string_agg(distinct coalesce(r::text, '?') || '%', ' and ') from unnest(v_rates) r) using errcode = '22023';
  end if;
  /* R-2519b: a part not begun is billed ahead only on a proforma — never mixed with a started part, whose pool
     credit could then put the not-begun part on a tax invoice ahead. */
  if v_begun is not null and v_ahead is not null then
    raise exception '% has not started yet — a part that has not started cannot be billed with a started one (%). Bill the started parts together now.',
      v_ahead, v_begun using errcode = '22023';
  end if;

  /* The request is linked to ONE part (subscription_billing_id, unique). rev2-r2810: a part freed by a credit note
     still holds its old, spent proforma's link — so the lead is the first ticked part with no old request. */
  select u.id into v_lead
    from unnest(v_ids) with ordinality u(id, n)
   where not exists (select 1 from public.quotes q where q.subscription_billing_id = u.id)
   order by u.n limit 1;
  if v_lead is null then
    raise exception 'Every one of these parts still carries an earlier proforma (%) — bill them with Bill next part one by one.',
      (select string_agg(q.id, ', ' order by q.id) from public.quotes q where q.subscription_billing_id = any(v_ids))
      using errcode = '22023';
  end if;
  select s.id, s.customer_id, s.customer_name, s.domain into v_lead_sub
    from public.subscription_billings b join public.subscriptions s on s.id = b.subscription_id where b.id = v_lead;

  /* GST: one rate; an export customer pays 0% (zero-rated, as Bill next part and the tax invoice). INR — the
     parts are laid in INR, like every part request. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_customer;
  v_rate := case when v_country is not null and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_rates[1] end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* The bill group: one id for the members, their sale-quote siblings and any group one was in — of THIS customer. */
  select min(s.bill_group_id::text)::uuid into v_group from public.subscriptions s where s.id = any(v_subs) and s.bill_group_id is not null;
  v_group := coalesce(v_group, gen_random_uuid());
  update public.subscriptions s
     set bill_group_id = v_group, updated_at = now()
   where s.tenant_id = v_tenant and s.customer_id = v_customer
     and s.bill_group_id is distinct from v_group
     and (s.id in (select bp.subscription_id from unnest(v_subs) m(id) cross join lateral public.billing_pool_subscriptions(m.id) bp)
          or s.bill_group_id in (select s2.bill_group_id from public.subscriptions s2 where s2.id = any(v_subs) and s2.bill_group_id is not null));

  /* Money already in the (now merged) pool: a started group it covers is invoiced at once (as Bill next part);
     a not-started group already paid for is invoiced on its date — no proforma asking for paid money. */
  v_credit := public.instalment_credit(v_lead_sub.id);
  if v_credit >= v_gross and v_ahead is not null then
    raise exception 'Money already received covers these parts (₹%) — they are invoiced on their dates; no proforma is needed.', v_gross
      using errcode = '22023';
  end if;

  v_terms := public.part_request_terms_days(v_lead_sub.id);
  v_due   := greatest(v_first_start, v_today) + v_terms;
  v_id := public.next_document_number('proforma', v_tenant);
  if v_id is null then
    raise exception 'No proforma number could be issued. Check Settings → Document numbering.';
  end if;

  perform set_config('app.r2519_write', 'on', true);
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id, currency, created_by
  ) values (
    v_id, v_tenant, v_customer, v_lead_sub.customer_name, array_to_string(v_plans, ' + '), v_seats, v_gross, 'sent', 'awaiting',
    v_lead_sub.domain, v_today, null, v_lines, v_taxable, 0, 0, v_rate,
    true, 'yearly', v_terms,
    'Billed together: ' || array_to_string(v_plans, ' + ') || '. Due on ' || to_char(v_due, 'FMDD Mon YYYY')
      || '. The tax invoice is issued when this is paid.',
    v_lead, 'INR', (select u.id from public.users u where u.id = auth.uid())
  );
  perform set_config('app.r2519_write', '', true);
  update public.subscription_billings set due_on = v_due, updated_at = now() where id = any(v_ids) and due_on is null;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, (select u.id from public.users u where u.id = auth.uid()), 'quote.bill_together', 'quote', v_id,
          left(format('Billed together on %s: %s', v_id, array_to_string(v_plans, ' + ')), 120),
          jsonb_build_object('billing_ids', to_jsonb(v_ids), 'subscription_ids', to_jsonb(v_subs), 'bill_group_id', v_group, 'gross', v_gross));

  /* Already paid from the pool, or an "Invoice on due date" customer (a started group) → its tax invoice now
     (Bill next part's rule); Bill next part then closes this proforma itself. Anything else it answers is a
     contradiction — undo everything rather than leave a live proforma for invoiced or paid parts. */
  if (v_credit >= v_gross or v_on_due) and v_ahead is null then
    v_inv := public.bill_subscription_instalment(v_lead, false);
    if v_inv->>'action' is distinct from 'invoice' or v_inv->>'invoice_id' is null
       or exists (select 1 from public.subscription_billings b where b.id = any(v_ids) and b.invoice_id is distinct from v_inv->>'invoice_id')
       or exists (select 1 from public.quotes q where q.id = v_id and q.invoice_id is null and q.status::text not in ('expired', 'rejected')) then
      raise exception 'These parts could not be invoiced together right now (%) — nothing was changed; try Bill next part, or ask support.',
        coalesce(v_inv->>'action', '?') || coalesce(' ' || (v_inv->>'reason'), '') using errcode = '22023';
    end if;
    return jsonb_build_object('action', 'invoice', 'quote_id', v_id, 'already_existed', false, 'invoice_id', v_inv->>'invoice_id',
      'subscription_ids', to_jsonb(v_subs), 'billing_ids', to_jsonb(v_ids), 'bill_group_id', v_group,
      'taxable', v_taxable, 'tax_rate', v_rate, 'gross', v_gross, 'currency', 'INR');
  end if;

  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'already_existed', false,
    'subscription_ids', to_jsonb(v_subs), 'billing_ids', to_jsonb(v_ids), 'bill_group_id', v_group,
    'taxable', v_taxable, 'tax_rate', v_rate, 'tax', v_tax, 'gross', v_gross, 'currency', 'INR', 'due_on', v_due);
end;
$$;
revoke all on function public.bill_parts_together(uuid[]) from public, anon;
grant execute on function public.bill_parts_together(uuid[]) to authenticated, service_role;

-- ── 3. cancel_quote — body of 20261106120956 (R-2527) + rev-r2806 F6 ──────────────────────────────
create or replace function public.cancel_quote(p_quote_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2810 (rev-r2806 F6): the later-period check covers every part a request names. R-2527: trusts only the login. R-2519d: a later row only laid does not refuse (the freed row is billed first). R-2519b: refused while a later period's proforma is open. R-2519: cancel an unpaid quote / proforma. The subscription is not touched. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_later   text;
begin
  /* R-2527: trust only the login, never a JWT role claim (R-2519c's rule for the guard). Before, a
     direct client login claiming service_role with no sub was trusted and skipped the company check.
     The service key through PostgREST runs as role service_role; the Cloud SQL admin client logs in
     as app_service and psql / scripts as their owner — none of them a request login. */
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can cancel a quote.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Write why it is cancelled (at least 5 characters) — it is kept on the record.' using errcode = '22023';
  end if;
  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote % not found.', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  /* rev2/rev3-r2810: a part request takes Bill together's per-customer lock right after its own row lock and
     BEFORE any part row is touched — the same order as bill_parts_together (lock, then parts), so the two never
     wait on each other in a circle; a Bill together running for this customer finishes first (or waits). */
  if v_q.subscription_billing_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('r2810:bill-together:' || v_q.tenant_id::text || ':' || coalesce(v_q.customer_id::text, ''), 0));
  end if;
  if v_q.cancelled_at is not null then
    raise exception 'Quote % is already cancelled.', v_q.id using errcode = '22023';
  end if;
  if v_q.status::text in ('rejected', 'expired') or v_q.superseded_by is not null then
    raise exception 'Quote % is already closed.', v_q.id using errcode = '22023';
  end if;
  if v_q.invoice_id is not null
     or exists (select 1 from public.invoices i where i.quote_id = v_q.id and i.status::text <> 'void')
     or (v_q.subscription_billing_id is not null and exists (
           select 1 from public.subscription_billings b where b.id = v_q.subscription_billing_id and b.invoice_id is not null)) then
    raise exception 'Quote % already has a tax invoice — cancel that with a credit note instead.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0) then
    raise exception 'Money was already received on % — refund it first, or record the rest.', v_q.id using errcode = '22023';
  end if;
  /* R-2519b: only the LATEST billed period of a subscription is freed. With a later period billed
     (a proforma, paid or not, or its tax invoice) the billing job — which bills only the current
     term — would never bill the freed earlier one again. */
  if v_q.subscription_billing_id is not null then
    /* R-2810 (rev-r2806 F6): every part this request names (a together proforma's members, not only its lead),
       and a later part named as a line of another live request — of a part on this bill (R-2810). */
    select string_agg(x.doc, ', ' order by x.ps, x.doc) into v_later
      from (select coalesce(q2.id, b2.invoice_id) as doc, min(b2.period_start) as ps
              from public.subscription_billings b
              join public.subscription_billings b2 on b2.subscription_id = b.subscription_id and b2.period_start > b.period_start
              left join public.quotes q2 on q2.tenant_id = v_q.tenant_id and q2.id <> v_q.id
                    and (q2.subscription_billing_id = b2.id
                         /* a line of another request counts only while that request is live (a dead one could
                            never be cancelled — no reachable way out) */
                         or (q2.subscription_billing_id is not null and q2.cancelled_at is null and q2.invoice_id is null
                             and q2.superseded_by is null and q2.status::text not in ('rejected', 'expired')
                             and jsonb_typeof(q2.line_items) = 'array'
                             and q2.line_items @> jsonb_build_array(jsonb_build_object('billing_id', b2.id::text))))
             where b.tenant_id = v_q.tenant_id
               and (b.id = v_q.subscription_billing_id
                    or b.id::text in (select l->>'billing_id'
                                        from jsonb_array_elements(case when jsonb_typeof(v_q.line_items) = 'array' then v_q.line_items else '[]'::jsonb end) l
                                       where l ? 'billing_id'))
               and (q2.id is not null or b2.invoice_id is not null)
             group by 1) x;
    /* R-2519d (coordinator): a later row that is only LAID (no proforma, no invoice) does not stop the
       cancel — the billing job and Bill next part bill the earliest freed row first (freed_parts_due). */
    if v_later is not null then
      raise exception 'A later period of this subscription is already billed (%) — cancel the later proforma(s) first; a paid or invoiced later period needs a credit note, not a cancel here.', v_later
        using errcode = '22023';
    end if;
  end if;
  if coalesce(v_q.is_add_seats, false) then
    raise exception 'Quote % added seats to a subscription — use Mark rejected, which also takes those seats back.', v_q.id
      using errcode = '22023';
  end if;
  /* Accepted with a seat change → those seats are already on the subscription (apply_part_request_terms). */
  if v_q.proforma_terms_applied_at is not null then
    raise exception 'Proforma % was accepted and its % seats are already on the subscription — change the seats from Manage seats, or record the payment.',
      v_q.id, v_q.proforma_seats using errcode = '22023';
  end if;

  perform set_config('app.r2519_write', 'on', true);
  update public.quotes
     set cancelled_from_status = v_q.status::text,
         cancelled_payment_status = v_q.payment_status::text,
         cancelled_part_billing_id = v_q.subscription_billing_id,
         subscription_billing_id = null,
         status = 'rejected',
         payment_status = 'none',
         cancelled_at = now(),
         cancelled_by = auth.uid(),
         cancel_reason = v_reason,
         notes = concat_ws(E'\n', nullif(notes, ''), 'Cancelled — ' || v_reason || ' (' || to_char(public.ist_today(), 'DD Mon YYYY') || ').')
   where id = v_q.id;
  perform set_config('app.r2519_write', '', true);
  /* The part(s) are free to be billed again — their due date was this request's (a group request
     names every part on its lines: billing_id). */
  if v_q.subscription_billing_id is not null then
    update public.subscription_billings
       set due_on = null, request_reminder_step = null, updated_at = now()
     where invoice_id is null and tenant_id = v_q.tenant_id
       and (id = v_q.subscription_billing_id
            or id::text in (select l->>'billing_id' from jsonb_array_elements(coalesce(v_q.line_items, '[]'::jsonb)) l
                             where l ? 'billing_id'));
  end if;

  /* R-2810 (coordinator, 15 Nov): Cancel never clears a bill group — reviews rev2–rev4 each found money used twice
     in an automatic un-group. All members are one customer, so a shared pool is never money-wrong, only less tidy. */

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_q.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'quote.cancelled', 'quote', v_q.id,
          left(format('Cancelled %s — %s', v_q.id, v_reason), 120),
          jsonb_build_object('status', jsonb_build_object('from', v_q.status::text, 'to', 'cancelled'), 'reason', v_reason));

  return jsonb_build_object('quote_id', v_q.id, 'status', 'cancelled', 'part_released', v_q.subscription_billing_id is not null);
end;
$$;
revoke all on function public.cancel_quote(text, text) from public, anon;
grant execute on function public.cancel_quote(text, text) to authenticated, service_role;

commit;
