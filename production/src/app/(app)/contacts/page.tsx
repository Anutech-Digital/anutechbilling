/**
 * Contacts — unified directory of every person known to the tenant.
 * Aggregates leads + customers and lets the operator run campaigns to selected contacts.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
/* typedRoutes: `router.push("/leads")` is rejected at BUILD time only — tsc, vitest and
   eslint all pass it. See CLAUDE.md §25.2. */
import type { Route } from "next";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { useAllContacts, type UnifiedContact } from "@/lib/queries/contacts";
import {
  BIZ_LABEL, applyFacets, asBizFacet, asRelFacet, facetCounts, isCompanyWithoutPerson,
  type BizFacet, type RelFacet,
} from "@/lib/contacts/relationship";
import { ContactsFacetRows, RelationshipBusinessGrid } from "@/components/features/contacts/contacts-facets";
import { RelationshipChip } from "@/components/features/contacts/relationship-chip";
import { RelationshipMap } from "@/components/features/contacts/relationship-map";
import ImportContactsDialog from "@/components/features/contacts/import-contacts-dialog";
import { ContactForm } from "@/components/features/contacts/contact-form";
import CampaignComposerDialog from "@/components/features/campaigns/campaign-composer-dialog";
import { FAB } from "@/components/ui/fab";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { BulkActionBar, BulkBarButton } from "@/components/ui/bulk-action-bar";
import { Avatar } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { useUrlState } from "@/lib/hooks/use-url-state";


// R-1740: two sides per person. BUSINESS comes from links (a lead, a customer, a vendor or
// referral partner row) — never chosen by hand. RELATIONSHIP is mine to set (Friend ·
// Close …). The old one-dimension "kind" tabs (Lead / Company / Partner / Vendor /
// Employee / Personal / Not decided) mixed the two.
const BIZ_BADGE: Record<BizFacet, "success" | "warning" | "info" | "muted"> = {
  lead: "warning", customer: "success", vendor_partner: "info", none: "muted",
};

const CONTACT_COL_ORDER = ["select", "name", "company", "email", "phone", "business", "relationship", "action"];
// Fluid percentage widths (sum = 100%) so the table always fits its container
// with no horizontal scroll — replaces the old fixed-pixel resizable columns
// that overflowed narrow laptops. Dropped the low-value "Created" column (still
// on the detail page) to give Email / Company readable room.
const CONTACT_COL_WIDTHS: Record<string, string> = {
  select: "4%", name: "18%", company: "14%", email: "20%", phone: "13%", business: "10%", relationship: "13%", action: "8%",
};

