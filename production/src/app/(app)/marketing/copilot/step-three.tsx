/**
 * R-1897 — Co-pilot Step 3: the ad copy. Pardeep (25 Oct): "campaign me ad copy kaise banegi
 * iska bhi poora logical system banao taki user aasani se kaam kar sake".
 *
 *   Top:    the plan in one line (product, goal, platforms, audiences) + copy language.
 *   Tabs:   one per chosen platform (Google Ads, Meta); inside, one block per audience
 *           (Main audience; People like my customers on Meta when the lookalike is on).
 *   Block:  "Write copy with AI" fills the whole set (kept lines stay). Every line: inline edit
 *           with a live counter (28/30, red past the limit), Rewrite (only that line), Keep,
 *           Pin (Google), Delete; "Add …" up to the platform's count. History brings back an
 *           earlier saved version. Every change autosaves (with a version) a moment later.
 *   Bottom: "Mark ready" — allowed when every platform has one full set; otherwise it lists
 *           exactly what is left.
 * The rules live in lib/marketing/copilot/copy-set.ts; the AI never publishes anything.
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CHANNEL_SPECS, type AdPlatform, type CopilotObjective, type CopyField } from "@/lib/marketing/copilot/channel-specs";
import { COPY_LANGUAGES, type CopyLanguage } from "@/lib/marketing/copilot/copy-prompt";
import { OBJECTIVE_INFO } from "@/lib/marketing/copilot/plan-draft";
import {
  audienceBlocks, counterTone, emptySet, formatFields, fromRows, mergeAi, newLineKey,
  pinOptions, readyCheck, replaceLine, setProgress, toRows,
  type AudienceBlock, type CopySet, type DraftLine,
} from "@/lib/marketing/copilot/copy-set";
import {
  ApiError, listVersions, markReady, rewriteLine, saveSet, useCopySets, writeCopy,
  type SavedSetDto, type VersionDto,
} from "./use-copy";

const AUTOSAVE_MS = 1200;
const LANGUAGE_LABEL: Record<CopyLanguage, string> = { en: "English", hinglish: "Hinglish", hi: "Hindi" };

export interface StepThreePlan {
  id: string;
  objective: CopilotObjective;
  platforms: AdPlatform[];
  lookalike: boolean;
  language: CopyLanguage;
  product: string | null;
  status: string;
}

const keyOf = (b: { platform: string; audience: string }) => `${b.platform}:${b.audience}`;

export function StepThree({ plan, onStatus }: { plan: StepThreePlan; onStatus?: (s: string) => void }) {
  const q = useCopySets(plan.id);
  if (q.isLoading) return <Skeleton className="h-72 w-full" />;
  if (q.error) return <LoadError what="The ad copy" error={q.error} onRetry={() => q.refetch()} />;
  return <CopyEditor key={q.dataUpdatedAt} plan={plan} saved={q.data?.sets ?? []} onStatus={onStatus} reload={() => q.refetch()} />;
}

type SaveState = { state: "idle" | "saving" | "saved" | "error" | "conflict"; error?: string; at?: number };

function initialSets(blocks: AudienceBlock[], saved: readonly SavedSetDto[]): Record<string, CopySet> {
  const out: Record<string, CopySet> = {};
  for (const b of blocks) {
    const s = saved.find((x) => x.platform === b.platform && x.audience === b.audience);
    out[keyOf(b)] = s && s.format === b.format
      ? fromRows(b.platform, b.audience, b.format, s.rows, s.version)
      /* Saved under another format (objective changed): start empty but keep the version for the save. */
      : { ...emptySet(b.platform, b.audience, b.format), version: s?.version ?? 0 };
  }
  return out;
}

