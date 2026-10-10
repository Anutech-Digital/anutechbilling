/**
 * The /contacts book — every source row mapped to one shape, then grouped so one real
 * person is one row. Pure: `useAllContacts` fetches, this assembles, tests call it directly.
 *
 * R-535 (10 Oct 2026, staging report): a company showed up as its own row with a blank
 * email and phone, sitting next to the real people. The company row read only the legacy
 * `customers.contact_*` columns — but since 10/18 Sep a company's people live in
 * `contacts` through `customer_contacts`, and a company made by 1-Click Onboard or an
 * order has no legacy columns at all. So the row became "company name, —, —".
 *
 * Now a company row is plainly a COMPANY row: its name is the company, the subtitle is its
 * primary contact, the Company column carries its domain, and email/phone come from that
 * primary contact (same rule as `primaryContactsFor`: the link wins, the legacy columns are
 * the floor). A company with nobody yet is still listed — it is a real company — and the
 * page says "No contact yet" instead of two dashes. A row with no name, email or phone at
 * all is never emitted.
 */
import type { ContactSource, UnifiedContact } from "@/lib/queries/contacts";

export interface BookLeadRow {
  id: string; company: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; stage: string | null; created_at: string;
  is_junk?: boolean | null; contact_id?: string | null;
}
export interface BookCustomerRow {
  id: string; name: string; domain?: string | null; contact_name: string | null;
  contact_title: string | null; contact_email: string | null; contact_phone: string | null;
  health: number | null; created_at: string;
}
export interface BookVendorRow {
  id: string; name: string; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; created_at: string;
}
export interface BookPartnerRow {
  id: string; name: string | null; email: string | null; phone: string | null;
  is_active: boolean | null; created_at: string;
}
export interface BookImportedRow {
  id: string; full_name: string | null; email: string | null; phone: string | null;
  company: string | null; title: string | null; source: string | null; status: string | null;
  relationship: string | null; created_at: string;
}
export interface BookEmployeeRow {
  id: string; name: string | null; email: string | null; phone: string | null;
  designation: string | null; is_active: boolean | null; created_at: string;
}
/** One customer_contacts link with its person embedded. */
export interface BookCustomerLinkRow {
  customer_id: string;
  is_primary: boolean | null;
  contacts: { full_name: string | null; email: string | null; phone: string | null } | null;
}

export interface BookSources {
  leads: BookLeadRow[];
  customers: BookCustomerRow[];
  vendors: BookVendorRow[];
  partners: BookPartnerRow[];
  imported: BookImportedRow[];
  employees: BookEmployeeRow[];
  customerLinks: BookCustomerLinkRow[];
}

const blank = (s?: string | null) => (s ?? "").trim() === "";

/** Name, email and phone all empty — nothing a person could be reached or known by. */
export function isBlankRow(c: Pick<UnifiedContact, "name" | "email" | "phone">): boolean {
  return blank(c.name) && blank(c.email) && blank(c.phone);
}

/** The company's contact person: primary link, else first linked person with an email,
 *  else the first link, else the legacy columns. Same order as primaryContactsFor. */
function companyPerson(
  c: BookCustomerRow, links: BookCustomerLinkRow[],
): { name: string | null; email: string | null; phone: string | null } {
  const people = links.filter((l) => l.contacts);
  const chosen =
    people.find((l) => l.is_primary)
    ?? people.find((l) => !blank(l.contacts!.email))
    ?? people[0];
  const p = chosen?.contacts;
  return {
    name:  (p?.full_name?.trim() || null) ?? (c.contact_name?.trim() || null),
    email: (p?.email?.trim() || null) ?? (c.contact_email?.trim() || null),
    phone: (p?.phone?.trim() || null) ?? (c.contact_phone?.trim() || null),
  };
}

