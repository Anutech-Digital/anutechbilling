/**
 * S31 — where each new-workspace setup step is finished. One table, used by the Dashboard
 * setup card AND by the errors that used to dead-end ("Could not allocate a quote number"),
 * so both send the user to the same screen and the same spot on it.
 *
 * The `#…` part scrolls Settings to the card; the ids are set in app/(app)/settings/page.tsx.
 */
export const SETUP_HREF = {
  company: "/settings?tab=company",
  series:  "/settings?tab=company#invoice-numbering",
  payout:  "/settings?tab=company#payment-details",
  email:   "/settings?tab=integrations#email-sending",
  team:    "/team",
  /** The checklist itself lives on the Dashboard. */
  checklist: "/dashboard#setup-checklist",
} as const;

/**
 * The "go fix it" button for a failed document-number allocation. A failed
 * next_document_number() is almost always a workspace whose numbering was never set up;
 * the toast must open that screen in one click rather than say "under Settings".
 */
export const NUMBERING_FIX = {
  label: "Set up numbering",
  href: SETUP_HREF.series,
  description: "Nothing was saved and no number was used. Check your invoice numbering, then try again.",
} as const;
