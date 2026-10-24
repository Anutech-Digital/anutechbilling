-- deploy-peek: exists(select 1 from pg_proc where proname = 'format_document_number' and prosrc like '%R-1617%')
-- deploy-key: r1617nocut
--
-- R-1617 (19 Oct 2026): document number 10,000 was cut back to "1000".
--
-- format_document_number (20260930172000) padded with lpad(p_number::text, 4, '0').
-- Postgres lpad also TRUNCATES a longer string to the given length, so #10000 printed as
-- "…-1000" — the same string as the real #1000 of that series — and #990001 as "…-9900".
-- Document ids (invoices, receipts, POs) are primary keys, so the 10,000th document of a
-- financial year failed with a duplicate key inside record_payment / generate_invoice.
--
-- Decision (manager, for Pardeep): pad to AT LEAST 4 digits and never cut. The 16-character
-- limit of CGST Rule 46(b) stays: a number that would be longer is refused with an error that
-- names the series and the fix — never silently shortened. With the longest prefixes (INV,
-- RFV, BOS) a 3-letter invoice code leaves room for 5 digits; a 4-letter one is full at 9999.
--
-- Only format_document_number changes. next_document_number (latest body: R-1529,
-- 20261018022629) is untouched — it already calls this function. Existing numbers do not
-- change: 1..9999 print exactly as before. The raise rolls back the whole statement, so the
-- series counter does not move when a number is refused.
--
-- Same signature, same IMMUTABLE contract (it reads nothing but its arguments).
-- plpgsql instead of sql only so it can raise. Grants restated (Cloud SQL gives no PUBLIC
-- default — R-401).

begin;

create or replace function public.format_document_number(p_prefix text, p_fiscal_year text, p_number integer)
returns text
language plpgsql
immutable
as $function$
declare
  v_digits text := p_number::text;
  v_number text;
begin
  /* R-1617: <PREFIX>-<CODE>-<YY>-<NNNN…>. At least 4 digits, NEVER cut — lpad(x, 4) cut
     10000 to "1000", a duplicate of the real #1000. */
  if length(v_digits) < 4 then
    v_digits := lpad(v_digits, 4, '0');
  end if;
  v_number := p_prefix || '-' || substring(p_fiscal_year from 5 for 2) || '-' || v_digits;

  if length(v_number) > 16 then
    /* §24: what happened, why, what to do — all in the MESSAGE, because callers surface
       sqlerrm and drop the hint. The invoice code is locked once numbers are issued
       (api/tenant/invoice-code), so the next step names support, not a dead settings field. */
    raise exception 'Document series % is full for this financial year: the next number would be % (% characters), and GST allows at most 16 (CGST Rule 46(b)). To continue, shorten your invoice code to 3 letters (Settings > Invoice code; it is locked once numbers are issued, so ask support to change it). Old numbers stay as they are.',
        p_prefix, v_number, length(v_number)
      using errcode = 'check_violation';
  end if;

  return v_number;
end;
$function$;

comment on function public.format_document_number(text, text, integer) is
  'Document number shape, <= 16 characters (CGST Rule 46(b)). The FY is carried by its '
  'END year: FY2627 -> 27. At least 4 digits, never truncated; a number longer than 16 '
  'raises (series full) instead of being cut. R-015 / R-1617.';

grant execute on function public.format_document_number(text, text, integer) to authenticated, service_role;

commit;
