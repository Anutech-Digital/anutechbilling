/**
 * Where a lead came from — the Source dropdown on Add / Edit lead.
 *
 * Pardeep, 26 Sep 2026: "zaroori platform bhi daalo jaise Facebook". The list had seven
 * entries, three of which describe how the lead was typed in rather than where it came
 * from, and no Facebook, LinkedIn, IndiaMART or JustDial at all.
 *
 * The VALUES are not free text: Marketing → ROAS & CAC puts a channel's spend
 * (`expenses.channel`, keys in lib/marketing/ad-channels.ts) against the leads whose
 * `source` has the same key. A Facebook lead saved as "facebook" while its ad bill says
 * "meta-ads" would be spend with no leads and leads with no spend. So every paid channel
 * an expense can be tagged with exists here under the same key (lead-sources.test.ts).
 *
 * Paid and unpaid are separate entries on purpose: a lead from a Facebook AD has a cost
 * per lead; one who found the Facebook PAGE does not, and one row for both would make
 * the ad look better than it is.
 */

export interface LeadSource { value: string; label: string }

export const LEAD_SOURCES: readonly LeadSource[] = [
  // Paid — these carry spend (same keys as AD_CHANNELS)
  { value: "google-ads",       label: "Google Ads" },
  { value: "meta-ads",         label: "Facebook / Instagram Ads" },
  { value: "linkedin-ads",     label: "LinkedIn Ads" },
  { value: "indiamart",        label: "IndiaMART" },
  { value: "justdial",         label: "JustDial" },
  // Found us without an ad
  { value: "google-organic",   label: "Google search / SEO" },
  { value: "meta-organic",     label: "Facebook / Instagram page (organic)" },
  { value: "linkedin-organic", label: "LinkedIn (organic)" },
  { value: "youtube-organic",  label: "YouTube" },
  { value: "enquiry-form",     label: "Website enquiry form" },
  { value: "buy-workspace-v2", label: "Buy Workspace page" },
  // Direct
  { value: "whatsapp",         label: "WhatsApp" },
  { value: "referral",         label: "Referral" },
  { value: "tele-calling",     label: "Tele calling" },
  { value: "email-outreach",   label: "Email outreach" },
  { value: "email-inbound",    label: "Email (inbound)" },
  { value: "trade-show",       label: "Trade show / event" },
  { value: "walk-in",          label: "Walk-in / office visit" },
  { value: "ai-finder",        label: "AI Lead Finder" },
  // How it was entered — not a channel (channel-economics reports these apart)
  { value: "manual",           label: "Added manually" },
  { value: "csv",              label: "CSV import" },
];

/**
 * The key a saved source stands for. Older rows (hand-typed, early imports) hold a LABEL or a
 * different case — "Added manually", "Manual" — instead of the key "manual". sourceOptions
 * then appended the unknown value as a second entry, so the dropdown listed "Added manually"
 * twice (Deals audit, 30 Sep 2026). A value that matches a key or a label, ignoring case and
 * spaces, is that key; anything else is returned as it was.
 */
export function canonicalSource(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return v;
  const k = v.toLowerCase();
  const hit = LEAD_SOURCES.find((s) => s.value.toLowerCase() === k || s.label.toLowerCase() === k);
  return hit ? hit.value : v;
}

/**
 * The options to show for a lead whose saved source may be one this list no longer
 * names (an old import, a form tag). Kept visible rather than shown blank, so opening
 * and saving a lead never silently rewrites where it came from — unless it is just another
 * spelling of a listed source (canonicalSource), which is never offered twice.
 */
export function sourceOptions(current: string | null | undefined): readonly LeadSource[] {
  const c = canonicalSource(current);
  if (!c || LEAD_SOURCES.some((s) => s.value === c)) return LEAD_SOURCES;
  return [...LEAD_SOURCES, { value: c, label: c }];
}

export function sourceLabel(value: string | null | undefined): string {
  return LEAD_SOURCES.find((s) => s.value === canonicalSource(value))?.label ?? (value || "—");
}

/**
 * R-392 (7 Oct 2026, Abhishek's report): typing "Google Ads" in the /leads search found
 * nothing — the search never looked at the source. The text a lead's source adds to its
 * search haystack: the saved value, that value with dashes as spaces ("google ads"), and
 * its label ("Facebook / Instagram Ads"). Lowercased. SQL twin: public.lead_search_hit()'s
 * source part in migration 20261007190000_lead_source_filter_search.sql.
 */
export function sourceSearchText(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const key = canonicalSource(raw);
  const label = LEAD_SOURCES.find((s) => s.value === key)?.label ?? "";
  return [raw, raw.replace(/-/g, " "), label].join(" ").toLowerCase();
}

/**
 * The Source filter's options (R-392): only sources the tenant's leads actually carry
 * (lead_counts().pool.by_source — keys already canonical on the server), with labels, in
 * LEAD_SOURCES order, then unknown sources A→Z. Zero-count keys are dropped.
 */
export function sourceFilterOptions(
  bySource: Readonly<Record<string, number>> | undefined,
): Array<{ value: string; label: string; count: number }> {
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(bySource ?? {})) {
    const key = canonicalSource(k);
    if (!key || n <= 0) continue;
    merged.set(key, (merged.get(key) ?? 0) + n);
  }
  const order = (v: string) => {
    const i = LEAD_SOURCES.findIndex((s) => s.value === v);
    return i === -1 ? LEAD_SOURCES.length : i;
  };
  return [...merged.entries()]
    .map(([value, count]) => ({ value, label: sourceLabel(value), count }))
    .sort((a, b) => order(a.value) - order(b.value) || a.label.localeCompare(b.label));
}
