/**
 * Team chat slot — R-2302 (G-TEAMCHAT TC-09) record links with a live preview.
 *
 * Composer:
 *   - Toolbar "Link a record": a search box that reuses Ctrl+K's own server search
 *     (usePaletteSearch + useLeadSearch) for the groups THIS role can open (palette-access).
 *     A pick writes the record's app address into the text (so the message reads on its own
 *     and has something to send) — the chips pick it up from there.
 *   - AboveInput chips: every app record address in the text — pasted from the address bar,
 *     typed, or picked — becomes a {type,id} in draft.links (record-links.ts parser). × takes
 *     a link out without touching the text. ONLY {type,id} is ever sent (chat_links_ok refuses
 *     anything else on the server).
 * Conversation (MessageBelow): one preview card per link, read under the READER's own role and
 * session (fetchRecordPreview): a role that cannot open the page sees "Invoice — you don't have
 * access" and its browser never reads the row; RLS-hidden rows read "not found or no access".
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { usePaletteSearch } from "@/lib/queries/palette-search";
import { useLeadSearch } from "@/lib/queries/leads";
import { contactSearchHidden } from "@/lib/contacts/search-columns";
import { paletteGroupsFor } from "@/components/layout/palette-access";
import {
  RECORD_LABEL,
  chatLinkKey,
  fetchRecordPreview,
  recordHref,
  recordLinksInText,
  sanitizeChatLinks,
  type PreviewDb,
  type RecordLinkType,
} from "@/lib/team-chat/record-links";
import type { ChatLink } from "@/lib/team-chat/types";
import type { ChatExtension, ComposerSlotProps, MessageSlotProps } from "../composer-slots";

const SEARCH_DEBOUNCE_MS = 200;
const MAX_OPTIONS = 12;

const appOrigin = () => (typeof window !== "undefined" ? window.location.origin : null);
const sameLinks = (a: readonly ChatLink[], b: readonly ChatLink[]) =>
  a.length === b.length && a.every((l, i) => chatLinkKey(l) === chatLinkKey(b[i]));

// ── Composer: "Link a record" picker ────────────────────────────────────────────────────

interface PickOption {
  key: string;
  type: RecordLinkType;
  id: string;
  title: string;
  meta: string;
}

function LinkPicker({ setDraft, textareaRef, sending }: ComposerSlotProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [active, setActive] = React.useState(0);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const listId = React.useId();

  const me = useCurrentUser().data ?? null;
  const role = me?.role ?? null;
  const groups = paletteGroupsFor(role);

  React.useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const found = usePaletteSearch(
    term,
    open,
    { companies: groups.companies, quotes: groups.quotes, invoices: groups.invoices, subscriptions: groups.subscriptions, payments: false, contacts: false },
    me?.tenantId ?? null,
    contactSearchHidden(role),
  );
  const leads = useLeadSearch(term, open && groups.leads && term.length > 0);

  const options: PickOption[] = React.useMemo(() => {
    if (!open || !term) return [];
    const out: PickOption[] = [];
    const money = (n: number | null) => (n != null ? rupee(n) : null);
    for (const q of found.quotes) {
      out.push({ key: `quote:${q.id}`, type: "quote", id: q.id, title: `Quote ${q.id}`, meta: [q.customer_name, money(q.amount)].filter(Boolean).join(" · ") });
    }
    for (const i of found.invoices) {
      out.push({ key: `invoice:${i.id}`, type: "invoice", id: i.id, title: `Invoice ${i.id}`, meta: [i.customer_name, money(i.amount)].filter(Boolean).join(" · ") });
    }
    for (const c of found.customers) {
      out.push({ key: `customer:${c.id}`, type: "customer", id: c.id, title: c.display_name || c.name, meta: [RECORD_LABEL.customer, c.city].filter(Boolean).join(" · ") });
    }
    for (const s of found.subscriptions as { id: string; plan?: string | null; customer_name?: string | null; domain?: string | null }[]) {
      out.push({ key: `subscription:${s.id}`, type: "subscription", id: s.id, title: `Subscription · ${s.plan ?? s.domain ?? ""}`.trim(), meta: [s.customer_name, s.domain].filter(Boolean).join(" · ") });
    }
    if (groups.leads) {
      for (const l of leads.data ?? []) {
        const row = l as unknown as { id: string; company?: string | null; contact_name?: string | null };
        out.push({ key: `lead:${row.id}`, type: "lead", id: row.id, title: `Lead · ${row.company || row.contact_name || row.id}`, meta: row.company && row.contact_name ? row.contact_name : "" });
      }
    }
    return out.slice(0, MAX_OPTIONS);
  }, [open, term, found.quotes, found.invoices, found.customers, found.subscriptions, groups.leads, leads.data]);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setTerm("");
    setActive(0);
  }, []);

  /* A click outside closes the search. */
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const pick = (o: PickOption) => {
    const href = recordHref({ type: o.type, id: o.id });
    setDraft((d) => ({ ...d, body: `${d.body}${d.body && !/\s$/.test(d.body) ? " " : ""}${href} ` }));
    close();
    textareaRef.current?.focus();
  };

  const searching = open && (query.trim() !== term || found.fetching || leads.isFetching);
  const index = Math.min(active, Math.max(0, options.length - 1));

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon="link"
        aria-expanded={open}
        disabled={sending}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Link a record
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-hairline bg-paper p-2 shadow-md">
          <input
            autoFocus
            role="combobox"
            aria-label="Search records to link"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            value={query}
            placeholder="Search quotes, invoices, customers…"
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); close(); textareaRef.current?.focus(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (options[index]) pick(options[index]); }
            }}
            className="block w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
          />
          <ul id={listId} role="listbox" aria-label="Records" className="mt-1 max-h-64 overflow-y-auto">
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={i === index}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseEnter={() => setActive(i)}
                className={cn("cursor-pointer rounded px-2 py-1.5 text-sm", i === index ? "bg-paper-2" : "")}
              >
                <span className="block truncate text-ink">{o.title}</span>
                {o.meta && <span className="block truncate text-xs text-ink-3">{o.meta}</span>}
              </li>
            ))}
          </ul>
          <p className="px-2 py-1 text-xs text-ink-3" aria-live="polite">
            {!query.trim() ? "Type a quote no., invoice no. or company" : searching ? "Searching…" : options.length === 0 ? "No records found" : ""}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Composer: chips of the records the text links ───────────────────────────────────────

