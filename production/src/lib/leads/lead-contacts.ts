/**
 * AI Lead Finder — "contact dhoondho" (28 Sep 2026).
 *
 * A found company is useless to a telecaller without a way to reach it. This reads the
 * company's OWN website (home, contact, about) and keeps only what the company publishes
 * there for business enquiries: mailto:/tel: links first, then addresses and Indian phone
 * numbers written in the page text.
 *
 * Deliberately NOT done: guessing addresses (rahul@domain.com), third-party directories,
 * LinkedIn or Maps scraping. A guessed address bounces and hurts our sending domain; a
 * scraped personal number is exactly the kind of data the page promises not to use.
 *
 * Pure functions only — the fetching lives in lead-finder.server.ts.
 */

export interface FoundContacts {
  emails: string[];
  phones: string[];
}

/* A type alias, not an interface, so it fits the jsonb `signals` column's Json type. */
export type ContactResult = {
  email: string | null;
  phone: string | null;
  emails: string[];
  phones: string[];
  /** page the best email/phone came from */
  source_url: string | null;
  checked_at: string;
  /** who to ask for — see "Contact person" below; absent on rows checked before 29 Sep */
  person?: ContactPerson | null;
  person_checked?: boolean;
  /** public-record search already tried (it costs a search call; do not repeat) */
  person_searched?: boolean;
};

/** Pages worth reading, in order. The home page is read first by the caller. */
export const CONTACT_PATHS = ["/contact", "/contact-us", "/about-us", "/contactus", "/about"] as const;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const ASSET_TAIL = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$/i;
/** Addresses that appear on sites but never reach the company. */
const JUNK_DOMAIN = /(^|\.)(example\.(com|org)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|domain\.com|email\.com|yourdomain\.com|godaddy\.com|w3\.org|schema\.org)$/i;
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|webmaster|wordpress|admin@wordpress)$/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

/** Visible page text, tags and scripts removed — what a person reading the page sees. */
export function pageText(html: string): string { return unObfuscate(stripTags(html)); }

/** "info [at] firm [dot] com" → "info@firm.com" — the common way sites hide an address. */
function unObfuscate(text: string): string {
  return text
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
}

export function cleanEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0].replace(/[.,;:)]+$/, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  if (ASSET_TAIL.test(e)) return null;                 // logo@2x.png
  const [local, host] = e.split("@");
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(host)) return null;
  return e;
}

/**
 * Indian numbers only — this is an Indian reseller and a foreign number on an Indian SME's
 * site is usually a vendor's. Mobiles → +91XXXXXXXXXX; landlines keep their STD code
 * (0XX-XXXXXXXX) so a caller can dial them as written.
 */
export function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  let d = digits.replace(/^\+/, "");
  if (d.startsWith("0091")) d = d.slice(4);
  else if (d.startsWith("91") && d.length === 12) d = d.slice(2);
  if (/^[6-9]\d{9}$/.test(d)) return "+91" + d;                               // mobile
  if (/^0[6-9]\d{9}$/.test(d)) return "+91" + d.slice(1);                      // 0 + mobile
  if (/^0[1-9]\d{8,9}$/.test(d)) return d;                                     // landline with STD
  if (/^[1-9]\d{9}$/.test(d) && digits.startsWith("+91")) return "0" + d;      // +91 11 2345 6789
  if (/^1800\d{6,7}$/.test(d)) return d;                                       // toll-free
  return null;
}

const PHONE_TEXT_RE = /(?:\+91[\s-]?|0091[\s-]?|\b0)?(?:\d[\s-]?){9,11}\d/g;

