/**
 * R-1740 — the owner's own examples (card, 22 Oct 2026), first.
 */
import { describe, it, expect } from "vitest";
import {
  relationshipLabel, relationshipTone, relationshipRing, mapLegacyRelationship,
  facetCounts, applyFacets, facetHref, isCompanyWithoutPerson, pickCompanyRelationship,
  relFacetOf, asRelationshipType, type FacetRow,
} from "./relationship";

describe("R-1740 owner examples", () => {
  it("Rahul = Friend, Close → chip 'Friend · Close' (pink), inner ring on the Map", () => {
    expect(relationshipLabel("friend", "close")).toBe("Friend · Close");
    expect(relationshipTone("friend")).toBe("pink");
    expect(relationshipRing("friend", "close")).toBe(1);
  });

  it("a new cold lead with no relationship chosen → 'Unknown' (grey), outer ring", () => {
    // The lead's anchor contact gets the column default 'unknown'; null reads the same.
    for (const t of ["unknown", null, undefined, ""]) {
      expect(relationshipLabel(t, null)).toBe("Unknown");
      expect(relationshipTone(t)).toBe("grey");
      expect(relationshipRing(t, null)).toBe(4);
    }
    // Unknown stays outside even if a closeness was somehow saved.
    expect(relationshipRing("unknown", "close")).toBe(4);
  });

  it("an old contact with relationship=partner → 'Partner · Professional' (blue)", () => {
    const t = mapLegacyRelationship("partner");
    expect(t).toBe("partner");
    expect(relationshipLabel(t, null)).toBe("Partner · Professional");
    expect(relationshipTone(t)).toBe("blue");
  });

  it("maps every old value the way the card says", () => {
    expect(mapLegacyRelationship("vendor")).toBe("vendor");
    expect(mapLegacyRelationship("employee")).toBe("colleague");
    expect(mapLegacyRelationship("personal")).toBe("friend");
    expect(mapLegacyRelationship("other")).toBe("unknown");
    expect(mapLegacyRelationship(null)).toBe("unknown");
    expect(mapLegacyRelationship("")).toBe("unknown");
  });

  // Owner's data shape for examples 4 + 5: customers and leads, some friends, some unknown.
  const people: FacetRow[] = [
    ...Array.from({ length: 3 }, () => ({ business: "customer" as const, relationshipType: "friend", email: "a@x.in" })),
    ...Array.from({ length: 4 }, () => ({ business: "customer" as const, relationshipType: "unknown", email: "b@x.in" })),
    { business: "customer", relationshipType: "client", email: "c@x.in" },
    ...Array.from({ length: 2 }, () => ({ business: "lead" as const, relationshipType: "friend", phone: "9876543210" })),
    { business: "lead", relationshipType: "relative", phone: "9876500000" },
    { business: "none", relationshipType: "relative", email: "d@x.in" },
    // A company with nobody on it — not a person.
    { business: "customer", isCompany: true, title: null, email: null, phone: null, relationshipType: "unknown" },
  ];

  it("Business = Customer → the Relationship row reads Friend 3, Relative 0, Unknown 4 …", () => {
    const c = facetCounts(people, { biz: "customer", rel: "all" });
    expect(c.rel).toMatchObject({ all: 8, friend: 3, relative: 0, acquaintance: 0, professional: 1, unknown: 4 });
    // The Business row is NOT narrowed by its own choice.
    expect(c.biz).toMatchObject({ all: 12, customer: 8, lead: 3, none: 1, vendor_partner: 0 });
  });

  it("choosing a relationship changes the Business counts (faceted both ways)", () => {
    const c = facetCounts(people, { biz: "all", rel: "friend" });
    expect(c.biz).toMatchObject({ all: 5, customer: 3, lead: 2, none: 0 });
    expect(c.rel.all).toBe(12);
  });

  it("grid cell Friend × Lead (2) → just those 2 people; link ?biz=lead&rel=friend", () => {
    const c = facetCounts(people, { biz: "all", rel: "all" });
    expect(c.grid.friend.lead).toBe(2);
    expect(applyFacets(people, { biz: "lead", rel: "friend" })).toHaveLength(2);
    expect(facetHref("lead", "friend")).toBe("/contacts?biz=lead&rel=friend");
    expect(facetHref("all", "all")).toBe("/contacts");
  });

  it("counts people only — a company without a contact person is counted apart", () => {
    const c = facetCounts(people, { biz: "all", rel: "all" });
    expect(c.companiesWithoutPerson).toBe(1);
    expect(c.biz.all).toBe(12);
    expect(applyFacets(people, { biz: "customer", rel: "all" })).toHaveLength(8);
    expect(isCompanyWithoutPerson({ isCompany: true, title: "Rajesh" })).toBe(false);
    expect(isCompanyWithoutPerson({ isCompany: true, email: "x@y.in" })).toBe(false);
    expect(isCompanyWithoutPerson({ isCompany: false })).toBe(false);
  });

  it("the four professional types share one 'Professional' facet", () => {
    for (const t of ["client", "partner", "vendor", "colleague"]) expect(relFacetOf(t)).toBe("professional");
    expect(asRelationshipType("Nonsense")).toBe("unknown");
  });

  it("a company chip shows its best-known person; the primary wins a tie", () => {
    expect(pickCompanyRelationship([
      { id: "a", relationship_type: "unknown", closeness: null, is_primary: true },
      { id: "b", relationship_type: "relative", closeness: "close", is_primary: false },
    ])?.id).toBe("b");
    expect(pickCompanyRelationship([
      { id: "a", relationship_type: "unknown", closeness: null, is_primary: false },
      { id: "b", relationship_type: "unknown", closeness: null, is_primary: true },
    ])?.id).toBe("b");
    expect(pickCompanyRelationship([])).toBeNull();
  });
});
