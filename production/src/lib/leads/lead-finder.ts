/**
 * AI Lead Finder — the pure part: prompts, parsers, signal interpretation, scoring rules.
 * The network (Gemini, DNS, websites) is in lead-finder.server.ts; everything a test can
 * pin down without a network lives here.
 */

import { ASK_FOR_OWNER, WHO_TO_ASK } from "./lead-contacts";

export interface FinderProfile {
  name: string;
  cities: string;
  industries: string;
  company_size: string;
  products: string[];        // workspace | website | hosting | software | whatsapp
  must_have: string;
  exclude: string;
  daily_limit: number;
}

export const PRODUCT_LABEL: Record<string, string> = {
  workspace: "Google Workspace (business email)",
  website: "Website design / redesign",
  hosting: "Hosting & domain",
  software: "Custom software / app",
  whatsapp: "WhatsApp Business API",
};

export interface DiscoveredCompany { company: string; domain: string; website?: string | null; city?: string | null; industry?: string | null; description?: string | null; source_url?: string | null }

/** "Gurgaon, Noida / Delhi" → ["Gurgaon", "Noida", "Delhi"] — the profile's free-text lists. */
export function splitList(s: string | null | undefined): string[] {
  return [...new Set((s ?? "").split(/[,;/\n]|\band\b/i).map((x) => x.trim()).filter((x) => x.length > 1))];
}

/** Normalise "https://www.Example.co.in/about" → "example.co.in"; null when not a domain. */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  // Free-mail and marketplace domains are never a company's own.
  if (/^(gmail|yahoo|hotmail|outlook|rediffmail|justdial|indiamart|facebook|linkedin|instagram|google)\.(com|co\.in|in)$/.test(s)) return null;
  return s;
}

// ── Discovery ──────────────────────────────────────────────────────────────

export function discoveryPrompt(p: FinderProfile, excludeDomains: readonly string[], want: number): { system: string; user: string } {
  const products = p.products.map((k) => PRODUCT_LABEL[k] ?? k).join("; ");
  const system =
    "You are a B2B prospect researcher for an Indian IT services reseller (Google Workspace, websites, hosting, custom software). " +
    "Using web search, find REAL, currently operating companies that match the profile. Only companies with their own website domain. " +
    "Never invent a company or a domain; if unsure, leave it out. Do not use Google Maps / Business Profile listings as a source — use company websites, directories, news, job posts. " +
    "Answer ONLY with a JSON array (no prose) of objects: {company, domain, website, city, industry, description, source_url}. " +
    "domain = bare domain (example.co.in); city and industry = one of the values from the lists given, copied exactly.";
  const cities = splitList(p.cities), industries = splitList(p.industries);
  // Asked for "clinics, labs, schools in Gurgaon, Noida", the model returned ten Gurgaon dental
  // clinics (29 Sep). Name every city and industry and ask for a spread.
  const spread = cities.length > 1 || industries.length > 1
    ? `Spread the results: cover EVERY city and EVERY industry listed, roughly equally — about ${Math.max(1, Math.ceil(want / Math.max(1, industries.length)))} per industry and ${Math.max(1, Math.ceil(want / Math.max(1, cities.length)))} per city. Do not return mostly one kind of business or one city.`
    : "";
  const user = [
    `Find up to ${want} companies.`,
    cities.length > 1 ? `Cities (all of them): ${cities.join(" | ")}.` : `Location: ${p.cities || "India"}.`,
    industries.length > 1 ? `Industries (all of them): ${industries.join(" | ")}.` : `Industry: ${p.industries || "any SME"}.`,
    spread,
    `Size: ${p.company_size}.`,
    `We want to sell: ${products}.`,
    p.must_have ? `Must have: ${p.must_have}.` : "",
    p.exclude ? `Exclude: ${p.exclude}.` : "",
    "Prefer small and mid-size businesses that likely run their own email and website and are growing (hiring, new office, new product).",
    "Strongly prefer companies whose own website shows a phone number or email for enquiries (a contact page) — we can only use a company we can call or write to.",
    excludeDomains.length ? `Skip these domains (already known): ${excludeDomains.slice(0, 200).join(", ")}.` : "",
  ].filter(Boolean).join("\n");
  return { system, user };
}