function CopyEditor({ plan, saved, onStatus, reload }: {
  plan: StepThreePlan; saved: readonly SavedSetDto[]; onStatus?: (s: string) => void; reload: () => void;
}) {
  const qc = useQueryClient();
  const blocks = React.useMemo(() => audienceBlocks(plan.platforms, plan.objective, plan.lookalike), [plan.platforms, plan.objective, plan.lookalike]);
  const tabs = React.useMemo(() => [...new Set(blocks.map((b) => b.platform))], [blocks]);
  const [tab, setTab] = React.useState<AdPlatform | undefined>(tabs[0]);
  const [language, setLanguage] = React.useState<CopyLanguage>(plan.language);
  const [sets, setSets] = React.useState<Record<string, CopySet>>(() => initialSets(blocks, saved));
  const [saves, setSaves] = React.useState<Record<string, SaveState>>({});
  const [readying, setReadying] = React.useState(false);
  const [readyError, setReadyError] = React.useState<string[] | null>(null);

  /* Autosave bookkeeping per set: an edit counter, so an edit made WHILE a save is in flight stays unsaved. */
  const setsRef = React.useRef(sets);
  setsRef.current = sets;
  const edits = React.useRef<Record<string, number>>({});
  const savedEdits = React.useRef<Record<string, number>>({});
  const inFlight = React.useRef<Record<string, Promise<boolean> | undefined>>({});
  const [tick, setTick] = React.useState(0);

  const dirtyKeys = Object.keys(edits.current).filter((k) => (edits.current[k] ?? 0) !== (savedEdits.current[k] ?? 0));

  const update = React.useCallback((k: string, fn: (s: CopySet) => CopySet) => {
    setSets((prev) => ({ ...prev, [k]: fn(prev[k]) }));
    edits.current[k] = (edits.current[k] ?? 0) + 1;
    /* A new edit retries a failed save by itself; a conflict waits for Reload (it would overwrite). */
    setSaves((s) => (s[k]?.state === "error" ? { ...s, [k]: { state: "idle" } } : s));
    setTick((t) => t + 1);
    setReadyError(null);
  }, []);

  const saveKey = React.useCallback(async (k: string): Promise<boolean> => {
    if (inFlight.current[k]) await inFlight.current[k];
    const at = edits.current[k] ?? 0;
    if (at === (savedEdits.current[k] ?? 0)) return true;
    const set = setsRef.current[k];
    const run = (async () => {
      setSaves((s) => ({ ...s, [k]: { state: "saving" } }));
      try {
        const r = await saveSet(plan.id, {
          platform: set.platform, audience: set.audience, format: set.format, expectedVersion: set.version,
          lines: toRows(set).map(({ field, text, position, locked, pinned, ai_generated }) => ({ field, text, position, locked, pinned, ai_generated })),
        });
        setSets((prev) => ({ ...prev, [k]: { ...prev[k], version: r.version } }));
        setsRef.current = { ...setsRef.current, [k]: { ...setsRef.current[k], version: r.version } };
        savedEdits.current[k] = at;
        setSaves((s) => ({ ...s, [k]: { state: "saved", at: Date.now() } }));
        if (r.status !== plan.status) onStatus?.(r.status);
        return true;
      } catch (e) {
        const conflict = e instanceof ApiError && e.status === 409 && e.body.code === "version_conflict";
        setSaves((s) => ({ ...s, [k]: { state: conflict ? "conflict" : "error", error: e instanceof Error ? e.message : "Could not save." } }));
        return false;
      } finally {
        inFlight.current[k] = undefined;
        setTick((t) => t + 1);
      }
    })();
    inFlight.current[k] = run;
    return run;
  }, [plan.id, plan.status, onStatus]);

  /* Autosave a moment after the last change of each set. Failed / conflicting sets wait for the person. */
  React.useEffect(() => {
    const ready = dirtyKeys.filter((k) => !inFlight.current[k] && saves[k]?.state !== "error" && saves[k]?.state !== "conflict");
    if (!ready.length) return;
    const t = setTimeout(() => { ready.forEach((k) => void saveKey(k)); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick changes on every edit / save
  }, [tick, saveKey]);

  const check = readyCheck(plan.platforms, plan.objective, Object.values(sets));
  const anySaving = Object.values(saves).some((s) => s.state === "saving");
  const blocked = Object.entries(saves).filter(([, s]) => s.state === "error" || s.state === "conflict");

  const doMarkReady = async () => {
    setReadying(true);
    setReadyError(null);
    try {
      for (const k of dirtyKeys) if (!(await saveKey(k))) { setReadyError(["Some copy could not be saved — see the message on its block."]); return; }
      await markReady(plan.id);
      onStatus?.("ready");
      void qc.invalidateQueries({ queryKey: ["copilot-plans"] });
      toast.success("Ad copy marked ready. Nothing has been sent to Google or Meta.");
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.body.missing)) setReadyError(e.body.missing as string[]);
      else setReadyError([e instanceof Error ? e.message : "Could not mark ready. Try again."]);
    } finally {
      setReadying(false);
    }
  };

  const audiences = [...new Set(blocks.map((b) => b.label))];

  if (!blocks.length) {
    return <p className="text-sm text-amber-ink">No platform in this plan can run this objective. Go back to step 2 and pick one.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-hairline bg-paper-2 px-3 py-2 text-sm text-ink-2 flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="text-ink-3">Product:</span> {plan.product ?? "Whole business"}</span>
        <span><span className="text-ink-3">Goal:</span> {OBJECTIVE_INFO[plan.objective].label}</span>
        <span><span className="text-ink-3">Platforms:</span> {plan.platforms.map((p) => CHANNEL_SPECS[p].label).join(", ")}</span>
        <span><span className="text-ink-3">Audiences:</span> {audiences.join(", ")}</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor="copilot-copy-language" className="block text-sm font-medium text-ink mb-1.5">Copy language</label>
          <Select value={language} onValueChange={(v) => setLanguage(v as CopyLanguage)}>
            <SelectTrigger id="copilot-copy-language" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{COPY_LANGUAGES.map((l) => <SelectItem key={l} value={l}>{LANGUAGE_LABEL[l]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <p className="text-xs text-ink-3 max-w-md">
          The AI drafts, you edit and approve. Nothing is sent to Google or Meta from this step.
        </p>
      </div>

      <div role="tablist" aria-label="Platforms" className="flex gap-1 border-b border-hairline overflow-x-auto">
        {tabs.map((p) => {
          const mine = blocks.filter((b) => b.platform === p).map((b) => sets[keyOf(b)]);
          const done = mine.some((s) => setProgress(s).complete);
          return (
            <button key={p} type="button" role="tab" id={`copilot-tab-${p}`} aria-controls={`copilot-panel-${p}`}
              aria-selected={tab === p} onClick={() => setTab(p)}
              className={cn("relative -mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                tab === p ? "border-amber text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
              {CHANNEL_SPECS[p].label}
              <Badge kind={done ? "success" : "muted"} size="sm">{done ? "Set complete" : "Not complete"}</Badge>
            </button>
          );
        })}
      </div>

      {tabs.map((p) => (
        <div key={p} role="tabpanel" id={`copilot-panel-${p}`} aria-labelledby={`copilot-tab-${p}`} hidden={tab !== p} className="space-y-5">
          {blocks.filter((b) => b.platform === p).map((b) => (
            <SetBlock
              key={keyOf(b)}
              planId={plan.id}
              block={b}
              set={sets[keyOf(b)]}
              language={language}
              save={saves[keyOf(b)]}
              dirty={dirtyKeys.includes(keyOf(b))}
              update={(fn) => update(keyOf(b), fn)}
              retry={() => { setSaves((s) => ({ ...s, [keyOf(b)]: { state: "idle" } })); void saveKey(keyOf(b)); }}
              reload={reload}
            />
          ))}
        </div>
      ))}

      <div className="border-t border-hairline pt-4 space-y-2">
        {plan.status === "ready" && !dirtyKeys.length ? (
          <p className="text-sm text-emerald-ink" role="status">This plan is ready. Editing any line puts it back to draft.</p>
        ) : !check.ok ? (
          <div className="text-sm text-ink-2">
            <p className="font-medium text-ink">Before you can mark it ready:</p>
            <ul className="list-disc pl-5">{check.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        ) : (
          <p className="text-sm text-ink-2">Every platform has a full set. Read it once more, then mark it ready.</p>
        )}
        {readyError && <ul className="text-sm text-rose-ink list-disc pl-5" role="alert">{readyError.map((m) => <li key={m}>{m}</li>)}</ul>}
        {blocked.length > 0 && <p className="text-sm text-rose-ink">Some copy is not saved — see the message on its block.</p>}
        <div className="flex justify-end">
          <Button variant="primary" icon="check" loading={readying}
            disabled={!check.ok || readying || blocked.length > 0 || (plan.status === "ready" && !dirtyKeys.length && !anySaving)}
            onClick={() => void doMarkReady()}>
            Mark ready
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetBlock({ planId, block, set, language, save, dirty, update, retry, reload }: {
  planId: string;
  block: AudienceBlock;
  set: CopySet;
  language: CopyLanguage;
  save: SaveState | undefined;
  dirty: boolean;
  update: (fn: (s: CopySet) => CopySet) => void;
  retry: () => void;
  reload: () => void;
}) {
  const [writing, setWriting] = React.useState(false);
  const [rewriting, setRewriting] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<VersionDto[] | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const progress = setProgress(set);
  const platformLabel = CHANNEL_SPECS[block.platform].label;
  const headingId = `copilot-block-${block.platform}-${block.audience}`;

  const write = async () => {
    setWriting(true);
    try {
      const r = await writeCopy(planId, block.platform, block.audience, language);
      const ai = r.fields.filter((f) => f.platform === block.platform).map((f) => ({ field: f.field, lines: f.lines.map((l) => l.text) }));
      update((s) => mergeAi(s, ai));
      const dropped = r.fields.filter((f) => f.platform === block.platform).reduce((n, f) => n + f.dropped.length, 0);
      if (r.note) toast.info(r.note);
      else toast.success(dropped ? `Copy written. ${dropped} line${dropped === 1 ? " was" : "s were"} left out (too long or a price you did not give).` : "Copy written. Check each line.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not write the copy. Try again.");
    } finally {
      setWriting(false);
    }
  };

  const rewrite = async (field: CopyField, line: DraftLine) => {
    setRewriting(line.key);
    try {
      const others = (set.lines[field.key] ?? []).filter((l) => l.key !== line.key).map((l) => l.text).filter(Boolean);
      const r = await rewriteLine({ planId, platform: block.platform, field: field.key, current: line.text, others, audience: block.audience, language });
      update((s) => replaceLine(s, field.key, line.key, r.text, true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rewrite the line. Try again.");
    } finally {
      setRewriting(null);
    }
  };

  const openHistory = async () => {
    if (historyOpen) { setHistoryOpen(false); return; }
    setHistoryOpen(true);
    try {
      setHistory((await listVersions(planId, block.platform, block.audience)).versions);
    } catch (e) {
      setHistoryOpen(false);
      toast.error(e instanceof Error ? e.message : "Could not load the history.");
    }
  };

  const bringBack = (v: VersionDto) => {
    update((s) => ({ ...fromRows(s.platform, s.audience, s.format, v.lines, s.version) }));
    setHistoryOpen(false);
    toast.success(`Version ${v.version} is back — it saves as a new version.`);
  };

  const status = save?.state === "saving" ? "Saving…"
    : save?.state === "error" ? "Not saved"
    : save?.state === "conflict" ? "Changed elsewhere"
    : dirty ? "Unsaved changes…"
    : set.version ? `Saved · version ${set.version}` : "Not started";

  const hasUnkept = Object.values(set.lines).some((ls) => ls.some((l) => !l.locked));

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-hairline p-3 md:p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="font-serif text-lg leading-tight">{platformLabel} · {block.label}</h3>
          <p className="text-xs text-ink-3 mt-0.5">
            {progress.complete ? "Set complete" : progress.started ? `Still needed: ${progress.missing.join(", ")}` : "No copy yet"}
            {" · "}<span role="status" aria-live="polite" className={cn(save?.state === "error" || save?.state === "conflict" ? "text-rose-ink" : "")}>{status}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" size="sm" icon="clock" onClick={() => void openHistory()} aria-expanded={historyOpen} disabled={!set.version}>
            History
          </Button>
          <Button variant={progress.started ? "default" : "primary"} size="sm" icon="sparkles" loading={writing} onClick={() => void write()}>
            Write copy with AI
          </Button>
        </div>
      </div>
      {progress.started && hasUnkept && (
        <p className="text-xs text-ink-3">Writing again replaces the lines you have not kept. Kept lines stay.</p>
      )}

      {(save?.state === "error" || save?.state === "conflict") && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-rose/40 bg-rose-soft px-3 py-2 text-sm text-rose-ink" role="alert">
          <span className="min-w-0 flex-1">{save.error}</span>
          {save.state === "conflict"
            ? <Button size="sm" variant="default" icon="refresh" onClick={reload}>Reload</Button>
            : <Button size="sm" variant="default" icon="refresh" onClick={retry}>Try again</Button>}
        </div>
      )}

      {historyOpen && (
        <div className="rounded-md border border-hairline bg-paper-2 p-3 text-sm">
          {!history ? <Skeleton className="h-10 w-full" />
            : !history.length ? <p className="text-ink-3">No saved versions yet.</p>
            : (
              <ul className="space-y-1.5">
                {history.map((v) => (
                  <li key={v.version} className="flex flex-wrap items-center justify-between gap-2">
                    <span>Version {v.version} · {new Date(v.savedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {v.lines.length} line{v.lines.length === 1 ? "" : "s"}</span>
                    {v.version === set.version
                      ? <span className="text-xs text-ink-3">Current</span>
                      : <Button size="sm" variant="ghost" onClick={() => bringBack(v)}>Bring back</Button>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {formatFields(block.platform, block.format).map((field) => (
        <FieldGroup
          key={field.key}
          platform={block.platform}
          field={field}
          lines={set.lines[field.key] ?? []}
          rewriting={rewriting}
          onRewrite={(l) => void rewrite(field, l)}
          update={update}
        />
      ))}
    </section>
  );
}

function FieldGroup({ platform, field, lines, rewriting, onRewrite, update }: {
  platform: AdPlatform;
  field: CopyField;
  lines: DraftLine[];
  rewriting: string | null;
  onRewrite: (l: DraftLine) => void;
  update: (fn: (s: CopySet) => CopySet) => void;
}) {
  const label = field.label;
  const filled = lines.filter((l) => l.text.trim()).length;
  const setLines = (fn: (ls: DraftLine[]) => DraftLine[]) => update((s) => ({ ...s, lines: { ...s.lines, [field.key]: fn(s.lines[field.key] ?? []) } }));
  const limitText = field.max != null ? `up to ${field.max} characters each` : field.recommended != null ? `Meta suggests up to ${field.recommended} characters` : null;

  if (field.choices) {
    const value = lines[0]?.text ?? "";
    return (
      <div>
        <label htmlFor={`copilot-${platform}-${field.key}`} className="block text-sm font-medium text-ink mb-1.5">{label}</label>
        <Select value={value || undefined} onValueChange={(v) => setLines(() => [{ key: lines[0]?.key ?? newLineKey(), text: v, locked: false, pinned: null, ai: false }])}>
          <SelectTrigger id={`copilot-${platform}-${field.key}`} className="w-full sm:w-64"><SelectValue placeholder="Pick a button" /></SelectTrigger>
          <SelectContent>{field.choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">
        {label}s <span className="font-normal text-ink-3">· {filled} of {field.maxCount}{field.minCount ? `, at least ${field.minCount}` : ", optional"}{limitText ? ` · ${limitText}` : ""}</span>
      </legend>
      {lines.length > 0 && (
        <ol className="space-y-2">
          {lines.map((l, i) => (
            <LineRow
              key={l.key}
              platform={platform}
              field={field}
              line={l}
              n={i + 1}
              busy={rewriting === l.key}
              onText={(text) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, text, ai: false } : x)))}
              onKeep={() => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, locked: !x.locked } : x)))}
              onPin={(pinned) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, pinned } : x)))}
              onDelete={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              onRewrite={() => onRewrite(l)}
            />
          ))}
        </ol>
      )}
      {lines.length < field.maxCount && (
        <Button size="sm" variant="ghost" icon="plus"
          onClick={() => setLines((ls) => [...ls, { key: newLineKey(), text: "", locked: false, pinned: null, ai: false }])}>
          Add {label.toLowerCase()}
        </Button>
      )}
    </fieldset>
  );
}

const NO_PIN = "none";

export function LineRow({ platform, field, line, n, busy, onText, onKeep, onPin, onDelete, onRewrite }: {
  platform: AdPlatform;
  field: CopyField;
  line: DraftLine;
  n: number;
  busy: boolean;
  onText: (t: string) => void;
  onKeep: () => void;
  onPin: (p: number | null) => void;
  onDelete: () => void;
  onRewrite: () => void;
}) {
  const c = counterTone(line.text, field);
  const name = `${field.label} ${n}`;
  const id = `copilot-line-${platform}-${field.key}-${line.key}`;
  const pins = pinOptions(platform, field.key);
  const long = (field.max ?? field.recommended ?? 0) > 90 || field.key === "primary_text";
  const inputClass = cn(
    "w-full min-w-0 rounded-md border bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
    c.tone === "over" ? "border-rose" : "border-hairline",
  );
  return (
    <li className="rounded-md border border-hairline bg-paper p-2 space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="mt-2 w-5 shrink-0 text-right text-xs text-ink-3" aria-hidden>{n}</span>
        {long ? (
          <textarea id={id} aria-label={name} rows={2} value={line.text} onChange={(e) => onText(e.target.value)}
            aria-invalid={c.blocks || undefined} aria-describedby={`${id}-count`} className={cn(inputClass, "resize-y")} />
        ) : (
          <input id={id} aria-label={name} value={line.text} onChange={(e) => onText(e.target.value)}
            aria-invalid={c.blocks || undefined} aria-describedby={`${id}-count`} className={cn(inputClass, "h-9")} />
        )}
        <span id={`${id}-count`} data-testid="counter" data-tone={c.tone}
          className={cn("mt-2 shrink-0 tabular-nums text-xs", c.tone === "over" ? "text-rose-ink font-semibold" : "text-ink-3")}>
          {c.label}
        </span>
      </div>
      {c.hint && <p className="pl-7 text-xs text-rose-ink">{c.hint}</p>}
      <div className="flex flex-wrap items-center gap-1 pl-7">
        <Button size="sm" variant="ghost" icon="sparkles" loading={busy} onClick={onRewrite} disabled={!line.text.trim()}
          aria-label={`Rewrite ${name.toLowerCase()}`}>
          Rewrite
        </Button>
        <Button size="sm" variant="ghost" icon="lock" aria-pressed={line.locked} onClick={onKeep}
          aria-label={`Keep ${name.toLowerCase()}`} className={cn(line.locked && "bg-amber-soft")}>
          Keep
        </Button>
        {pins.length > 0 && (
          <Select value={line.pinned ? String(line.pinned) : NO_PIN} onValueChange={(v) => onPin(v === NO_PIN ? null : Number(v))}>
            <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label={`Pin ${name.toLowerCase()}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PIN}>No pin</SelectItem>
              {pins.map((p) => <SelectItem key={p} value={String(p)}>Pin to position {p}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" variant="ghost" icon="trash" onClick={onDelete} aria-label={`Delete ${name.toLowerCase()}`}>
          Delete
        </Button>
      </div>
    </li>
  );
}