export function extractContacts(html: string, domain: string): FoundContacts {
  const emails: string[] = [], phones: string[] = [];
  const addE = (x: string) => { const e = cleanEmail(x); if (e && !emails.includes(e)) emails.push(e); };
  const addP = (x: string) => { const p = cleanPhone(x); if (p && !phones.includes(p)) phones.push(p); };

  // 1. Links the site itself marked as contact — the most reliable signal.
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) addE(decodeURIComponent(m[1]));
  for (const m of html.matchAll(/href=["']tel:([^"']+)/gi)) addP(decodeURIComponent(m[1]));

  // 2. Written in the page text.
  const text = unObfuscate(stripTags(html));
  for (const m of text.matchAll(EMAIL_RE)) addE(m[0]);
  for (const m of text.matchAll(PHONE_TEXT_RE)) addP(m[0]);

  // Company's own domain first: info@firm.com beats the web agency's hello@agency.com.
  const own = domain.toLowerCase().replace(/^www\./, "");
  emails.sort((a, b) => Number(!a.endsWith("@" + own) && !a.endsWith("." + own)) - Number(!b.endsWith("@" + own) && !b.endsWith("." + own)));
  return { emails: emails.slice(0, 5), phones: phones.slice(0, 5) };
}

/** Best single email: own domain, and a role address (info/contact/sales) over a person's. */
export function pickEmail(emails: string[], domain: string): string | null {
  if (!emails.length) return null;
  const own = domain.toLowerCase().replace(/^www\./, "");
  const score = (e: string) =>
    (e.endsWith("@" + own) || e.endsWith("." + own) ? 0 : 10) +
    (/^(info|contact|sales|enquiry|enquiries|inquiry|hello|office|mail|support)@/.test(e) ? 0 : 1);
  return [...emails].sort((a, b) => score(a) - score(b))[0];
}

/** Mobile first — it reaches a person and takes WhatsApp; toll-free last. */
export function pickPhone(phones: string[]): string | null {
  if (!phones.length) return null;
  const score = (p: string) => (p.startsWith("+91") ? 0 : p.startsWith("1800") ? 2 : 1);
  return [...phones].sort((a, b) => score(a) - score(b))[0];
}

/** The contact block stored in lead_finder_candidates.signals.contact. */
export function readContact(signals: unknown): ContactResult | null {
  const c = (signals as { contact?: ContactResult } | null)?.contact;
  return c && typeof c === "object" && "checked_at" in c ? c : null;
}

/** A lead nobody can call or write to is not a lead — it stays out of Review. */
export const reachable = (c: ContactResult | null): boolean => !!(c && (c.phone || c.email));

/** Score bonus: phone beats email, a mobile beats a landline. */
export function contactBonus(c: ContactResult | null): number {
  if (!c) return 0;
  if (c.phone?.startsWith("+91")) return 10;
  if (c.phone) return 6;
  return c.email ? 4 : 0;
}

/* ── Contact person (29 Sep 2026) ───────────────────────────────────────────
 * Who to ask for on the call. Taken ONLY from text on the company's own pages, near a
 * role word; an AI picks the name, and a name that is not literally in that text is thrown
 * away, so the model cannot invent a person. Failing that, a first.last@ address gives a
 * name, marked as a guess from the email. */

export type ContactPerson = { name: string; role: string | null; from: "page" | "email" | "search"; source_url: string | null; /** search only: false = source site blocked the check */ verified?: boolean };

export const ROLE_RE = /\b(founder|co-?founder|director|managing director|md|ceo|chief executive|partner|managing partner|proprietor|owner|principal|chairman|president|head|manager|ca\b|advocate|chartered accountant)\b/i;

/** Short windows of page text around role words — all the model gets to see. */
export function roleSnippets(text: string, max = 6): string[] {
  const out: string[] = [];
  const re = new RegExp(ROLE_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    const s = text.slice(Math.max(0, i - 120), i + 120).replace(/\s+/g, " ").trim();
    if (!out.some((o) => o.includes(s.slice(20, 80)))) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const GENERIC_LOCAL = /^(info|contact|sales|enquiry|enquiries|inquiry|hello|office|mail|support|admin|accounts|hr|careers|jobs|team|ip|legal|help|service|customercare|care|business|marketing)$/i;

/** rahul.choudhary@firm.in → "Rahul Choudhary". Role inboxes and single tokens give nothing. */
export function nameFromEmail(email: string | null): string | null {
  const local = email?.split("@")[0] ?? "";
  if (!local || GENERIC_LOCAL.test(local)) return null;
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]{2,}$/i.test(p));
  if (parts.length < 2 || parts.length > 3) return null;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/** The model's answer counts only if the name is written in the snippets we sent. */
export function personIsGrounded(name: string, snippets: string[]): boolean {
  const n = name.trim().replace(/\s+/g, " ").toLowerCase().replace(/^(mr|mrs|ms|dr|ca|adv)\.?\s+/, "");
  if (n.split(" ").length < 2 || n.length < 5) return false;          // "Rahul" alone is not enough to ask for
  return snippets.some((s) => s.toLowerCase().replace(/\s+/g, " ").includes(n));
}

export function personPrompt(items: { i: number; company: string; snippets: string[] }[]): { system: string; user: string } {
  return {
    system:
      "From text copied from each company's own website, name the most senior decision-maker a salesperson should ask for " +
      "(founder, director, managing partner, proprietor, CEO, partner). Copy the name EXACTLY as written in the text; never invent, " +
      "translate or complete a name. If no person's name is in the text, return null for that company. " +
      'Answer ONLY a JSON array: [{"i": number, "name": string|null, "role": string|null}].',
    user: items.map((x) => `#${x.i} ${x.company}\n${x.snippets.map((s) => `- ${s}`).join("\n")}`).join("\n\n"),
  };
}

/* ── Contact person from public records (29 Sep 2026) ─────────────────────────
 * For companies whose own site names nobody: one grounded search per company, limited to
 * public business records — the MCA register (directors / designated partners), ICAI and
 * bar directories, news and press. LinkedIn and personal profiles are refused: reading
 * LinkedIn by program breaks its terms. Only a name and a role are kept, never a personal
 * phone or email, and the card says "search se — call par confirm karo". */

export function personSearchPrompt(c: { company: string; domain: string; city: string | null }): { system: string; user: string } {
  return {
    system:
      "You find the owner or most senior decision-maker of an Indian business from PUBLIC BUSINESS RECORDS, using web search. " +
      "Allowed sources: the company's own website, the MCA company register and sites that republish it (directors / designated partners), " +
      "ICAI or Bar Council directories, news articles and press releases. Never use LinkedIn, Facebook, Instagram or any personal profile. " +
      "Return a name only if a source you found states it for THIS company (match the domain or the exact company name and city). " +
      "Never guess. Do not return phone numbers or emails. " +
      'Answer ONLY one JSON object: {"name": string|null, "role": string|null, "source_url": string|null}.',
    user: `Company: ${c.company}\nWebsite: https://${c.domain}\nCity: ${c.city ?? "India"}\nWho is the founder / director / managing partner / proprietor?`,
  };
}

const BANNED_SOURCE = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|truecaller\.com)$/i;

/** Keep a search answer only if it looks like a real person's name with a usable, allowed source. */
export function parsePersonSearch(text: string | null | undefined, company: string): { name: string; role: string | null; source_url: string } | null {
  if (!text) return null;
  const m = text.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: { name?: unknown; role?: unknown; source_url?: unknown };
  try { o = JSON.parse(m[0]); } catch { return null; }
  const name = typeof o.name === "string" ? o.name.trim().replace(/\s+/g, " ") : "";
  const src = typeof o.source_url === "string" ? o.source_url.trim() : "";
  if (!name || !/^https?:\/\//i.test(src)) return null;
  let host = "";
  try { host = new URL(src).hostname.replace(/^www\./, ""); } catch { return null; }
  if (BANNED_SOURCE.test(host)) return null;
  const bare = name.replace(/^(mr|mrs|ms|dr|ca|adv|shri|smt)\.?\s+/i, "");
  if (!/^[A-Za-z][A-Za-z.' -]{3,60}$/.test(bare) || bare.split(" ").length < 2) return null;   // a person, not "N/A" or a firm
  if (company.toLowerCase().includes(bare.toLowerCase())) return null;                         // the firm's own name echoed back
  return { name: name.slice(0, 80), role: typeof o.role === "string" && o.role.trim() ? o.role.trim().slice(0, 60) : null, source_url: src.slice(0, 500) };
}

/** Task-note line labels. Tasks written before 22 Oct 2026 carry the old Hinglish labels, so code that
 * finds these lines on a saved task matches both (lead-finder.server.ts fillLead;
 * the old labels live in legacy-task-labels.ts). */
export const WHO_TO_ASK = "Who to ask for";
export const NAME_UNKNOWN = "Name unknown";

/** Receptionist line for a call when we do not know whom to ask for. */
export const ASK_FOR_OWNER =
  `${NAME_UNKNOWN} — ask the receptionist: "Hello, I am calling from Anutech. I wanted 2 minutes with the owner or director about your office email and website — could you tell me their name?" Once you get the name, add it to the lead.`;

/* ── Team pages (29 Sep 2026) ─────────────────────────────────────────────────
 * Most names turned out to be on the firm's own team page, under a different path on every
 * site (/team, /meet-the-team/, /our-people, /partners, /leadership). So read the home
 * page's own links instead of guessing: same-site links whose URL or text says team,
 * people, partners, leadership, founder, management, directors, attorneys or "about". */

// "management" alone matched service pages (hospitality-booking-management); only as a team page.
const TEAM_WORD = /(team|people|partners?|leadership|founders?|management[- ]team|our[- ]management|board[- ]of[- ]directors|directors|attorneys|lawyers|advocates|professionals|our-firm|who-we-are|about)/i;
const STRONG_TEAM = /(team|people|partners|leadership|founders?|management[- ]team|our[- ]management|board[- ]of[- ]directors|directors|attorneys|lawyers|professionals)/i;

/** Same-site links that probably list the firm's people, strongest first (max 4). */
export function teamLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, "");
  const seen = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u: URL;
    try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
    if (/\.(pdf|jpe?g|png|docx?)$/i.test(u.pathname) || u.pathname === "/" ) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const hay = `${u.pathname} ${text}`;
    if (!TEAM_WORD.test(hay)) continue;
    const url = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    const rank = STRONG_TEAM.test(hay) ? 0 : 1;               // "about" is a weaker bet than "our team"
    if (!seen.has(url) || rank < seen.get(url)!) seen.set(url, rank);
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u).slice(0, 4);
}

/**
 * A search answer's source link, checked by opening it (29 Sep 2026): the model once gave a
 * Tracxn URL that was a 404, with a name nobody could confirm. Pure verdict from the fetch:
 *   "ok"      page opened and shows the surname
 *   "blocked" the site refuses automated readers (401/403/406/429/503) — cannot tell
 *   "bad"     the page does not exist, or opened without the name → drop the name
 */
export function sourceVerdict(status: number | null, body: string | null, name: string): "ok" | "blocked" | "bad" {
  if (status === null) return "blocked";                                   // timeout / TLS — not proof either way
  if ([401, 403, 406, 429, 503].includes(status)) return "blocked";
  if (status >= 400) return "bad";
  const surname = name.replace(/^(mr|mrs|ms|dr|ca|adv|shri|smt)\.?\s+/i, "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  return surname.length > 1 && (body ?? "").toLowerCase().includes(surname) ? "ok" : "bad";
}
