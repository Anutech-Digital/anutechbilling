/**
 * Campaign Co-pilot — /marketing/copilot (R-1879, epic R-1874, modelled on NYX CamPulse).
 *
 * "What will you create today?" — one line in the prompt bar becomes a SAVED draft plan
 * (POST /api/marketing/copilot/draft: the AI fills product, objective, platforms and audience,
 * checked against the real lists; no AI key → filled from the words). The wizard opens on it
 * (?plan=<id>&step=1|2|3), so a refresh keeps both the plan and the step. Recent plans below.
 * Owner, manager, marketing (nav.ts OMK; the API checks the role again, RLS a third time).
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { cn, formatDate } from "@/lib/utils";
import { CHANNEL_SPECS, type AdPlatform, type CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import { OBJECTIVE_INFO } from "@/lib/marketing/copilot/plan-draft";
import { useCopilotHome, useCopilotPlan, useCreateFromPrompt, type RecentPlan } from "./use-copilot";
import { Wizard } from "./wizard";

const EXAMPLES = [
  "Diwali offer on Google Workspace for small businesses in Delhi — get enquiries",
  "Instagram ads for Tally Prime in Mumbai and Pune to get more sales",
];

const STATUS: Record<string, { label: string; kind: "muted" | "info" | "success" | "warning" | "danger" }> = {
  draft: { label: "Draft", kind: "muted" },
  ready: { label: "Ready", kind: "info" },
  publishing: { label: "Publishing", kind: "warning" },
  live: { label: "Live", kind: "success" },
  failed: { label: "Failed", kind: "danger" },
};

export default function CopilotPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-40 w-full" /></div>}>
      <Copilot />
    </React.Suspense>
  );
}

function Copilot() {
  const router = useRouter();
  const params = useSearchParams();
  const planId = params.get("plan");
  const step = params.get("step") === "3" ? 3 : params.get("step") === "2" ? 2 : 1;
  const home = useCopilotHome();
  const plan = useCopilotPlan(planId);
  const create = useCreateFromPrompt();
  const [prompt, setPrompt] = React.useState("");

  const go = (id: string | null, s = 1) =>
    router.replace((id ? `/marketing/copilot?plan=${id}&step=${s}` : "/marketing/copilot") as Route, { scroll: false });

  const submit = async () => {
    const text = prompt.trim();
    if (text.length < 3 || create.isPending) return;
    try {
      const r = await create.mutateAsync(text);
      setPrompt("");
      if (r.note) toast.info(r.note);
      else toast.success("Plan drafted — check each step below.");
      go(r.planId, 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not draft the plan. Try again.");
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Campaign Co-pilot</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          Write one line about the campaign. The co-pilot fills the plan — product, goal, platforms and audience — and you
          check it step by step. Google Ads and Meta for now.
        </p>
      </header>

      <Card className="p-4 md:p-5">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
          <label htmlFor="copilot-prompt" className="block font-serif text-xl text-ink">What will you create today?</label>
          <div className="flex flex-col gap-2 md:flex-row md:items-end">
            <textarea
              id="copilot-prompt"
              rows={2}
              maxLength={2000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
              placeholder={EXAMPLES[0]}
              className="flex-1 min-w-0 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber resize-y"
            />
            <Button type="submit" variant="primary" icon="sparkles" loading={create.isPending} disabled={prompt.trim().length < 3}>
              Draft the plan
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span>Try:</span>
            {EXAMPLES.map((x) => (
              <button key={x} type="button" onClick={() => setPrompt(x)}
                className="rounded-full border border-hairline px-2.5 py-1 text-left hover:bg-paper-2 text-ink-2">
                {x}
              </button>
            ))}
          </div>
        </form>
      </Card>

      {planId && (
        plan.isLoading || home.isLoading ? <Skeleton className="h-72 w-full" />
        : plan.error ? <LoadError what="This plan" error={plan.error} onRetry={() => plan.refetch()} />
        : plan.data && home.data ? (
          <Wizard
            key={plan.data.id}
            plan={plan.data}
            items={home.data.items}
            brand={home.data.brand}
            step={step}
            onStep={(n) => go(plan.data!.id, n)}
            onClose={() => go(null)}
          />
        ) : null
      )}

      <section aria-labelledby="recent-plans">
        <h2 id="recent-plans" className="font-serif text-xl mb-3">Recent plans</h2>
        {home.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>
        ) : home.error ? (
          <LoadError what="Recent plans" error={home.error} onRetry={() => home.refetch()} />
        ) : !home.data?.plans.length ? (
          <p className="text-sm text-ink-3">No plans yet. Write one line above to start your first.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {home.data.plans.map((p) => <RecentCard key={p.id} p={p} open={p.id === planId} onOpen={() => go(p.id, 1)} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function RecentCard({ p, open, onOpen }: { p: RecentPlan; open: boolean; onOpen: () => void }) {
  const st = STATUS[p.status] ?? { label: p.status, kind: "muted" as const };
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={open ? "true" : undefined}
        className={cn("w-full h-full text-left rounded-lg border bg-paper p-4 hover:bg-paper-2 transition-colors",
          open ? "border-amber" : "border-hairline")}>
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-ink break-words min-w-0">{p.name}</span>
          <Badge kind={st.kind} size="sm" dot>{st.label}</Badge>
        </div>
        <p className="text-xs text-ink-3 mt-1">
          {OBJECTIVE_INFO[p.objective as CopilotObjective]?.label ?? p.objective}
          {p.product ? ` · ${p.product}` : ""}
        </p>
        <p className="text-xs text-ink-3 mt-1">
          {p.platforms.map((x) => CHANNEL_SPECS[x as AdPlatform]?.label ?? x).join(" + ")} · updated {formatDate(p.updatedAt)}
        </p>
      </button>
    </li>
  );
}
