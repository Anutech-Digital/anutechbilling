"use client";
/**
 * R-2670: Facebook / Instagram lead forms → Sales → Leads. The person ticks which forms (on any Page
 * their Meta Ads login manages) should bring leads in; then Fetch leads now, and every 30 minutes
 * by itself. Server: /api/integrations/meta-lead-forms (list + save) and
 * /api/integrations/facebook-page/leads (fetch).
 */
import * as React from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { toastError } from "@/lib/errors/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

interface FormChoice { id: string; name: string; status: string; leadsCount: number | null }
interface PageChoice { id: string; name: string; forms: FormChoice[]; error: string | null }
interface Chosen { form_id: string; page_name: string; form_name: string; last_pulled_at: string | null; last_result: string | null }
interface FormsState { canManage: boolean; adsConnected: boolean; pages: PageChoice[]; chosen: Chosen[] }

const when = (at: string | null) => at ? new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;

export function LeadFormsCard() {
  const [state, setState] = React.useState<FormsState | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  const [result, setResult] = React.useState<{ text: string; warn: boolean } | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/integrations/meta-lead-forms", { cache: "no-store" });
      const data = await response.json() as FormsState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not load your lead forms.");
      setState(data);
      setPicked(new Set(data.chosen.map((c) => c.form_id)));
      if (data.chosen.length === 0 && data.pages.some((p) => p.forms.length > 0)) setChoosing(true);
    } catch (e) { setLoadError(e instanceof Error ? e.message : "Could not load your lead forms."); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/integrations/meta-lead-forms", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ formIds: [...picked] }) });
      const data = await response.json() as { error?: string; description?: string; chosen?: Chosen[]; autoPullOn?: boolean | null };
      if (!response.ok) throw new Error(data.error ?? "Could not save the lead forms.");
      setState((s) => s ? { ...s, chosen: data.chosen ?? [] } : s);
      setChoosing(false);
      /* R-2692: forms saved, but the 30-minute pull is off for the company. */
      if (picked.size && data.autoPullOn !== undefined && data.autoPullOn !== true) toast.warning(`${picked.size} lead form${picked.size === 1 ? "" : "s"} saved, but the 30-minute pull is off.`, {
        description: "New leads come in only when you press Fetch leads now. The owner turns on Facebook lead-form leads in Automation.",
        action: { label: "Open Automation", onClick: () => { window.location.href = "/automation"; } } });
      else toast.success(picked.size ? `${picked.size} lead form${picked.size === 1 ? "" : "s"} saved.` : "No lead form chosen.", { description: picked.size ? "Press Fetch leads now to bring the last 30 days in." : "Leads from Facebook forms will not come in." });
    } catch (e) { toastError(e, { fallback: "Could not save the lead forms.", description: "Nothing changed. Try again." }); }
    finally { setSaving(false); }
  }

  async function fetchLeads() {
    setFetching(true); setResult(null);
    try {
      const response = await fetch("/api/integrations/facebook-page/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: 30 }) });
      const data = await response.json() as { error?: string; description?: string; found?: number; created?: number; duplicate?: number; already?: number; failed?: number; problems?: string[] };
      if (!response.ok) { setResult({ text: [data.error, data.description].filter(Boolean).join(" "), warn: true }); return; }
      const created = data.created ?? 0;
      const parts = [`Last 30 days: ${data.found ?? 0} leads found, ${created} new added to Leads`];
      if (data.duplicate) parts.push(`${data.duplicate} matched an existing lead (note added)`);
      if (data.already) parts.push(`${data.already} already in Leads`);
      if (data.failed) parts.push(`${data.failed} could not be saved`);
      setResult({ text: `${parts.join(", ")}.${data.problems?.length ? ` ${data.problems.join(" ")}` : ""}`, warn: Boolean(data.problems?.length || data.failed) });
      if (created > 0) toast.success(`${created} new Facebook lead${created === 1 ? "" : "s"} added.`, { description: "Open Leads to call them.", action: { label: "Open Leads", onClick: () => { window.location.href = "/leads"; } } });
      await load();
    } catch (e) { toastError(e, { fallback: "Could not fetch Facebook leads.", description: "Check your internet and press Fetch leads now again." }); }
    finally { setFetching(false); }
  }

  const allForms = state?.pages.flatMap((p) => p.forms) ?? [];

  return (
    <Card>
      <div className="space-y-4 p-1 md:p-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <UserPlus size={20} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink">Lead form leads</h2>
              <p className="mt-0.5 text-sm text-ink-3">Choose your Facebook / Instagram lead forms. Their leads are added to Leads every 30 minutes, with the answers in the notes.</p>
            </div>
          </div>
          {state?.canManage && state.adsConnected && !choosing && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setChoosing(true)}>Choose forms</Button>
              <Button variant="primary" loading={fetching} disabled={state.chosen.length === 0} onClick={() => void fetchLeads()}>Fetch leads now</Button>
            </div>
          )}
        </div>

        {!state && !loadError && <Skeleton className="h-24 rounded-lg" />}
        {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-rose-soft px-3 py-2 text-sm text-rose-ink"><span>{loadError}</span><Button size="sm" onClick={() => void load()}>Try again</Button></div>}
        {state && !state.adsConnected && <p className="rounded-md bg-paper-2 px-3 py-2 text-sm text-ink-2">Connect Meta Ads first — its login is used to read your lead forms. <a className="font-medium underline" href="/marketing/ads">Open Paid ads</a></p>}

        {state?.adsConnected && choosing && (
          <div className="space-y-3">
            {allForms.length === 0 && <p className="rounded-md bg-paper-2 px-3 py-2 text-sm text-ink-2">None of your Pages has a lead form yet. Create a lead form ad in Meta Ads Manager, then come back.</p>}
            {state.pages.filter((p) => p.forms.length > 0 || p.error).map((page) => (
              <fieldset key={page.id} className="rounded-lg border border-hairline p-3">
                <legend className="px-1 text-sm font-semibold text-ink">{page.name}</legend>
                {page.error && <p className="text-xs text-amber-ink">{page.error}</p>}
                <div className="space-y-2">
                  {page.forms.map((form) => (
                    <label key={form.id} htmlFor={`lf-${form.id}`} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-paper-2">
                      <Checkbox id={`lf-${form.id}`} checked={picked.has(form.id)} onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v === true) n.add(form.id); else n.delete(form.id); return n; })} />
                      <span className="min-w-0 flex-1 text-sm text-ink">{form.name}</span>
                      {form.leadsCount !== null && <span className="shrink-0 text-xs tabular-nums text-ink-3">{form.leadsCount} leads</span>}
                      {form.status && form.status !== "ACTIVE" && <Badge kind="muted">{form.status.toLowerCase()}</Badge>}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={saving} onClick={() => void save()}>Save {picked.size} form{picked.size === 1 ? "" : "s"}</Button>
              {state.chosen.length > 0 && <Button variant="ghost" onClick={() => { setPicked(new Set(state.chosen.map((c) => c.form_id))); setChoosing(false); }}>Cancel</Button>}
            </div>
          </div>
        )}

        {state?.adsConnected && !choosing && state.chosen.length > 0 && (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {state.chosen.map((c) => (
              <li key={c.form_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0"><span className="font-medium text-ink">{c.form_name}</span> <span className="text-ink-3">· {c.page_name}</span></span>
                <span className="text-xs text-ink-3">{c.last_pulled_at ? `Last fetched ${when(c.last_pulled_at)} · ${c.last_result ?? ""}` : "Not fetched yet"}</span>
              </li>
            ))}
          </ul>
        )}

        {result && <div role="status" className={result.warn ? "rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-ink" : "rounded-md bg-paper-2 px-3 py-2 text-sm text-ink-2"}>{result.text} <a className="font-medium underline" href="/leads">Open Leads</a></div>}
      </div>
    </Card>
  );
}
