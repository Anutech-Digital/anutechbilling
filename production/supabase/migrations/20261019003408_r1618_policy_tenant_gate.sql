-- deploy-peek: exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'prepaid_advances' and policyname = 'prepaid_advances_all' and qual like '%current_tenant_id()%') and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_messages' and policyname = 'whatsapp_messages_tenant_write' and qual like '%current_tenant_id()%')
-- deploy-key: r1618policy
-- 20261019003408_r1618_policy_tenant_gate.sql
--
-- R-1618 (P1 security), found by the R-1615 worker; guard: supabase/tests/r1618_policy_tenant_guard.test.sql
--
-- ══ THE HOLE ══════════════════════════════════════════════════════════════════════════════
--   32 row-level-security policies on 22 tables found the caller's company with
--       tenant_id = (select tenant_id from public.users where id = auth.uid())
--   instead of public.current_tenant_id(). current_tenant_id() is NULL for a deactivated user
--   (R-722) and for an MFA-enrolled user whose session has not passed the second step (R-731,
--   session_mfa_ok()). So a deactivated user, or a password-only (aal1) session of an MFA user,
--   could still read and write these tables — prepaid_advances (money) first among them.
--   R-1615 closed the same hole in 14 SECURITY DEFINER functions; R-1560's guard covers
--   functions only, so table policies were never checked.
--
-- ══ THE FIX ═══════════════════════════════════════════════════════════════════════════════
--   Each policy is dropped and re-created with the SAME name, command, roles (PUBLIC — none of
--   them had a TO list) and permissive mode; the only change is the tenant source:
--       (select tenant_id from users where id = auth.uid())  →  (select public.current_tenant_id())
--   tenant_secrets also checked the role the same way ((select role from users ...) = 'owner');
--   that becomes public.current_user_has_role('owner') — the same owner-only intent, with
--   is_active + session_mfa_ok() like every other role gate.
--   Not touched: policies on customers / contacts (R-1004 is changing them) and the
--   policies that read users only for a role/employee check next to current_tenant_id().
--
-- Rollback: re-create the old expressions from git history of the original migrations
-- (do not — it re-opens the hole).

begin;

drop policy if exists prepaid_advances_all on public.prepaid_advances;
create policy prepaid_advances_all on public.prepaid_advances as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists attempts_select on public.assessment_attempts;
create policy attempts_select on public.assessment_attempts as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists assessments_all on public.assessments;
create policy assessments_all on public.assessments as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists "tenant select bank_aa_connections" on public.bank_aa_connections;
create policy "tenant select bank_aa_connections" on public.bank_aa_connections as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists compliance_log_delete on public.compliance_log;
create policy compliance_log_delete on public.compliance_log as permissive for DELETE
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists compliance_log_insert on public.compliance_log;
create policy compliance_log_insert on public.compliance_log as permissive for INSERT
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists compliance_log_select on public.compliance_log;
create policy compliance_log_select on public.compliance_log as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists compliance_log_update on public.compliance_log;
create policy compliance_log_update on public.compliance_log as permissive for UPDATE
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists contact_greeting_log_select on public.contact_greeting_log;
create policy contact_greeting_log_select on public.contact_greeting_log as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists contract_amendments_select on public.contract_amendments;
create policy contract_amendments_select on public.contract_amendments as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists inbound_purchases_select on public.inbound_purchases;
create policy inbound_purchases_select on public.inbound_purchases as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists inbound_purchases_update on public.inbound_purchases;
create policy inbound_purchases_update on public.inbound_purchases as permissive for UPDATE
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists invoice_dunning_log_select on public.invoice_dunning_log;
create policy invoice_dunning_log_select on public.invoice_dunning_log as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists mrr_snapshots_select on public.mrr_snapshots;
create policy mrr_snapshots_select on public.mrr_snapshots as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists payment_mandates_cancel on public.payment_mandates;
create policy payment_mandates_cancel on public.payment_mandates as permissive for UPDATE
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check (((tenant_id = ( select public.current_tenant_id() )) AND (status = 'cancelled'::mandate_status)));

drop policy if exists payment_mandates_select on public.payment_mandates;
create policy payment_mandates_select on public.payment_mandates as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists project_labour_rw on public.project_labour;
create policy project_labour_rw on public.project_labour as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists project_tasks_tenant_all on public.project_tasks;
create policy project_tasks_tenant_all on public.project_tasks as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists provisioning_tasks_select on public.provisioning_tasks;
create policy provisioning_tasks_select on public.provisioning_tasks as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists provisioning_tasks_write on public.provisioning_tasks;
create policy provisioning_tasks_write on public.provisioning_tasks as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists quote_signatures_select on public.quote_signatures;
create policy quote_signatures_select on public.quote_signatures as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists seat_increase_claims_select on public.seat_increase_claims;
create policy seat_increase_claims_select on public.seat_increase_claims as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists seat_requests_tenant on public.seat_requests;
create policy seat_requests_tenant on public.seat_requests as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists site_promos_tenant_read on public.site_promos;
create policy site_promos_tenant_read on public.site_promos as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists subscription_billings_select on public.subscription_billings;
create policy subscription_billings_select on public.subscription_billings as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists support_call_requests_select on public.support_call_requests;
create policy support_call_requests_select on public.support_call_requests as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists support_call_requests_update on public.support_call_requests;
create policy support_call_requests_update on public.support_call_requests as permissive for UPDATE
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists tenant_secrets_owner_insert on public.tenant_secrets;
create policy tenant_secrets_owner_insert on public.tenant_secrets as permissive for INSERT
  with check (((tenant_id = ( select public.current_tenant_id() )) AND (public.current_user_has_role('owner'))));

drop policy if exists tenant_secrets_owner_read on public.tenant_secrets;
create policy tenant_secrets_owner_read on public.tenant_secrets as permissive for SELECT
  using (((tenant_id = ( select public.current_tenant_id() )) AND (public.current_user_has_role('owner'))));

drop policy if exists tenant_secrets_owner_write on public.tenant_secrets;
create policy tenant_secrets_owner_write on public.tenant_secrets as permissive for UPDATE
  using (((tenant_id = ( select public.current_tenant_id() )) AND (public.current_user_has_role('owner'))))
  with check (((tenant_id = ( select public.current_tenant_id() )) AND (public.current_user_has_role('owner'))));

drop policy if exists whatsapp_messages_tenant_read on public.whatsapp_messages;
create policy whatsapp_messages_tenant_read on public.whatsapp_messages as permissive for SELECT
  using ((tenant_id = ( select public.current_tenant_id() )));

drop policy if exists whatsapp_messages_tenant_write on public.whatsapp_messages;
create policy whatsapp_messages_tenant_write on public.whatsapp_messages as permissive for ALL
  using ((tenant_id = ( select public.current_tenant_id() )))
  with check ((tenant_id = ( select public.current_tenant_id() )));

commit;
