"use client";
/**
 * R-1740 — "my relationship with this person", one component everywhere.
 *
 *   RelationshipChip    the pill: "Friend · Close" (pink), "Partner · Professional" (blue),
 *                       "Unknown" (grey). Read-only.
 *   RelationshipFields  the two controls: a grouped dropdown + Close / Known / Weak buttons.
 *                       Used inside the contact form and inside the editor below.
 *   RelationshipEditor  the chip as a button; it opens the same two controls in a popover
 *                       and saves to the person's contacts row. Contact page, lead and
 *                       customer all use THIS, so setting a relationship is one way.
 */
import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CLOSENESS, CLOSENESS_LABEL, GROUP_LABEL, RELATIONSHIP_OPTION_GROUPS, TYPE_LABEL,
  asCloseness, asRelationshipType, pickCompanyRelationship, relationshipLabel, relationshipTone,
  type Closeness, type RelationshipTone, type RelationshipType,
} from "@/lib/contacts/relationship";
import { useSetContactRelationship, type Contact } from "@/lib/queries/contacts";

/**
 * The customer header chip: my relationship with the company's best-known person (primary
 * wins a tie), from the rows useCustomerContacts returns. Nobody on the company → nothing.
 */
export function CustomerRelationshipChip({ people, canEdit }: { people: Contact[] | undefined; canEdit: boolean }) {
  const person = pickCompanyRelationship(people ?? []);
  if (!person) return null;
  return (
    <div className="mt-1">
      <RelationshipEditor
        contactId={person.id}
        type={person.relationship_type}
        closeness={person.closeness}
        personName={person.full_name}
        size="sm"
        canEdit={canEdit}
      />
    </div>
  );
}

export const TONE_CLASS: Record<RelationshipTone, string> = {
  pink: "bg-rose-soft text-rose-ink",
  blue: "bg-indigo-soft text-indigo-ink",
  grey: "bg-paper-2 text-ink-3",
};
export const TONE_DOT: Record<RelationshipTone, string> = {
  pink: "bg-rose",
  blue: "bg-indigo",
  grey: "bg-ink-3",
};

export function RelationshipChip({
  type, closeness, size = "md", className, title,
}: {
  type: string | null | undefined;
  closeness?: string | null;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  const tone = relationshipTone(type);
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-0.5 text-3xs" : "px-2 py-0.5 text-xs",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("inline-block rounded-full", size === "sm" ? "w-1 h-1" : "w-1.5 h-1.5", TONE_DOT[tone])} />
      {relationshipLabel(type, closeness)}
    </span>
  );
}

export function RelationshipFields({
  type, closeness, onChange, idPrefix = "rel",
}: {
  type: RelationshipType;
  closeness: Closeness | null;
  onChange: (next: { type: RelationshipType; closeness: Closeness | null }) => void;
  idPrefix?: string;
}) {
  const unknown = type === "unknown";
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-type`} className="text-xs font-medium text-ink-2">Relationship</label>
        <select
          id={`${idPrefix}-type`}
          value={type}
          onChange={(e) => {
            const next = asRelationshipType(e.target.value);
            // Unknown has no closeness — clear it so the two never disagree.
            onChange({ type: next, closeness: next === "unknown" ? null : closeness });
          }}
          className="h-9 w-full rounded-md border border-hairline bg-paper px-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
        >
          {RELATIONSHIP_OPTION_GROUPS.map((g) =>
            g.group === "unknown"
              ? <option key="unknown" value="unknown">{TYPE_LABEL.unknown}</option>
              : (
                <optgroup key={g.group} label={GROUP_LABEL[g.group]}>
                  {g.types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </optgroup>
              ))}
        </select>
      </div>
      <div className="space-y-1">
        <span id={`${idPrefix}-closeness-label`} className="text-xs font-medium text-ink-2">How close</span>
        <div role="group" aria-labelledby={`${idPrefix}-closeness-label`} className="flex gap-1.5">
          {CLOSENESS.map((c) => {
            const on = closeness === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                disabled={unknown}
                onClick={() => onChange({ type, closeness: on ? null : c })}
                className={cn(
                  "h-8 flex-1 rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                  on ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:bg-paper-2",
                  unknown && "opacity-50 cursor-not-allowed hover:bg-paper",
                )}
              >
                {CLOSENESS_LABEL[c]}
              </button>
            );
          })}
        </div>
        <p className="text-2xs text-ink-3">
          {unknown ? "Pick a relationship first." : "Optional. Tap again to clear."}
        </p>
      </div>
    </div>
  );
}

/**
 * The chip, clickable: opens the two controls and saves to `contactId`. With no contactId
 * (nobody to save to) it is just the chip.
 */
export function RelationshipEditor({
  contactId, type, closeness, personName, size = "md", canEdit = true,
}: {
  contactId: string | null | undefined;
  type: string | null | undefined;
  closeness?: string | null;
  /** Whose relationship this is — said in the tooltip when the chip sits on a company. */
  personName?: string | null;
  size?: "sm" | "md";
  canEdit?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState({ type: asRelationshipType(type), closeness: asCloseness(closeness) });
  const save = useSetContactRelationship();
  React.useEffect(() => {
    if (open) setDraft({ type: asRelationshipType(type), closeness: asCloseness(closeness) });
  }, [open, type, closeness]);

  const label = relationshipLabel(type, closeness);
  const who = personName ? `Your relationship with ${personName}` : "Your relationship";
  if (!contactId || !canEdit) return <RelationshipChip type={type} closeness={closeness} size={size} title={who} />;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${who}: ${label}. Change`}
          title={`${who} — click to change`}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          <RelationshipChip type={type} closeness={closeness} size={size} className="cursor-pointer hover:ring-1 hover:ring-hairline-strong" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        <p className="text-xs font-semibold text-ink">{who}</p>
        <RelationshipFields
          idPrefix={`rel-${contactId}`}
          type={draft.type}
          closeness={draft.closeness}
          onChange={(n) => setDraft({ type: n.type, closeness: n.closeness })}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: contactId, relationship_type: draft.type, closeness: draft.closeness });
                setOpen(false);
              } catch { /* the hook shows the error */ }
            }}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