export default function ContactsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: contacts, isLoading, error, refetch } = useAllContacts();

  /* R-286: filters and search live in the URL — open a contact, press Back, same list.
     R-1740: ?biz=&rel= so a grid cell is a link you can share; ?view=map; ?missing=1 lists
     the companies that have no contact person yet. */
  const [bizParam, setBizParam] = useUrlState("biz");
  const [relParam, setRelParam] = useUrlState("rel");
  const [view, setView]         = useUrlState("view", "list");
  const [missing, setMissing]   = useUrlState("missing");
  const [search, setSearch]     = useUrlState("q");
  const biz = asBizFacet(bizParam);
  const rel = asRelFacet(relParam);
  const setBiz = (v: BizFacet | "all") => setBizParam(v === "all" ? "" : v);
  const setRel = (v: RelFacet | "all") => setRelParam(v === "all" ? "" : v);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [emailComposerOpen, setEmailComposerOpen] = React.useState(false);
  const [composerRecipients, setComposerRecipients] = React.useState<{ email: string; name?: string; company?: string }[]>([]);
  const [composerTotalSelected, setComposerTotalSelected] = React.useState(0);

  // Promote a single imported contact to lead
  async function promoteOne(contactId: string) {
    try {
      const res = await fetch(`/api/contacts/${contactId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, { fallback: "Could not turn this contact into a lead.", description: "Refresh the page and try again." });
        return;
      }
      toast.success(`Promoted → lead ${json.leadId}`);
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      router.push(`/leads?lead=${json.leadId}` as never);
    } catch (err) {
      toastError(err, { fallback: "Could not reach the server.", description: "Check your connection and try again." });
    }
  }

  // Two-way sync with Google Contacts (leads + customers + standalone contacts).
  // If Google isn't connected yet, guide the operator to Settings to connect.
  async function syncGoogle() {
    setSyncing(true);
    try {
      const st = await fetch("/api/integrations/google-contacts").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!st?.configured) {
        toast.error("Google Contacts is not set up yet.", { description: "Opening Settings → Integrations — add the Google keys there." });
        router.push("/settings?tab=integrations" as never);
        return;
      }
      if (!st?.connected) {
        toast.info("Connect Google Contacts first — opening Settings.");
        router.push("/settings?tab=integrations" as never);
        return;
      }
      const res = await fetch("/api/integrations/google-contacts/sync", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError(j?.error, { fallback: "Google Contacts sync failed.", description: "Try again in a minute. If it keeps failing, reconnect Google in Settings → Integrations." });
        return;
      }
      toast.success(`Synced with Google — ${j.pulled} in, ${j.pushed + j.created} out${j.deleted ? `, ${j.deleted} removed` : ""}`);
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      refetch();
    } catch (e) {
      toastError(e, { fallback: "Could not reach the server.", description: "Check your connection and try again." });
    } finally {
      setSyncing(false);
    }
  }

  // Open a contact — standalone contacts get the rich detail page; lead/customer
  // people open their own record (which already has a full page).
  const openContact = (c: { source: string; refId: string }) => {
    const path =
      c.source === "imported" ? `/contacts/${c.refId}`
      : c.source === "lead"     ? `/leads?lead=${c.refId}`
      : c.source === "vendor"   ? `/accounting/vendors`
      : c.source === "partner"  ? `/referrals`
      :                           `/customers/${c.refId}`;
    router.push(path as never);
  };

  // Was client-side filtered by a "workspace" that matched on company-name
  // keywords. RLS already scopes every read to the caller's tenant, so that
  // filter only ever HID the tenant's own rows. Removed 2026-08-13.
  const contactsByWorkspace = React.useMemo(() => contacts ?? [], [contacts]);

  // Search first; the facets and their counts work on what the search left.
  const searched = contactsByWorkspace.filter((c) => {
    if (search.trim()) {
      const s = search.toLowerCase();
      const inArr = (arr?: string[]) => (arr ?? []).some((v) => v.toLowerCase().includes(s));
      if (
        !c.name?.toLowerCase().includes(s) &&
        /* R-535: a company row names its primary contact in the subtitle — find it by that person too. */
        !c.title?.toLowerCase().includes(s) &&
        !c.email?.toLowerCase().includes(s) &&
        !c.phone?.toLowerCase().includes(s) &&
        !c.company.toLowerCase().includes(s) &&
        !inArr(c.emails) &&
        !inArr(c.phones) &&
        /* Merge hui leads ki companies bhi — "demo 7" wala sabak (1 Sep 2026). */
        !inArr(c.companies)
      ) return false;
    }
    return true;
  });

  /* R-1740: counts are PEOPLE only. A company with nobody on it is not a person — it is
     counted apart ("N companies without a contact person — add one"). */
  const showMissing = missing === "1";
  const counts = facetCounts(searched, { biz, rel });
  const filtered = showMissing ? searched.filter(isCompanyWithoutPerson) : applyFacets(searched, { biz, rel });
  const people = contactsByWorkspace.filter((c) => !isCompanyWithoutPerson(c));
  const companiesWithoutPerson = contactsByWorkspace.length - people.length;
  const clearFilters = () => { setBiz("all"); setRel("all"); setSearch(""); setMissing(""); };

  // Selection helpers
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (allFilteredSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  };

  // Bulk actions — message the exact selected contacts. (The Campaigns tool is
  // stage-targeted and email-only; here the operator hand-picked people, so we
  // act on precisely those: Gmail with everyone in BCC for email, and — since
  // WhatsApp has no bulk-link — copy the numbers for a broadcast list.)
  const startCampaign = (channel: "email" | "whatsapp") => {
    const chosen = (contacts ?? []).filter((c) => selected.has(c.id));
    if (chosen.length === 0) {
      toast.error("Select at least one contact.", { description: "Tick the contacts you want to message." });
      return;
    }

    if (channel === "email") {
      const recips = chosen
        .filter((c) => c.email?.trim())
        .map((c) => ({ email: c.email!.trim(), name: c.name ?? undefined, company: c.company || undefined }));
      if (recips.length === 0) {
        toast.error("None of the selected contacts have an email.", { description: "Add an email to them, or pick other contacts." });
        return;
      }
      setComposerRecipients(recips);
      setComposerTotalSelected(chosen.length);
      setEmailComposerOpen(true);
      return;
    }

    // WhatsApp: no bulk-send link exists; copy the numbers for a broadcast list.
    const phones = chosen
      .map((c) => (c.phone ?? "").replace(/\D/g, ""))
      .filter((p) => p.length >= 10);
    if (phones.length === 0) {
      toast.error("None of the selected contacts have a phone number.", { description: "Add a 10-digit mobile number to them, or pick other contacts." });
      return;
    }
    navigator.clipboard?.writeText(phones.join("\n")).then(
      () => toast.success(`${phones.length} number${phones.length > 1 ? "s" : ""} copied — paste into a WhatsApp broadcast list`),
      () => toast.error("Could not copy the numbers.", { description: "The browser blocked the clipboard. Allow clipboard access for this site and try again." }),
    );
  };

  // KPIs — over people (R-1740), so "with email" can never count a company with nobody on it.
  const totalEmails = people.filter((c) => c.email).length;
  const totalPhones = people.filter((c) => c.phone).length;
  const reachablePct = people.length > 0
    ? Math.round((totalEmails / people.length) * 100)
    : 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto min-h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.5rem)] flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            Sales
          </p>
          <h1 className="font-serif text-2xl md:text-3xl leading-tight">Contacts</h1>
          <p className="text-sm text-ink-3 mt-0.5">
            All people across leads & companies · run targeted campaigns
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button icon="refresh" onClick={syncGoogle} loading={syncing}>
            {syncing ? "Syncing…" : "Sync with Google Contacts"}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add contact
          </Button>
        </div>
      </div>

      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />
      <ContactForm open={addOpen} onOpenChange={setAddOpen} />

      {emailComposerOpen && (
        <CampaignComposerDialog
          open={emailComposerOpen}
          onOpenChange={setEmailComposerOpen}
          recipients={composerRecipients}
          totalSelected={composerTotalSelected}
        />
      )}

      {/* Mobile thumb-zone action — contacts are added via import (no single-add form). */}
      <FAB icon="plus" label="Add contact" onClick={() => setAddOpen(true)} />

      {/* Stats — one slim strip, not tall cards. On a Contacts page the LIST is
          the hero; giant KPI cards were pushing the table down so only ~2 rows
          showed. This strip frees that vertical space for the contacts. */}
      {!isLoading && contacts && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-hairline bg-paper px-4 py-2.5">
          <StatItem value={people.length} label="people" />
          <StatDivider />
          <StatItem value={totalEmails} label="with email" hint={`${reachablePct}% reachable`} icon="mail" />
          <StatDivider />
          <StatItem value={totalPhones} label="with phone" hint="WhatsApp reachable" icon="whatsapp" />
          {companiesWithoutPerson > 0 && (<>
            <StatDivider />
            <button
              type="button"
              onClick={() => setMissing(showMissing ? "" : "1")}
              aria-pressed={showMissing}
              className="text-xs text-amber-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
            >
              {companiesWithoutPerson} {companiesWithoutPerson === 1 ? "company" : "companies"} without a contact person — add one
            </button>
          </>)}
        </div>
      )}

      {/* Filter + search — R-1740: Business (from links) and Relationship (mine), faceted,
          with the Relationship × Business grid beside them. */}
      {!isLoading && contacts && contacts.length > 0 && (
        <>
          {showMissing ? (
            <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-hairline bg-paper px-4 py-2.5">
              <p className="text-sm text-ink">
                <b>Companies without a contact person.</b>{" "}
                <span className="text-ink-3">Open one and add the person you deal with there.</span>
              </p>
              <Button size="sm" icon="arrow_left" onClick={() => setMissing("")}>Back to people</Button>
            </div>
          ) : (
            <div className="flex gap-4 flex-wrap items-start justify-between rounded-lg border border-hairline bg-paper px-4 py-3">
              <ContactsFacetRows counts={counts} biz={biz} rel={rel} onBiz={setBiz} onRel={setRel} />
              <RelationshipBusinessGrid
                grid={counts.grid}
                biz={biz}
                rel={rel}
                onPick={(b, r) => {
                  // Same cell again = clear, so the grid is also the way back.
                  if (b === biz && r === rel) { setBiz("all"); setRel("all"); }
                  else { setBiz(b); setRel(r); }
                }}
              />
            </div>
          )}
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              {!showMissing && (
                <div role="group" aria-label="View" className="inline-flex rounded-md border border-hairline overflow-hidden">
                  {(["list", "map"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={`inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber ${
                        view === v ? "bg-amber-soft text-amber-ink" : "bg-paper text-ink-2 hover:bg-paper-2"
                      }`}
                    >
                      <Icon name={v === "list" ? "list" : "target"} size={13} />
                      {v === "list" ? "List" : "Map"}
                    </button>
                  ))}
                </div>
              )}
              <div className="text-xs text-ink-3">
                {showMissing
                  ? `${filtered.length} ${filtered.length === 1 ? "company" : "companies"}`
                  : `Showing ${filtered.length} of ${people.length} people`}
                {selected.size > 0 && ` · ${selected.size} selected`}
              </div>
            </div>
            <div className="w-72">
              <Input
                aria-label="Search contacts"
                prefix={<Icon name="search" size={14} />}
                placeholder="Name, email, phone, company…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {/* R-1740: the Map view — rings by closeness, colour by relationship. */}
      {!isLoading && !error && !showMissing && view === "map" && filtered.length > 0 && (
        <RelationshipMap people={filtered} onOpen={openContact} />
      )}

      {/* Error — R-1535: plain words + Try again; the raw database text goes to the console. */}
      {error && <LoadError what="Contacts" error={error} onRetry={() => void refetch()} />}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty. RETIRED 10 Sep 2026: this page left the nav when a customer's people
          moved onto the customer itself, and CSV / Google import now fails closed (see
          lib/contacts/retired.ts). An "Import CSV" button here would return 410 — a
          dead end (§24) — so this points at the two places that DO take a new person. */}
      {!isLoading && !error && contacts && contacts.length === 0 && (
        <EmptyState
          icon="users"
          title="Nothing here"
          body="This directory just reflects your leads and companies. A company's people are managed on the company's own page; anybody who is not a customer yet belongs in Sales & Pipeline."
          action={<Button variant="primary" icon="users" onClick={() => router.push("/customers")}>Open Companies</Button>}
          secondary={<Button icon="target" onClick={() => router.push("/leads" as Route)}>Open Sales &amp; Pipeline</Button>}
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && contacts && contacts.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="No contacts match"
          body={search ? `No results for "${search}".` : "Nobody matches these filters."}
          action={<Button icon="x" onClick={clearFilters}>Clear filters</Button>}
          compact
        />
      )}

      {/* Mobile card list — phones only */}
      {!isLoading && !error && filtered.length > 0 && (showMissing || view !== "map") && (
        <ul className="md:hidden space-y-2 mb-3">
          {filtered.map((c) => (
            <li key={c.id} onClick={() => openContact(c)} className="bg-paper border border-hairline rounded-lg p-3 cursor-pointer hover:border-hairline-strong transition-colors">
              <div className="flex items-start gap-3">
                <RowAvatar c={c} />
                <div className="min-w-0 flex-1">
                  {/* R-1134: a real button, so Tab reaches the card and Enter/Space open it. */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openContact(c); }}
                    className="block max-w-full text-left font-medium text-ink truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                  >
                    {c.name ?? <span className="italic text-ink-3">No name</span>}
                  </button>
                  {c.isCompany && c.title && <p className="text-xs text-ink-2 truncate mt-0.5">{c.title}</p>}
                  {c.company && <p className="text-xs text-ink-3 truncate mt-0.5">{c.company}</p>}
                  {isCompanyWithoutPerson(c) && (
                    <p className="text-2xs text-ink-3 italic mt-1">No contact person yet</p>
                  )}
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block font-mono text-2xs text-amber-ink truncate mt-1"
                    >
                      {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block font-mono text-2xs text-amber-ink truncate"
                    >
                      {c.phone}
                    </a>
                  )}
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <Badge kind={BIZ_BADGE[c.business ?? "none"]} size="sm" dot>
                    {BIZ_LABEL[c.business ?? "none"]}
                  </Badge>
                  {!isCompanyWithoutPerson(c) && (
                    <RelationshipChip type={c.relationshipType} closeness={c.closeness} size="sm" />
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Desktop table — mirrors the Leads list: a viewport-capped scroll
          container (flex-1 min-h-0) so the table scrolls INTERNALLY on both axes.
          The horizontal scrollbar therefore always sits at the bottom of the
          visible frame (reachable without scrolling the whole page down), and the
          sticky header stays put while rows scroll. table-fixed + min-w keeps the
          columns readable on narrow widths instead of crushing. */}
      {!isLoading && !error && filtered.length > 0 && (showMissing || view !== "map") && (
        <div className="hidden md:block w-full max-w-full border border-hairline rounded-md overflow-y-auto overflow-x-hidden bg-paper flex-1 min-h-0">
          <table className="w-full table-fixed">
            <colgroup>
              {CONTACT_COL_ORDER.map((id) => <col key={id} style={{ width: CONTACT_COL_WIDTHS[id] }} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline p-3">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 accent-amber cursor-pointer"
                    aria-label="Select all"
                  />
                </th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Name</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Company</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Email</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Phone</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Business</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Relationship</th>
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const isSelected = selected.has(c.id);
                return (
                  <tr
                    key={c.id}
                    onClick={() => openContact(c)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${c.name ?? c.email ?? "contact"}`}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openContact(c); } }}
                    className={`group/row border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset ${
                      isSelected ? "bg-amber-soft/40" : ""
                    }`}
                  >
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(c.id)}
                        className="w-3.5 h-3.5 accent-amber cursor-pointer"
                        aria-label={`Select ${c.name ?? c.email}`}
                      />
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2.5">
                        <RowAvatar c={c} />
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-ink truncate">
                            {c.name ?? <span className="italic text-ink-3">No name</span>}
                          </div>
                          {c.title && (
                            <div className="text-2xs text-ink-3 truncate">{c.title}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-sm text-ink-2 truncate" title={c.company}>{c.company}</td>
                    {isCompanyWithoutPerson(c) ? (
                      /* R-535: a company with nobody on it yet says so, instead of two dashes
                         that read like a broken person row. */
                      <td colSpan={2} className="p-3 text-xs italic text-ink-3 truncate">
                        No contact person yet · add one on the company page
                      </td>
                    ) : (<>
                    <td className="p-3 text-xs font-mono text-ink-2 truncate" title={(c.emails ?? []).join(", ") || undefined}>
                      {c.email ?? "—"}
                      {(c.emails?.length ?? 0) > 1 && (
                        <span className="ml-1 text-ink-3 font-sans" title={`${c.emails!.length} emails`}>+{c.emails!.length - 1}</span>
                      )}
                    </td>
                    <td className="p-3 text-xs font-mono text-ink-2 truncate" title={(c.phones ?? []).join(", ") || undefined}>
                      {c.phone ?? "—"}
                      {(c.phones?.length ?? 0) > 1 && (
                        <span className="ml-1 text-ink-3 font-sans" title={`${c.phones!.length} phones`}>+{c.phones!.length - 1}</span>
                      )}
                    </td>
                    </>)}
                    <td className="p-3 truncate">
                      <Badge kind={BIZ_BADGE[c.business ?? "none"]} dot>
                        {BIZ_LABEL[c.business ?? "none"]}
                      </Badge>
                    </td>
                    <td className="p-3 truncate">
                      {isCompanyWithoutPerson(c)
                        ? <span className="text-xs text-ink-3">—</span>
                        : <RelationshipChip type={c.relationshipType} closeness={c.closeness} />}
                    </td>
                    <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {/* Quick-reach actions — a contacts directory's core job is
                          reaching a person fast. Email + WhatsApp are one click,
                          no need to open the record. Shown on row hover to keep
                          the table calm at rest. */}
                      <div className="inline-flex items-center gap-0.5 justify-end opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                        {c.email && (
                          <IconButton
                            icon="mail"
                            size="sm"
                            variant="ghost"
                            aria-label={`Email ${c.name ?? c.company}`}
                            title={`Email ${c.email}`}
                            onClick={() => { window.location.href = `mailto:${c.email}`; }}
                          />
                        )}
                        {c.phone && (
                          <IconButton
                            icon="whatsapp"
                            size="sm"
                            variant="ghost"
                            aria-label={`WhatsApp ${c.name ?? c.company}`}
                            title={`WhatsApp ${c.phone}`}
                            onClick={() => {
                              const digits = (c.phone ?? "").replace(/\D/g, "");
                              const num = digits.length === 10 ? `91${digits}` : digits;
                              window.open(`https://wa.me/${num}`, "_blank", "noopener,noreferrer");
                            }}
                          />
                        )}
                        {c.source === "imported" && (
                          <IconButton
                            icon="arrow_right"
                            size="sm"
                            variant="ghost"
                            aria-label="Convert to lead"
                            title="Convert this contact into a lead"
                            onClick={() => promoteOne(c.refId)}
                          />
                        )}
                        <IconButton
                          icon="external"
                          size="sm"
                          variant="ghost"
                          aria-label="Open contact"
                          title="Open contact"
                          onClick={() => openContact(c)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Selection bar — the shared BulkActionBar (R-268), so it clears the phone bottom
          nav and stays inside 375px like every other list's bar. */}
      <BulkActionBar count={selected.size} noun="contact" onClear={() => setSelected(new Set())}>
        <BulkBarButton icon="mail" onClick={() => startCampaign("email")}>
          Email
        </BulkBarButton>
        <BulkBarButton icon="whatsapp" onClick={() => startCampaign("whatsapp")}>
          WhatsApp blast
        </BulkBarButton>
      </BulkActionBar>
    </div>
  );
}

