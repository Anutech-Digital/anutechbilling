/**
 * CountryCombobox — searchable Country picker for the customer forms (R-2180).
 *
 * The list is the full ISO 3166-1 list (lib/gst/countries.ts, ~249 names), too long for a
 * plain <select>: the user types "Est" and picks Estonia (mouse, or ↑/↓ + Enter). The
 * value is the country's display name — the same string the old <select> saved — and a
 * saved value that is not in the list is shown as it is, never silently swapped for India.
 * The list portals into the dialog it sits in (Add customer from bank reconcile), like
 * CustomerCombobox (R-468), so a click inside it is not lost to the dialog's focus trap.
 */
"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { searchCountries } from "@/lib/gst/countries";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (country: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function CountryCombobox({ value, onChange, id, disabled, className }: Props) {
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
      setQ("");
      setActive(0);
    }
    setOpen(next);
  };

  const matches = React.useMemo(() => searchCountries(q), [q]);

  const pick = (country: string) => {
    onChange(country);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Keep the highlighted option in view while moving with the arrow keys.
  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault(); // never submit the surrounding form from the search box
      const hit = matches[active];
      if (hit) pick(hit);
    }
  };

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
          <span className={cn("min-w-0 flex-1 truncate", !value && "text-ink-3")}>{value || "Select a country"}</span>
          <Icon name="chevron_down" size={16} className="text-ink-3 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[240px] rounded-lg border border-hairline bg-paper p-0 shadow-md outline-none"
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
                aria-label="Search countries"
                aria-controls={listId}
                aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
                placeholder="Type to search, e.g. Est"
                className="w-full bg-transparent text-sm focus:outline-none placeholder:text-ink-4"
              />
            </div>
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label="Countries" className="max-h-64 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-ink-3">No country matches &quot;{q}&quot;</p>
            ) : (
              matches.map((c, i) => {
                const selected = c === value;
                return (
                  <div
                    key={c}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(c)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink",
                      i === active ? "bg-paper-2" : "",
                      selected && "font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{c}</span>
                    {selected && <Icon name="check" size={14} className="text-amber shrink-0" />}
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
