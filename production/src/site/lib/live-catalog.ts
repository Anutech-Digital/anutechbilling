/**
 * Live licence prices (Google Workspace, Microsoft 365, Zoho), read from ResellerOS — the
 * actual connection between the website's product cards and the app's catalogue.
 *
 * ─── WHY LIVE, AND WHY A FALLBACK ───────────────────────────────────────────
 * The handoff shipped placeholder rates (GW Starter at ₹136/mo). The app's REAL catalogue
 * says ₹270/mo annual and ₹325/mo flexible — measured on the live DB, 31 Aug 2026. A
 * website that quotes ₹136 while the app then emails a quotation at ₹270 is the
 * document-disagrees-with-itself defect all over again, this time in front of a prospect.
 *
 * So the website reads `GET /api/public/catalog/workspace` on the app (which strips
 * wholesale — that endpoint's test proves it) and OVERRIDES the matching placeholder
 * editions. Fetched server-side with a 10-minute revalidate: a price edit in
 * Operations → Catalog reaches the website inside ten minutes with no redeploy.
 *
 * R-076 (7 Oct 2026): Microsoft 365 and Zoho come through the same endpoint, each item
 * tagged with its `vendor`, and are merged exactly like Google Workspace. Before this only
 * GW was live and the M365/Zoho cards showed the typed figures in data/catalog.ts forever.
 *
 * When the app is unreachable the placeholders stand and the page still renders — a
 * pricing page that 500s because an API hiccuped is worse than one that is briefly stale.
 * The merge NEVER invents: a live item without a monthly tier keeps monthly null rather
 * than deriving one, because inventing a flexible-tier price is exactly the class of
 * mistake (term boundary, 12×) the app has already paid for.
 */
import { RESELLEROS_URL } from "./config";
import { EDITION_MATRICES, LICENCE_EDITIONS, MAIL_RATES, type LicenceEdition } from "./data/catalog";

export type SuiteVendor = "google" | "microsoft" | "zoho";

export interface LiveWorkspaceItem {
  name: string;
  annualPerSeatMo: number;
  monthlyPerSeatMo: number | null;
  /** Sent by the endpoint since R-076; absent on an older app → read from the name. */
  vendor?: SuiteVendor;
}

const VENDORS: readonly SuiteVendor[] = ["google", "microsoft", "zoho"];

export async function fetchLiveWorkspace(): Promise<LiveWorkspaceItem[] | null> {
  try {
    const res = await fetch(`${RESELLEROS_URL}/api/public/catalog/workspace`, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) return null;
    const items = body.items.filter(
      (i): i is LiveWorkspaceItem =>
        !!i && typeof i === "object" &&
        typeof (i as LiveWorkspaceItem).name === "string" &&
        typeof (i as LiveWorkspaceItem).annualPerSeatMo === "number",
    );
    return items.length ? items : null;
  } catch {
    return null;
  }
}

/**
 * Which suite a live item belongs to. The endpoint tags it; an untagged item is read from
 * its name, and anything else is Google — the endpoint returned only GW rows before R-076,
 * so an untagged item from an older app keeps its old meaning.
 */
export function vendorOf(item: LiveWorkspaceItem): SuiteVendor {
  const tagged = VENDORS.find((v) => v === item.vendor);
  if (tagged) return tagged;
  if (/^microsoft 365\b/i.test(item.name.trim())) return "microsoft";
  if (/^zoho\b/i.test(item.name.trim())) return "zoho";
  return "google";
}

/**
 * The website's name for a live product: the app says "Google Workspace Business Starter"
 * and "Microsoft 365 Business Basic", the website abbreviates to "GW …" / "M365 …".
 * Zoho keeps its own name ("Zoho Workplace Standard").
 */
function websiteName(item: LiveWorkspaceItem): string {
  const name = item.name.trim();
  switch (vendorOf(item)) {
    case "microsoft":
      return `M365 ${name.replace(/^Microsoft 365\s*/i, "").trim()}`.trim();
    case "zoho":
      return name;
    default:
      return `GW ${name.replace(/^Google Workspace\s*/i, "").trim()}`.trim();
  }
}

/**
 * Website edition names that differ from the catalogue's full name. "Zoho Workplace" in
 * LICENCE_EDITIONS is the Workplace Standard plan (₹90 — the same figure as the compare
 * matrix's WORKPLACE STANDARD column), so the catalogue's "Zoho Workplace Standard" price
 * lands on it instead of appearing as a second Zoho card beside a stale one.
 */