/** Company rows get a building tile, people get their initials — tells the two apart at a glance (R-535). */
function RowAvatar({ c }: { c: UnifiedContact }) {
  if (c.isCompany) {
    return (
      <span
        role="img"
        aria-label="Company"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-soft text-emerald-ink"
      >
        <Icon name="building" size={14} />
      </span>
    );
  }
  return (
    <Avatar
      initials={c.name ? initials(c.name) : "?"}
      color={c.source === "customer" ? "emerald" : "amber"}
      size="sm"
    />
  );
}

/** One stat in the slim Contacts header strip — big serif number + small label. */
function StatItem({
  value, label, hint, icon,
}: {
  value: number;
  label: string;
  hint?: string;
  icon?: React.ComponentProps<typeof Icon>["name"];
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      {icon && <Icon name={icon} size={13} className="text-ink-3 self-center" />}
      <span className="font-serif text-xl text-ink leading-none tabular-nums">{value}</span>
      <span className="text-xs text-ink-3">{label}</span>
      {hint && <span className="text-2xs text-ink-3">· {hint}</span>}
    </div>
  );
}

/** Thin vertical rule between stats — hidden once the strip wraps on mobile. */
function StatDivider() {
  return <span aria-hidden className="hidden sm:inline h-6 w-px bg-hairline self-center" />;
}
