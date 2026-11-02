/**
 * R-2021 (R-2019b, Pardeep 27 Oct 2026): what the phone buy flow tells us about the order, sent
 * with the checkout, quote and trial requests so the team knows the job before the first call:
 *   intent          — "transfer" (switch an existing Google Workspace to us) or "new";
 *   domainMode      — "have" (their own domain), "new" (we register one), "google" (already on
 *                     Google Workspace — billing moves only) or "later" (decide on the setup call);
 *   migrationSource — where their email lives today (none, Microsoft 365, Zoho, hosting, other).
 * All three are OPTIONAL — added, never required: the desktop page and any older page that sends
 * none of them works exactly as before. They only add a line to the lead's notes.
 * No zod here (the phone page reads the labels); the route fields are in buy-intent-schema.ts.
 */
export const BUY_INTENTS = ["transfer", "new"] as const;
export const DOMAIN_MODES = ["have", "new", "google", "later"] as const;
export const MIGRATION_SOURCES = ["none", "m365", "zoho", "host", "other"] as const;
export type BuyIntent = (typeof BUY_INTENTS)[number];
export type DomainMode = (typeof DOMAIN_MODES)[number];
export type MigrationSource = (typeof MIGRATION_SOURCES)[number];

export const MIGRATION_LABEL: Record<MigrationSource, string> = {
  none: "Nowhere / Gmail",
  m365: "Microsoft 365",
  zoho: "Zoho Mail",
  host: "GoDaddy / hosting",
  other: "Something else",
};

const DOMAIN_MODE_NOTE: Record<DomainMode, string> = {
  have: "has a domain of their own — connect it",
  new: "needs a new domain registered",
  google: "already on Google Workspace — move the billing only",
  later: "will decide the domain on the setup call",
};

/** One line for the lead notes, or null when the page sent none of the three. */
export function buyIntentNote(v: { intent?: BuyIntent; domainMode?: DomainMode; migrationSource?: MigrationSource }): string | null {
  const parts = [
    v.intent ? (v.intent === "transfer" ? "Switching an existing Google Workspace to us" : "New Google Workspace") : null,
    v.domainMode ? `Domain: ${DOMAIN_MODE_NOTE[v.domainMode]}` : null,
    v.migrationSource ? `Email today: ${MIGRATION_LABEL[v.migrationSource]}` : null,
  ].filter(Boolean);
  return parts.length ? `Phone buy flow — ${parts.join(" · ")}` : null;
}
