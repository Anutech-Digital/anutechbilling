/**
 * Tracking links — a URL for one ad / post / listing that tells the app where the lead
 * came from, with nobody typing a source.
 *
 * How it lands: the public form routes run `captureFromRequest` (lib/marketing/utm.ts) on
 * the page the form was submitted from, so `?utm_source=…` on that page is stored on the
 * lead. ROAS & CAC then reads the channel through `channelFor`, which returns an unmapped
 * utm_source as-is — so this builder puts the CHANNEL KEY itself in utm_source
 * ("meta-ads", not "facebook"). "facebook" would map to meta-ads even for an unpaid post,
 * and the page's free leads would be credited to the ads.
 *
 * The link must point straight at a page with a lead form. A visitor who lands on the home
 * page and clicks through to the form arrives without the query string, and the source is
 * lost — which is why DESTINATIONS lists form pages only.
 */

export interface Destination { path: string; label: string }

/* Only pages whose form creates a lead through captureFromRequest. /project-quote/[id] and
   /quote/… were listed first and removed the same day: they are views of a quote already
   sent, they create no lead, and a link to them would lose the source entirely. */
export const DESTINATIONS: readonly Destination[] = [
  { path: "/enquiry",        label: "Enquiry form (all products, incl. custom software)" },
  { path: "/buy/workspace",  label: "Google Workspace buy page" },
];

/** utm_medium the channel implies: an ad is cpc, a listing is referral, a post is social. */
export function defaultMedium(channel: string): string {
  if (/-ads$/.test(channel)) return "cpc";
  if (/-organic$/.test(channel)) return channel.startsWith("google") ? "organic" : "social";
  if (channel === "indiamart" || channel === "justdial") return "listing";
  if (channel === "email-outreach") return "email";
  if (channel === "whatsapp") return "whatsapp";
  return "referral";
}

/** "Diwali Offer 2026!" → "diwali-offer-2026". Lower-case, hyphens, 60 chars. */
export function slugCampaign(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface TrackingInput {
  origin: string;          // https://example.com — no trailing slash needed
  path: string;            // one of DESTINATIONS
  channel: string;         // ad-channel / lead-source key
  campaign: string;        // free text; slugged
  medium?: string;         // defaults from the channel
  content?: string;        // optional: which ad / creative
}

export function buildTrackingUrl(i: TrackingInput): string {
  const u = new URL(i.path, i.origin.replace(/\/+$/, "") + "/");
  u.searchParams.set("utm_source", i.channel);
  u.searchParams.set("utm_medium", (i.medium?.trim() || defaultMedium(i.channel)));
  u.searchParams.set("utm_campaign", slugCampaign(i.campaign) || "general");
  const content = slugCampaign(i.content ?? "");
  if (content) u.searchParams.set("utm_content", content);
  return u.toString();
}
