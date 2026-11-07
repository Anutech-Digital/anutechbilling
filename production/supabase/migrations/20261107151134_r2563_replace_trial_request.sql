-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.replace_trial_request(uuid,text,text,text,text,text)') and prosrc like '%R-2563%')
-- deploy-key: r2563replacetrial
--
-- R-2563 (7 Nov 2026, follow-up of R-1491) — website /trial "← Change the request".
--
-- The visitor sends a trial request (lead + draft quote), presses "← Change the request", picks
-- another product and sends again. The second request said "Replaces my earlier request <no>", but
-- the FIRST lead and its draft quote stayed open — sales saw two open leads for one customer, one
-- of them quoting the wrong product.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────────────────────────
--   replace_trial_request(tenant, new lead, new quote, old lead, email, mobile) — called ONLY by the
--   two public enquiry handlers (service role), and only for an old lead whose signed replace token
--   the server itself gave to that browser with the first request (lib/leads/replace-trial-request.ts:
--   HMAC over tenant + lead + time + email + mobile). Here, in ONE transaction with row locks, it
--   checks everything again and then either closes the old request or leaves a note:
--
--   ignore (writes nothing) — another tenant, the new lead missing, the email OR mobile not the same
--                             as the new request's, the lead already binned, or old = new.
--   note   (lead stays open, one note per new request) — older than 24 h, not a website-form lead,
--                             the team moved its stage, it has a customer, a person logged an activity
--                             on it, or any quote on it was sent (status, invoice or a send-log row).
--   close  — the old lead goes to Junk (reason "other", note "Replaced by <new lead>": it leaves the
--            open lists, is not a lost deal or spam, Un-bin restores it); its never-sent DRAFT quotes
--            become 'expired' with superseded_by = the new draft quote (the R-482 "Replaced by …"
--            shape) when there is one; a note on both leads says what happened. A sent quote is
--            never touched.
--
-- owner_id is NOT a "the team picked it up" sign: leads_assign_new_owner gives every new lead an
-- owner by round robin when someone opted in. A person's own activity (created_by not null) is.
--
-- SECURITY DEFINER, execute for service_role only: anon / authenticated can never call it.

create or replace function public.replace_trial_request(
  p_tenant    uuid,
  p_new_lead  text,
  p_new_quote text,
  p_old_lead  text,
  p_email     text,
  p_phone     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- R-2563
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_phone  text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_old    public.leads;
  v_why    text;
  v_sent   text;
  v_quote  text;
  v_closed text[];
begin
  if p_tenant is null or p_new_lead is null or p_old_lead is null or p_old_lead = p_new_lead
     or v_email = '' or length(v_phone) < 10 then
    return jsonb_build_object('action', 'ignore', 'why', 'missing input');
  end if;

  -- The new lead must be this tenant's and carry the same contact (the handler just made it).
  perform 1 from public.leads l
   where l.id = p_new_lead and l.tenant_id = p_tenant
     and lower(btrim(coalesce(l.contact_email, ''))) = v_email
     and right(regexp_replace(coalesce(l.contact_phone, ''), '\D', '', 'g'), 10) = v_phone;
  if not found then
    return jsonb_build_object('action', 'ignore', 'why', 'new lead not found');
  end if;

  select * into v_old from public.leads l
   where l.id = p_old_lead and l.tenant_id = p_tenant
   for update;
  if not found then
    return jsonb_build_object('action', 'ignore', 'why', 'not found');
  end if;
  if lower(btrim(coalesce(v_old.contact_email, ''))) <> v_email
     or right(regexp_replace(coalesce(v_old.contact_phone, ''), '\D', '', 'g'), 10) <> v_phone then
    return jsonb_build_object('action', 'ignore', 'why', 'another contact');
  end if;
  if v_old.is_junk then
    return jsonb_build_object('action', 'ignore', 'why', 'already closed');
  end if;

  -- Lock its quotes too, so a Send cannot slip in between the check and the close.
  perform 1 from public.quotes q where q.tenant_id = p_tenant and q.lead_id = p_old_lead for update;
  select q.id into v_sent from public.quotes q
   where q.tenant_id = p_tenant and q.lead_id = p_old_lead
     and (q.status not in ('draft', 'expired')
          or q.invoice_id is not null
          or exists (select 1 from public.quote_send_log s where s.quote_id = q.id))
   order by q.id limit 1;

  v_why := case
    when v_old.created_at < now() - interval '24 hours' then 'it is older than 24 hours'
    when coalesce(v_old.source, '') not in ('website-trial', 'enquiry-form') then 'it did not come from the website form'
    when v_old.stage::text not in ('new', 'trial') then format('the team already moved it to "%s"', v_old.stage)
    when v_old.customer_id is not null then 'it is already linked to a customer'
    when exists (select 1 from public.lead_activities a where a.lead_id = p_old_lead and a.created_by is not null)
      then 'someone in the team already worked on it'
    when v_sent is not null then format('its quote %s was already sent', v_sent)
  end;

  if v_why is not null then
    insert into public.lead_activities (tenant_id, lead_id, kind, detail)
    select p_tenant, p_old_lead, 'note',
           format('The customer sent a new trial request (%s) that replaces this one. Not closed automatically — %s; check both and close one by hand.', p_new_lead, v_why)
     where not exists (select 1 from public.lead_activities a
                        where a.lead_id = p_old_lead and a.kind = 'note'
                          and a.detail like format('The customer sent a new trial request (%s)%%', p_new_lead));
    return jsonb_build_object('action', 'note', 'why', v_why);
  end if;

  -- The new draft quote, only if it is really the new lead's (else no "Replaced by" link).
  select q.id into v_quote from public.quotes q
   where q.id = p_new_quote and q.tenant_id = p_tenant and q.lead_id = p_new_lead;

  with closed as (
    update public.quotes q
       set status = 'expired', superseded_by = v_quote, superseded_at = now()
     where q.tenant_id = p_tenant and q.lead_id = p_old_lead
       and q.status = 'draft' and q.invoice_id is null and q.superseded_by is null
    returning q.id
  )
  select coalesce(array_agg(id order by id), '{}') into v_closed from closed;

  update public.leads
     set is_junk = true, junk_reason = 'other', junked_at = now(),
         junk_note = format('Replaced by %s — the customer changed the trial request on the website.', p_new_lead)
   where id = p_old_lead and tenant_id = p_tenant;

  insert into public.lead_activities (tenant_id, lead_id, kind, detail) values
    (p_tenant, p_old_lead, 'note',
     format('Closed automatically: replaced by %s — the customer changed the trial request on the website.%s',
            p_new_lead,
            case when cardinality(v_closed) > 0
                 then format(' Its draft quote %s was closed (never sent).', array_to_string(v_closed, ', '))
                 else '' end)),
    (p_tenant, p_new_lead, 'note',
     format('Replaces the customer''s earlier trial request %s (closed automatically, same email and mobile).', p_old_lead));

  return jsonb_build_object('action', 'close', 'quotes', to_jsonb(v_closed));
end;
$$;

revoke all on function public.replace_trial_request(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.replace_trial_request(uuid, text, text, text, text, text) to service_role;

comment on function public.replace_trial_request(uuid, text, text, text, text, text) is
  'R-2563: website /trial "Change the request" — closes the SAME contact''s earlier untouched trial lead (Junk "Replaced by …") and expires its never-sent draft quotes, or leaves a note. Service role only; the handler first checks a server-signed replace token.';