/** Pull the JSON array out of a grounded answer that may carry prose or a ```json fence. */
export function parseDiscovery(text: string | null | undefined): DiscoveredCompany[] {
  if (!text) return [];
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("["), end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: DiscoveredCompany[] = [];
  const seen = new Set<string>();
  for (const x of arr as Record<string, unknown>[]) {
    const domain = normaliseDomain(String(x.domain ?? x.website ?? ""));
    const company = String(x.company ?? "").trim();
    if (!domain || !company || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      company: company.slice(0, 120), domain,
      website: x.website ? String(x.website).slice(0, 300) : `https://${domain}`,
      city: x.city ? String(x.city).slice(0, 80) : null,
      industry: x.industry ? String(x.industry).slice(0, 80) : null,
      description: x.description ? String(x.description).slice(0, 400) : null,
      source_url: x.source_url ? String(x.source_url).slice(0, 500) : null,
    });
  }
  return out;
}

// ── Signals ────────────────────────────────────────────────────────────────

export type MxProvider = "google" | "microsoft" | "zoho" | "rediff" | "godaddy" | "cpanel" | "other" | "none" | "unknown";

/** MX host names → provider. "none" = domain exists, no MX (no email on this domain). */
export function mxProvider(hosts: readonly string[] | null): MxProvider {
  if (hosts === null) return "unknown";
  if (hosts.length === 0) return "none";
  const h = hosts.map((x) => x.toLowerCase()).join(" ");
  if (/google\.com|googlemail\.com/.test(h)) return "google";
  if (/outlook\.com|office365|protection\.outlook/.test(h)) return "microsoft";
  if (/zoho/.test(h)) return "zoho";
  if (/rediff/.test(h)) return "rediff";
  if (/secureserver\.net|godaddy/.test(h)) return "godaddy";
  if (/mail\.[a-z0-9-]+\.(com|in|co\.in|net)\.?$|hostgator|bluehost|bigrock|hostinger|mxroute|titan\.email/.test(h)) return "cpanel";
  return "other";
}

export const MX_LABEL: Record<MxProvider, string> = {
  google: "Google Workspace", microsoft: "Microsoft 365", zoho: "Zoho Mail", rediff: "Rediffmail Pro", godaddy: "GoDaddy email",
  cpanel: "Hosting (cPanel) email", other: "Other provider", none: "No email on domain", unknown: "Not checked",
};

export interface SiteAudit { https: boolean | null; status: number | null; note: string; server?: string | null; generator?: string | null }

/** Interpret a fetch of https://domain: what the site tells a salesperson. */
export function siteNote(a: { httpsOk: boolean; httpOk: boolean; status: number | null; server?: string | null; generator?: string | null; title?: string | null }): SiteAudit {
  if (!a.httpsOk && !a.httpOk) return { https: false, status: a.status, note: "Site down" };
  if (!a.httpsOk && a.httpOk) return { https: false, status: a.status, note: "No SSL", server: a.server, generator: a.generator };
  const gen = (a.generator ?? "").toLowerCase();
  let note = "Site OK";
  if (/wordpress [1-5]\./.test(gen)) note = "Old WordPress";
  else if (/wix|weebly|godaddy website builder|jimdo/.test(gen)) note = "Site builder (Wix / Weebly)";
  else if (/joomla|drupal 7/.test(gen)) note = "Old CMS (Joomla / Drupal 7)";
  else if (!a.title) note = "No title / SEO";
  return { https: true, status: a.status, note, server: a.server, generator: a.generator };
}

// ── Scoring ────────────────────────────────────────────────────────────────

export interface ScoreInput {
  company: string; domain: string; city: string | null; description: string | null;
  mx: MxProvider; site: SiteAudit; products: string[];
}
export interface ScoreOutput { score: number; product: string; fit_reason: string; pitch: string }

/**
 * Deterministic baseline so a Gemini outage still produces a usable, explainable row.
 * The AI pass (scoringPrompt) refines wording and can move the score ±20.
 */
