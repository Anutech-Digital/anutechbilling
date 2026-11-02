"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";

type Row = { day: string; campaign_name: string; spend: number | string; impressions: number; clicks: number; leads: number };
const n = (v: number | string) => Number(v) || 0;

export default function LinkedInAdsPage() {
  const [showSetup, setShowSetup] = React.useState(false);
  const [configured, setConfigured] = React.useState(false);
  const [checkingConfig, setCheckingConfig] = React.useState(true);
  const [configForm, setConfigForm] = React.useState({ clientId: "", clientSecret: "" });
  const [savingConfig, setSavingConfig] = React.useState(false);
  React.useEffect(() => { setShowSetup(new URLSearchParams(window.location.search).get("setup") === "1"); }, []);
  React.useEffect(() => { void fetch("/api/integrations/linkedin-ads").then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Could not check setup."); setConfigured(!!b.configured); }).catch((e) => toast.error(e.message)).finally(() => setCheckingConfig(false)); }, []);
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({ day: istToday(), campaignName: "", spend: "", impressions: "", clicks: "", leads: "" });
  const load = React.useCallback(async () => { const r = await fetch("/api/marketing/linkedin-ads/metrics"); const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Could not load metrics."); setRows(b.rows); }, []);
  React.useEffect(() => { void load().catch((e) => toast.error(e.message)); }, [load]);
  const totals = (rows ?? []).reduce((a, r) => ({ spend: a.spend + n(r.spend), impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, leads: a.leads + r.leads }), { spend: 0, impressions: 0, clicks: 0, leads: 0 });
  const ctr = totals.impressions ? (totals.clicks / totals.impressions * 100).toFixed(2) : "—";
  const cpl = totals.leads ? rupee(totals.spend / totals.leads) : "—";
  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/marketing/linkedin-ads/metrics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, spend: Number(form.spend || 0), impressions: Number(form.impressions || 0), clicks: Number(form.clicks || 0), leads: Number(form.leads || 0) }) });
      const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Could not save metrics.");
      toast.success("LinkedIn Ads metrics saved."); setForm({ day: istToday(), campaignName: "", spend: "", impressions: "", clicks: "", leads: "" }); await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save metrics."); } finally { setSaving(false); }
  }
  async function saveConfig() {
    setSavingConfig(true);
    try {
      const r = await fetch("/api/integrations/linkedin-ads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(configForm) });
      const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Could not save setup.");
      setConfigured(true); setConfigForm({ clientId: "", clientSecret: "" }); toast.success("LinkedIn Ads setup saved. You can connect now.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save setup."); } finally { setSavingConfig(false); }
  }
  if (!rows) return <div className="mx-auto max-w-5xl p-6"><Skeleton className="h-64" /></div>;
  return <div className="mx-auto max-w-5xl p-4 md:p-6 lg:p-8 space-y-5">
    <header className="flex items-end justify-between gap-3 flex-wrap"><div><p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Marketing Hub</p><h1 className="font-serif text-3xl md:text-4xl">LinkedIn Ads</h1><p className="text-sm text-ink-3 mt-1">Use manual metrics until LinkedIn approves your Advertising API request.</p></div>{configured ? <Button asChild variant="primary"><a href="/api/integrations/linkedin-ads/connect">Connect LinkedIn Ads</a></Button> : <Button variant="primary" disabled>{checkingConfig ? "Checking setup…" : "Save app keys first"}</Button>}</header>
    {showSetup && <Card className="p-5"><div className="space-y-4"><div><h2 className="font-semibold">LinkedIn Ads setup</h2><p className="text-sm text-ink-3 mt-1">Add your app keys here once. They are encrypted before saving.</p></div><ol className="list-decimal pl-5 space-y-2 text-sm text-ink-2"><li>In your LinkedIn Developer app, request the <b>Advertising API</b>.</li><li>In app settings, add this redirect URL: <code className="rounded bg-paper-2 px-1">http://localhost:3001/api/integrations/linkedin-ads/callback</code></li><li>Copy the Client ID and Client Secret from LinkedIn, then save them below.</li><li>Click <b>Connect LinkedIn Ads</b> above.</li></ol><div className="grid gap-3 md:grid-cols-2"><FormField label="LinkedIn Client ID" htmlFor="li_client_id"><Input id="li_client_id" value={configForm.clientId} onChange={(e) => setConfigForm({ ...configForm, clientId: e.target.value })} autoComplete="off" /></FormField><FormField label="LinkedIn Client Secret" htmlFor="li_client_secret"><Input id="li_client_secret" type="password" value={configForm.clientSecret} onChange={(e) => setConfigForm({ ...configForm, clientSecret: e.target.value })} autoComplete="new-password" /></FormField></div><div className="flex gap-2 flex-wrap"><Button variant="primary" onClick={() => void saveConfig()} disabled={!configForm.clientId.trim() || !configForm.clientSecret.trim()} loading={savingConfig}>Save app keys</Button><Button asChild variant="outline" size="sm"><a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noreferrer">Open LinkedIn Developer Apps</a></Button></div></div></Card>}
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{[["Spend", rupee(totals.spend)], ["Impressions", totals.impressions.toLocaleString("en-IN")], ["Clicks", totals.clicks.toLocaleString("en-IN")], ["CTR", `${ctr}${ctr === "—" ? "" : "%"}`], ["Cost / lead", cpl]].map(([label, value]) => <Card key={label} className="p-3"><p className="text-xs text-ink-3">{label}</p><p className="font-serif text-2xl">{value}</p></Card>)}</div>
    <Card className="p-5"><h2 className="text-lg font-semibold">Add Campaign Manager data</h2><p className="text-xs text-ink-3 mt-1 mb-4">Copy the daily numbers from LinkedIn Campaign Manager. Saving the same date and campaign updates it.</p><div className="grid gap-3 md:grid-cols-3"><FormField label="Date" htmlFor="day"><Input id="day" type="date" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} /></FormField><FormField label="Campaign name" htmlFor="campaign"><Input id="campaign" value={form.campaignName} onChange={(e) => setForm({ ...form, campaignName: e.target.value })} /></FormField><FormField label="Spend (₹)" htmlFor="spend"><Input id="spend" type="number" min="0" value={form.spend} onChange={(e) => setForm({ ...form, spend: e.target.value })} /></FormField><FormField label="Impressions" htmlFor="impressions"><Input id="impressions" type="number" min="0" value={form.impressions} onChange={(e) => setForm({ ...form, impressions: e.target.value })} /></FormField><FormField label="Clicks" htmlFor="clicks"><Input id="clicks" type="number" min="0" value={form.clicks} onChange={(e) => setForm({ ...form, clicks: e.target.value })} /></FormField><FormField label="Leads" htmlFor="leads"><Input id="leads" type="number" min="0" value={form.leads} onChange={(e) => setForm({ ...form, leads: e.target.value })} /></FormField></div><div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => void save()} disabled={!form.campaignName.trim()} loading={saving}>Save metrics</Button></div></Card>
    <Card className="overflow-hidden"><div className="p-4"><h2 className="font-semibold">Saved metrics</h2></div>{rows.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-paper-2 text-left text-xs text-ink-3"><tr><th className="p-3">Date</th><th className="p-3">Campaign</th><th className="p-3 text-right">Spend</th><th className="p-3 text-right">Impr.</th><th className="p-3 text-right">Clicks</th><th className="p-3 text-right">Leads</th></tr></thead><tbody>{rows.map((r) => <tr key={`${r.day}-${r.campaign_name}`} className="border-t border-hairline"><td className="p-3">{r.day}</td><td className="p-3">{r.campaign_name}</td><td className="p-3 text-right">{rupee(n(r.spend))}</td><td className="p-3 text-right">{r.impressions}</td><td className="p-3 text-right">{r.clicks}</td><td className="p-3 text-right">{r.leads}</td></tr>)}</tbody></table></div> : <p className="p-4 text-sm text-ink-3">No LinkedIn Ads metrics yet.</p>}</Card>
  </div>;
}
