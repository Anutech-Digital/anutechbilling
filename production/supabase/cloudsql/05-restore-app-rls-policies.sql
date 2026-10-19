-- Auto-generated from SOURCE Supabase pg_policies (7 Sep 2026).
-- Recreates the app RLS policies that were missing on Cloud SQL. Idempotent (DROP IF EXISTS + CREATE).
--
-- Only a table's OWNER may CREATE POLICY on it, and every public table is owned by
-- resellersos_migration. So we run as postgres, grant that role to postgres (creator has
-- admin on it), and SET ROLE to it. ON_ERROR_STOP guards ONLY the role switch — if that
-- fails we must NOT create policies as the wrong role. Then it is turned OFF so one bad
-- policy (e.g. a helper function that does not exist on Cloud SQL) does not abort the rest.
\set ON_ERROR_STOP on
GRANT resellersos_migration TO postgres;
SET ROLE resellersos_migration;
\echo 'role is now:' 
SELECT current_user;
\set ON_ERROR_STOP off

DROP POLICY IF EXISTS access_credentials_delete ON public.access_credentials;
CREATE POLICY access_credentials_delete ON public.access_credentials AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS access_credentials_insert ON public.access_credentials;
CREATE POLICY access_credentials_insert ON public.access_credentials AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS access_credentials_select ON public.access_credentials;
CREATE POLICY access_credentials_select ON public.access_credentials AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS access_credentials_update ON public.access_credentials;
CREATE POLICY access_credentials_update ON public.access_credentials AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS activity_log_sel ON public.activity_log;
CREATE POLICY activity_log_sel ON public.activity_log AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_action_log_select ON public.ai_action_log;
CREATE POLICY ai_action_log_select ON public.ai_action_log AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_autonomy_select ON public.ai_autonomy;
CREATE POLICY ai_autonomy_select ON public.ai_autonomy AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_autonomy_write ON public.ai_autonomy;
CREATE POLICY ai_autonomy_write ON public.ai_autonomy AS PERMISSIVE FOR ALL TO public USING (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.tenant_id = current_tenant_id()) AND (u.role = ANY (ARRAY['owner'::user_role, 'manager'::user_role])))))));
DROP POLICY IF EXISTS ai_draft_feedback_select ON public.ai_draft_feedback;
CREATE POLICY ai_draft_feedback_select ON public.ai_draft_feedback AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_draft_feedback_service ON public.ai_draft_feedback;
CREATE POLICY ai_draft_feedback_service ON public.ai_draft_feedback AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS ai_sales_conversations_select ON public.ai_sales_conversations;
CREATE POLICY ai_sales_conversations_select ON public.ai_sales_conversations AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_sales_conversations_service ON public.ai_sales_conversations;
CREATE POLICY ai_sales_conversations_service ON public.ai_sales_conversations AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS ai_sales_loops_cancel ON public.ai_sales_loops;
CREATE POLICY ai_sales_loops_cancel ON public.ai_sales_loops AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_sales_loops_select ON public.ai_sales_loops;
CREATE POLICY ai_sales_loops_select ON public.ai_sales_loops AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_sales_loops_service ON public.ai_sales_loops;
CREATE POLICY ai_sales_loops_service ON public.ai_sales_loops AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS ai_support_conversations_select ON public.ai_support_conversations;
CREATE POLICY ai_support_conversations_select ON public.ai_support_conversations AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_support_conversations_service ON public.ai_support_conversations;
CREATE POLICY ai_support_conversations_service ON public.ai_support_conversations AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS ai_telecall_logs_select ON public.ai_telecall_logs;
CREATE POLICY ai_telecall_logs_select ON public.ai_telecall_logs AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS ai_telecall_logs_service ON public.ai_telecall_logs;
CREATE POLICY ai_telecall_logs_service ON public.ai_telecall_logs AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS api_keys_insert_own ON public.api_keys;
CREATE POLICY api_keys_insert_own ON public.api_keys AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS api_keys_select_own ON public.api_keys;
CREATE POLICY api_keys_select_own ON public.api_keys AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS api_keys_update_own ON public.api_keys;
CREATE POLICY api_keys_update_own ON public.api_keys AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS attempts_select ON public.assessment_attempts;
CREATE POLICY attempts_select ON public.assessment_attempts AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS assessments_all ON public.assessments;
CREATE POLICY assessments_all ON public.assessments AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.attendance;
CREATE POLICY "tenant isolation delete" ON public.attendance AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.attendance;
CREATE POLICY "tenant isolation read" ON public.attendance AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.attendance;
CREATE POLICY "tenant isolation update" ON public.attendance AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.attendance;
CREATE POLICY "tenant isolation write" ON public.attendance AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.attendance_settings;
CREATE POLICY "tenant isolation read" ON public.attendance_settings AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.attendance_settings;
CREATE POLICY "tenant isolation update" ON public.attendance_settings AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.attendance_settings;
CREATE POLICY "tenant isolation write" ON public.attendance_settings AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.balance_sheet_items;
CREATE POLICY "tenant isolation delete" ON public.balance_sheet_items AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.balance_sheet_items;
CREATE POLICY "tenant isolation read" ON public.balance_sheet_items AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.balance_sheet_items;
CREATE POLICY "tenant isolation update" ON public.balance_sheet_items AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.balance_sheet_items;
CREATE POLICY "tenant isolation write" ON public.balance_sheet_items AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant delete bank_aa_connections" ON public.bank_aa_connections;
CREATE POLICY "tenant delete bank_aa_connections" ON public.bank_aa_connections AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant insert bank_aa_connections" ON public.bank_aa_connections;
CREATE POLICY "tenant insert bank_aa_connections" ON public.bank_aa_connections AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant select bank_aa_connections" ON public.bank_aa_connections;
CREATE POLICY "tenant select bank_aa_connections" ON public.bank_aa_connections AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant update bank_aa_connections" ON public.bank_aa_connections;
CREATE POLICY "tenant update bank_aa_connections" ON public.bank_aa_connections AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.bank_accounts;
CREATE POLICY "tenant isolation delete" ON public.bank_accounts AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.bank_accounts;
CREATE POLICY "tenant isolation read" ON public.bank_accounts AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.bank_accounts;
CREATE POLICY "tenant isolation update" ON public.bank_accounts AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.bank_accounts;
CREATE POLICY "tenant isolation write" ON public.bank_accounts AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.bank_transactions;
CREATE POLICY "tenant isolation delete" ON public.bank_transactions AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.bank_transactions;
CREATE POLICY "tenant isolation read" ON public.bank_transactions AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.bank_transactions;
CREATE POLICY "tenant isolation update" ON public.bank_transactions AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.bank_transactions;
CREATE POLICY "tenant isolation write" ON public.bank_transactions AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.business_loan_payments;
CREATE POLICY "tenant isolation delete" ON public.business_loan_payments AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.business_loan_payments;
CREATE POLICY "tenant isolation read" ON public.business_loan_payments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.business_loan_payments;
CREATE POLICY "tenant isolation update" ON public.business_loan_payments AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.business_loan_payments;
CREATE POLICY "tenant isolation write" ON public.business_loan_payments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.business_loans;
CREATE POLICY "tenant isolation delete" ON public.business_loans AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.business_loans;
CREATE POLICY "tenant isolation read" ON public.business_loans AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.business_loans;
CREATE POLICY "tenant isolation update" ON public.business_loans AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.business_loans;
CREATE POLICY "tenant isolation write" ON public.business_loans AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS campaign_sends_select ON public.campaign_sends;
CREATE POLICY campaign_sends_select ON public.campaign_sends AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS campaign_sends_service_role ON public.campaign_sends;
CREATE POLICY campaign_sends_service_role ON public.campaign_sends AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ctmpl_delete ON public.campaign_templates;
CREATE POLICY ctmpl_delete ON public.campaign_templates AS PERMISSIVE FOR DELETE TO authenticated USING (((is_system = false) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS ctmpl_insert ON public.campaign_templates;
CREATE POLICY ctmpl_insert ON public.campaign_templates AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((is_system = false) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS ctmpl_select ON public.campaign_templates;
CREATE POLICY ctmpl_select ON public.campaign_templates AS PERMISSIVE FOR SELECT TO authenticated USING (((is_system = true) OR (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS ctmpl_service_role ON public.campaign_templates;
CREATE POLICY ctmpl_service_role ON public.campaign_templates AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ctmpl_update ON public.campaign_templates;
CREATE POLICY ctmpl_update ON public.campaign_templates AS PERMISSIVE FOR UPDATE TO authenticated USING (((is_system = false) AND (tenant_id = current_tenant_id()))) WITH CHECK (((is_system = false) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS campaigns_delete ON public.campaigns;
CREATE POLICY campaigns_delete ON public.campaigns AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS campaigns_insert ON public.campaigns;
CREATE POLICY campaigns_insert ON public.campaigns AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS campaigns_select ON public.campaigns;
CREATE POLICY campaigns_select ON public.campaigns AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS campaigns_service_role ON public.campaigns;
CREATE POLICY campaigns_service_role ON public.campaigns AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS campaigns_update ON public.campaigns;
CREATE POLICY campaigns_update ON public.campaigns AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS compliance_log_delete ON public.compliance_log;
CREATE POLICY compliance_log_delete ON public.compliance_log AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS compliance_log_insert ON public.compliance_log;
CREATE POLICY compliance_log_insert ON public.compliance_log AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS compliance_log_select ON public.compliance_log;
CREATE POLICY compliance_log_select ON public.compliance_log AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS compliance_log_update ON public.compliance_log;
CREATE POLICY compliance_log_update ON public.compliance_log AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS compliance_reminder_log_sel ON public.compliance_reminder_log;
CREATE POLICY compliance_reminder_log_sel ON public.compliance_reminder_log AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS contact_greeting_log_select ON public.contact_greeting_log;
CREATE POLICY contact_greeting_log_select ON public.contact_greeting_log AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS contacts_insert ON public.contacts;
CREATE POLICY contacts_insert ON public.contacts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS contacts_service_role ON public.contacts;
CREATE POLICY contacts_service_role ON public.contacts AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS contract_amendments_select ON public.contract_amendments;
CREATE POLICY contract_amendments_select ON public.contract_amendments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS coupon_red_select ON public.coupon_redemptions;
CREATE POLICY coupon_red_select ON public.coupon_redemptions AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS coupon_red_service_role ON public.coupon_redemptions;
CREATE POLICY coupon_red_service_role ON public.coupon_redemptions AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS coupons_delete ON public.coupons;
CREATE POLICY coupons_delete ON public.coupons AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS coupons_insert ON public.coupons;
CREATE POLICY coupons_insert ON public.coupons AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS coupons_select ON public.coupons;
CREATE POLICY coupons_select ON public.coupons AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS coupons_service_role ON public.coupons;
CREATE POLICY coupons_service_role ON public.coupons AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS coupons_update ON public.coupons;
CREATE POLICY coupons_update ON public.coupons AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS credit_notes_delete_own_tenant ON public.credit_notes;
CREATE POLICY credit_notes_delete_own_tenant ON public.credit_notes AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS credit_notes_insert_own_tenant ON public.credit_notes;
CREATE POLICY credit_notes_insert_own_tenant ON public.credit_notes AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS credit_notes_select_own_tenant ON public.credit_notes;
CREATE POLICY credit_notes_select_own_tenant ON public.credit_notes AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS credit_notes_service_role_all ON public.credit_notes;
CREATE POLICY credit_notes_service_role_all ON public.credit_notes AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS credit_notes_update_own_tenant ON public.credit_notes;
CREATE POLICY credit_notes_update_own_tenant ON public.credit_notes AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_credits_delete_own_tenant ON public.customer_credits;
CREATE POLICY customer_credits_delete_own_tenant ON public.customer_credits AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_credits_insert_own_tenant ON public.customer_credits;
CREATE POLICY customer_credits_insert_own_tenant ON public.customer_credits AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_credits_select_own_tenant ON public.customer_credits;
CREATE POLICY customer_credits_select_own_tenant ON public.customer_credits AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_credits_service_role_all ON public.customer_credits;
CREATE POLICY customer_credits_service_role_all ON public.customer_credits AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS customer_credits_update_own_tenant ON public.customer_credits;
CREATE POLICY customer_credits_update_own_tenant ON public.customer_credits AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_domains_tenant ON public.customer_domains;
CREATE POLICY customer_domains_tenant ON public.customer_domains AS PERMISSIVE FOR ALL TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_groups_delete_own_tenant ON public.customer_groups;
CREATE POLICY customer_groups_delete_own_tenant ON public.customer_groups AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_groups_insert_own_tenant ON public.customer_groups;
CREATE POLICY customer_groups_insert_own_tenant ON public.customer_groups AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_groups_select_own_tenant ON public.customer_groups;
CREATE POLICY customer_groups_select_own_tenant ON public.customer_groups AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_groups_service_role_all ON public.customer_groups;
CREATE POLICY customer_groups_service_role_all ON public.customer_groups AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS customer_groups_update_own_tenant ON public.customer_groups;
CREATE POLICY customer_groups_update_own_tenant ON public.customer_groups AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_number_seq_service ON public.customer_number_seq;
CREATE POLICY customer_number_seq_service ON public.customer_number_seq AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS customer_users_insert_service_role ON public.customer_users;
CREATE POLICY customer_users_insert_service_role ON public.customer_users AS PERMISSIVE FOR INSERT TO public WITH CHECK (((tenant_id = current_tenant_id()) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS customer_users_select_own_tenant ON public.customer_users;
CREATE POLICY customer_users_select_own_tenant ON public.customer_users AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customer_users_select_self ON public.customer_users;
CREATE POLICY customer_users_select_self ON public.customer_users AS PERMISSIVE FOR SELECT TO public USING ((auth_user_id = auth.uid()));
DROP POLICY IF EXISTS customer_users_update_operator ON public.customer_users;
CREATE POLICY customer_users_update_operator ON public.customer_users AS PERMISSIVE FOR UPDATE TO public USING (((tenant_id = current_tenant_id()) OR (auth.role() = 'service_role'::text))) WITH CHECK (((tenant_id = current_tenant_id()) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS customers_delete ON public.customers;
CREATE POLICY customers_delete ON public.customers AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customers_hierarchy_delete ON public.customers;
CREATE POLICY customers_hierarchy_delete ON public.customers AS RESTRICTIVE FOR DELETE TO public USING (can_see_record(account_manager_id));
DROP POLICY IF EXISTS customers_hierarchy_select ON public.customers;
CREATE POLICY customers_hierarchy_select ON public.customers AS RESTRICTIVE FOR SELECT TO public USING (can_see_record(account_manager_id));
DROP POLICY IF EXISTS customers_hierarchy_write ON public.customers;
CREATE POLICY customers_hierarchy_write ON public.customers AS RESTRICTIVE FOR UPDATE TO public USING (can_see_record(account_manager_id));
DROP POLICY IF EXISTS customers_insert ON public.customers;
CREATE POLICY customers_insert ON public.customers AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customers_select ON public.customers;
CREATE POLICY customers_select ON public.customers AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS customers_select_self_customer ON public.customers;
CREATE POLICY customers_select_self_customer ON public.customers AS PERMISSIVE FOR SELECT TO public USING ((id = current_customer_id()));
DROP POLICY IF EXISTS customers_update ON public.customers;
CREATE POLICY customers_update ON public.customers AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS debit_notes_delete_own_tenant ON public.debit_notes;
CREATE POLICY debit_notes_delete_own_tenant ON public.debit_notes AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS debit_notes_insert_own_tenant ON public.debit_notes;
CREATE POLICY debit_notes_insert_own_tenant ON public.debit_notes AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS debit_notes_select_own_tenant ON public.debit_notes;
CREATE POLICY debit_notes_select_own_tenant ON public.debit_notes AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS debit_notes_service_role_all ON public.debit_notes;
CREATE POLICY debit_notes_service_role_all ON public.debit_notes AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS debit_notes_update_own_tenant ON public.debit_notes;
CREATE POLICY debit_notes_update_own_tenant ON public.debit_notes AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS document_series_select ON public.document_series;
CREATE POLICY document_series_select ON public.document_series AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS document_series_service_role ON public.document_series;
CREATE POLICY document_series_service_role ON public.document_series AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS documents_tenant ON public.documents;
CREATE POLICY documents_tenant ON public.documents AS PERMISSIVE FOR ALL TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS email_log_select ON public.email_log;
CREATE POLICY email_log_select ON public.email_log AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.emi_payments;
CREATE POLICY "tenant isolation delete" ON public.emi_payments AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.emi_payments;
CREATE POLICY "tenant isolation read" ON public.emi_payments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.emi_payments;
CREATE POLICY "tenant isolation update" ON public.emi_payments AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.emi_payments;
CREATE POLICY "tenant isolation write" ON public.emi_payments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.emi_purchases;
CREATE POLICY "tenant isolation delete" ON public.emi_purchases AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.emi_purchases;
CREATE POLICY "tenant isolation read" ON public.emi_purchases AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.emi_purchases;
CREATE POLICY "tenant isolation update" ON public.emi_purchases AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.emi_purchases;
CREATE POLICY "tenant isolation write" ON public.emi_purchases AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "employee_documents tenant all" ON public.employee_documents;
CREATE POLICY "employee_documents tenant all" ON public.employee_documents AS PERMISSIVE FOR ALL TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.employee_loan_repayments;
CREATE POLICY "tenant isolation delete" ON public.employee_loan_repayments AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.employee_loan_repayments;
CREATE POLICY "tenant isolation read" ON public.employee_loan_repayments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.employee_loan_repayments;
CREATE POLICY "tenant isolation write" ON public.employee_loan_repayments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.employee_loans;
CREATE POLICY "tenant isolation delete" ON public.employee_loans AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.employee_loans;
CREATE POLICY "tenant isolation read" ON public.employee_loans AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.employee_loans;
CREATE POLICY "tenant isolation update" ON public.employee_loans AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.employee_loans;
CREATE POLICY "tenant isolation write" ON public.employee_loans AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.employees;
CREATE POLICY "tenant isolation delete" ON public.employees AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.employees;
CREATE POLICY "tenant isolation read" ON public.employees AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.employees;
CREATE POLICY "tenant isolation update" ON public.employees AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.employees;
CREATE POLICY "tenant isolation write" ON public.employees AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.expense_claims;
CREATE POLICY "tenant isolation delete" ON public.expense_claims AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.expense_claims;
CREATE POLICY "tenant isolation read" ON public.expense_claims AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.expense_claims;
CREATE POLICY "tenant isolation update" ON public.expense_claims AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS expenses_delete_own_tenant ON public.expenses;
CREATE POLICY expenses_delete_own_tenant ON public.expenses AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS expenses_insert_own_tenant ON public.expenses;
CREATE POLICY expenses_insert_own_tenant ON public.expenses AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS expenses_select_own_tenant ON public.expenses;
CREATE POLICY expenses_select_own_tenant ON public.expenses AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS expenses_update_own_tenant ON public.expenses;
CREATE POLICY expenses_update_own_tenant ON public.expenses AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_insert ON public.feedback;
CREATE POLICY feedback_insert ON public.feedback AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_select ON public.feedback;
CREATE POLICY feedback_select ON public.feedback AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_update ON public.feedback;
CREATE POLICY feedback_update ON public.feedback AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_screenshots_delete ON public.feedback_screenshots;
CREATE POLICY feedback_screenshots_delete ON public.feedback_screenshots AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_screenshots_insert ON public.feedback_screenshots;
CREATE POLICY feedback_screenshots_insert ON public.feedback_screenshots AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS feedback_screenshots_select ON public.feedback_screenshots;
CREATE POLICY feedback_screenshots_select ON public.feedback_screenshots AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS holidays_delete_own_tenant ON public.holidays;
CREATE POLICY holidays_delete_own_tenant ON public.holidays AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS holidays_insert_own_tenant ON public.holidays;
CREATE POLICY holidays_insert_own_tenant ON public.holidays AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS holidays_select_own_tenant ON public.holidays;
CREATE POLICY holidays_select_own_tenant ON public.holidays AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS holidays_service_role_all ON public.holidays;
CREATE POLICY holidays_service_role_all ON public.holidays AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS inbound_emails_select_own_tenant ON public.inbound_emails;
CREATE POLICY inbound_emails_select_own_tenant ON public.inbound_emails AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS inbound_purchases_select ON public.inbound_purchases;
CREATE POLICY inbound_purchases_select ON public.inbound_purchases AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS inbound_purchases_update ON public.inbound_purchases;
CREATE POLICY inbound_purchases_update ON public.inbound_purchases AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS invoice_dunning_log_select ON public.invoice_dunning_log;
CREATE POLICY invoice_dunning_log_select ON public.invoice_dunning_log AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS invoices_insert ON public.invoices;
CREATE POLICY invoices_insert ON public.invoices AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS invoices_select_own_customer ON public.invoices;
-- R-728 (migration 20261019013050): not re-created — it showed portal logins whole invoice rows, cost included.
DROP POLICY IF EXISTS invoices_update ON public.invoices;
CREATE POLICY invoices_update ON public.invoices AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS items_delete ON public.items;
CREATE POLICY items_delete ON public.items AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS items_insert ON public.items;
CREATE POLICY items_insert ON public.items AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS items_select ON public.items;
CREATE POLICY items_select ON public.items AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS items_update ON public.items;
CREATE POLICY items_update ON public.items AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS join_requests_decide ON public.join_requests;
CREATE POLICY join_requests_decide ON public.join_requests AS PERMISSIVE FOR UPDATE TO authenticated USING (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.role = ANY (ARRAY['owner'::user_role, 'manager'::user_role]))))))) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS join_requests_select ON public.join_requests;
CREATE POLICY join_requests_select ON public.join_requests AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.lead_activities;
CREATE POLICY "tenant isolation delete" ON public.lead_activities AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation insert" ON public.lead_activities;
CREATE POLICY "tenant isolation insert" ON public.lead_activities AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.lead_activities;
CREATE POLICY "tenant isolation read" ON public.lead_activities AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS leads_delete ON public.leads;
CREATE POLICY leads_delete ON public.leads AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS leads_hierarchy_delete ON public.leads;
CREATE POLICY leads_hierarchy_delete ON public.leads AS RESTRICTIVE FOR DELETE TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS leads_hierarchy_select ON public.leads;
CREATE POLICY leads_hierarchy_select ON public.leads AS RESTRICTIVE FOR SELECT TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS leads_hierarchy_write ON public.leads;
CREATE POLICY leads_hierarchy_write ON public.leads AS RESTRICTIVE FOR UPDATE TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS leads_insert ON public.leads;
CREATE POLICY leads_insert ON public.leads AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS leads_select ON public.leads;
CREATE POLICY leads_select ON public.leads AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS leads_update ON public.leads;
CREATE POLICY leads_update ON public.leads AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.leave_entries;
CREATE POLICY "tenant isolation delete" ON public.leave_entries AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.leave_entries;
CREATE POLICY "tenant isolation read" ON public.leave_entries AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.leave_entries;
CREATE POLICY "tenant isolation update" ON public.leave_entries AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.leave_entries;
CREATE POLICY "tenant isolation write" ON public.leave_entries AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS mrr_snapshots_select ON public.mrr_snapshots;
CREATE POLICY mrr_snapshots_select ON public.mrr_snapshots AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS notifications_service ON public.notifications;
CREATE POLICY notifications_service ON public.notifications AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS notifications_update ON public.notifications;
CREATE POLICY notifications_update ON public.notifications AS PERMISSIVE FOR UPDATE TO authenticated USING (((user_id = auth.uid()) AND (tenant_id = current_tenant_id()))) WITH CHECK (((user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS payment_mandates_cancel ON public.payment_mandates;
CREATE POLICY payment_mandates_cancel ON public.payment_mandates AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK (((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))) AND (status = 'cancelled'::mandate_status)));
DROP POLICY IF EXISTS payment_mandates_select ON public.payment_mandates;
CREATE POLICY payment_mandates_select ON public.payment_mandates AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS payments_insert ON public.payments;
CREATE POLICY payments_insert ON public.payments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select ON public.payments AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS payments_select_own_customer ON public.payments;
CREATE POLICY payments_select_own_customer ON public.payments AS PERMISSIVE FOR SELECT TO public USING ((customer_id = current_customer_id()));
DROP POLICY IF EXISTS payments_service_role_all ON public.payments;
CREATE POLICY payments_service_role_all ON public.payments AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS payments_update ON public.payments;
CREATE POLICY payments_update ON public.payments AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS personal_accounts_all ON public.personal_accounts;
CREATE POLICY personal_accounts_all ON public.personal_accounts AS PERMISSIVE FOR ALL TO public USING (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id()))) WITH CHECK (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS personal_holdings_all ON public.personal_holdings;
CREATE POLICY personal_holdings_all ON public.personal_holdings AS PERMISSIVE FOR ALL TO public USING (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id()))) WITH CHECK (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS personal_transactions_all ON public.personal_transactions;
CREATE POLICY personal_transactions_all ON public.personal_transactions AS PERMISSIVE FOR ALL TO public USING (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id()))) WITH CHECK (((owner_user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS personal_vault_pin_all ON public.personal_vault_pin;
CREATE POLICY personal_vault_pin_all ON public.personal_vault_pin AS PERMISSIVE FOR ALL TO public USING (((user_id = auth.uid()) AND (tenant_id = current_tenant_id()))) WITH CHECK (((user_id = auth.uid()) AND (tenant_id = current_tenant_id())));
DROP POLICY IF EXISTS po_alloc_delete ON public.po_bill_allocations;
CREATE POLICY po_alloc_delete ON public.po_bill_allocations AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS po_alloc_insert ON public.po_bill_allocations;
CREATE POLICY po_alloc_insert ON public.po_bill_allocations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS po_alloc_select ON public.po_bill_allocations;
CREATE POLICY po_alloc_select ON public.po_bill_allocations AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS po_alloc_service_role ON public.po_bill_allocations;
CREATE POLICY po_alloc_service_role ON public.po_bill_allocations AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS po_alloc_update ON public.po_bill_allocations;
CREATE POLICY po_alloc_update ON public.po_bill_allocations AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS prepaid_advances_all ON public.prepaid_advances;
CREATE POLICY prepaid_advances_all ON public.prepaid_advances AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS project_labour_rw ON public.project_labour;
CREATE POLICY project_labour_rw ON public.project_labour AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS project_milestones_tenant ON public.project_milestones;
CREATE POLICY project_milestones_tenant ON public.project_milestones AS PERMISSIVE FOR ALL TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS project_payments_tenant ON public.project_payments;
CREATE POLICY project_payments_tenant ON public.project_payments AS PERMISSIVE FOR ALL TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS project_sales_tenant ON public.project_sales;
CREATE POLICY project_sales_tenant ON public.project_sales AS PERMISSIVE FOR ALL TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS project_tasks_tenant_all ON public.project_tasks;
CREATE POLICY project_tasks_tenant_all ON public.project_tasks AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS provisioning_requests_select ON public.provisioning_requests;
CREATE POLICY provisioning_requests_select ON public.provisioning_requests AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS provisioning_requests_service ON public.provisioning_requests;
CREATE POLICY provisioning_requests_service ON public.provisioning_requests AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS provisioning_requests_update ON public.provisioning_requests;
CREATE POLICY provisioning_requests_update ON public.provisioning_requests AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS provisioning_tasks_select ON public.provisioning_tasks;
CREATE POLICY provisioning_tasks_select ON public.provisioning_tasks AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS provisioning_tasks_write ON public.provisioning_tasks;
CREATE POLICY provisioning_tasks_write ON public.provisioning_tasks AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS purchase_orders_delete ON public.purchase_orders;
CREATE POLICY purchase_orders_delete ON public.purchase_orders AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS purchase_orders_insert ON public.purchase_orders;
CREATE POLICY purchase_orders_insert ON public.purchase_orders AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS purchase_orders_select ON public.purchase_orders;
CREATE POLICY purchase_orders_select ON public.purchase_orders AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS purchase_orders_service_role ON public.purchase_orders;
CREATE POLICY purchase_orders_service_role ON public.purchase_orders AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS purchase_orders_update ON public.purchase_orders;
CREATE POLICY purchase_orders_update ON public.purchase_orders AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS push_subscriptions_delete_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions AS PERMISSIVE FOR DELETE TO public USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS push_subscriptions_insert_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_insert_own ON public.push_subscriptions AS PERMISSIVE FOR INSERT TO public WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS push_subscriptions_select_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions AS PERMISSIVE FOR SELECT TO public USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS push_subscriptions_update_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_update_own ON public.push_subscriptions AS PERMISSIVE FOR UPDATE TO public USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid()))) WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS quote_send_log_insert ON public.quote_send_log;
CREATE POLICY quote_send_log_insert ON public.quote_send_log AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quote_send_log_select ON public.quote_send_log;
CREATE POLICY quote_send_log_select ON public.quote_send_log AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quote_send_log_service ON public.quote_send_log;
CREATE POLICY quote_send_log_service ON public.quote_send_log AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS quote_signatures_select ON public.quote_signatures;
CREATE POLICY quote_signatures_select ON public.quote_signatures AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS quote_views_select ON public.quote_views;
CREATE POLICY quote_views_select ON public.quote_views AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quote_views_service ON public.quote_views;
CREATE POLICY quote_views_service ON public.quote_views AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS quotes_delete ON public.quotes;
CREATE POLICY quotes_delete ON public.quotes AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quotes_hierarchy_delete ON public.quotes;
CREATE POLICY quotes_hierarchy_delete ON public.quotes AS RESTRICTIVE FOR DELETE TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS quotes_hierarchy_select ON public.quotes;
CREATE POLICY quotes_hierarchy_select ON public.quotes AS RESTRICTIVE FOR SELECT TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS quotes_hierarchy_write ON public.quotes;
CREATE POLICY quotes_hierarchy_write ON public.quotes AS RESTRICTIVE FOR UPDATE TO public USING (can_see_record(owner_id));
DROP POLICY IF EXISTS quotes_insert ON public.quotes;
CREATE POLICY quotes_insert ON public.quotes AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quotes_select ON public.quotes;
CREATE POLICY quotes_select ON public.quotes AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS quotes_select_own_customer ON public.quotes;
CREATE POLICY quotes_select_own_customer ON public.quotes AS PERMISSIVE FOR SELECT TO public USING ((customer_id = current_customer_id()));
DROP POLICY IF EXISTS quotes_update ON public.quotes;
CREATE POLICY quotes_update ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_agreements_delete_own_tenant ON public.referral_agreements;
CREATE POLICY referral_agreements_delete_own_tenant ON public.referral_agreements AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_agreements_insert_own_tenant ON public.referral_agreements;
CREATE POLICY referral_agreements_insert_own_tenant ON public.referral_agreements AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_agreements_select_own_tenant ON public.referral_agreements;
CREATE POLICY referral_agreements_select_own_tenant ON public.referral_agreements AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_agreements_service_role_all ON public.referral_agreements;
CREATE POLICY referral_agreements_service_role_all ON public.referral_agreements AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS referral_agreements_update_own_tenant ON public.referral_agreements;
CREATE POLICY referral_agreements_update_own_tenant ON public.referral_agreements AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_commissions_delete_own_tenant ON public.referral_commissions;
CREATE POLICY referral_commissions_delete_own_tenant ON public.referral_commissions AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_commissions_insert_own_tenant ON public.referral_commissions;
CREATE POLICY referral_commissions_insert_own_tenant ON public.referral_commissions AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_commissions_select_own_tenant ON public.referral_commissions;
CREATE POLICY referral_commissions_select_own_tenant ON public.referral_commissions AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_commissions_service_role_all ON public.referral_commissions;
CREATE POLICY referral_commissions_service_role_all ON public.referral_commissions AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS referral_commissions_update_own_tenant ON public.referral_commissions;
CREATE POLICY referral_commissions_update_own_tenant ON public.referral_commissions AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_partners_delete_own_tenant ON public.referral_partners;
CREATE POLICY referral_partners_delete_own_tenant ON public.referral_partners AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_partners_insert_own_tenant ON public.referral_partners;
CREATE POLICY referral_partners_insert_own_tenant ON public.referral_partners AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_partners_select_own_tenant ON public.referral_partners;
CREATE POLICY referral_partners_select_own_tenant ON public.referral_partners AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS referral_partners_service_role_all ON public.referral_partners;
CREATE POLICY referral_partners_service_role_all ON public.referral_partners AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS referral_partners_update_own_tenant ON public.referral_partners;
CREATE POLICY referral_partners_update_own_tenant ON public.referral_partners AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "reimbursements tenant all" ON public.reimbursements;
CREATE POLICY "reimbursements tenant all" ON public.reimbursements AS PERMISSIVE FOR ALL TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS renewal_email_log_select ON public.renewal_email_log;
CREATE POLICY renewal_email_log_select ON public.renewal_email_log AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS renewal_email_log_service ON public.renewal_email_log;
CREATE POLICY renewal_email_log_service ON public.renewal_email_log AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "tenant isolation delete" ON public.salary_payments;
CREATE POLICY "tenant isolation delete" ON public.salary_payments AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.salary_payments;
CREATE POLICY "tenant isolation read" ON public.salary_payments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.salary_payments;
CREATE POLICY "tenant isolation update" ON public.salary_payments AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.salary_payments;
CREATE POLICY "tenant isolation write" ON public.salary_payments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS seat_requests_tenant ON public.seat_requests;
CREATE POLICY seat_requests_tenant ON public.seat_requests AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS site_promos_tenant_read ON public.site_promos;
CREATE POLICY site_promos_tenant_read ON public.site_promos AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS site_promos_tenant_write ON public.site_promos;
CREATE POLICY site_promos_tenant_write ON public.site_promos AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS "tenant isolation delete" ON public.statutory_dues_payments;
CREATE POLICY "tenant isolation delete" ON public.statutory_dues_payments AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation read" ON public.statutory_dues_payments;
CREATE POLICY "tenant isolation read" ON public.statutory_dues_payments AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation update" ON public.statutory_dues_payments;
CREATE POLICY "tenant isolation update" ON public.statutory_dues_payments AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "tenant isolation write" ON public.statutory_dues_payments;
CREATE POLICY "tenant isolation write" ON public.statutory_dues_payments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS subscription_billings_select ON public.subscription_billings;
CREATE POLICY subscription_billings_select ON public.subscription_billings AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS subs_delete ON public.subscriptions;
CREATE POLICY subs_delete ON public.subscriptions AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS subs_insert ON public.subscriptions;
CREATE POLICY subs_insert ON public.subscriptions AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS subs_select ON public.subscriptions;
CREATE POLICY subs_select ON public.subscriptions AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS subs_update ON public.subscriptions;
CREATE POLICY subs_update ON public.subscriptions AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS subscriptions_select_own_customer ON public.subscriptions;
CREATE POLICY subscriptions_select_own_customer ON public.subscriptions AS PERMISSIVE FOR SELECT TO public USING ((customer_id = current_customer_id()));
DROP POLICY IF EXISTS support_call_requests_select ON public.support_call_requests;
CREATE POLICY support_call_requests_select ON public.support_call_requests AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS support_call_requests_update ON public.support_call_requests;
CREATE POLICY support_call_requests_update ON public.support_call_requests AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS support_plans_select_own_tenant ON public.support_plans;
CREATE POLICY support_plans_select_own_tenant ON public.support_plans AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS support_plans_write_own_tenant ON public.support_plans;
CREATE POLICY support_plans_write_own_tenant ON public.support_plans AS PERMISSIVE FOR ALL TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS support_sync_outbox_service_role ON public.support_sync_outbox;
CREATE POLICY support_sync_outbox_service_role ON public.support_sync_outbox AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
DROP POLICY IF EXISTS support_tickets_delete_own_tenant ON public.support_tickets;
CREATE POLICY support_tickets_delete_own_tenant ON public.support_tickets AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS support_tickets_insert_own_customer ON public.support_tickets;
CREATE POLICY support_tickets_insert_own_customer ON public.support_tickets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((customer_id = current_customer_id()));
DROP POLICY IF EXISTS support_tickets_insert_own_tenant ON public.support_tickets;
CREATE POLICY support_tickets_insert_own_tenant ON public.support_tickets AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS support_tickets_select_own_customer ON public.support_tickets;
CREATE POLICY support_tickets_select_own_customer ON public.support_tickets AS PERMISSIVE FOR SELECT TO public USING ((customer_id = current_customer_id()));
DROP POLICY IF EXISTS support_tickets_select_own_tenant ON public.support_tickets;
CREATE POLICY support_tickets_select_own_tenant ON public.support_tickets AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS support_tickets_update_own_tenant ON public.support_tickets;
CREATE POLICY support_tickets_update_own_tenant ON public.support_tickets AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_collaborators_delete ON public.task_collaborators;
CREATE POLICY task_collaborators_delete ON public.task_collaborators AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_collaborators_insert ON public.task_collaborators;
CREATE POLICY task_collaborators_insert ON public.task_collaborators AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_collaborators_select ON public.task_collaborators;
CREATE POLICY task_collaborators_select ON public.task_collaborators AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_comments_delete_own ON public.task_comments;
CREATE POLICY task_comments_delete_own ON public.task_comments AS PERMISSIVE FOR DELETE TO authenticated USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS task_comments_insert ON public.task_comments;
CREATE POLICY task_comments_insert ON public.task_comments AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_comments_select ON public.task_comments;
CREATE POLICY task_comments_select ON public.task_comments AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS task_comments_update_own ON public.task_comments;
CREATE POLICY task_comments_update_own ON public.task_comments AS PERMISSIVE FOR UPDATE TO authenticated USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid()))) WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));
DROP POLICY IF EXISTS task_kudos_delete_own ON public.task_kudos;
CREATE POLICY task_kudos_delete_own ON public.task_kudos AS PERMISSIVE FOR DELETE TO authenticated USING (((tenant_id = current_tenant_id()) AND (awarded_by = auth.uid())));
DROP POLICY IF EXISTS task_kudos_insert_as_self ON public.task_kudos;
CREATE POLICY task_kudos_insert_as_self ON public.task_kudos AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((tenant_id = current_tenant_id()) AND (awarded_by = auth.uid())));
DROP POLICY IF EXISTS task_kudos_select ON public.task_kudos;
CREATE POLICY task_kudos_select ON public.task_kudos AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tasks_delete ON public.tasks;
CREATE POLICY tasks_delete ON public.tasks AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tasks_insert ON public.tasks;
CREATE POLICY tasks_insert ON public.tasks AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tasks_update ON public.tasks;
CREATE POLICY tasks_update ON public.tasks AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tds_receivable_delete_own_tenant ON public.tds_receivable;
CREATE POLICY tds_receivable_delete_own_tenant ON public.tds_receivable AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tds_receivable_insert_own_tenant ON public.tds_receivable;
CREATE POLICY tds_receivable_insert_own_tenant ON public.tds_receivable AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tds_receivable_select_own_tenant ON public.tds_receivable;
CREATE POLICY tds_receivable_select_own_tenant ON public.tds_receivable AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tds_receivable_update_own_tenant ON public.tds_receivable;
CREATE POLICY tds_receivable_update_own_tenant ON public.tds_receivable AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS team_invites_owner_manage ON public.team_invites;
CREATE POLICY team_invites_owner_manage ON public.team_invites AS PERMISSIVE FOR ALL TO authenticated USING (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'owner'::user_role)))))) WITH CHECK (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'owner'::user_role))))));
DROP POLICY IF EXISTS tenant_domains_select ON public.tenant_domains;
CREATE POLICY tenant_domains_select ON public.tenant_domains AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS tenant_domains_write ON public.tenant_domains;
CREATE POLICY tenant_domains_write ON public.tenant_domains AS PERMISSIVE FOR ALL TO authenticated USING (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'owner'::user_role)))))) WITH CHECK (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.role = 'owner'::user_role))))));
DROP POLICY IF EXISTS tenant_secrets_owner_insert ON public.tenant_secrets;
CREATE POLICY tenant_secrets_owner_insert ON public.tenant_secrets AS PERMISSIVE FOR INSERT TO public WITH CHECK (((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))) AND (( SELECT users.role
   FROM users
  WHERE (users.id = auth.uid())) = 'owner'::user_role)));
