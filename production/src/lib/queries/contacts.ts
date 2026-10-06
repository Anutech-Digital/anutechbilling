/**
 * Contacts — aggregated view of every person known to the tenant (leads + customers).
 * Pure derivation from existing tables; no new DB schema yet.
 *
 * Down the line we can promote this to a real `contacts` table when we need
 * standalone contacts (newsletter subscribers, networking, etc.) or richer
 * features like tags, opt-out, lifecycle stage.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { primaryContactsFor, type PrimaryContact } from "@/lib/contacts/primary";
import {
  buildContactSearchIndex,
  type ContactSearchIndex,
  type ContactLinkRow,
} from "@/lib/contacts/search-index";
import type { ContactRow, ContactChannel } from "@/lib/supabase/database.types";

export type Contact = ContactRow;
export type { ContactChannel } from "@/lib/supabase/database.types";

export type ContactSource = "lead" | "customer" | "vendor" | "partner" | "imported" | "employee";

export interface UnifiedContact {
  id:        string;            // "lead:<id>" / "customer:<id>" / "imported:<id>"
  source:    ContactSource;
  refId:     string;            // original lead.id / customer.id / contacts.id
  name:      string | null;
  email:     string | null;
  phone:     string | null;
  company:   string;
  title:     string | null;
  /** For leads: stage. For customers: health (0-100). For imported: pending/engaged/promoted/archived. */
  status:    string | null;
  /** Sub-source for imported contacts: 'google_csv' | 'manual' | etc. */
  importedFrom?: string;
  /** Relationship classification for standalone contacts: 'partner' | 'vendor'
   *  | 'personal' | 'other'. null/undefined for lead/customer contacts (their
   *  kind comes from the source). */
  relationship?: string | null;
  createdAt: string;
  /** ALL emails/phones this identity is reachable at, merged across every source
   *  row that shares an email OR phone with it (dedup, primary first). One real
   *  person can enquire from several addresses — identity grouping collapses them
   *  into ONE contact so the book never shows the same human twice. */
  emails?: string[];
  phones?: string[];
  /**
   * Har merge hui row ki company (dedup, face pehle). 1 Sep 2026: "demo 7" ki
   * lead search me nahi mili — wo usi email/phone ke customer-card me MERGE thi
   * aur search sirf chehre wali company dekhta tha. Insaan ek hi hai, par uski
   * HAR company se wo dhoondha ja sake.
   */
  companies?: string[];
  /** How many source rows were merged into this identity (1 = not merged). */
  mergedCount?: number;
  /** The master contact id this row is tied to — a lead's `contact_id`, or an
   *  imported contact's own id. Used to union a lead with its shadow contact
   *  even if their channels were later edited apart. */
  linkId?: string | null;
}

/** A contact's unified "kind" for filtering + badges. Leads/customers derive it
 *  from their source; standalone contacts from their `relationship` column. */
export type ContactKind = "lead" | "customer" | "partner" | "vendor" | "employee" | "personal" | "other";

export function contactKind(c: UnifiedContact): ContactKind {
  // Hard business relations, derived from real data (no AI, no guessing):
  if (c.source === "customer") return "customer";  // we sold to them
  if (c.source === "vendor")   return "vendor";    // we buy from them
  if (c.source === "partner")  return "partner";   // referral / commission
  if (c.source === "employee") return "employee";  // works for us
  if (c.source === "lead")     return "lead";      // they enquired
  // Standalone contact — its manually-set relationship, else "not decided".
  const rel = (c.relationship ?? "").toLowerCase();
  if (rel === "partner" || rel === "vendor" || rel === "personal") return rel;
  return "other";
}

