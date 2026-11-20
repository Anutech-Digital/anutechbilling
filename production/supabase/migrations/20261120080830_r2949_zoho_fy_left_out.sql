-- deploy-peek: to_regclass('public.zoho_fy_left_out') is not null and exists(select 1 from pg_trigger where tgname = 'trg_invoices_zoho_sale_left_out' and tgrelid = to_regclass('public.invoices')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_invoices_zoho_sale_left_out()') and prosrc like '%R-2949%')
--
-- R-2949 (G-RECON) — Invoices → "FY 2025-26 sales from Zoho": the owner leaves Zoho invoices OUT of
-- the import and the app remembers it.
--
-- Why: the dialog showed only counts ("52 to import"), and one of them carried a number series of a
-- closed business line that must never enter this company's books. There was no way to leave one
-- invoice out: Import took everything, Remove import removed a whole batch.
--
-- What:
--   1. public.zoho_fy_left_out — one row per rule, per company:
--        rule 'doc'    → value = the Zoho invoice id (number kept for display);
--        rule 'prefix' → value = the start of the invoice number, UPPER CASE, trimmed, 2–20 characters.
--      Server only, like the Zoho scan next to it (zoho_fy_scan): RLS on, no grant to anon /
--      authenticated, service_role policy. The API route reads and writes it with the admin client,
--      always filtered by the signed-in user's own tenant, owner / accountant only
--      (src/lib/integrations/zoho-books/sales-import/left-out-store.ts).
--   2. trg_invoices_zoho_sale_left_out — the database refuses to ADD an FY sale from Zoho that matches
--      one of the company's rules. The route's plan already skips those invoices; this is the second
--      lock, for a direct call to import_zoho_fy_sales (it is granted to authenticated). Inside the
--      import the refusal is caught per invoice (reason in the part's "refused" list) — the rest of
--      the part still comes in. Insert only: an invoice already in the books is never touched.
--
-- Additive and idempotent. No existing function is redefined. No data is changed.

create table if not exists public.zoho_fy_left_out (
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  kind        text        not null,
  rule        text        not null,
  value       text        not null,
  number      text,
  created_by  uuid        references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, kind, rule, value),
  constraint zoho_fy_left_out_kind_check   check (kind in ('invoices')),
  constraint zoho_fy_left_out_rule_check   check (rule in ('doc', 'prefix')),
  constraint zoho_fy_left_out_value_check  check (char_length(value) between 1 and 40),
  constraint zoho_fy_left_out_number_check check (number is null or char_length(number) <= 60),
  constraint zoho_fy_left_out_prefix_check check (rule <> 'prefix' or (value = upper(btrim(value)) and char_length(value) between 2 and 20))
);
comment on table public.zoho_fy_left_out is
  'R-2949: Zoho documents the owner keeps out of the FY import — one invoice (rule doc, value = Zoho id) or every number starting with a prefix (rule prefix, upper case). Server only; the import plan and trg_invoices_zoho_sale_left_out obey it.';

alter table public.zoho_fy_left_out enable row level security;
revoke all on table public.zoho_fy_left_out from public, anon, authenticated;
grant all on table public.zoho_fy_left_out to service_role;
drop policy if exists zzz_service_role_all on public.zoho_fy_left_out;
create policy zzz_service_role_all on public.zoho_fy_left_out as permissive for all to service_role using (true) with check (true);

-- ── The second lock: no FY sale from Zoho is added against the owner's own rule ────────────────
-- SECURITY DEFINER: the table has no grant for the caller's role; the function reads only the rows
-- of the NEW invoice's own tenant and gives back nothing but the refusal.
create or replace function public.tg_invoices_zoho_sale_left_out()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_number text := upper(btrim(coalesce(new.external_number, new.id, '')));
begin
  /* R-2949 */
  if exists (
    select 1 from public.zoho_fy_left_out l
     where l.tenant_id = new.tenant_id and l.kind = 'invoices'
       and ((l.rule = 'doc' and l.value = new.zoho_invoice_id)
         or (l.rule = 'prefix' and left(v_number, char_length(l.value)) = l.value))
  ) then
    raise exception 'Left out by you — take it back under "Left out by you" (Invoices → FY sales from Zoho) to import it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_invoices_zoho_sale_left_out() from public, anon, authenticated;

-- Named to fire AFTER trg_invoices_zoho_sale_guard (triggers run in name order): a row that is not
-- from the import at all is refused there first, with its own message.
drop trigger if exists trg_invoices_zoho_sale_left_out on public.invoices;
create trigger trg_invoices_zoho_sale_left_out
  before insert on public.invoices
  for each row when (new.zoho_invoice_id is not null)
  execute function public.tg_invoices_zoho_sale_left_out();
