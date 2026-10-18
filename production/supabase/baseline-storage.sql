-- Storage buckets + policies from production.
-- `supabase db dump --schema public` omits these; without them file upload/download
-- silently fails on a rebuilt DB while every public-schema check looks perfect.
--
-- INSERT policies carry ONLY a WITH CHECK expression -- emitting USING there is a
-- syntax error, which is how the first version of this generator failed.

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('attendance-selfies','attendance-selfies','f',null,'{image/jpeg,image/png,image/webp}'::text[]) on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('documents','documents','f',20971520,'{application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,application/zip}'::text[]) on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('employee-docs','employee-docs','f',null,'{application/pdf,image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif}'::text[]) on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('expense-receipts','expense-receipts','f',null,'{application/pdf,image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif}'::text[]) on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('logos','logos','t',5242880,'{image/png,image/jpeg,image/webp}'::text[]) on conflict (id) do nothing;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('tds-certificates','tds-certificates','f',10485760,'{application/pdf,image/jpeg,image/png}'::text[]) on conflict (id) do nothing;

create policy "att selfies insert" on storage.objects as permissive for insert to authenticated with check (((bucket_id = 'attendance-selfies'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy "att selfies read" on storage.objects as permissive for select to authenticated using (((bucket_id = 'attendance-selfies'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy "att selfies update" on storage.objects as permissive for update to authenticated using (((bucket_id = 'attendance-selfies'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text))) with check (((bucket_id = 'attendance-selfies'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy documents_delete_own_tenant on storage.objects as permissive for delete to public using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy documents_insert_own_tenant on storage.objects as permissive for insert to public with check (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy documents_select_own_tenant on storage.objects as permissive for select to public using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy documents_update_own_tenant on storage.objects as permissive for update to public using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy "employee-docs tenant delete" on storage.objects as permissive for delete to authenticated using (((bucket_id = 'employee-docs'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy "employee-docs tenant insert" on storage.objects as permissive for insert to authenticated with check (((bucket_id = 'employee-docs'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy "employee-docs tenant read" on storage.objects as permissive for select to authenticated using (((bucket_id = 'employee-docs'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy logos_delete_own_tenant on storage.objects as permissive for delete to public using (((bucket_id = 'logos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy logos_insert_own_tenant on storage.objects as permissive for insert to public with check (((bucket_id = 'logos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy logos_update_own_tenant on storage.objects as permissive for update to public using (((bucket_id = 'logos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy tds_cert_delete_own_tenant on storage.objects as permissive for delete to public using (((bucket_id = 'tds-certificates'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy tds_cert_insert_own_tenant on storage.objects as permissive for insert to public with check (((bucket_id = 'tds-certificates'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy tds_cert_select_own_tenant on storage.objects as permissive for select to public using (((bucket_id = 'tds-certificates'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
create policy tds_cert_update_own_tenant on storage.objects as permissive for update to public using (((bucket_id = 'tds-certificates'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