DROP POLICY IF EXISTS tenant_secrets_owner_read ON public.tenant_secrets;
CREATE POLICY tenant_secrets_owner_read ON public.tenant_secrets AS PERMISSIVE FOR SELECT TO public USING (((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))) AND (( SELECT users.role
   FROM users
  WHERE (users.id = auth.uid())) = 'owner'::user_role)));
DROP POLICY IF EXISTS tenant_secrets_owner_write ON public.tenant_secrets;
CREATE POLICY tenant_secrets_owner_write ON public.tenant_secrets AS PERMISSIVE FOR UPDATE TO public USING (((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))) AND (( SELECT users.role
   FROM users
  WHERE (users.id = auth.uid())) = 'owner'::user_role))) WITH CHECK (((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))) AND (( SELECT users.role
   FROM users
  WHERE (users.id = auth.uid())) = 'owner'::user_role)));
DROP POLICY IF EXISTS tenants_select_own_customer ON public.tenants;
CREATE POLICY tenants_select_own_customer ON public.tenants AS PERMISSIVE FOR SELECT TO public USING ((id = ( SELECT customer_users.tenant_id
   FROM customer_users
  WHERE (customer_users.auth_user_id = auth.uid())
 LIMIT 1)));
DROP POLICY IF EXISTS tenants_self_read ON public.tenants;
CREATE POLICY tenants_self_read ON public.tenants AS PERMISSIVE FOR SELECT TO authenticated USING ((id = current_tenant_id()));
DROP POLICY IF EXISTS tenants_self_update ON public.tenants;
CREATE POLICY tenants_self_update ON public.tenants AS PERMISSIVE FOR UPDATE TO authenticated USING (((id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = 'owner'::user_role))))));
DROP POLICY IF EXISTS tenants_signup_insert ON public.tenants;
CREATE POLICY tenants_signup_insert ON public.tenants AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS txn_category_rules_tenant_delete ON public.txn_category_rules;
CREATE POLICY txn_category_rules_tenant_delete ON public.txn_category_rules AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS txn_category_rules_tenant_read ON public.txn_category_rules;
CREATE POLICY txn_category_rules_tenant_read ON public.txn_category_rules AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS txn_category_rules_tenant_update ON public.txn_category_rules;
CREATE POLICY txn_category_rules_tenant_update ON public.txn_category_rules AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS txn_category_rules_tenant_write ON public.txn_category_rules;
CREATE POLICY txn_category_rules_tenant_write ON public.txn_category_rules AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS users_self_read ON public.users;
CREATE POLICY users_self_read ON public.users AS PERMISSIVE FOR SELECT TO authenticated USING ((id = auth.uid()));
DROP POLICY IF EXISTS users_self_update ON public.users;
CREATE POLICY users_self_update ON public.users AS PERMISSIVE FOR UPDATE TO authenticated USING ((id = auth.uid()));
DROP POLICY IF EXISTS users_signup_insert ON public.users;
CREATE POLICY users_signup_insert ON public.users AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((id = auth.uid()));
DROP POLICY IF EXISTS users_tenant_delete ON public.users;
CREATE POLICY users_tenant_delete ON public.users AS PERMISSIVE FOR DELETE TO authenticated USING (((tenant_id = current_tenant_id()) AND current_user_is_owner() AND (id <> auth.uid())));
DROP POLICY IF EXISTS users_tenant_read ON public.users;
CREATE POLICY users_tenant_read ON public.users AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS users_tenant_update ON public.users;
CREATE POLICY users_tenant_update ON public.users AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_access_log_insert ON public.vault_access_log;
CREATE POLICY vault_access_log_insert ON public.vault_access_log AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_access_log_select ON public.vault_access_log;
CREATE POLICY vault_access_log_select ON public.vault_access_log AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_passwords_delete ON public.vault_passwords;
CREATE POLICY vault_passwords_delete ON public.vault_passwords AS PERMISSIVE FOR DELETE TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_passwords_insert ON public.vault_passwords;
CREATE POLICY vault_passwords_insert ON public.vault_passwords AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_passwords_select ON public.vault_passwords;
CREATE POLICY vault_passwords_select ON public.vault_passwords AS PERMISSIVE FOR SELECT TO authenticated USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vault_passwords_update ON public.vault_passwords;
CREATE POLICY vault_passwords_update ON public.vault_passwords AS PERMISSIVE FOR UPDATE TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vendor_bills_delete_own_tenant ON public.vendor_bills;
CREATE POLICY vendor_bills_delete_own_tenant ON public.vendor_bills AS PERMISSIVE FOR DELETE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vendor_bills_insert_own_tenant ON public.vendor_bills;
CREATE POLICY vendor_bills_insert_own_tenant ON public.vendor_bills AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vendor_bills_select_own_tenant ON public.vendor_bills;
CREATE POLICY vendor_bills_select_own_tenant ON public.vendor_bills AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS vendor_bills_update_own_tenant ON public.vendor_bills;
CREATE POLICY vendor_bills_update_own_tenant ON public.vendor_bills AS PERMISSIVE FOR UPDATE TO public USING ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS "vendors tenant all" ON public.vendors;
CREATE POLICY "vendors tenant all" ON public.vendors AS PERMISSIVE FOR ALL TO authenticated USING ((tenant_id = current_tenant_id())) WITH CHECK ((tenant_id = current_tenant_id()));
DROP POLICY IF EXISTS whatsapp_messages_tenant_read ON public.whatsapp_messages;
CREATE POLICY whatsapp_messages_tenant_read ON public.whatsapp_messages AS PERMISSIVE FOR SELECT TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
DROP POLICY IF EXISTS whatsapp_messages_tenant_write ON public.whatsapp_messages;
CREATE POLICY whatsapp_messages_tenant_write ON public.whatsapp_messages AS PERMISSIVE FOR ALL TO public USING ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid())))) WITH CHECK ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
RESET ROLE;