export function buildContactBook(src: BookSources): UnifiedContact[] {
  const linksByCustomer = new Map<string, BookCustomerLinkRow[]>();
  for (const l of src.customerLinks) {
    (linksByCustomer.get(l.customer_id) ?? linksByCustomer.set(l.customer_id, []).get(l.customer_id)!).push(l);
  }

  const fromLeads: UnifiedContact[] = src.leads
    /* R-135 (3 Oct 2026): a lead saved with only a company name ("demo", Won) was hidden
       from the book — Customers and Vendors already fell back to the company name, Leads
       did not. Same rule now: the company stands in for a missing person's name. */
    .filter((l) => !l.is_junk && (l.contact_name || l.contact_email || l.contact_phone || l.company))
    .map((l) => ({
      id:        `lead:${l.id}`,
      source:    "lead" as const,
      refId:     l.id,
      name:      l.contact_name || l.company,
      email:     l.contact_email,
      phone:     l.contact_phone,
      company:   l.company,
      title:     null,
      status:    l.stage,
      createdAt: l.created_at,
      linkId:    l.contact_id ?? null,
    }));

  const fromCustomers: UnifiedContact[] = src.customers
    .filter((c) => !blank(c.name) || !blank(c.contact_name) || !blank(c.contact_email) || !blank(c.contact_phone))
    .map((c) => {
      const person = companyPerson(c, linksByCustomer.get(c.id) ?? []);
      const companyName = c.name?.trim() || person.name || "";
      return {
        id:        `customer:${c.id}`,
        source:    "customer" as const,
        refId:     c.id,
        isCompany: true,
        name:      companyName || null,
        email:     person.email,
        phone:     person.phone,
        // The Company column carries the domain — repeating the name there says nothing.
        company:   c.domain?.trim() || companyName,
        domain:    c.domain?.trim() || null,
        // Subtitle under the company name = who to talk to there.
        title:     person.name && person.name !== companyName ? person.name : null,
        status:    c.health != null ? String(c.health) : null,
        createdAt: c.created_at,
      };
    });

  const fromVendors: UnifiedContact[] = src.vendors
    .filter((v) => v.contact_name || v.contact_email || v.contact_phone || v.name)
    .map((v) => ({
      id:        `vendor:${v.id}`,
      source:    "vendor" as const,
      refId:     v.id,
      name:      v.contact_name || v.name,
      email:     v.contact_email,
      phone:     v.contact_phone,
      company:   v.name,
      title:     null,
      status:    null,
      createdAt: v.created_at,
    }));

  const fromPartners: UnifiedContact[] = src.partners
    .filter((p) => p.name || p.email || p.phone)
    .map((p) => ({
      id:        `partner:${p.id}`,
      source:    "partner" as const,
      refId:     p.id,
      name:      p.name,
      email:     p.email,
      phone:     p.phone,
      company:   "—",
      title:     null,
      status:    p.is_active ? "active" : "inactive",
      createdAt: p.created_at,
    }));

  const fromEmployees: UnifiedContact[] = src.employees
    .filter((e) => e.name || e.email || e.phone)
    .map((e) => ({
      id:        `employee:${e.id}`,
      source:    "employee" as const,
      refId:     e.id,
      name:      e.name,
      email:     e.email,
      phone:     e.phone,
      company:   "—",
      title:     e.designation ?? null,
      status:    e.is_active === false ? "inactive" : "active",
      createdAt: e.created_at,
    }));

  const fromImported: UnifiedContact[] = src.imported.map((c) => ({
    id:           `imported:${c.id}`,
    source:       "imported" as const,
    refId:        c.id,
    name:         c.full_name,
    email:        c.email,
    phone:        c.phone,
    company:      c.company ?? "—",
    title:        c.title,
    status:       c.status,
    importedFrom: c.source ?? undefined,
    relationship: c.relationship,
    createdAt:    c.created_at,
    linkId:       c.id,
  }));

  // ── Identity grouping ────────────────────────────────────────────────
  // One real person can appear across several sources AND under several
  // emails/phones (they enquire from a personal + an office address, call
  // from a second number, etc.). We union every source row that shares an
  // email OR a phone into a SINGLE identity, so the book never shows the
  // same human twice. Each identity keeps the STRONGEST current business
  // relation as its face: Customer (we sold) > Vendor (we buy) > Partner
  // (referral) > Lead (enquiry) > standalone contact.
  const all: UnifiedContact[] = [
    ...fromCustomers, ...fromVendors, ...fromPartners, ...fromEmployees, ...fromLeads, ...fromImported,
  ];

  const PRIORITY: Record<ContactSource, number> = {
    customer: 0, vendor: 1, partner: 2, employee: 3, lead: 4, imported: 5,
  };
  const normEmail = (e?: string | null): string | null => {
    const s = (e ?? "").toLowerCase().trim();
    return s.includes("@") ? s : null;
  };
  const normPhone = (p?: string | null): string | null => {
    // India: match on the last 10 significant digits so +91 / 0 / spaced
    // variants of the same number unify. Ignore anything shorter (too weak
    // an identity signal — would wrongly merge unrelated people).
    const d = (p ?? "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : null;
  };

  // Union-Find over row indices, keyed by shared email/phone.
  const parent = all.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const keyToRow = new Map<string, number>();
  all.forEach((c, i) => {
    for (const key of [
      normEmail(c.email) && `e:${normEmail(c.email)}`,
      normPhone(c.phone) && `p:${normPhone(c.phone)}`,
      c.linkId && `k:${c.linkId}`,
    ]) {
      if (!key) continue;
      const prev = keyToRow.get(key);
      if (prev === undefined) keyToRow.set(key, i);
      else union(prev, i);
    }
  });

  // Collapse each union group into one identity.
  const groups = new Map<number, number[]>();
  all.forEach((_, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  });

  const combined: UnifiedContact[] = [];
  for (const idxs of groups.values()) {
    // Face = strongest relation; tie-break = most recent.
    const rep = idxs
      .map((i) => all[i])
      .sort((a, b) =>
        PRIORITY[a.source] - PRIORITY[b.source] ||
        b.createdAt.localeCompare(a.createdAt),
      )[0];

    // Merge all reachable channels (primary first, deduped, order-stable).
    const emails: string[] = [];
    const phones: string[] = [];
    const companies: string[] = [];
    const seenE = new Set<string>();
    const seenP = new Set<string>();
    const seenC = new Set<string>();
    const ordered = [rep, ...idxs.map((i) => all[i]).filter((c) => c !== rep)];
    for (const c of ordered) {
      const e = (c.email ?? "").trim();
      const ek = normEmail(e);
      if (e && ek && !seenE.has(ek)) { seenE.add(ek); emails.push(e); }
      const p = (c.phone ?? "").trim();
      const pk = normPhone(p);
      if (p && pk && !seenP.has(pk)) { seenP.add(pk); phones.push(p); }
      // A company face also answers to its own name, not only its domain.
      for (const raw of c.isCompany ? [c.company, c.name] : [c.company]) {
        const co = (raw ?? "").trim();
        const ck = co.toLowerCase();
        if (co && co !== "—" && !seenC.has(ck)) { seenC.add(ck); companies.push(co); }
      }
    }
    // Prefer a real company name over a "—" placeholder from a weaker row.
    const company =
      rep.company && rep.company !== "—"
        ? rep.company
        : (idxs.map((i) => all[i]).find((c) => c.company && c.company !== "—")?.company ?? rep.company);

    // A company face whose primary contact merged in: name that person on the row.
    const mergedPerson = rep.isCompany && !rep.title
      ? idxs.map((i) => all[i]).find((c) => !c.isCompany && c.name && c.name !== rep.name)?.name ?? null
      : null;

    const row: UnifiedContact = {
      ...rep,
      name:        rep.name ?? idxs.map((i) => all[i]).find((c) => c.name)?.name ?? null,
      company,
      email:       emails[0] ?? rep.email,
      phone:       phones[0] ?? rep.phone,
      emails,
      phones,
      companies,
      mergedCount: idxs.length,
      ...(mergedPerson ? { title: mergedPerson } : {}),
    };
    // Never a row with nothing to know or reach it by.
    if (isBlankRow(row)) continue;
    combined.push(row);
  }

  // Sort by created date desc
  combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return combined;
}
