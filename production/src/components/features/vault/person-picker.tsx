/**
 * R-2392 — PersonPicker: pick one of your own people (Private Vault → People) wherever the
 * vault asks for a person — Loans from / to a person, Money I owe / hold, Income "Received
 * from" and Expense "Paid to".
 *
 * Pardeep (3 Nov): "from a person karne par contact list show honi chahiye". Type to search
 * (name, phone or email), pick with the mouse or ↑/↓ + Enter, or "+ New contact" adds the
 * typed name to People and picks it — without leaving the form. With `allowText` (Income /
 * Expense: a shop or an employer is not a person you keep), the typed name can also be used
 * as plain text, no contact made.
 *
 * The value is { contactId, name }: the form saves contact_id AND party = name (the DB
 * trigger keeps party equal to the contact's name; older screens read party).
 * The list portals into the dialog it sits in (like CountryCombobox, R-2180), so a click
 * inside it is not lost to the dialog's focus trap.
 *
 * Only personal_contacts — never the company's customers or contacts.
 */
"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { usePersonalContacts, useSavePersonalContact } from "@/lib/queries/personal-contacts";
import { CONTACT_RELATION_LABEL, findByName, searchContacts } from "@/lib/vault/personal/contacts";
import { cn } from "@/lib/utils";

export interface PersonValue {
  contactId: string | null;
  name: string;
}

type Option =
  | { kind: "contact"; id: string; name: string; hint: string }
  | { kind: "new"; name: string }
  | { kind: "text"; name: string }
  | { kind: "none" };

interface Props {
  value: PersonValue;
  onChange: (v: PersonValue) => void;
  id?: string;
  /** Allow a typed name with no contact (Income / Expense). */
  allowText?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function PersonPicker({ value, onChange, id, allowText = false, placeholder = "Pick a person", disabled, className }: Props) {
  const { data: contacts = [], isLoading } = usePersonalContacts();
  const save = useSavePersonalContact();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const listId = React.useId();

  const onOpenChange = (next: boolean) => {
    if (next) {
      setContainer(triggerRef.current?.closest<HTMLElement>("[role=dialog]") ?? null);
      // An old typed party (no contact yet) starts as the search, so "+ New contact" is one click.
      setQ(value.contactId ? "" : value.name);
      setActive(0);
    }
    setOpen(next);
  };

  const options = React.useMemo<Option[]>(() => {
    const typed = q.trim();
    const out: Option[] = searchContacts(contacts, q).map((c) => ({
      kind: "contact" as const, id: c.id, name: c.name,
      hint: [CONTACT_RELATION_LABEL[c.relation], c.phone].filter(Boolean).join(" · "),
    }));
    if (typed && !findByName(contacts, typed)) {
      out.push({ kind: "new", name: typed.slice(0, 120) });
      if (allowText) out.push({ kind: "text", name: typed.slice(0, 120) });
    }
    if (allowText && (value.name || value.contactId)) out.push({ kind: "none" });
    return out;
  }, [contacts, q, allowText, value.name, value.contactId]);

  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  const pick = async (o: Option) => {
    if (o.kind === "contact") { onChange({ contactId: o.id, name: o.name }); close(); return; }
    if (o.kind === "text") { onChange({ contactId: null, name: o.name }); close(); return; }
    if (o.kind === "none") { onChange({ contactId: null, name: "" }); close(); return; }
    try {
      const row = await save.mutateAsync({ name: o.name, relation: "other", phone: null, email: null, pan: null, note: null });
      onChange({ contactId: row.id, name: row.name });
      close();
    } catch {
      /* the hook already showed why; the list stays open */
    }
  };

  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault(); // never submit the surrounding form from the search box
      const hit = options[active];
      if (hit) void pick(hit);
    }
  };

  const label = (o: Option) =>
    o.kind === "contact" ? o.name
    : o.kind === "new" ? `+ New contact "${o.name}"`
    : o.kind === "text" ? `Use "${o.name}" without adding to People`
    : "No person";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-left text-ink",
            "focus:outline-none focus:ring-2 focus:ring-amber/40",
            disabled && "opacity-60 cursor-not-allowed",
            className,
          )}
        >
          <Icon name="user" size={14} className="text-ink-3 shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", !value.name && "text-ink-3")}>{value.name || placeholder}</span>
          {value.name && !value.contactId && <span className="text-3xs text-ink-3 shrink-0">not in People</span>}
          <Icon name="chevron_down" size={16} className="text-ink-3 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[260px] rounded-lg border border-hairline bg-paper p-0 shadow-md outline-none"
        >
          <div className="p-2 border-b border-hairline">
            <div className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-amber/40">
              <Icon name="search" size={14} className="text-ink-3 shrink-0" />
              <input
                autoFocus
                type="search"
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onSearchKey}
                aria-label="Search your people"
                aria-controls={listId}
                aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
                placeholder="Type a name or phone"
                className="w-full bg-transparent text-sm focus:outline-none placeholder:text-ink-4"
              />
            </div>
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label="Your people" className="max-h-64 overflow-y-auto py-1">
            {isLoading ? (
              <p className="px-3 py-4 text-center text-xs text-ink-3">Loading your people…</p>
            ) : options.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-ink-3">No people yet — type a name to add one.</p>
            ) : (
              options.map((o, i) => {
                const selected = o.kind === "contact" && o.id === value.contactId;
                return (
                  <div
                    key={o.kind === "contact" ? o.id : o.kind}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void pick(o)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                      i === active ? "bg-paper-2" : "",
                      o.kind === "new" ? "text-primary font-medium" : o.kind === "contact" ? "text-ink" : "text-ink-3",
                      selected && "font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{label(o)}</span>
                    {o.kind === "contact" && o.hint && <span className="text-3xs text-ink-3 shrink-0">{o.hint}</span>}
                    {selected && <Icon name="check" size={14} className="text-amber shrink-0" />}
                    {o.kind === "new" && save.isPending && <span className="text-3xs text-ink-3 shrink-0">Adding…</span>}
                  </div>
                );
              })
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