const EDITION_ALIASES: Readonly<Record<string, string>> = {
  "zoho workplace standard": "zoho workplace",
};

/**
 * Overlay live prices onto the placeholder editions list.
 *
 * Matching is by website name ("GW Business Starter", "M365 Business Basic", "Zoho
 * Workplace"). A live item with no placeholder counterpart is APPENDED (a new product in
 * the catalogue should show up here, not wait for a website deploy). Matched editions get
 * `live: true`, which the calculator uses to say the price is current rather than
 * indicative.
 */
export interface MergedEdition extends LicenceEdition {
  live?: boolean;
  /** Null when the live catalogue has no flexible tier for this product. */
  monthlyOrNull?: number | null;
}

export function mergeEditions(live: LiveWorkspaceItem[] | null): MergedEdition[] {
  const base: MergedEdition[] = LICENCE_EDITIONS.map((e) => ({ ...e, monthlyOrNull: e.monthly }));
  if (!live) return base;

  const out = [...base];
  for (const item of live) {
    const name = websiteName(item);
    const key = name.toLowerCase();
    const target = EDITION_ALIASES[key] ?? key;
    const idx = out.findIndex((e) => e.name.toLowerCase() === target);
    const merged: MergedEdition = {
      name: idx >= 0 ? out[idx].name : name,
      note: idx >= 0 ? out[idx].note : "From our live catalogue",
      annual: item.annualPerSeatMo,
      /* For the base `monthly: number` field a null live tier falls back to annual so the
         type holds, but `monthlyOrNull` carries the truth and the UI must read THAT. */
      monthly: item.monthlyPerSeatMo ?? item.annualPerSeatMo,
      monthlyOrNull: item.monthlyPerSeatMo,
      live: true,
    };
    if (idx >= 0) out[idx] = merged;
    else out.push(merged);
  }
  return out;
}

/** The live flexible ₹/seat/month for a suite's entry-level product, or null. */
export function liveMonthlyRate(live: LiveWorkspaceItem[] | null, vendor: SuiteVendor): number | null {
  const items = (live ?? []).filter((i) => vendorOf(i) === vendor);
  if (!items.length) return null;
  const entry = vendor === "google"
    ? items.find((i) => /starter/i.test(i.name)) ?? items[0]
    : [...items].sort((a, b) => a.annualPerSeatMo - b.annualPerSeatMo)[0];
  return entry.monthlyPerSeatMo;
}

/** The live flexible ₹/seat/month for the entry-level GW product — the quote page's rate. */
export function liveGwMonthlyRate(live: LiveWorkspaceItem[] | null): number | null {
  return liveMonthlyRate(live, "google");
}

/** Compare-editions matrix columns → the website edition each one prices. */
const MATRIX_EDITIONS: Readonly<Record<string, readonly [string, string, string]>> = {
  "Google Workspace": ["GW Business Starter", "GW Business Standard", "GW Business Plus"],
  "Microsoft 365": ["M365 Business Basic", "M365 Business Standard", "M365 Business Premium"],
  Zoho: ["Zoho Mail Lite", "Zoho Workplace", "Zoho One"],
};

/**
 * The compare page's "Price per seat, annual" row for every suite. A product the merged
 * editions carry shows that price (live where the catalogue has it); one they do not
 * carry keeps the matrix's own cell — never "—", never a derived number.
 */
export function suitePriceRows(
  editions: readonly LicenceEdition[],
): Record<string, readonly [string, string, string]> {
  const out: Record<string, readonly [string, string, string]> = {};
  for (const [suite, names] of Object.entries(MATRIX_EDITIONS)) {
    const typed = EDITION_MATRICES[suite]?.rows.find((r) => /price per seat/i.test(r[0]));
    const cell = (i: 0 | 1 | 2): string => {
      const e = editions.find((x) => x.name.toLowerCase() === names[i].toLowerCase());
      if (e) return `₹${Math.round(e.annual).toLocaleString("en-IN")}/mo`;
      return typed ? typed[i + 1] : "—";
    };
    out[suite] = [cell(0), cell(1), cell(2)] as const;
  }
  return out;
}

/**
 * "Business email from ₹…" — the cheapest of the Anutech Mail mailbox and every licence
 * edition's annual rate (live where the catalogue has it). One function so the header
 * teaser and the home page card cannot disagree.
 */
export function emailFromRate(editions: readonly LicenceEdition[]): number {
  return Math.min(MAIL_RATES["Anutech Mail"] ?? Infinity, ...editions.map((e) => e.annual));
}
