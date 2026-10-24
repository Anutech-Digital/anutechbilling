-- 0129: re-scheme Company Document Vault categories to the business scheme
-- ============================================================================
-- Old categories were compliance-shaped (company_legal / gst_tax / banking /
-- agreements / licenses / hr / other). Move to the broader business scheme that
-- matches how the owner already organises Google Drive, and add a dedicated
-- Branding / Logo bucket. Existing docs are remapped; the company logo lands in
-- Branding / Logo.

alter table public.documents drop constraint if exists documents_category_check;

-- Remap old keys → new business scheme.
update public.documents set category = case category
    when 'company_legal' then 'legal'
    when 'agreements'    then 'legal'
    when 'licenses'      then 'legal'
    when 'gst_tax'       then 'finance'
    when 'banking'       then 'finance'
    when 'hr'            then 'hr'
    else 'other'
  end
 where category in ('company_legal','agreements','licenses','gst_tax','banking','hr');

-- Company logo(s) → Branding / Logo.
update public.documents set category = 'branding'
 where lower(title) like '%logo%';

alter table public.documents
  add constraint documents_category_check
  check (category = any (array[
    'legal','finance','hr','operations','sales_marketing','admin','branding','other'
  ]));
