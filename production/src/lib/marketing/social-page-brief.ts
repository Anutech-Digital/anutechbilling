/**
 * The AI learns the business from the Facebook Page itself — its about, description, category,
 * services/products, website and recent posts. The owner's own words (the optional box) come
 * first when filled. Owner asked this on 17 Nov 2026 (Abhishek): "AI should make the strategy
 * from the page data — every page has its services and products."
 */

export interface PageProfile {
  name?: string; about?: string; description?: string; category?: string; website?: string;
  mission?: string; company_overview?: string; products?: string; general_info?: string;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** What the Page says about the business, as one short text for the AI ("" when the Page says nothing). */
export function profileBrief(profile: PageProfile | null, posts: string[] = []): string {
  const p = profile ?? {};
  const parts = [
    clean(p.name, 120) && `Page: ${clean(p.name, 120)}`,
    clean(p.category, 120) && `Category: ${clean(p.category, 120)}`,
    clean(p.about, 400) && `About: ${clean(p.about, 400)}`,
    clean(p.description, 600) && `Description: ${clean(p.description, 600)}`,
    clean(p.company_overview, 500) && `Overview: ${clean(p.company_overview, 500)}`,
    clean(p.products, 400) && `Services and products: ${clean(p.products, 400)}`,
    clean(p.mission, 300) && `Mission: ${clean(p.mission, 300)}`,
    clean(p.general_info, 300) && `More: ${clean(p.general_info, 300)}`,
    clean(p.website, 200) && `Website: ${clean(p.website, 200)}`,
  ].filter(Boolean) as string[];
  const recent = posts.map((m) => clean(m, 200)).filter(Boolean).slice(0, 8);
  if (recent.length) parts.push(`Recent posts on the Page:\n- ${recent.join("\n- ")}`);
  return parts.join("\n");
}

/** The owner's words first (when given), then what the Page says. Never empty: a safe default last. */
export function businessBrief(ownerBrief: string, fromPage: string): string {
  const own = ownerBrief.trim();
  const page = fromPage.trim();
  if (own && page) return `${own}\n\nFrom the Facebook Page:\n${page}`;
  return own || page || "a cloud services reseller (Google Workspace, Microsoft 365, Zoho) for small businesses";
}
