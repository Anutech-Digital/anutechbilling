-- deploy-peek: exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'coupons' and policyname = 'coupons_insert_om' and with_check like '%marketing%') and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_reminder_templates' and policyname = 'owner manager update' and qual like '%marketing%') and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'social_content_settings' and policyname = 'social_content_settings_manage' and qual like '%marketing%')
-- deploy-key: r2897marketingrolemarketingtables
-- 20261117053806_r2897_marketing_role_marketing_tables
--
-- R-2897 (17 Nov 2026, Abhishek): "give these all tab right to marketing person, he can perform
-- everything on these tabs" — the Marketing Hub tabs (Paid ads, Budget, ROAS & CAC, Listings,
-- WhatsApp & calling, Cold Calling, Email, Website & tracking, Social). The app now lets the
-- marketing role run them; these tables still allowed only owner / manager (or + billing) to write:
--   • coupons (Email → Coupons)                          owner, manager        → + marketing
--   • referral_partners (Offers & new leads → Referrals) owner, manager, billing → + marketing
--   • whatsapp_reminder_settings / _templates (WhatsApp reminders) owner, manager → + marketing
--   • social_content_settings (Social growth: Stop all AI, strategies — R-2709)  → + marketing
--     (the API still keeps "resume the AI" and the AI settings owner-only).
-- Only the role list changes; tenant checks stay as they were. Reads were already open.
begin;

-- coupons
drop policy if exists coupons_insert_om on public.coupons;
create policy coupons_insert_om on public.coupons for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'marketing'));
drop policy if exists coupons_update_om on public.coupons;
create policy coupons_update_om on public.coupons for update to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'marketing'))
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'marketing'));
drop policy if exists coupons_delete_om on public.coupons;
create policy coupons_delete_om on public.coupons for delete to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'marketing'));

-- referral_partners
drop policy if exists referral_partners_insert_roles on public.referral_partners;
create policy referral_partners_insert_roles on public.referral_partners for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'billing', 'marketing'));
drop policy if exists referral_partners_update_roles on public.referral_partners;
create policy referral_partners_update_roles on public.referral_partners for update to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'billing', 'marketing'))
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'billing', 'marketing'));
drop policy if exists referral_partners_delete_roles on public.referral_partners;
create policy referral_partners_delete_roles on public.referral_partners for delete to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'manager', 'billing', 'marketing'));

-- whatsapp_reminder_settings / whatsapp_reminder_templates
do $$
declare t text;
begin
  foreach t in array array['whatsapp_reminder_settings', 'whatsapp_reminder_templates'] loop
    execute format('drop policy if exists "owner manager insert" on public.%I', t);
    execute format(
      'create policy "owner manager insert" on public.%I for insert to authenticated
         with check (tenant_id = public.current_tenant_id() and public.current_user_has_role(''owner'', ''manager'', ''marketing''))', t);
    execute format('drop policy if exists "owner manager update" on public.%I', t);
    execute format(
      'create policy "owner manager update" on public.%I for update to authenticated
         using (tenant_id = public.current_tenant_id() and public.current_user_has_role(''owner'', ''manager'', ''marketing''))
         with check (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists "owner manager delete" on public.%I', t);
    execute format(
      'create policy "owner manager delete" on public.%I for delete to authenticated
         using (tenant_id = public.current_tenant_id() and public.current_user_has_role(''owner'', ''manager'', ''marketing''))', t);
  end loop;
end $$;

-- social_content_settings
drop policy if exists social_content_settings_manage on public.social_content_settings;
create policy social_content_settings_manage on public.social_content_settings for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner', 'manager', 'marketing')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner', 'manager', 'marketing')));

commit;
