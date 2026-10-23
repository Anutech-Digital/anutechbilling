/**
 * CommandPalette — global ⌘K / Ctrl+K search.
 *
 * Includes:
 * - Navigate to any page
 * - Search customers / leads / quotes / invoices / subscriptions / contacts / payments
 * - Run quick actions (new lead, new quote, etc.)
 *
 * ⚠️ The line above used to read "(stub data — to be wired to Supabase)" and was FALSE —
 * corrected 25 Aug 2026. The seven `use*` query hooks imported below have been real Supabase
 * reads for some time. It is left visible rather than quietly deleted because a stale comment
 * costs more than a wrong one: anybody opening this file to add search believed the feature
 * was a mock and would have built it a second time.
 *
 * @example consumer-side
 * const { open, isOpen, setOpen } = useCommandPalette();
 * <button onClick={open}>⌘K</button>
 * <CommandPalette open={isOpen} onOpenChange={setOpen} />
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Command } from "cmdk";

import { Dialog, DialogContent, DialogPortal, DialogOverlay } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { APP_NAV, filterNavForRole, flattenNav, type UserRole } from "@/lib/nav";
import { buildSidebarApps, appLabelForHref } from "@/lib/nav-apps";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee, cn } from "@/lib/utils";
// Real-data search. R-1121: nothing is read until something is typed; then every group asks
// the server for a few matching rows (palette-search.ts). Leads have their own server search.
import { useLeadSearch } from "@/lib/queries/leads";
import { usePaletteSearch } from "@/lib/queries/palette-search";
import { formatDate } from "@/lib/utils";
import {
  customerKeywords, companyPaletteMeta, leadKeywords, quoteKeywords,
  invoiceKeywords, subscriptionKeywords, contactKeywords, matchesAllTerms,
} from "@/lib/search/keywords";
import AddSeatsDialog from "@/components/features/subscriptions/add-seats-dialog";
import type { Subscription } from "@/lib/supabase/database.types";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import {
  subscriptionHref, subscriptionStatusLabel, paymentHref, SUBSCRIPTION_SEARCH_EVENT, searchFromSubscriptionHref,
} from "@/app/(app)/subscriptions/palette-links";
import { paymentMethodLabel } from "@/app/(app)/payments/method-label";
import { COPY } from "@/lib/copy";
import { paletteGroupsFor, paletteMayOpen } from "./palette-access";

// ============================================================
// Hook to manage open state + register ⌘K shortcut
// ============================================================
export function useCommandPalette() {
  const [isOpen, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { isOpen, setOpen, open: () => setOpen(true), close: () => setOpen(false) };
}

/**
 * How many rows per group to render when NOTHING has been typed — a browsable
 * preview, not a search result.
 *
 * This used to be applied unconditionally: `customers.slice(0, MAX_PER_GROUP)`.
 * The order was backwards. Slicing happened BEFORE cmdk filtered, so only the
 * first ten rows of each group were ever rendered and therefore only those ten
 * could ever be matched. With 340 records across the groups, roughly 70 were
 * searchable and 270 were invisible — searching "democo" returned a different
 * customer entirely, because Demo Co was the 30-somethingth row and
 * never made it into the DOM.
 *
 * The old comment claimed "cmdk's filter then narrows further as they type",
 * which is exactly what could not happen: a filter cannot widen a set that was
 * already truncated.
 *
 * So the cap now applies ONLY to the empty-query view. The moment the operator
 * types, every row is rendered and cmdk filters the whole set. Rendering a few
 * hundred rows is what cmdk is built for, and measured scoring cost across the
 * entire working set is ~2.5ms per keystroke.
 *
 * R-1121 (23 Oct 2026): only Leads still have an empty-query preview. Every other group
 * is searched on the server once something is typed (palette-search.ts) — the
 * server does the matching, so no truncated set can hide a row.
 */
const PREVIEW_PER_GROUP = 10;