export function baselineScore(i: ScoreInput): ScoreOutput {
  let score = 40;
  const reasons: string[] = [];
  let product = i.products[0] ?? "workspace";
  const wantsWorkspace = i.products.includes("workspace");
  const wantsWeb = i.products.includes("website") || i.products.includes("hosting");
  if (wantsWorkspace) {
    if (i.mx === "none") { score += 25; reasons.push("no email on the domain"); product = "workspace"; }
    else if (["zoho", "rediff", "godaddy", "cpanel", "other"].includes(i.mx)) { score += 20; reasons.push(`email is on ${MX_LABEL[i.mx]}, not on Workspace`); product = "workspace"; }
    else if (i.mx === "google") { score -= 15; reasons.push("already on Google Workspace"); }
    else if (i.mx === "microsoft") { score -= 5; reasons.push("on Microsoft 365 (hard to switch)"); }
  }
  if (wantsWeb) {
    if (i.site.https === false && i.site.status === null) { score += 20; reasons.push("website does not open"); if (product !== "workspace" || i.mx === "google") product = "website"; }
    else if (i.site.https === false) { score += 15; reasons.push("no SSL"); if (i.mx === "google") product = "hosting"; }
    else if (/^old |builder/i.test(i.site.note)) { score += 10; reasons.push(i.site.note); if (i.mx === "google") product = "website"; }
  }
  if (i.description && /hiring|expand|new office|launch|funded|growing/i.test(i.description)) { score += 5; reasons.push("growing"); }
  score = Math.max(0, Math.min(100, score));
  const fit_reason = reasons.length ? reasons.join("; ") : "Matches the profile; no strong signal";
  const pitch = product === "workspace"
    ? `Google Workspace on ${i.domain} for ${i.company} — professional email, 30GB+ storage, Meet/Drive, Gmail security. We handle the migration.`
    : product === "website"
      ? `${i.company}'s website: ${i.site.note.toLowerCase()} — a new fast, mobile-first site with SSL, live in 2 weeks.`
      : product === "hosting"
        ? `SSL + managed hosting for ${i.domain} — remove 'Not secure', improve speed.`
        : `${PRODUCT_LABEL[product] ?? product} for ${i.company}.`;
  return { score, product, fit_reason, pitch };
}

export function scoringPrompt(items: readonly ScoreInput[], baselines: readonly ScoreOutput[]): { system: string; user: string } {
  const system =
    "You are a sales analyst for an Indian IT reseller. For each company you get public signals and a baseline score. " +
    "Return ONLY a JSON array, same order, of {domain, score (0-100), product (one of the allowed keys), fit_reason (Hinglish, ≤160 chars, concrete), pitch (Hinglish, ≤220 chars, one line the salesperson can say on WhatsApp)}. " +
    "Keep the score within ±20 of the baseline unless a signal clearly contradicts it. Never promise prices or discounts. " +
    "The pitch is pasted after our own greeting, so it must NOT start with a greeting or address (no Namaste, Hello, Hi, Sir, Dear) — start with the point.";
  const user = JSON.stringify(items.map((i, k) => ({
    domain: i.domain, company: i.company, city: i.city, description: i.description,
    email_provider: MX_LABEL[i.mx], website: i.site.note, allowed_products: i.products, baseline: baselines[k],
  })));
  return { system, user };
}

/** Merge the AI pass over the baseline; anything malformed keeps the baseline. */
export function mergeScores(items: readonly ScoreInput[], baselines: readonly ScoreOutput[], ai: unknown): ScoreOutput[] {
  const byDomain = new Map<string, Record<string, unknown>>();
  if (Array.isArray(ai)) for (const x of ai as Record<string, unknown>[]) if (x && typeof x.domain === "string") byDomain.set(x.domain, x);
  return items.map((i, k) => {
    const b = baselines[k], a = byDomain.get(i.domain);
    if (!a) return b;
    const score = typeof a.score === "number" && Number.isFinite(a.score) ? Math.max(0, Math.min(100, Math.round(a.score))) : b.score;
    const bounded = Math.max(b.score - 20, Math.min(b.score + 20, score));
    const product = typeof a.product === "string" && i.products.includes(a.product) ? a.product : b.product;
    const fit_reason = typeof a.fit_reason === "string" && a.fit_reason.trim() ? a.fit_reason.trim().slice(0, 200) : b.fit_reason;
    const pitch = typeof a.pitch === "string" && cleanPitch(a.pitch) && !/₹|\brs\.?\s?\d|discount|% off/i.test(a.pitch) ? cleanPitch(a.pitch).slice(0, 260) : b.pitch;
    return { score: bounded, product, fit_reason, pitch };
  });
}

/**
 * The pitch is pasted after a greeting ("Namaste {{name}} ji, {{pitch}}"), so one that opens
 * with its own "Namaste!" or "Sir," greeted twice (29 Sep preview). Strip a leading greeting
 * or address, however many, and capitalise what is left.
 */
