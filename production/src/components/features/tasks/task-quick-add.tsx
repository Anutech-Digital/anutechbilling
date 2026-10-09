/**
 * R-354 — quick-add bar at the top of /tasks. Type "Call Amit tomorrow 3 PM", press Enter:
 * the task is saved with the title and due time read from the text (quick-add-parse.ts).
 * Below the box it always says what will be saved, and says so plainly when no day or time
 * was found and the default (today 6 PM) is being used.
 *
 * R-471 (via R-486): it also says WHO — a name in the title is looked up among leads and
 * customers (quick-add-link.ts). One match is linked by default (press × to save unlinked);
 * several are offered to pick from; none links nothing.
 */
"use client";

import * as React from "react";
import { useCreateTask } from "@/lib/queries/tasks";
import { useLeadSearch } from "@/lib/queries/leads";
import { useCustomers } from "@/lib/queries/customers";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IST_TZ } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "./quick-add-parse";
import { quickAddNameGuess, quickAddSurnameGuess, quickAddLinkCandidates, type QuickAddLink } from "./quick-add-link";
import { relatedToLinkColumns } from "./task-related-picker";
import { KIND_META } from "./task-row";

export function TaskQuickAdd() {
  const createTask = useCreateTask();
  const [text, setText] = React.useState("");
  const parsed = React.useMemo(() => (text.trim() ? parseQuickAdd(text) : null), [text]);
  const canSave = !!parsed && parsed.title.length > 0 && !createTask.isPending;

  /* Who is it about — searched a moment after typing stops. */
  const name = React.useMemo(() => (parsed ? quickAddNameGuess(parsed.title) : null), [parsed]);
  const surname = React.useMemo(() => (parsed ? quickAddSurnameGuess(parsed.title) : null), [parsed]);
  const [searchName, setSearchName] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setSearchName(name), 300);
    return () => clearTimeout(t);
  }, [name]);
  const { data: leads } = useLeadSearch(searchName ?? "", !!searchName);
  const { data: customers } = useCustomers({ enabled: !!searchName });
  const candidates = React.useMemo(
    () => (searchName ? quickAddLinkCandidates(searchName, leads ?? [], customers ?? [], surname) : []),
    [searchName, leads, customers, surname],
  );
  /* undefined = follow the default (the single match); null = the user said "don't link". */
  const [picked, setPicked] = React.useState<QuickAddLink | null | undefined>(undefined);
  React.useEffect(() => { setPicked(undefined); }, [searchName]);
  const link = picked === undefined ? (candidates.length === 1 ? candidates[0] : null) : picked;

  const save = () => {
    if (!parsed || !canSave) return;
    createTask.mutate(
      {
        title: parsed.title, kind: parsed.kind, due_at: parsed.dueAt.toISOString(),
        ...relatedToLinkColumns(link ? { kind: link.kind, id: link.id } : null),
      },
      { onSuccess: () => { setText(""); setPicked(undefined); } },
    );
  };

  const when = parsed?.dueAt.toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: IST_TZ,
  });
  const guessed = parsed && (!parsed.understood.date || !parsed.understood.time);

  return (
    <div className="mb-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <Input
          aria-label="Quick add a task"
          placeholder="Quick add: Call Amit tomorrow 3 PM"
          value={text}
          onChange={(e) => setText(e.target.value)}
          prefix={<Icon name="plus" size={14} />}
          enterKeyHint="done"
          autoComplete="off"
          maxLength={200}
        />
        <Button type="submit" variant="default" disabled={!canSave} loading={createTask.isPending}>
          Add
        </Button>
      </form>
      {parsed && (
        <p className="mt-1.5 text-xs text-ink-3" aria-live="polite">
          {parsed.title ? (
            <>
              Will save: <span aria-hidden="true">{KIND_META[parsed.kind].icon}</span>{" "}
              <span className="font-medium text-ink-2">{parsed.title}</span> ·{" "}
              <span className={cn("tabular-nums", guessed ? "text-amber-ink" : "text-ink-2")}>{when}</span>
              {guessed && (
                <span className="text-amber-ink">
                  {!parsed.understood.date && !parsed.understood.time
                    ? " — no day or time found, using the default"
                    : !parsed.understood.time
                    ? " — no time found, using 6 PM"
                    : " — no day found"}
                </span>
              )}
              <span className="hidden sm:inline"> · Enter to save</span>
            </>
          ) : (
            <span className="text-amber-ink">Add what the task is, e.g. “Call Amit”.</span>
          )}
        </p>
      )}
      {parsed?.title && (link || candidates.length > 1 || (picked === null && candidates.length > 0)) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3" data-testid="quick-add-link">
          {link ? (
            <>
              <span>Linked to</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-hairline bg-paper-2/60 px-1.5 py-0.5 text-ink-2">
                <span className="text-3xs uppercase tracking-wide text-ink-3">{link.kind}</span>
                {link.label}
                <button type="button" aria-label="Don't link" className="ml-0.5 text-ink-3 hover:text-rose" onClick={() => setPicked(null)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            </>
          ) : (
            <>
              <span>Link to:</span>
              {candidates.map((c) => (
                <button
                  key={`${c.kind}:${c.id}`}
                  type="button"
                  onClick={() => setPicked(c)}
                  className="rounded-md border border-hairline px-1.5 py-0.5 text-ink-2 hover:bg-paper-2"
                >
                  <span className="text-3xs uppercase tracking-wide text-ink-3 mr-1">{c.kind}</span>{c.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