export function useAllContacts() {
  return useQuery({
    queryKey: ["contacts", "all"],
    queryFn: async (): Promise<UnifiedContact[]> => {
      const supabase = createClient();

      const [leadsRes, customersRes, vendorsRes, partnersRes, importedRes, employeesRes] = await Promise.all([
        supabase
          .from("leads")
          .select("id, company, contact_name, contact_email, contact_phone, stage, created_at, is_junk, contact_id"),
        supabase
          .from("customers")
          .select("id, name, contact_name, contact_title, contact_email, contact_phone, health, created_at"),
        // Vendors = people/companies we BUY from — a real business relation, so
        // they belong in the contact book auto-classified as "Vendor".
        supabase
          .from("vendors")
          .select("id, name, contact_name, contact_email, contact_phone, created_at"),
        // Referral partners = people who send us business (commission) → "Partner".
        supabase
          .from("referral_partners")
          .select("id, name, email, phone, is_active, created_at"),
        supabase
          .from("contacts")
          .select("id, full_name, email, phone, company, title, source, status, relationship, promoted_to_lead_id, created_at")
          // 'enquiry' contacts are durable identity anchors auto-created for leads
          // (migration 0197). They're never shown directly — the lead they belong
          // to already represents the person in the book (and if that lead is junk,
          // it's hidden, so its anchor must stay hidden too). They exist only to
          // give leads a stable contact_id + accumulate a person's channels.
          .neq("source", "enquiry")
          // Hide promoted contacts ONLY while their lead still exists (they show
          // via that lead row). If the lead was later deleted, promoted_to_lead_id
          // is SET NULL by the FK — then re-show the contact so a real person
          // never silently vanishes from the book after a lead delete.
          .or("status.neq.promoted,promoted_to_lead_id.is.null"),
        // Employees are people too — they belong in the contact book (auto "Employee").
        supabase
          .from("employees")
          .select("id, name, email, phone, designation, is_active, created_at"),
      ]);

      const leadsData = leadsRes.data ?? [];
      const customersData = customersRes.data ?? [];
      const vendorsData = vendorsRes.data ?? [];
      const partnersData = partnersRes.data ?? [];
      const importedData = importedRes.data ?? [];
      const employeesData = employeesRes.data ?? [];

      const fromLeads: UnifiedContact[] = leadsData
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
          linkId:    (l as { contact_id?: string | null }).contact_id ?? null,
        }));

      const fromCustomers: UnifiedContact[] = customersData
        .filter((c) => c.contact_name || c.contact_email || c.contact_phone || c.name)
        .map((c) => ({
          id:        `customer:${c.id}`,
          source:    "customer" as const,
          refId:     c.id,
          name:      c.contact_name || c.name,
          email:     c.contact_email,
          phone:     c.contact_phone,
          company:   c.name,
          title:     c.contact_title,
          status:    c.health != null ? String(c.health) : null,
          createdAt: c.created_at,
        }));

      const fromVendors: UnifiedContact[] = vendorsData
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

      const fromPartners: UnifiedContact[] = partnersData
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

      const fromEmployees: UnifiedContact[] = employeesData
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

      const fromImported: UnifiedContact[] = importedData.map((c) => ({
        id:           `imported:${c.id}`,
        source:       "imported" as const,
        refId:        c.id,
        name:         c.full_name,
        email:        c.email,
        phone:        c.phone,
        company:      c.company ?? "—",
        title:        c.title,
        status:       c.status,
        importedFrom: c.source,
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
          const co = (c.company ?? "").trim();
          const ck = co.toLowerCase();
          if (co && co !== "—" && !seenC.has(ck)) { seenC.add(ck); companies.push(co); }
        }
        // Prefer a real company name over a "—" placeholder from a weaker row.
        const company =
          rep.company && rep.company !== "—"
            ? rep.company
            : (idxs.map((i) => all[i]).find((c) => c.company && c.company !== "—")?.company ?? rep.company);

        combined.push({
          ...rep,
          name:        rep.name ?? idxs.map((i) => all[i]).find((c) => c.name)?.name ?? null,
          company,
          email:       emails[0] ?? rep.email,
          phone:       phones[0] ?? rep.phone,
          emails,
          phones,
          companies,
          mergedCount: idxs.length,
        });
      }

      // Sort by created date desc
      combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return combined;
    },
  });
}

// ============================================================
// Celebrations — upcoming birthdays / anniversaries (migration 0198).
// Powers the notification-bell reminder + 1-tap WhatsApp wish. Pure client
// derivation; month-day match ignoring year, next occurrence within N days.
// ============================================================

export interface Celebration {
  id:        string;                    // `${kind}:${contactId}` — stable key
  contactId: string;
  name:      string;
  kind:      "birthday" | "anniversary";
  dateISO:   string;                    // stored YYYY-MM-DD
  inDays:    number;                    // 0 = today
  age:       number | null;             // years turning (birthday, if year known)
  phone:     string | null;
}

