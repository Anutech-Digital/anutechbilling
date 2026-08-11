-- 0196_contacts_relationship.sql
-- Standalone contacts (the `contacts` table) can be classified by relationship
-- so the owner can keep non-lead / non-customer people — partners, vendors,
-- personal/relations — in the same contact book and filter them out.
--
-- Values used by the app: 'partner' | 'vendor' | 'personal' | 'other'
-- (NULL = unclassified). Leads/customers get their "kind" from their own table,
-- so this column only matters for manually-added contacts.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS relationship text;

COMMENT ON COLUMN contacts.relationship IS
  'Relationship classification for standalone contacts: partner | vendor | personal | other. NULL = unclassified. Leads/customers derive their kind from their source table.';