export function cleanPitch(p: string | null | undefined): string {
  let s = (p ?? "").trim();
  const lead = /^(namaste|namaskar|hello|hi|hey|dear|greetings|good (morning|afternoon|evening)|sir|ma'?am|sir\/ma'?am)\b[\s!,.:\-–—]*(ji\b[\s!,.:\-–—]*)?/i;
  for (let i = 0; i < 3 && lead.test(s); i++) s = s.replace(lead, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** Lead note written on approval — everything the salesperson needs on the card. */
export function leadNotes(c: { fit_reason: string | null; pitch: string | null; mx_provider: string | null; site_note: string | null; source_url: string | null; description: string | null }): string {
  return [
    "AI Lead Finder",
    c.description ? `About: ${c.description}` : "",
    c.fit_reason ? `Why: ${c.fit_reason}` : "",
    c.mx_provider ? `Email: ${MX_LABEL[c.mx_provider as MxProvider] ?? c.mx_provider}` : "",
    c.site_note ? `Website: ${c.site_note}` : "",
    c.pitch ? `Pitch: ${c.pitch}` : "",
    c.source_url ? `Source: ${c.source_url}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The first follow-up an approved candidate gets (29 Sep 2026): approving without a task
 * meant the lead sat in the pipeline until someone remembered it. Call if there is a phone,
 * else email. Due in business hours, IST, Mon–Sat 10:00–18:00:
 *   before 10:00 on a working day → 11:00 that day
 *   10:00–17:00                   → one hour from now
 *   after 17:00, or Sunday         → 11:00 the next working day
 */
export function firstTouchTask(
  c: { company: string; pitch: string | null; fit_reason: string | null; domain: string },
  contact: { email: string | null; phone: string | null; person?: { name: string; role: string | null; from: "page" | "email" | "search" } | null } | null,
  now: Date = new Date(),
): { kind: "call" | "email"; title: string; notes: string; dueAt: Date } {
  const kind = contact?.phone ? "call" : "email";
  const title = kind === "call" ? `Call: ${c.company}` : `Email: ${c.company}`;
  const who = contact?.person;
  const notes = [
    who ? `${WHO_TO_ASK}: ${who.name}${who.role ? ` (${who.role})` : ""}${who.from === "email" ? " — name guessed from the email" : who.from === "search" ? " — from public records, confirm on the call" : ""}` : kind === "call" ? ASK_FOR_OWNER : "",
    contact?.phone ? `Phone: ${contact.phone}` : "",
    contact?.email ? `Email: ${contact.email}` : "",
    `Website: https://${c.domain}`,
    c.fit_reason ? `Why: ${c.fit_reason}` : "",
    cleanPitch(c.pitch) ? `What to say: ${cleanPitch(c.pitch)}` : "",
  ].filter(Boolean).join("\n");
  return { kind, title, notes, dueAt: firstTouchDue(now) };
}

const IST_MS = 330 * 60_000;
export function firstTouchDue(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);                   // wall clock in IST, read via UTC getters
  const at = (dayOffset: number, h: number, m = 0) => {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + dayOffset, h, m));
    return new Date(d.getTime() - IST_MS);
  };
  const working = (off: number) => new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + off)).getUTCDay() !== 0;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (working(0) && mins < 10 * 60) return at(0, 11);
  if (working(0) && mins < 17 * 60) return new Date(now.getTime() + 60 * 60_000);
  let off = 1;
  while (!working(off)) off++;
  return at(off, 11);
}

/**
 * Order companies so that taking the first N gives a spread: round-robin over industry, and
 * within an industry over city. The model is asked for a spread; this makes sure a lopsided
 * answer still fills the day's limit with a mix. Unknown industry/city form their own group.
 */
export function spreadByIndustryCity<T extends { industry?: string | null; city?: string | null }>(items: T[]): T[] {
  const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase() || "?";
  const byInd = new Map<string, Map<string, T[]>>();
  for (const it of items) {
    const ind = byInd.get(key(it.industry)) ?? new Map<string, T[]>();
    const list = ind.get(key(it.city)) ?? [];
    list.push(it); ind.set(key(it.city), list); byInd.set(key(it.industry), ind);
  }
  // each industry's own queue, cities interleaved
  const queues = [...byInd.values()].map((cities) => {
    const lists = [...cities.values()];
    const out: T[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  });
  const out: T[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]);
  return out;
}
