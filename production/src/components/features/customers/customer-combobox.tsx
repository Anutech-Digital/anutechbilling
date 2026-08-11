/**
 * CustomerCombobox — a rich, searchable customer picker (Zoho-Books-style).
 *
 * Replaces a plain <select> of names with: a trigger showing the selected
 * customer (avatar + name + email), and a dropdown with a search box, a
 * scrollable list (avatar · name · email/domain), and a "New customer" footer
 * action. Keeps a single-source-of-truth `value` (customer id) — the caller
 * owns state + the add-customer dialog.
 */
"use client";

import * as React from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { useCustomers } from "@/lib/queries/customers";
import { cn } from "@/lib/utils";

interface Props {
  value: string;                       // selected customer id ("" = none)
  onChange: (id: string) => void;
  onCreateNew?: () => void;            // opens the caller's Add-customer dialog
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}

export function CustomerCombobox({
  value, onChange, onCreateNew, disabled, placeholder = "Select or add a customer", id,
}: Props) {
  const { data: customers = [], isLoading } = useCustomers();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");

  const selected = customers.find((c) => c.id === value) ?? null;

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) =>
      c.name.toLowerCase().includes(s) ||
      (c.contact_email?.toLowerCase().includes(s) ?? false) ||
      (c.contact_name?.toLowerCase().includes(s) ?? false) ||
      (c.domain?.toLowerCase().includes(s) ?? false),
    );
  }, [customers, q]);

  // Reset the search each time the panel opens so it always starts clean.
  React.useEffect(() => { if (open) setQ(""); }, [open]);

  const sub = (c: (typeof customers)[number]) =>
    c.contact_email || c.domain || c.state || "—";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-left",
            "focus:outline-none focus:ring-2 focus:ring-amber/40",
            disabled && "opacity-60 cursor-not-allowed",
          )}
        >
          {selected ? (
            <>
              <Avatar initials={selected.name} color="emerald" size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink truncate">{selected.name}</span>
                {(selected.contact_email || selected.domain) && (
                  <span className="block text-[11px] text-ink-3 truncate">{selected.contact_email || selected.domain}</span>
                )}
              </span>
            </>
          ) : (
            <span className="flex-1 text-ink-3">{placeholder}</span>
          )}
          {selected && !disabled && (
            // Clear the selection → lets the caller fall back to a new-prospect
            // entry. A span (not a nested <button>) to keep valid trigger markup.
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selected customer"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onChange(""); } }}
              className="shrink-0 rounded p-0.5 text-ink-3 hover:text-rose hover:bg-paper-2"
            >
              <Icon name="x" size={14} />
            </span>
          )}
          <Icon name="chevron_down" size={16} className="text-ink-3 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        {/* Search */}
        <div className="p-2 border-b border-hairline">
          <div className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5">
            <Icon name="search" size={14} className="text-ink-3 shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search customers…"
              className="w-full bg-transparent text-sm focus:outline-none placeholder:text-ink-4"
            />
          </div>
        </div>

        {/* List */}
        <div className="max-h-64 overflow-y-auto py-1">
          {isLoading ? (
            <p className="px-3 py-4 text-center text-xs text-ink-3">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-ink-3">
              {q ? `No customers match "${q}"` : "No customers yet"}
            </p>
          ) : (
            filtered.map((c) => {
              const active = c.id === value;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { onChange(c.id); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                    active ? "bg-amber-soft/60" : "hover:bg-paper-2/60",
                  )}
                >
                  <Avatar initials={c.name} color={active ? "amber" : "slate"} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink truncate">{c.name}</span>
                    <span className="block text-[11px] text-ink-3 truncate">{sub(c)}</span>
                  </span>
                  {active && <Icon name="check" size={15} className="text-amber shrink-0" />}
                </button>
              );
            })
          )}
        </div>

        {/* New customer */}
        {onCreateNew && (
          <button
            type="button"
            onClick={() => { setOpen(false); onCreateNew(); }}
            className="flex w-full items-center gap-2 border-t border-hairline px-3 py-2.5 text-sm font-medium text-amber-ink hover:bg-paper-2/60"
          >
            <Icon name="plus" size={15} /> New customer
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
