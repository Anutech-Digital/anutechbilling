/**
 * TaskRelatedPicker — attach a task to a customer / lead / deal.
 *
 * One searchable box across all three (each tagged). Stores the chosen entity as
 * { kind, id }; the parent maps that to the right column (customer_id / lead_id /
 * quote_id). A pre-existing subscription link is shown but not user-pickable.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useCustomers } from "@/lib/queries/customers";
import { useLeadLabel, useLeadSearch } from "@/lib/queries/leads";
import { useQuotes } from "@/lib/queries/quotes";

export type RelatedKind = "customer" | "lead" | "deal" | "subscription";
export interface RelatedValue { kind: RelatedKind; id: string }

interface Opt { kind: RelatedKind; id: string; label: string }

const TAG: Record<RelatedKind, { label: string; cls: string }> = {
  customer:     { label: "Customer",     cls: "bg-indigo-soft/60 text-indigo" },
  lead:         { label: "Lead",         cls: "bg-amber-soft text-amber-ink" },
  deal:         { label: "Deal",         cls: "bg-emerald/10 text-emerald" },
  subscription: { label: "Subscription", cls: "bg-paper-2 text-ink-3" },
};

export function TaskRelatedPicker({
  value, onChange, id = "related",
}: {
  value: RelatedValue | null;
  onChange: (v: RelatedValue | null) => void;
  /** Ties the caller's <FormField htmlFor> to the search box (add-task-dialog uses "related"). */
  id?: string;
}) {
  const { data: customers } = useCustomers();
  const { data: quotes } = useQuotes();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  /* Leads are searched on the server as you type (S40) — this picker sits in every "Add
     task" dialog, including the leads page's row Follow-up, and it used to load every lead
     with select("*") to offer eight. The chosen lead's name is read by its id. */
  const [leadQuery, setLeadQuery] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setLeadQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const { data: leads } = useLeadSearch(leadQuery, open);
  const { data: chosenLead } = useLeadLabel(value?.kind === "lead" ? value.id : null);

  const options = React.useMemo<Opt[]>(() => {
    const out: Opt[] = [];
    (customers ?? []).forEach((c) => out.push({ kind: "customer", id: c.id, label: c.name }));
    (leads ?? []).forEach((l) => out.push({ kind: "lead", id: l.id, label: l.company || l.contact_name || "Lead" }));
    (quotes ?? []).forEach((q) => out.push({ kind: "deal", id: q.id, label: `${q.customer_name || "Deal"} · ${q.id}` }));
    return out;
  }, [customers, leads, quotes]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return base.slice(0, 8);
  }, [options, query]);

  // Selected chip (resolve the label from the loaded lists; fall back to a generic tag).
  if (value) {
    const sel = options.find((o) => o.kind === value.kind && o.id === value.id)
      ?? (value.kind === "lead" && chosenLead
        ? { kind: "lead" as const, id: chosenLead.id, label: chosenLead.company || chosenLead.contact_name || "Lead" }
        : undefined);
    return (
      <div className="flex items-center gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
        <span className={`text-3xs px-1.5 py-0.5 rounded ${TAG[value.kind].cls}`}>{TAG[value.kind].label}</span>
        <span className="text-sm text-ink truncate flex-1">{sel?.label ?? TAG[value.kind].label}</span>
        <button
          type="button"
          aria-label="Remove link"
          onClick={() => onChange(null)}
          className="text-ink-3 hover:text-rose transition-colors"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        id={id}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search a customer, lead or deal…"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
          {filtered.map((o) => (
            <button
              key={`${o.kind}:${o.id}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}  /* keep focus so onClick fires before blur */
              onClick={() => { onChange({ kind: o.kind, id: o.id }); setQuery(""); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-2/60"
            >
              <span className={`text-3xs px-1.5 py-0.5 rounded shrink-0 ${TAG[o.kind].cls}`}>{TAG[o.kind].label}</span>
              <span className="text-sm text-ink truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Map a picked entity to the task's link columns (only one is set). */
export function relatedToLinkColumns(r: RelatedValue | null) {
  return {
    lead_id:         r?.kind === "lead"         ? r.id : null,
    quote_id:        r?.kind === "deal"         ? r.id : null,
    customer_id:     r?.kind === "customer"     ? r.id : null,
    subscription_id: r?.kind === "subscription" ? r.id : null,
  };
}
