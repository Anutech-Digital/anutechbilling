/**
 * Contacts — unified directory of every person known to the tenant.
 * Aggregates leads + customers and lets the operator run campaigns to selected contacts.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useAllContacts, contactKind, type ContactKind } from "@/lib/queries/contacts";
import ImportContactsDialog from "@/components/features/contacts/import-contacts-dialog";
import { ContactForm } from "@/components/features/contacts/contact-form";
import CampaignComposerDialog from "@/components/features/campaigns/campaign-composer-dialog";
import { FAB } from "@/components/ui/fab";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

// Contacts are grouped by their unified "kind" (see contactKind): leads +
// customers come from their own tables; partners / vendors / personal / other
// are standalone contacts classified by their `relationship` field.
const KIND_META: Record<ContactKind, { label: string; dot: TabBarItem["dot"]; badge: "success" | "warning" | "info" | "muted" }> = {
  lead:     { label: "Leads",     dot: "amber",   badge: "warning" },
  customer: { label: "Customers", dot: "emerald", badge: "success" },
  partner:  { label: "Partners",  dot: "indigo",  badge: "info"    },
  vendor:   { label: "Vendors",   dot: "slate",   badge: "muted"   },
  employee: { label: "Employees", dot: "emerald", badge: "success" },
  personal: { label: "Personal",  dot: "rose",    badge: "info"    },
  other:    { label: "Not decided", dot: "slate", badge: "muted"   },
};
const KIND_ORDER: ContactKind[] = ["lead", "customer", "partner", "vendor", "employee", "personal", "other"];
// Singular label for the per-row badge.
const KIND_BADGE_LABEL: Record<ContactKind, string> = {
  lead: "Lead", customer: "Customer", partner: "Partner", vendor: "Vendor", employee: "Employee", personal: "Personal", other: "Not decided",
};

const CONTACT_COL_ORDER = ["select", "name", "company", "email", "phone", "source", "action"];
// Fluid percentage widths (sum = 100%) so the table always fits its container
// with no horizontal scroll — replaces the old fixed-pixel resizable columns
// that overflowed narrow laptops. Dropped the low-value "Created" column (still
// on the detail page) to give Email / Company readable room.
const CONTACT_COL_WIDTHS: Record<string, string> = {
  select: "4%", name: "20%", company: "17%", email: "23%", phone: "15%", source: "10%", action: "11%",
};

export default function ContactsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: contacts, isLoading, error, refetch } = useAllContacts();

  const [tab, setTab]       = React.useState("all");
  const [search, setSearch] = React.useState("");
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
        toast.error(json.error ?? "Could not promote");
        return;
      }
      toast.success(`Promoted → lead ${json.leadId}`);
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      router.push(`/leads?lead=${json.leadId}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    }
  }

  // Two-way sync with Google Contacts (leads + customers + standalone contacts).
  // If Google isn't connected yet, guide the operator to Settings to connect.
  async function syncGoogle() {
    setSyncing(true);
    try {
      const st = await fetch("/api/integrations/google-contacts").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!st?.configured) {
        toast.error("Google Contacts abhi set up nahi — Settings → Integrations me keys chahiye");
        router.push("/settings?tab=integrations" as never);
        return;
      }
      if (!st?.connected) {
        toast.info("Pehle Google Contacts connect karo — Settings khol raha hoon");
        router.push("/settings?tab=integrations" as never);
        return;
      }
      const res = await fetch("/api/integrations/google-contacts/sync", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j?.error ?? "Sync failed");
        return;
      }
      toast.success(`Google se sync ho gaya — ${j.pulled} aaye, ${j.pushed + j.created} bheje${j.deleted ? `, ${j.deleted} hataye` : ""}`);
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
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

  // Filter
  const filtered = (contacts ?? []).filter((c) => {
    if (tab !== "all" && contactKind(c) !== tab) return false;
    if (search.trim()) {
      const s = search.toLowerCase();
      const inArr = (arr?: string[]) => (arr ?? []).some((v) => v.toLowerCase().includes(s));
      if (
        !c.name?.toLowerCase().includes(s) &&
        !c.email?.toLowerCase().includes(s) &&
        !c.phone?.toLowerCase().includes(s) &&
        !c.company.toLowerCase().includes(s) &&
        !inArr(c.emails) &&
        !inArr(c.phones)
      ) return false;
    }
    return true;
  });

  // Counts by unified kind
  const counts: Record<string, number> = { all: contacts?.length ?? 0 };
  for (const c of contacts ?? []) {
    const k = contactKind(c);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  // "All" always; each kind chip only when it has members (keeps the bar clean —
  // no empty "Vendors 0" until the owner actually adds one).
  const tabsWithCounts: TabBarItem[] = [
    { id: "all", label: "All", count: counts.all ?? 0 },
    ...KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => ({
      id: k,
      label: KIND_META[k].label,
      dot: KIND_META[k].dot,
      count: counts[k] ?? 0,
    })),
  ];

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
      toast.error("Select at least one contact");
      return;
    }

    if (channel === "email") {
      const recips = chosen
        .filter((c) => c.email?.trim())
        .map((c) => ({ email: c.email!.trim(), name: c.name ?? undefined, company: c.company || undefined }));
      if (recips.length === 0) {
        toast.error("None of the selected contacts have an email");
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
      toast.error("None of the selected contacts have a phone number");
      return;
    }
    navigator.clipboard?.writeText(phones.join("\n")).then(
      () => toast.success(`${phones.length} number${phones.length > 1 ? "s" : ""} copied — paste into a WhatsApp broadcast list`),
      () => toast.error("Clipboard blocked — couldn't copy the numbers"),
    );
  };

  // KPIs
  const totalEmails = (contacts ?? []).filter((c) => c.email).length;
  const totalPhones = (contacts ?? []).filter((c) => c.phone).length;
  const reachablePct = (contacts?.length ?? 0) > 0
    ? Math.round((totalEmails / (contacts?.length ?? 1)) * 100)
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
            All people across leads & customers · run targeted campaigns
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
          <StatItem value={contacts.length} label="contacts" />
          <StatDivider />
          <StatItem value={totalEmails} label="with email" hint={`${reachablePct}% reachable`} icon="mail" />
          <StatDivider />
          <StatItem value={totalPhones} label="with phone" hint="WhatsApp reachable" icon="whatsapp" />
          <StatDivider />
          <StatItem value={counts.customer ?? 0} label="customers" hint={`${counts.lead ?? 0} prospects too`} />
        </div>
      )}

      {/* Filter + search */}
      {!isLoading && contacts && contacts.length > 0 && (
        <>
          <TabBar value={tab} onChange={setTab} items={tabsWithCounts} className="overflow-y-hidden" />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="text-xs text-ink-3">
              Showing {filtered.length} of {counts.all ?? 0} contacts
              {selected.size > 0 && ` · ${selected.size} selected`}
            </div>
            <div className="w-72">
              <Input
                prefix={<Icon name="search" size={14} />}
                placeholder="Name, email, phone, company…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load contacts"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

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

      {/* Empty */}
      {!isLoading && !error && contacts && contacts.length === 0 && (
        <EmptyState
          icon="users"
          title="No contacts yet"
          body="Contacts also appear automatically as you add leads and customers — or add one directly."
          action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add contact</Button>}
          secondary={<Button icon="upload" onClick={() => setImportOpen(true)}>Import CSV</Button>}
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && contacts && contacts.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="No contacts match"
          body={search ? `No results for "${search}".` : `No contacts in "${tab}".`}
          action={<Button icon="x" onClick={() => { setTab("all"); setSearch(""); }}>Clear filters</Button>}
          compact
        />
      )}

      {/* Mobile card list — phones only */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {filtered.map((c) => (
            <li key={c.id} onClick={() => openContact(c)} className="bg-paper border border-hairline rounded-lg p-3 cursor-pointer hover:border-hairline-strong transition-colors">
              <div className="flex items-start gap-3">
                <Avatar
                  initials={c.name ? initials(c.name) : "?"}
                  color={c.source === "customer" ? "emerald" : "amber"}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink truncate">
                    {c.name ?? <span className="italic text-ink-3">No name</span>}
                  </p>
                  {c.company && <p className="text-xs text-ink-3 truncate mt-0.5">{c.company}</p>}
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block font-mono text-[11px] text-amber-ink truncate mt-1"
                    >
                      {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block font-mono text-[11px] text-amber-ink truncate"
                    >
                      {c.phone}
                    </a>
                  )}
                </div>
                <div className="shrink-0">
                  <Badge
                    kind={KIND_META[contactKind(c)].badge}
                    size="sm"
                    dot
                  >
                    {KIND_BADGE_LABEL[contactKind(c)]}
                  </Badge>
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
      {!isLoading && !error && filtered.length > 0 && (
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
                <th className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Source</th>
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
                        <Avatar
                          initials={c.name ? initials(c.name) : "?"}
                          color={c.source === "customer" ? "emerald" : "amber"}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-ink truncate">
                            {c.name ?? <span className="italic text-ink-3">No name</span>}
                          </div>
                          {c.title && (
                            <div className="text-[11px] text-ink-3 truncate">{c.title}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-sm text-ink-2 truncate" title={c.company}>{c.company}</td>
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
                    <td className="p-3">
                      <Badge
                        kind={KIND_META[contactKind(c)].badge}
                        dot
                      >
                        {KIND_BADGE_LABEL[contactKind(c)]}
                      </Badge>
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

      {/* Floating campaign bar — alternative when GeminiCard not visible */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-ink text-paper rounded-full pl-4 pr-2 py-2 shadow-lg flex items-center gap-3 z-40">
          <span className="text-sm">
            <b>{selected.size}</b> selected
          </span>
          <button
            onClick={() => startCampaign("email")}
            className="text-xs px-3 py-1 rounded-full bg-paper/10 hover:bg-paper/20 transition-colors flex items-center gap-1"
          >
            <Icon name="mail" size={12} /> Email
          </button>
          <button
            onClick={() => startCampaign("whatsapp")}
            className="text-xs px-3 py-1 rounded-full bg-amber text-paper hover:bg-amber/90 transition-colors flex items-center gap-1"
          >
            <Icon name="whatsapp" size={12} /> WhatsApp blast
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs px-2 py-1 rounded-full opacity-70 hover:opacity-100"
            aria-label="Clear selection"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
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
      {hint && <span className="text-[11px] text-ink-3">· {hint}</span>}
    </div>
  );
}

/** Thin vertical rule between stats — hidden once the strip wraps on mobile. */
function StatDivider() {
  return <span aria-hidden className="hidden sm:inline h-6 w-px bg-hairline self-center" />;
}