export function useCelebrations(daysAhead = 7) {
  return useQuery({
    queryKey: ["contacts", "celebrations", daysAhead],
    queryFn: async (): Promise<Celebration[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contacts")
        .select("id, full_name, phone, birthday, anniversary")
        .or("birthday.not.is.null,anniversary.not.is.null");
      if (error) throw error;

      // "Today" in IST (matches the rest of the app's day boundary).
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const ty = istNow.getUTCFullYear(), tm = istNow.getUTCMonth(), tdte = istNow.getUTCDate();
      const todayUTC = Date.UTC(ty, tm, tdte);

      const out: Celebration[] = [];
      const consider = (
        contactId: string, name: string | null, phone: string | null,
        kind: Celebration["kind"], dateStr: string | null,
      ) => {
        if (!dateStr) return;
        const d = new Date(`${dateStr}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return;
        const bm = d.getUTCMonth(), bd = d.getUTCDate();
        let occ = Date.UTC(ty, bm, bd);
        if (occ < todayUTC) occ = Date.UTC(ty + 1, bm, bd);      // already passed → next year
        const inDays = Math.round((occ - todayUTC) / 86_400_000);
        if (inDays > daysAhead) return;
        const birthYear = d.getUTCFullYear();
        const age = kind === "birthday" && birthYear > 1900
          ? new Date(occ).getUTCFullYear() - birthYear
          : null;
        out.push({ id: `${kind}:${contactId}`, contactId, name: name ?? "Contact", kind, dateISO: dateStr, inDays, age, phone });
      };

      for (const c of data ?? []) {
        consider(c.id, c.full_name, c.phone, "birthday", (c as { birthday?: string | null }).birthday ?? null);
        consider(c.id, c.full_name, c.phone, "anniversary", (c as { anniversary?: string | null }).anniversary ?? null);
      }
      return out.sort((a, b) => a.inDays - b.inDays);
    },
  });
}

// ============================================================
// Standalone contacts (the real `contacts` table) — full CRUD.
// These are the owner's own people: networking / marketing / personal
// outreach contacts with rich profile detail (social + address).
// ============================================================

/** One contact by id (contacts-table record). */
export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ["contact", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Contact | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("contacts").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Contact | null;
    },
  });
}

/** Fields the owner edits on a contact — everything except system columns. */
export type ContactFormValues = {
  full_name: string;
  /** Customer-contact fields (migration 20260910100000). `role` is what the person
   *  does for that customer; `is_primary` marks the one who receives invoices and
   *  payment reminders — at most one per customer, enforced by a UNIQUE index. */
  role?:       string | null;
  is_primary?: boolean;
  company?:  string | null;
  /** Optional link to a customer company — surfaces that company's records on
   *  the contact detail page. null = free-text `company` only. */
  customer_id?: string | null;
  /** Relationship classification: 'partner' | 'vendor' | 'personal' | 'other'. */
  relationship?: string | null;
  /** Personal-profile fields (migration 0198). birthday/anniversary = YYYY-MM-DD. */
  birthday?:    string | null;
  anniversary?: string | null;
  nickname?:    string | null;
  family?:      string | null;
  title?:    string | null;
  /** All emails/phones (each labelled). The mutations mirror index 0 into the
   *  legacy `email`/`phone` primary columns so existing consumers keep working. */
  emails?:   ContactChannel[];
  phones?:   ContactChannel[];
  email?:    string | null;
  phone?:    string | null;
  whatsapp?: string | null;
  linkedin?: string | null;
  instagram?:string | null;
  facebook?: string | null;
  twitter?:  string | null;
  website?:  string | null;
  address?:  string | null;
  city?:     string | null;
  tags?:     string[];
  notes?:    string | null;
};

/**
 * The id shape every contact in this tenant carries: `C-<base36 time>-<base36 rand>`.
 *
 * EXPORTED (11 Sep 2026) because the subscription onboarding dialog writes a customer's
 * first contact directly through Supabase rather than through useCreateContact — it is a
 * plain form inside a larger transaction-ish sequence, not a mutation on its own. A
 * second id generator over there would eventually disagree with this one about the
 * format, and contact ids are read by eye in the database.
 */
export function newContactId(): string {
  return "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
}

/**
 * Normalize form values before write: clean the email/phone arrays (drop blanks,
 * default labels) and mirror the PRIMARY (index 0) into the legacy email/phone
 * columns so the list, reach buttons, dedupe, campaigns and AI all keep working.
 */
function normalizeChannels(values: ContactFormValues): ContactFormValues {
  const out = { ...values };
  if (values.emails) {
    const cleaned = values.emails
      .map((e) => ({ value: (e.value ?? "").trim(), label: e.label || "other" }))
      .filter((e) => e.value !== "");
    out.emails = cleaned;
    out.email = cleaned[0]?.value ?? null;
  }
  if (values.phones) {
    const cleaned = values.phones
      .map((p) => ({ value: (p.value ?? "").trim(), label: p.label || "mobile" }))
      .filter((p) => p.value !== "");
    out.phones = cleaned;
    out.phone = cleaned[0]?.value ?? null;
  }
  return out;
}

/** Create a standalone contact (source='manual'). Resolves tenant_id from auth. */
export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: ContactFormValues): Promise<string> => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr) throw meErr;

      const id = newContactId();
      const { error } = await supabase.from("contacts").insert({
        id,
        tenant_id: me!.tenant_id,
        source:    "manual",
        status:    "engaged",
        ...normalizeChannels(values),
      });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
    },
    onError: (err) => toastError(err),
  });
}

/** Update a contact's editable fields. */
export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: ContactFormValues }) => {
      const supabase = createClient();
      const { error } = await supabase.from("contacts").update(normalizeChannels(values)).eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["contact", id] });
    },
    onError: (err) => toastError(err),
  });
}

/** Delete a standalone contact. */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("contacts").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      toast.success("Contact deleted");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// A CUSTOMER's contacts — the single home for "who do I ring"
// ============================================================
/**
 * Three places used to hold this fact and two were dead: the flat
 * `customers.contact_*` columns (which the app actually read), `contacts` with a
 * `customer_id` (0 rows), and `customers.contact_persons` jsonb (0 customers).
 *
 * Abhishek's decision, 10 Sep 2026: ONE identity. A customer has contacts — several,
 * with roles — and at least one is mandatory. People who are not customers belong in
 * `leads`, which already has a pipeline for them.
 *
 * Migration 20260910100000 added `role` + `is_primary` and backfilled every customer's
 * flat fields into a primary contact, so no customer arrived here without one.
 */

/** What a person does for this customer. */
export type ContactRole = "owner" | "accountant" | "it_head" | "poc" | "other";

export const CONTACT_ROLES: ReadonlyArray<{ value: ContactRole; label: string }> = [
  { value: "poc",        label: "Point of contact" },
  { value: "owner",      label: "Owner" },
  { value: "accountant", label: "Accountant" },
  { value: "it_head",    label: "IT head" },
  { value: "other",      label: "Other" },
] as const;

export const roleLabel = (r: string | null | undefined) =>
  CONTACT_ROLES.find((x) => x.value === r)?.label ?? "Point of contact";

/** Every contact for one customer, primary first. */
export function useCustomerContacts(customerId: string | undefined) {
  return useQuery({
    queryKey: ["contacts", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<Contact[]> => {
      const supabase = createClient();
      /* Reads the LINK table since 18 Sep 2026 — a person can serve several customers,
         so "is this customer's contact" is a fact about the link, not the person. The
         link's role and is_primary win over the legacy columns on the contact row: the
         same human can be the accountant here and the owner elsewhere. */
      const { data, error } = await supabase
        .from("customer_contacts")
        .select("role, is_primary, contacts(*)")
        .eq("customer_id", customerId!)
        /* Primary first, then alphabetical — the person who gets the invoice should
           never be somewhere down a list. */
        .order("is_primary", { ascending: false });
      if (error) throw error;
      type LinkRow = { role: string | null; is_primary: boolean | null; contacts: Contact | null };
      return ((data ?? []) as unknown as LinkRow[])
        .filter((l) => l.contacts)
        .map((l) => ({ ...(l.contacts as Contact), role: l.role, is_primary: !!l.is_primary }))
        .sort((a, b) =>
          Number(b.is_primary) - Number(a.is_primary)
          || (a.full_name ?? "").localeCompare(b.full_name ?? ""));
    },
  });
}

/**
 * Make one contact the primary, and demote whoever held it.
 *
 * Two statements, deliberately in this order: clear the old primary FIRST, then set
 * the new one. `contacts_one_primary_per_customer` is a UNIQUE index, so setting
 * before clearing collides and the whole thing fails — which is the index doing its
 * job, and the reason this cannot be one update.
 */
export function useSetPrimaryContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contactId, customerId }: { contactId: string; customerId: string }) => {
      const supabase = createClient();
      /* Both statements target customer_contacts. Setting is_primary on the CONTACT
         would make that person primary for every customer they serve — which since
         18 Sep 2026 can be several, and would redirect other customers' invoices. */
      const { error: clearErr } = await supabase
        .from("customer_contacts")
        .update({ is_primary: false })
        .eq("customer_id", customerId)
        .eq("is_primary", true);
      if (clearErr) throw clearErr;
      const { error } = await supabase
        .from("customer_contacts")
        .update({ is_primary: true })
        .eq("customer_id", customerId)
        .eq("contact_id", contactId);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["contacts", "customer", v.customerId] });
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Primary contact updated");
    },
    onError: (err) => toastError(err, {
      description: "The primary contact was not changed. Try again, or reload the page.",
    }),
  });
}

/**
 * Delete a contact — refusing to remove the last one.
 *
 * §24: the refusal says why and what to do instead. A customer with no contact is a
 * customer nobody can invoice or chase, and the mandatory-one rule is the whole point
 * of the redesign; enforcing it only in the UI would leave it enforced nowhere that
 * matters.
 */
export function useDeleteCustomerContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contactId, customerId }: { contactId: string; customerId: string }) => {
      const supabase = createClient();
      const { count, error: countErr } = await supabase
        .from("customer_contacts")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId);
      if (countErr) throw countErr;
      if ((count ?? 0) <= 1) {
        throw new Error(
          "This is the customer's only contact — add another one first, then remove this.",
        );
      }
      /* UNLINKS, it does not delete the person. Since 18 Sep 2026 the same human may
         serve other customers, and deleting the contact row would remove them from
         those too — taking their invoices' recipient with it. The person stays in the
         address book; only this relationship ends. */
      const { error } = await supabase
        .from("customer_contacts")
        .delete()
        .eq("customer_id", customerId)
        .eq("contact_id", contactId);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["contacts", "customer", v.customerId] });
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      toast.success("Contact removed from this customer", {
        description: "They are still in your contacts, and on any other customer they serve.",
      });
    },
    onError: (err) => toastError(err, {
      description: "Every customer must keep at least one contact.",
    }),
  });
}

/**
 * The contact search index — who serves which customers, for the Customers and
 * Subscriptions filters.
 *
 * Abhishek, 18 Sep 2026: "what if i have to filter customer and subscription who
 * attached with single contact". One fetch, shared by both pages through the query
 * cache, then matched in memory on every keystroke — see lib/contacts/search-index.ts
 * for why it is an index and not a query per search.
 *
 * `staleTime` is generous on purpose: links change when somebody adds or moves a
 * contact, which is rare next to how often these two pages are opened, and every
 * mutation that touches them already invalidates ["contacts", ...].
 */
export function useContactSearchIndex() {
  return useQuery({
    queryKey: ["contacts", "search-index"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ContactSearchIndex> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_contacts")
        .select("customer_id, contact_id, contacts(id, full_name, email, phone)");
      /* Throwing would take the whole customer list down with it — the pages render
         fine without contact matching, they just cannot search by person. Logged so the
         gap is visible rather than mysterious. */
      if (error) {
        console.warn("[contacts] contact search index unavailable:", error.message);
        return buildContactSearchIndex([]);
      }
      return buildContactSearchIndex((data ?? []) as unknown as ContactLinkRow[]);
    },
  });
}

/**
 * The primary contact for every customer, as a map.
 *
 * Added 23 Sep 2026 for the portable subscription export, which carries the contact so a
 * re-import can rebuild a missing customer — this app refuses to create one without a
 * contact person, so a file without it cannot restore.
 *
 * Wraps `primaryContactsFor`, the one resolver the invoice and dunning paths use, rather
 * than reading `customer_contacts` again here. Two readers of "who gets this customer's
 * mail" is how the answer starts to differ depending on which screen asked.
 */
export function usePrimaryContacts(customerIds: readonly string[]) {
  /* Sorted and joined, so re-rendering with the same customers in a different order does
     not refetch. The list comes from a filtered table and its order changes constantly. */
  const key = [...new Set(customerIds)].sort().join(",");
  return useQuery({
    queryKey: ["contacts", "primary-map", key],
    enabled: customerIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, PrimaryContact>> => {
      const supabase = createClient();
      return primaryContactsFor(supabase, [...new Set(customerIds)]);
    },
  });
}
