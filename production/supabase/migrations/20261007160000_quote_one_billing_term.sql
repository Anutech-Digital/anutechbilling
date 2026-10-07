-- 20261007160000_quote_one_billing_term.sql
--
-- R-381 (money bug, 7 Oct 2026). A quote with one flex-monthly line and one annual line
-- summed a MONTH and a YEAR into one subtotal: a monthly line's rate is per seat per
-- month, an annual_* line's per seat per year (lib/quotes/commitment-rate.ts). The PDF,
-- e-mail and builder all read the term from the first line, so the total carried the
-- wrong unit. Rule: one quote = one billing term. Monthly items go on a separate quote.
--
-- The app refuses the mix in the quote builder (lib/quotes/single-term.ts). This trigger
-- is the backstop for user-made quotes:
--   * only for anon / authenticated callers. Service-role writes are left alone - cart
--     checkout (lib/checkout/cart-checkout.ts) puts monthly hosting beside a domain on
--     one order quote, and that path bills per line itself;
--   * on INSERT, and on UPDATE OF line_items only when the change INTRODUCES the mix.
--     Existing mixed rows (local DB had 0 on 7 Oct) are not touched and stay editable;
--   * an empty commitment counts as annual (the column default, annual_yearly).
--
-- NOT APPLIED by the worker - the manager applies it (staging first).
-- Test (rolled back): supabase/tests/r381_quote_one_billing_term.test.sql

create or replace function public.quote_line_terms_mixed(p_lines jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_lines is null or jsonb_typeof(p_lines) <> 'array' then false
    else exists (select 1 from jsonb_array_elements(p_lines) e
                  where jsonb_typeof(e) = 'object' and e->>'commitment' = 'monthly')
     and exists (select 1 from jsonb_array_elements(p_lines) e
                  where jsonb_typeof(e) = 'object'
                    and coalesce(e->>'commitment', 'annual_yearly') <> 'monthly')
  end;
$$;

comment on function public.quote_line_terms_mixed(jsonb) is
  'R-381: true when a quote''s line_items hold a monthly flex line AND an annual line (missing commitment = annual).';

create or replace function public.quotes_refuse_mixed_billing_term()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;
  if not public.quote_line_terms_mixed(new.line_items) then
    return new;
  end if;
  -- An old mixed row stays editable: only a change that CREATES the mix is refused.
  if tg_op = 'UPDATE' and public.quote_line_terms_mixed(old.line_items) then
    return new;
  end if;
  raise exception 'One quote = one billing term. Put monthly items on a separate quote.'
    using errcode = 'check_violation',
          hint = 'R-381: a monthly flex line is priced per month, annual lines per year.';
end;
$$;

drop trigger if exists trg_quotes_one_billing_term on public.quotes;
create trigger trg_quotes_one_billing_term
  before insert or update of line_items on public.quotes
  for each row execute function public.quotes_refuse_mixed_billing_term();
