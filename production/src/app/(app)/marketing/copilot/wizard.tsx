/**
 * R-1879 — the co-pilot wizard, steps 1–2 (steps 3–4 are R-1880, 5 is the publisher).
 *   Step 1: plan name, brand (the company name), product, objective (goal → objective).
 *   Step 2: platforms (with WHY a platform is not offered), audience: ages, gender, regions,
 *           lookalike (only where the platform has one).
 * Every change is saved by itself a moment later, so a refresh never loses work; the buttons
 * save at once too. The rules live in lib/marketing/copilot/plan-draft.ts.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CHANNEL_SPECS, PLATFORMS, type AdPlatform, type CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import {
  AGE_CEIL, AGE_FLOOR, INDIA_REGIONS, OBJECTIVE_GROUPS, OBJECTIVE_INFO, groupOf, lookalikeInfo,
  normalizePlan, platformInfo, type Gender, type PlanDraft,
} from "@/lib/marketing/copilot/plan-draft";
import { useSavePlan, type SavedPlan } from "./use-copilot";

const NO_PRODUCT = "__none__";
const AUTOSAVE_MS = 1200;

export const STEPS = [
  { n: 1, label: "Product & goal" },
  { n: 2, label: "Platforms & audience" },
  { n: 3, label: "Ad copy" },
  { n: 4, label: "Budget & review" },
] as const;
const BUILT_STEPS = 2;

const toDraft = (p: SavedPlan): PlanDraft => ({
  name: p.name, itemId: p.itemId, objective: p.objective, platforms: p.platforms,
  prompt: p.prompt, language: p.language, audience: p.audience,
});

export function Wizard({ plan, items, brand, step, onStep, onClose }: {
  plan: SavedPlan;
  items: { id: string; name: string }[];
  brand: string;
  step: number;
  onStep: (n: number) => void;
  onClose: () => void;
}) {
  const save = useSavePlan(plan.id);
  const [draft, setDraft] = React.useState<PlanDraft>(() => toDraft(plan));
  const [dirty, setDirty] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<string | null>(plan.updatedAt);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const locked = plan.status !== "draft" && plan.status !== "ready";

  const check = normalizePlan(draft);
  const problem = !draft.name.trim() ? "Give the plan a name." : check.error ?? null;

  /* Counts edits, so an edit made WHILE a save is in flight stays "unsaved" after it lands. */
  const edits = React.useRef(0);
  const change = (next: Partial<PlanDraft>) => {
    edits.current += 1;
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
    setDone(false);
  };
  const audience = (next: Partial<PlanDraft["audience"]>) => change({ audience: { ...draft.audience, ...next } });

  const saveNow = React.useCallback(async (): Promise<boolean> => {
    if (locked) return false;
    const c = normalizePlan(draft);
    if (!draft.name.trim() || c.error) { setError(!draft.name.trim() ? "Give the plan a name." : c.error!); return false; }
    const at = edits.current;
    try {
      const r = await save.mutateAsync(c.plan);
      if (edits.current === at) setDirty(false);
      setError(null);
      setSavedAt(r.plan.updatedAt);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      return false;
    }
  }, [draft, locked, save]);

  /* Autosave: a moment after the last change, when the plan is valid. */
  React.useEffect(() => {
    if (!dirty || problem || locked || save.isPending) return;
    const t = setTimeout(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, problem, locked, save.isPending, saveNow]);

  const status = save.isPending ? "Saving…"
    : dirty ? (problem ? `Not saved — ${problem.replace(/\.$/, "").toLowerCase()}` : "Unsaved changes…")
    : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "";

  return (
    <Card className="p-4 md:p-6 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Campaign plan</p>
          <h2 className="font-serif text-2xl leading-tight break-words">{draft.name || "Untitled plan"}</h2>
          {plan.prompt && <p className="text-sm text-ink-3 mt-1 break-words">“{plan.prompt}”</p>}
        </div>
        <div className="flex items-center gap-3">
          <span className={cn("text-xs", dirty && problem ? "text-rose-ink" : "text-ink-3")} role="status" aria-live="polite">{status}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>

      <ol className="grid grid-cols-2 md:grid-cols-4 gap-2" aria-label="Steps">
        {STEPS.map((s) => {
          const built = s.n <= BUILT_STEPS;
          const current = s.n === step;
          return (
            <li key={s.n}>
              <button
                type="button"
                disabled={!built}
                aria-current={current ? "step" : undefined}
                onClick={() => built && onStep(s.n)}
                className={cn(
                  "w-full text-left rounded-md border px-3 py-2 text-sm",
                  current ? "border-amber bg-amber-soft text-ink" : "border-hairline text-ink-2",
                  !built && "opacity-60",
                )}
              >
                <span className="font-semibold">{s.n}.</span> {s.label}
                {!built && <span className="block text-xs text-ink-3">Coming next</span>}
              </button>
            </li>
          );
        })}
      </ol>

      {locked && <p className="text-sm text-amber-ink">This plan is already being published — it cannot be changed here.</p>}

      <fieldset disabled={locked} className="space-y-5">
        {step === 1 ? (
          <StepOne draft={draft} items={items} brand={brand} change={change} />
        ) : (
          <StepTwo draft={draft} change={change} audience={audience} />
        )}
      </fieldset>

      {check.notes.length > 0 && (
        <ul className="text-sm text-amber-ink list-disc pl-5">{check.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
      {error && <p className="text-sm text-rose-ink" role="alert">{error}</p>}
      {done && (
        <p className="text-sm text-emerald-ink" role="status">
          Draft saved. Ad copy and budget (steps 3–4) are being built next — this plan waits under Recent plans.
        </p>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap border-t border-hairline pt-4">
        {step === 1 ? <span /> : <Button variant="default" icon="chevron_left" onClick={() => onStep(1)}>Back</Button>}
        {step === 1 ? (
          <Button variant="primary" iconRight="arrow_right" loading={save.isPending} disabled={locked}
            onClick={async () => { if (await saveNow()) onStep(2); }}>
            Next: platforms &amp; audience
          </Button>
        ) : done ? (
          <Button variant="primary" iconRight="arrow_right" onClick={onClose}>Back to Recent plans</Button>
        ) : (
          <Button variant="primary" icon="check" loading={save.isPending} disabled={locked}
            onClick={async () => { if (await saveNow()) setDone(true); }}>
            Save draft
          </Button>
        )}
      </div>
    </Card>
  );
}

function StepOne({ draft, items, brand, change }: {
  draft: PlanDraft; items: { id: string; name: string }[]; brand: string; change: (p: Partial<PlanDraft>) => void;
}) {
  const group = groupOf(draft.objective);
  const known = draft.itemId == null || items.some((i) => i.id === draft.itemId);
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Plan name" required>
          <Input value={draft.name} maxLength={120} onChange={(e) => change({ name: e.target.value })} />
        </FormField>
        <div>
          <p className="text-sm font-medium text-ink mb-1.5">Brand</p>
          <p className="h-9 flex items-center text-sm text-ink-2">{brand || "Your company"}</p>
        </div>
      </div>

      <FormField label="Product" hint="Pick what the ads sell, or the whole business">
        <Select value={draft.itemId ?? NO_PRODUCT} onValueChange={(v) => change({ itemId: v === NO_PRODUCT ? null : v })}>
          <SelectTrigger className="w-full md:max-w-md"><SelectValue placeholder="Whole business" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PRODUCT}>Whole business (no single product)</SelectItem>
            {!known && draft.itemId && <SelectItem value={draft.itemId}>Product no longer active</SelectItem>}
            {items.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FormField>

      <div>
        <p className="text-sm font-medium text-ink mb-2">What should the ads do?</p>
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Goal">
          {OBJECTIVE_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              aria-pressed={g.key === group.key}
              onClick={() => g.key !== group.key && change({ objective: g.objectives[0] })}
              className={cn(
                "rounded-md border px-3 py-2 text-left",
                g.key === group.key ? "border-amber bg-amber-soft" : "border-hairline hover:bg-paper-2",
              )}
            >
              <span className="block text-sm font-semibold text-ink">{g.label}</span>
              <span className="block text-xs text-ink-3">{g.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Objective">
          {group.objectives.map((o: CopilotObjective) => (
            <label key={o} className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer",
              draft.objective === o ? "border-ink" : "border-hairline",
            )}>
              <input type="radio" name="objective" className="mt-1 accent-amber" checked={draft.objective === o}
                onChange={() => change({ objective: o })} />
              <span>
                <span className="block text-sm font-medium text-ink">{OBJECTIVE_INFO[o].label}</span>
                <span className="block text-xs text-ink-3">{OBJECTIVE_INFO[o].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

const GENDER_CHOICES: { key: string; label: string; value: Gender[] }[] = [
  { key: "all", label: "Everyone", value: [] },
  { key: "female", label: "Women", value: ["female"] },
  { key: "male", label: "Men", value: ["male"] },
];

function StepTwo({ draft, change, audience }: {
  draft: PlanDraft;
  change: (p: Partial<PlanDraft>) => void;
  audience: (p: Partial<PlanDraft["audience"]>) => void;
}) {
  const a = draft.audience;
  const togglePlatform = (p: AdPlatform, on: boolean) => {
    const next = on ? [...draft.platforms, p] : draft.platforms.filter((x) => x !== p);
    const platforms = PLATFORMS.filter((x) => next.includes(x));
    const lookalike = a.lookalike && platforms.some((x) => lookalikeInfo(x).available);
    change({ platforms, audience: { ...a, lookalike } });
  };
  const lookalikeOk = draft.platforms.some((p) => lookalikeInfo(p).available);
  const genderKey = a.genders.length === 1 ? a.genders[0] : "all";
  const left = INDIA_REGIONS.filter((r) => !a.regions.includes(r));
  const ageInput = (key: "ageMin" | "ageMax", label: string) => (
    <FormField label={label}>
      <Input type="number" inputMode="numeric" min={AGE_FLOOR} max={AGE_CEIL} value={a[key]} className="w-24"
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) audience({ [key]: Math.min(AGE_CEIL, Math.max(AGE_FLOOR, n)) });
        }} />
    </FormField>
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-ink mb-2">Platforms</p>
        <div className="grid gap-2 md:grid-cols-2">
          {PLATFORMS.map((p) => {
            const info = platformInfo(p, draft.objective);
            const on = draft.platforms.includes(p);
            return (
              <label key={p} className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2",
                on ? "border-ink" : "border-hairline", info.available ? "cursor-pointer" : "opacity-70",
              )}>
                <Checkbox className="mt-0.5" checked={on} disabled={!info.available}
                  onCheckedChange={(v) => togglePlatform(p, v === true)} aria-label={CHANNEL_SPECS[p].label} />
                <span>
                  <span className="block text-sm font-medium text-ink">{CHANNEL_SPECS[p].label}</span>
                  {info.reason && <span className="block text-xs text-ink-3">{info.reason}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-sm font-medium text-ink">Audience</p>
        <div className="flex flex-wrap items-end gap-4">
          {ageInput("ageMin", "Age from")}
          {ageInput("ageMax", "Age to")}
          <div>
            <p className="text-sm font-medium text-ink mb-1.5">Gender</p>
            <div className="inline-flex rounded-md border border-hairline overflow-hidden" role="group" aria-label="Gender">
              {GENDER_CHOICES.map((g) => (
                <button key={g.key} type="button" aria-pressed={genderKey === g.key}
                  onClick={() => audience({ genders: g.value })}
                  className={cn("h-9 px-3 text-sm border-l border-hairline first:border-l-0",
                    genderKey === g.key ? "bg-amber-soft text-ink font-medium" : "bg-paper text-ink-2 hover:bg-paper-2")}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <FormField label="Regions" hint={a.regions.length ? `${a.regions.length} selected` : "All of India"}>
            <Select value="" onValueChange={(v) => v && audience({ regions: [...a.regions, v].sort((x, y) => x.localeCompare(y)) })}>
              <SelectTrigger className="w-full md:max-w-md" aria-label="Add a state"><SelectValue placeholder="Add a state…" /></SelectTrigger>
              <SelectContent>{left.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          {a.regions.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {a.regions.map((r) => (
                <li key={r} className="inline-flex items-center gap-1 rounded-full border border-hairline bg-paper-2 pl-2.5 pr-1 py-0.5 text-xs text-ink">
                  {r}
                  <button type="button" aria-label={`Remove ${r}`} className="rounded-full px-1.5 hover:bg-paper"
                    onClick={() => audience({ regions: a.regions.filter((x) => x !== r) })}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className={cn("flex items-start gap-2", lookalikeOk ? "cursor-pointer" : "opacity-70")}>
          <Checkbox className="mt-0.5" checked={a.lookalike && lookalikeOk} disabled={!lookalikeOk}
            onCheckedChange={(v) => audience({ lookalike: v === true })} aria-label="Also reach people like my customers" />
          <span>
            <span className="block text-sm font-medium text-ink">Also reach people like my customers (lookalike)</span>
            <span className="block text-xs text-ink-3">
              {lookalikeOk ? "Meta finds people similar to your customers." : "Tick Meta to use this."}
              {PLATFORMS.filter((p) => draft.platforms.includes(p) && !lookalikeInfo(p).available)
                .map((p) => ` ${lookalikeInfo(p).reason}`).join("")}
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