// ============================================================
// CommandPalette
// ============================================================
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const { data: me }        = useCurrentUser();

  // Page list must respect the SAME role gating as the sidebar — otherwise a
  // sales user could ⌘K into owner/accounting destinations that just bounce off
  // middleware. Also de-dupe by href: the accountant "Filing" section reuses the
  // Accounting hrefs, so a shared route (P&L, GST, aging…) would otherwise list
  // twice. First section to claim an href wins.
  const pageItems = React.useMemo(() => {
    const nav = filterNavForRole(APP_NAV, me?.role as UserRole | undefined, { canViewDeals: me?.canViewDeals });
    /* R-088 follow-up: label each page with its sidebar app ("Billing", "Accounts"), not
       the old section name ("Bill", "Books") the sidebar no longer shows. */
    const apps = buildSidebarApps(me?.role as UserRole | undefined);
    const seen = new Set<string>();
    /* flattenNav: accordion children and directory rows (S30) are pages too — P&L now
       lives in the Reports directory, and must still come up when you type "P&L". */
    return flattenNav(nav)
      /* R-1543: and the URL rule itself (fails closed while the role loads) — a menu row the
         guard would bounce is not offered. */
      .filter(({ item }) => item.external || paletteMayOpen(me?.role, item.href))
      .filter(({ item }) => !seen.has(item.href) && seen.add(item.href))
      .map(({ item, section }) => ({ ...item, section: appLabelForHref(apps, item.href) ?? section.section }));
  }, [me?.role, me?.canViewDeals]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href as Route);
  };

  // Controlled so the Add-seats group can stay hidden until the operator has
  // typed something (see that group for why), and so the query does not persist
  // into the next open — reopening onto a stale search reads as a stuck palette.
  const [query, setQuery] = React.useState("");
  React.useEffect(() => { if (!open) setQuery(""); }, [open]);

  /* Leads are searched ON THE SERVER (S40), not loaded whole: this palette is mounted on
     every page, and it used to pull every lead with select("*") — at 20,000 leads, on every
     page view, to show ten of them. Now it asks only while open: the newest few, or the
     matches for what is typed (list_leads' search — company, contact, email, phone, plan).
     A beat after the last keystroke, so typing a name is one query, not one per letter. */
  const [leadQuery, setLeadQuery] = React.useState("");
  React.useEffect(() => {
    /* A phone typed with spaces ("94949 47304") is sent as its digits — the server
       matches the stored number as one string. */
    const q = /^[\d\s+\-()]+$/.test(query.trim()) ? query.replace(/\D/g, "") : query;
    const t = setTimeout(() => setLeadQuery(q), 200);
    return () => clearTimeout(t);
  }, [query]);
  const { data: leads, isFetching: leadsFetching } = useLeadSearch(leadQuery, open);

  /* R-1121: the other groups — the same beat after the last keystroke, then a few rows each
     from the server (palette-search.ts). Nothing is read while nothing is typed. */
  const [searchTerm, setSearchTerm] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSearchTerm(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  /* R-1543: a result is offered only when this role may open the page it leads to — the same
     rule as the URL guard (palette-access.ts). Sales picking a company bounced to /leads;
     billing picking a lead landed on /invoices. A group whose page is closed is not searched. */
  const role = me?.role;
  const allowed = paletteGroupsFor(role);
  const contactsOn = paletteMayOpen(role, "/contacts") || allowed.companies;
  const found = usePaletteSearch(
    searchTerm,
    open,
    {
      companies: allowed.companies, quotes: allowed.quotes, invoices: allowed.invoices,
      subscriptions: allowed.subscriptions || allowed.seats, payments: allowed.payments, contacts: contactsOn,
    },
    me?.tenantId,
  );
  const { customers, quotes, invoices, subscriptions, payments } = found;

  // customer_id → name, so a payment (which stores no customer_name) can say whose it is.
  const customerNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    customers.forEach((c) => m.set(c.id, c.name));
    return m;
  }, [customers]);

  // Seats can only be added to something currently running. A paused or expired
  // subscription needs reviving first, and offering the action on one would send
  // the operator into a dialog that cannot succeed.
  const activeSubs = React.useMemo(
    () => subscriptions.filter((s) => s.status === "active"),
    [subscriptions],
  );

  // Show a short preview per group when nothing is typed; render EVERYTHING once
  // the operator types, so cmdk can filter the whole set rather than a truncated
  // slice of it. See PREVIEW_PER_GROUP for why this is conditional.
  const searching = query.trim().length > 0;
  /* R-1121: typed, but the answer for exactly this text is not in yet → "Searching…", never
     "No results found" (it used to say that while six tables were still loading). */
  const loading = searching && (searchTerm !== query.trim() || found.fetching || leadsFetching);
  /* The palette filters itself (2 Oct 2026): every typed word must be in the row.
     cmdk's fuzzy scoring matched letters scattered across a line ("Thetaco" found
     "Test User 3 Etaco…") and hid leads that arrived from the server after the
     keystroke — Pardeep: "search button kaam hi nahi kar raha". */
  const pick = <T,>(rows: T[] | undefined | null, fields: (r: T) => (string | number | null | undefined)[]): T[] =>
    !rows ? [] : searching ? rows.filter((r) => matchesAllTerms(fields(r), query)) : rows.slice(0, PREVIEW_PER_GROUP);

  /* A contact opens the company it belongs to, else the contact book. Shown only when this
     role may open that page. */
  const contactHref = (c: { customer_id: string | null }) =>
    c.customer_id ? `/customers/${c.customer_id}` : "/contacts";
  const openContacts = found.contacts
    .filter((c) => paletteMayOpen(role, contactHref(c)))
    .map((c) => ({ ...c, name: c.full_name, designation: c.title }));

  /* R-1121: the server already matched every typed word (palette-search.ts) — its rows are
     shown as they come, only while searching (an empty palette reads nothing). */
  const shown = <T,>(on: boolean, rows: T[]): T[] => (on && searching ? rows : []);
  const fCustomers = shown(allowed.companies, customers);
  const fLeads = allowed.leads ? pick(leads, (l) => [l.company, l.stage, ...leadKeywords({ ...l, email: l.contact_email, phone: l.contact_phone })]) : [];
  const fContacts = shown(true, openContacts);
  const fQuotes = shown(allowed.quotes, quotes);
  const fInvoices = shown(allowed.invoices, invoices);
  const fSubs = shown(allowed.subscriptions, subscriptions);
  const fSeats = allowed.seats && query.trim().length >= 2 ? activeSubs : [];
  const fPayments = shown(allowed.payments, payments);
  const fPages = searching ? pageItems.filter((i) => matchesAllTerms([i.label, i.section], query)) : pageItems;
  const count = (rows: unknown[]) => rows.length;

  // Pages — role-filtered + href-deduped (see pageItems). Placed first while searching.
  const pagesGroup = fPages.length > 0 && (
    <Command.Group heading="Pages">
      {fPages.map((item) => (
        <PaletteItem
          key={item.id}
          icon={item.icon}
          label={item.label}
          meta={item.section}
          onSelect={() => go(item.href)}
        />
      ))}
    </Command.Group>
  );

  const quickActions = [
    { icon: "sparkles", label: "AI Entry",              meta: "Paste or photograph anything — it fills the entry", href: "/ai-entry" },
    { icon: "plus",    label: "Create new lead",        meta: "Open the quick-add form",                     href: "/leads?action=quick-add" },
    { icon: "file",    label: COPY.newQuote,             meta: "Open Quote Builder",                          href: "/quotes/new" },
    { icon: "receipt", label: "Create invoice",         meta: "Direct GST tax invoice",                      href: "/quotes/new?invoice=1" },
    /* R-243: the invoices still owed (pending, partial, overdue), not the whole list. */
    { icon: "rupee",   label: "Record a payment",       meta: "Invoices still owed — pick one to record what you received", href: "/invoices?focus=unpaid" },
    { icon: "users",   label: "Add new company",        meta: "Open new company (customer) form",           href: "/customers/new" },
    { icon: "send",    label: "Launch new campaign",    meta: "Email or WhatsApp blast",                     href: "/campaigns" },
    { icon: "mail",    label: "Send renewal reminders", meta: "Go to Renewals",                              href: "/renewals" },
  ];
  /* R-1543: an action whose page this role cannot open is not offered (sales has no
     /customers/new, billing no /quotes/new). */
  const roleActions = quickActions.filter((a) => paletteMayOpen(role, a.href));
  const fActions = searching ? roleActions.filter((a) => matchesAllTerms([a.label, a.meta], query)) : roleActions;

  // Which subscription the seats dialog is open for, if any.
  const [addSeatsSub, setAddSeatsSub] = React.useState<Subscription | null>(null);


  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          className={cn(
            "p-0 max-w-2xl top-[12vh] translate-y-0",
            "overflow-hidden"
          )}
          hideClose
        >
          <Command
            label="Command palette"
            shouldFilter={false}
            className="bg-transparent"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline">
              <Icon name="search" size={18} className="text-ink-3" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search customers, leads, quotes, invoices, or run an action…"
                className="flex-1 bg-transparent border-0 outline-none text-base text-ink placeholder:text-ink-4 font-sans"
              />
              <kbd className="text-3xs px-1.5 py-0.5 rounded bg-paper-2 border border-hairline text-ink-3 font-mono">
                ESC
              </kbd>
            </div>

            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              {/* R-1121: while the server is answering, say so — "No results found" only once
                  the answer for exactly what is typed is in. */}
              {loading ? (
                <Command.Loading>
                  <div role="status" className="py-3 px-3 flex items-center gap-2 text-sm text-ink-3">
                    <Icon name="search" size={14} className="animate-pulse" /> Searching…
                  </div>
                </Command.Loading>
              ) : (
                <Command.Empty className="py-8 text-center text-sm text-ink-3">
                  No results found.
                </Command.Empty>
              )}

              {/* Typing a page's name ("Invoices") should open that page on Enter — with
                  the actions first, Enter ran "Create invoice" instead (R-088 jaanch,
                  1 Oct). So while searching, Pages come first; on an empty palette the
                  actions still lead. */}
              {searching && pagesGroup}

              {/* Quick actions */}
              {fActions.length > 0 && (
              <Command.Group heading="Quick Actions" className="cmdk-group">
                {fActions.map((a) => (
                  <PaletteItem key={a.label} icon={a.icon} label={a.label} meta={a.meta} onSelect={() => go(a.href)} />
                ))}
              </Command.Group>
              )}

              {!searching && pagesGroup}

              {/* Customers — real, tenant-scoped */}
              {fCustomers.length > 0 && (
                <Command.Group heading={`Companies · ${count(fCustomers)}`}>
                  {fCustomers.map((c) => {
                    // R-821: readable subtitle, never the row id.
                    const meta = companyPaletteMeta(c);
                    return (
                      <PaletteItem
                        key={c.id}
                        icon="users"
                        label={c.name}
                        meta={meta || undefined}
                        keywords={customerKeywords(c)}
                        onSelect={() => go(`/customers/${c.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Leads — real, tenant-scoped. Deep-links to /leads?lead=<id>
                  which pops the detail drawer (existing pattern). */}
              {fLeads.length > 0 && (
                <Command.Group heading={`Leads · ${fLeads.length}`}>
                  {fLeads.map((l) => {
                    const stage = l.stage ? `${l.stage}` : "";
                    const value = l.value ? rupee(l.value, { compact: true }) : "";
                    const plan = l.plan ?? "No plan";
                    const meta = [plan, value, stage].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={l.id}
                        icon="target"
                        label={l.company}
                        meta={meta}
                        /* email / phone mapped by name: LeadLike calls them email / phone, the
                           row contact_email / contact_phone — passed as-is they were silently
                           dropped, and cmdk then hid a lead the server found BY its phone. */
                        keywords={leadKeywords({ ...l, email: l.contact_email, phone: l.contact_phone })}
                        onSelect={() => go(`/leads?lead=${l.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Contacts — unified across leads/customers/imported */}
              {fContacts.length > 0 && (
                <Command.Group heading={`Contacts · ${count(fContacts)}`}>
                  {fContacts.map((c) => (
                    <PaletteItem
                      key={c.id}
                      icon="user"
                      label={c.name || c.email || c.phone || "(unnamed)"}
                      meta={[c.company, c.email, c.phone].filter(Boolean).join(" · ")}
                      keywords={contactKeywords(c)}
                      onSelect={() => go(contactHref(c))}
                    />
                  ))}
                </Command.Group>
              )}

              {/* Quotes — real tenant-scoped quotes with status + ₹ */}
              {fQuotes.length > 0 && (
                <Command.Group heading={`Quotes · ${count(fQuotes)}`}>
                  {fQuotes.map((q) => {
                    const total = q.amount != null ? rupee(q.amount, { compact: true }) : "";
                    const meta = [q.customer_name, total, q.status].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={q.id}
                        icon="file"
                        label={q.id}
                        meta={meta}
                        keywords={quoteKeywords(q)}
                        onSelect={() => go(`/quotes/${q.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Invoices — real, tenant-scoped. Opens the invoice's own page
                  (invoiceHref → /invoices/<id>, R-218). */}
              {fInvoices.length > 0 && (
                <Command.Group heading={`Invoices · ${count(fInvoices)}`}>
                  {fInvoices.map((inv) => {
                    const total = inv.amount != null ? rupee(inv.amount, { compact: true }) : "";
                    const meta = [inv.customer_name, total, inv.status].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={inv.id}
                        icon="receipt"
                        label={inv.id}
                        meta={meta}
                        keywords={invoiceKeywords(inv)}
                        onSelect={() => go(invoiceHref(inv.id))}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Add seats — the on-call emergency path.
                  A customer rings asking for five more seats. This turns that into
                  Ctrl+K → type their name → Enter, with no page load in between,
                  and the pro-rata figure computed by add-seats-dialog.

                  SHOWN ONLY ONCE SOMETHING IS TYPED. One item per active
                  subscription would otherwise add ~38 rows to a palette that opens
                  cold, pushing navigation and quick actions off the first screen to
                  offer an action most opens don't want. Two characters is enough to
                  mean "I am looking for a particular customer". */}
              {fSeats.length > 0 && (
                <Command.Group heading="Add seats">
                  {fSeats.map((s) => (
                    <PaletteItem
                      key={`seats-${s.id}`}
                      icon="plus"
                      label={`Add seats — ${s.customer_name}`}
                      meta={[s.plan, s.seats ? `${s.seats} seats now` : null, s.renewal_date ? `renews ${formatDate(s.renewal_date)}` : null]
                        .filter(Boolean).join(" · ")}
                      onSelect={() => {
                        // Close the palette FIRST, then open the dialog on the next
                        // tick. Two Radix dialogs mounted at once fight over the
                        // focus trap and the seats input never receives focus.
                        onOpenChange(false);
                        setTimeout(() => setAddSeatsSub(s), 0);
                      }}
                    />
                  ))}
                </Command.Group>
              )}

              {/* Subscriptions — real, tenant-scoped */}
              {fSubs.length > 0 && (
                <Command.Group heading={`Subscriptions · ${count(fSubs)}`}>
                  {fSubs.map((s) => {
                    const mrr = s.mrr ? `${rupee(s.mrr, { compact: true })}/mo` : "";
                    const meta = [s.plan, mrr, subscriptionStatusLabel(s.status)].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={s.id}
                        icon="refresh"
                        label={s.customer_name}
                        meta={meta}
                        keywords={subscriptionKeywords(s)}
                        onSelect={() => {
                          const href = subscriptionHref(s);
                          go(href);
                          /* Already on /subscriptions: the page stays mounted, so tell it. */
                          window.dispatchEvent(new CustomEvent(SUBSCRIPTION_SEARCH_EVENT, { detail: searchFromSubscriptionHref(href) }));
                        }}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Payments — no customer_name column, so we resolve it from the
                  customers cache to make receipts name-searchable. */}
              {fPayments.length > 0 && (
                <Command.Group heading={`Payments · ${count(fPayments)}`}>
                  {fPayments.map((p) => {
                    const who = (p.customer_id && customerNameById.get(p.customer_id)) || "Payment";
                    const amount = rupee(p.amount, { compact: true });
                    const meta = [amount, p.method ? paymentMethodLabel(p.method) : null, formatDate(p.received_at), p.reference].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={p.id}
                        icon="rupee"
                        label={who}
                        meta={meta}
                        onSelect={() => go(paymentHref(p))}
                      />
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>

            {/* Footer hint */}
            <div className="flex items-center gap-3 px-3 py-2 border-t border-hairline bg-paper-2 text-2xs text-ink-3">
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">↵</kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">ESC</kbd>
                close
              </span>
            </div>
          </Command>
        </DialogContent>
      </DialogPortal>
    </Dialog>

    {/* Rendered as a SIBLING of the palette, not inside it. Nesting it under the
        palette's DialogContent would unmount the seats dialog the moment the
        palette closes — which is exactly when it needs to appear. */}
    {addSeatsSub && (
      <AddSeatsDialog
        sub={addSeatsSub}
        open={!!addSeatsSub}
        onOpenChange={(v) => { if (!v) setAddSeatsSub(null); }}
      />
    )}
    </>
  );
}

// ============================================================
// PaletteItem — styled cmdk Item
// ============================================================
function PaletteItem({
  icon,
  label,
  meta,
  keywords,
  onSelect,
}: {
  icon: string;
  label: string;
  meta?: string;
  /**
   * Extra terms to match on that are NOT displayed — phone digits, GSTIN, the
   * contact's name. Without these the palette could only find a row by what the
   * row happened to show, so a lead was unfindable by the person's name or
   * number: the two things you actually have when the phone rings.
   *
   * Kept out of `meta` on purpose. Padding the visible line makes rows
   * unreadable AND flattens cmdk's ranking, so the right answer stops coming
   * first.
   */
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      keywords={keywords}
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer",
        "data-[selected=true]:bg-paper-2",
        "text-ink hover:bg-paper-2"
      )}
    >
      <Icon name={icon} size={15} className="text-ink-3 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{label}</div>
        {meta && <div className="text-2xs text-ink-3 truncate">{meta}</div>}
      </div>
    </Command.Item>
  );
}