function LinkChips({ draft, setDraft, sending }: ComposerSlotProps) {
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());

  /* A sent (emptied) box forgets what was taken out. */
  React.useEffect(() => {
    if (draft.body === "") setDismissed((s) => (s.size ? new Set() : s));
  }, [draft.body]);

  /* draft.links = the records the text links, minus the ones taken out. */
  React.useEffect(() => {
    if (sending) return;
    const origin = appOrigin();
    setDraft((d) => {
      const want = recordLinksInText(d.body, origin).filter((l) => !dismissed.has(chatLinkKey(l)));
      return sameLinks(want, d.links) ? d : { ...d, links: want };
    });
  }, [draft.body, dismissed, sending, setDraft]);

  if (draft.links.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Linked records">
      {draft.links.map((l) => {
        const label = `${RECORD_LABEL[l.type as RecordLinkType] ?? "Record"} ${l.id}`;
        return (
          <li key={chatLinkKey(l)} className="inline-flex max-w-full items-center gap-1 rounded-full border border-hairline bg-paper-2 py-0.5 pl-2 pr-1 text-xs text-ink">
            <Icon name="link" size={12} className="text-ink-3" />
            <span className="truncate">{label}</span>
            <button
              type="button"
              aria-label={`Remove link ${label}`}
              disabled={sending}
              onClick={() => setDismissed((s) => new Set(s).add(chatLinkKey(l)))}
              className="rounded-full p-0.5 text-ink-3 hover:bg-paper hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
            >
              <Icon name="x" size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Conversation: live previews ─────────────────────────────────────────────────────────

function PreviewCard({ link, role, ready }: { link: ChatLink & { type: RecordLinkType }; role: string | null; ready: boolean }) {
  const label = RECORD_LABEL[link.type];
  const preview = useQuery({
    queryKey: ["team-chat", "record-preview", role, link.type, link.id],
    enabled: ready,
    staleTime: 30_000,
    queryFn: () => fetchRecordPreview(createClient() as unknown as PreviewDb, link, role),
  });
  const box = "flex max-w-md items-start gap-2 rounded-md border border-hairline bg-paper px-3 py-2 text-sm";
  const p = preview.data;

  if (!p) {
    return (
      <div className={cn(box, "text-ink-3")}>
        <Icon name="link" size={14} className="mt-0.5" />
        <span>{preview.isError ? `${label} — couldn't load` : `${label}…`}</span>
      </div>
    );
  }
  if (p.state !== "ok") {
    return (
      <div className={cn(box, "text-ink-3")}>
        <Icon name={p.state === "no_access" ? "lock" : "link"} size={14} className="mt-0.5" />
        <span>{p.message}</span>
      </div>
    );
  }
  const head = [p.title, p.amountText, p.status].filter(Boolean).join(" · ");
  return (
    <Link href={p.href as Route} className={cn(box, "hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40")}>
      <Icon name="link" size={14} className="mt-0.5 text-ink-3" />
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink">{head}</span>
        {p.subtitle && <span className="block truncate text-xs text-ink-3">{p.subtitle}</span>}
      </span>
    </Link>
  );
}

function RecordPreviews({ message }: MessageSlotProps) {
  const me = useCurrentUser();
  const links = sanitizeChatLinks(message.links);
  if (links.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {links.map((l) => (
        <PreviewCard key={chatLinkKey(l)} link={l} role={me.data?.role ?? null} ready={!me.isLoading} />
      ))}
    </div>
  );
}

export const linksExtension: ChatExtension | null = {
  id: "links",
  Toolbar: LinkPicker,
  AboveInput: LinkChips,
  MessageBelow: RecordPreviews,
};
