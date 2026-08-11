-- 0198 — Personal-profile fields on contacts.
--
-- For the owner's PERSONAL people (relationship='personal') — and useful for
-- anyone — capture the details you keep about a real relationship: when to wish
-- them, what to call them, and who's in their family. All nullable + additive;
-- no existing consumer changes. Birthday/anniversary are DATE so a future
-- reminder cron can find "whose birthday is this week".

alter table public.contacts
  add column if not exists birthday    date,
  add column if not exists anniversary date,
  add column if not exists nickname    text,
  add column if not exists family      text;

comment on column public.contacts.birthday    is 'Date of birth (year optional — store 1900 if unknown-year needed). Powers birthday reminders.';
comment on column public.contacts.anniversary is 'Anniversary / other yearly date to remember.';
comment on column public.contacts.nickname    is 'What the owner calls this person.';
comment on column public.contacts.family      is 'Free text: spouse, children, relations — personal context.';
