/**
 * R-1740 (22 Oct 2026, Pardeep) — "my relationship with this person".
 *
 * Two fields on `contacts` (migration 20261022*_r1740_contact_relationship):
 *   relationship_type — WHO they are to me. Never null: 'unknown' is the one meaning of
 *                       "not chosen yet" (a fresh cold lead, an old contact never set).
 *                       professional: client | partner | vendor | colleague
 *                       personal:     friend | relative | acquaintance
 *                       unknown
 *   closeness         — HOW close: close | known | weak. Optional; null = not set.
 *
 * It replaces `contacts.relationship` (Partner / Vendor / Employee / Personal / Not decided),
 * which mixed a business role with a personal tie. The old column stays in the database but
 * nothing reads or writes it any more; the migration mapped its values once
 * (mapLegacyRelationship below is the same rule, kept for the tests).
 *
 * The BUSINESS side (lead / customer / vendor-partner) is never chosen here — it comes from
 * the person's links (a lead, a customer, a vendor row). See businessOf in book.ts.
 */

export const RELATIONSHIP_TYPES = [
  "client", "partner", "vendor", "colleague",
  "friend", "relative", "acquaintance",
  "unknown",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const CLOSENESS = ["close", "known", "weak"] as const;
export type Closeness = (typeof CLOSENESS)[number];

export type RelationshipGroup = "professional" | "personal" | "unknown";

const GROUP: Record<RelationshipType, RelationshipGroup> = {
  client: "professional", partner: "professional", vendor: "professional", colleague: "professional",
  friend: "personal", relative: "personal", acquaintance: "personal",
  unknown: "unknown",
};

export const TYPE_LABEL: Record<RelationshipType, string> = {
  client: "Client", partner: "Partner", vendor: "Vendor", colleague: "Colleague",
  friend: "Friend", relative: "Relative", acquaintance: "Acquaintance",
  unknown: "Unknown",
};
export const CLOSENESS_LABEL: Record<Closeness, string> = { close: "Close", known: "Known", weak: "Weak" };
export const GROUP_LABEL: Record<RelationshipGroup, string> = {
  professional: "Professional", personal: "Personal", unknown: "Unknown",
};

/** The grouped options for the form's dropdown (one <optgroup> each). */
export const RELATIONSHIP_OPTION_GROUPS: ReadonlyArray<{ group: RelationshipGroup; types: RelationshipType[] }> = [
  { group: "personal",     types: ["friend", "relative", "acquaintance"] },
  { group: "professional", types: ["client", "partner", "vendor", "colleague"] },
  { group: "unknown",      types: ["unknown"] },
];

/** Anything outside the list (null, '', a typo) reads as 'unknown' — one meaning for empty. */
export function asRelationshipType(v: string | null | undefined): RelationshipType {
  const s = (v ?? "").trim().toLowerCase();
  return (RELATIONSHIP_TYPES as readonly string[]).includes(s) ? (s as RelationshipType) : "unknown";
}
export function asCloseness(v: string | null | undefined): Closeness | null {
  const s = (v ?? "").trim().toLowerCase();
  return (CLOSENESS as readonly string[]).includes(s) ? (s as Closeness) : null;
}

export function relationshipGroup(type: string | null | undefined): RelationshipGroup {
  return GROUP[asRelationshipType(type)];
}

/**
 * The chip text. "Friend · Close"; with no closeness the group says what kind of tie it is
 * ("Partner · Professional"); an unknown person is just "Unknown".
 */
export function relationshipLabel(type: string | null | undefined, closeness?: string | null): string {
  const t = asRelationshipType(type);
  if (t === "unknown") return "Unknown";
  const c = asCloseness(closeness);
  return `${TYPE_LABEL[t]} · ${c ? CLOSENESS_LABEL[c] : GROUP_LABEL[GROUP[t]]}`;
}

/** Colour by group: personal = pink (rose), professional = blue (indigo), unknown = grey. */
export type RelationshipTone = "pink" | "blue" | "grey";
export function relationshipTone(type: string | null | undefined): RelationshipTone {
  const g = relationshipGroup(type);
  return g === "personal" ? "pink" : g === "professional" ? "blue" : "grey";
}

/**
 * Map ring, 1 = innermost (next to "You"). Close → 1, Known → 2, Weak or not set → 3,
 * Unknown relationship → 4 (the outer ring), whatever closeness says.
 */
export function relationshipRing(type: string | null | undefined, closeness?: string | null): 1 | 2 | 3 | 4 {
  if (asRelationshipType(type) === "unknown") return 4;
  const c = asCloseness(closeness);
  return c === "close" ? 1 : c === "known" ? 2 : 3;
}
export const RING_LABEL: Record<1 | 2 | 3 | 4, string> = {
  1: "Close", 2: "Known", 3: "Weak or not set", 4: "Unknown",
};

/** The old `contacts.relationship` values → the new type. Same CASE as the migration. */
export function mapLegacyRelationship(old: string | null | undefined): RelationshipType {
  switch ((old ?? "").trim().toLowerCase()) {
    case "partner":  return "partner";
    case "vendor":   return "vendor";
    case "employee": return "colleague";
    case "personal": return "friend";
    default:         return "unknown";
  }
}

/** Rank for "which of a company's people do I know best": known tie first, then closeness. */
export function relationshipStrength(type: string | null | undefined, closeness?: string | null): number {
  return 5 - relationshipRing(type, closeness);
}

// ── Contacts page facets ────────────────────────────────────────────────────

/** Business side — derived from links, never chosen by hand. */
export type BizFacet = "lead" | "customer" | "vendor_partner" | "none";
export const BIZ_FACETS: BizFacet[] = ["lead", "customer", "vendor_partner", "none"];
export const BIZ_LABEL: Record<BizFacet, string> = {
  lead: "Lead", customer: "Customer", vendor_partner: "Vendor / Partner", none: "None",
};

/** Relationship side — the four professional types collapse into one "Professional". */
export type RelFacet = "friend" | "relative" | "acquaintance" | "professional" | "unknown";
export const REL_FACETS: RelFacet[] = ["friend", "relative", "acquaintance", "professional", "unknown"];
export const REL_LABEL: Record<RelFacet, string> = {
  friend: "Friend", relative: "Relative", acquaintance: "Acquaintance", professional: "Professional", unknown: "Unknown",
};

export function relFacetOf(type: string | null | undefined): RelFacet {
  const t = asRelationshipType(type);
  if (t === "friend" || t === "relative" || t === "acquaintance" || t === "unknown") return t;
  return "professional";
}

export function asBizFacet(v: string | null | undefined): BizFacet | "all" {
  return (BIZ_FACETS as string[]).includes(v ?? "") ? (v as BizFacet) : "all";
}
export function asRelFacet(v: string | null | undefined): RelFacet | "all" {
  return (REL_FACETS as string[]).includes(v ?? "") ? (v as RelFacet) : "all";
}

/** The fields a book row needs for faceting. */
export interface FacetRow {
  isCompany?: boolean;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  business?: BizFacet;
  relationshipType?: string | null;
}

/**
 * A company with nobody on it yet — not a person, so it is not counted among people.
 * Same test the list uses to print "No contact person yet".
 */
export function isCompanyWithoutPerson(c: FacetRow): boolean {
  const blank = (s?: string | null) => (s ?? "").trim() === "";
  return !!c.isCompany && blank(c.title) && blank(c.email) && blank(c.phone);
}

const bizOf = (c: FacetRow): BizFacet => c.business ?? "none";

export interface FacetCounts {
  /** Business row counts, under the chosen relationship. */
  biz: Record<BizFacet | "all", number>;
  /** Relationship row counts, under the chosen business. */
  rel: Record<RelFacet | "all", number>;
  /** Relationship × Business, over every person (no facet applied). */
  grid: Record<RelFacet, Record<BizFacet, number>>;
  /** Companies with no contact person — shown apart, never counted as people. */
  companiesWithoutPerson: number;
}

/** Faceted counts over PEOPLE only. Each row's counts follow the other row's choice. */
export function facetCounts(rows: FacetRow[], sel: { biz: BizFacet | "all"; rel: RelFacet | "all" }): FacetCounts {
  const zeroBiz = () => ({ all: 0, lead: 0, customer: 0, vendor_partner: 0, none: 0 });
  const biz: FacetCounts["biz"] = zeroBiz();
  const rel: FacetCounts["rel"] = { all: 0, friend: 0, relative: 0, acquaintance: 0, professional: 0, unknown: 0 };
  const grid = Object.fromEntries(REL_FACETS.map((r) => [r, { lead: 0, customer: 0, vendor_partner: 0, none: 0 }])) as FacetCounts["grid"];
  let companiesWithoutPerson = 0;
  for (const c of rows) {
    if (isCompanyWithoutPerson(c)) { companiesWithoutPerson++; continue; }
    const b = bizOf(c);
    const r = relFacetOf(c.relationshipType);
    grid[r][b]++;
    if (sel.rel === "all" || sel.rel === r) { biz.all++; biz[b]++; }
    if (sel.biz === "all" || sel.biz === b) { rel.all++; rel[r]++; }
  }
  return { biz, rel, grid, companiesWithoutPerson };
}

/** The people matching both facets (companies without a person are never in it). */
export function applyFacets<T extends FacetRow>(rows: T[], sel: { biz: BizFacet | "all"; rel: RelFacet | "all" }): T[] {
  return rows.filter((c) =>
    !isCompanyWithoutPerson(c)
    && (sel.biz === "all" || bizOf(c) === sel.biz)
    && (sel.rel === "all" || relFacetOf(c.relationshipType) === sel.rel));
}

/** The /contacts link for one grid cell — shareable. */
export function facetHref(biz: BizFacet | "all", rel: RelFacet | "all"): string {
  const p = new URLSearchParams();
  if (biz !== "all") p.set("biz", biz);
  if (rel !== "all") p.set("rel", rel);
  const q = p.toString();
  return q ? `/contacts?${q}` : "/contacts";
}

/**
 * Of a company's people, the one whose relationship the company chip shows: the best-known
 * tie, the primary person winning a tie. Null when the company has nobody.
 */
export function pickCompanyRelationship<P extends { relationship_type?: string | null; closeness?: string | null; is_primary?: boolean | null }>(
  people: P[],
): P | null {
  let best: P | null = null;
  for (const p of people) {
    if (!best) { best = p; continue; }
    const a = relationshipStrength(p.relationship_type, p.closeness);
    const b = relationshipStrength(best.relationship_type, best.closeness);
    if (a > b || (a === b && p.is_primary && !best.is_primary)) best = p;
  }
  return best;
}
