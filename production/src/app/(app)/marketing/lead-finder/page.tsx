/**
 * AI Lead Finder — /marketing/lead-finder
 *
 * The owner describes who they sell to; the agent finds matching companies from the public
 * web (Gemini + Google Search), checks each one's email provider (MX) and website, scores it
 * and writes a one-line pitch. Nothing becomes a lead until somebody here says Approve.
 * Prompts, parsers and scoring: lib/leads/lead-finder.ts; the run: lead-finder.server.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { cn, formatDate } from "@/lib/utils";
import { PRODUCT_LABEL, MX_LABEL } from "@/lib/leads/lead-finder";
import { readContact } from "@/lib/leads/lead-contacts";
import {
  useFinderProfiles, useSaveFinderProfile, useDeleteFinderProfile, useFinderCandidates, useFinderRuns, useRunFinder, useApproveCandidate, useRejectCandidate, useFindContacts, useSearchPeople,
  type FinderProfileRow, type FinderProfileInput, type FinderCandidate,
} from "@/lib/queries/lead-finder";

type Tab = "new" | "converted" | "rejected";
const PRODUCTS = Object.keys(PRODUCT_LABEL);
const EMPTY: FinderProfileInput = { name: "", cities: "", industries: "", company_size: "10-200 employees", products: ["workspace", "website", "hosting"], must_have: "", exclude: "", daily_limit: 20, enabled: true };

export default function LeadFinderPage() {
  const profiles = useFinderProfiles();
  const candidates = useFinderCandidates();
  const runs = useFinderRuns();
  const run = useRunFinder();
  const approve = useApproveCandidate();
  const reject = useRejectCandidate();
  const findContacts = useFindContacts();
  const searchPeople = useSearchPeople();
  const [tab, setTab] = React.useState<Tab>("new");
  const [editing, setEditing] = React.useState<FinderProfileInput | null>(null);
  const [q, setQ] = React.useState("");
  const [minScore, setMinScore] = React.useState(0);

  const list = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (candidates.data ?? [])
      .filter((c) => c.status === tab || (tab === "new" && c.status === "approved"))
      .filter((c) => (c.score ?? 0) >= minScore)
      .filter((c) => !needle || `${c.company} ${c.domain} ${c.city ?? ""} ${c.fit_reason ?? ""}`.toLowerCase().includes(needle));
  }, [candidates.data, tab, q, minScore]);
  const count = (s: Tab) => (candidates.data ?? []).filter((c) => c.status === s || (s === "new" && c.status === "approved")).length;
  const noProfiles = !profiles.isLoading && (profiles.data ?? []).length === 0;

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">AI Lead Finder</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Describe the customers you want — the agent finds companies on the public web, checks each one's email provider (on Workspace or not) and
            website, scores it and writes a pitch. A lead is created only when you approve. No Google Maps scraping — legitimate sources only.
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setEditing({ ...EMPTY })}>New profile</Button>
      </header>

      {/* Profiles */}
      {profiles.isLoading ? <Skeleton className="h-20 rounded-lg" /> : noProfiles && !editing ? (
        <Card className="p-6">
          <EmptyState icon="search" title="Create your first profile" body="For example: Gurgaon / Delhi NCR · CA firms, real estate, manufacturing · 10–200 people · Workspace + website. 20 new companies every night." />
          <div className="mt-3 text-center"><Button variant="primary" onClick={() => setEditing({ ...EMPTY, name: "SME Delhi NCR", cities: "Gurgaon, Delhi NCR, Noida", industries: "IT services, CA / law firms, real estate, manufacturing, clinics, schools" })}>Start from example</Button></div>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(profiles.data ?? []).map((p) => <ProfileCard key={p.id} p={p} onEdit={() => setEditing({ ...p })} onRun={() => run.mutate(p.id)} running={run.isPending && run.variables === p.id} />)}
        </div>
      )}
      {editing && <ProfileForm value={editing} onClose={() => setEditing(null)} />}

      {/* Candidates */}
      <Card className="p-0 overflow-hidden">
        <div className="p-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-ink">Companies found</p>
            <p className="text-xs text-ink-3">Score comes from signals (not on Workspace, no SSL, old site…). Review only shows companies whose phone or email was found on their website. Approve → a lead in Sales &amp; Pipeline, source &quot;AI Lead Finder&quot;.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, domain, city…" className="w-56" aria-label="Search" />
            <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="h-9 rounded-md border border-hairline bg-paper px-2 text-sm" aria-label="Minimum score">
              <option value={0}>Any score</option><option value={50}>50+</option><option value={70}>70+</option>
            </select>
            <Button size="sm" variant="outline" icon="search" onClick={() => findContacts.mutate({})} loading={findContacts.isPending}
              title="Read email/phone from the company website for companies not checked yet (25 at a time)">Find contacts</Button>
            <Button size="sm" variant="outline" icon="search" onClick={() => searchPeople.mutate({})} loading={searchPeople.isPending}
              title="Where the website shows no name, look up the owner/director in public records (MCA, ICAI, news) — 10 at a time, one Google search per company">Find names</Button>
          </div>
        </div>
        <div className="px-4">
          <TabBar value={tab} onChange={(v) => setTab(v as Tab)} items={[{ id: "new", label: "Review", count: count("new") || undefined, dot: count("new") ? "amber" : undefined }, { id: "converted", label: "Became lead", count: count("converted") || undefined }, { id: "rejected", label: "Rejected", count: count("rejected") || undefined }]} />
        </div>
        {candidates.isLoading ? <div className="p-4"><Skeleton className="h-20 rounded-lg" /></div> : list.length === 0 ? (
          <div className="p-4"><EmptyState icon="search" title={tab === "new" ? "Nothing to review" : "Nothing here"} body={tab === "new" ? "Press \"Run now\" on a profile, or wait for the nightly run." : ""} /></div>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((c) => (
              <CandidateRow key={c.id} c={c}
                onApprove={() => approve.mutate(c)} onReject={() => reject.mutate({ id: c.id })} onUndo={() => reject.mutate({ id: c.id, undo: true })}
                onFindContact={() => findContacts.mutate({ ids: [c.id], force: true })} finding={findContacts.isPending || searchPeople.isPending}
                onFindPerson={() => searchPeople.mutate({ ids: [c.id] })}
                busy={approve.isPending || reject.isPending} />
            ))}
          </ul>
        )}
      </Card>

      {(runs.data?.length ?? 0) > 0 && (
        <details className="text-xs text-ink-3">
          <summary className="cursor-pointer select-none">Run history ({runs.data!.length})</summary>
          <ul className="mt-2 space-y-1">
            {runs.data!.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3">
                <span className="tabular-nums">{formatDate(r.started_at)}</span><span>{r.trigger}</span>
                <span className={r.ok === false ? "text-rose-ink" : r.ok ? "text-emerald" : ""}>{r.ok === null ? "running…" : r.ok ? "ok" : "failed"}</span>
                <span>{r.discovered} found · {r.skipped_dupe} already known · {r.saved} new</span>{r.error && <span className="text-rose-ink">{r.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ProfileCard({ p, onEdit, onRun, running }: { p: FinderProfileRow; onEdit: () => void; onRun: () => void; running: boolean }) {
  const save = useSaveFinderProfile();
  return (
    <Card className={cn("p-4", !p.enabled && "opacity-70")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink truncate">{p.name}</p>
          <p className="text-xs text-ink-3 mt-0.5">{p.cities || "India"} · {p.industries || "any industry"} · {p.company_size}</p>
          <p className="text-xs text-ink-3 mt-1">{p.products.map((k) => PRODUCT_LABEL[k]?.split(" (")[0] ?? k).join(", ")} · {p.daily_limit}/day · {p.last_run_at ? `last run ${formatDate(p.last_run_at)}` : "never run"}</p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-3 shrink-0"><Switch checked={p.enabled} onCheckedChange={(v) => save.mutate({ ...p, enabled: v })} aria-label="Nightly run" /> nightly</label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" icon="search" onClick={onRun} loading={running}>{running ? "Searching…" : "Run now"}</Button>
        <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
      </div>
    </Card>
  );
}

function ProfileForm({ value, onClose }: { value: FinderProfileInput; onClose: () => void }) {
  const [v, setV] = React.useState(value);
  const save = useSaveFinderProfile();
  const del = useDeleteFinderProfile();
  const confirm = useConfirm();
  const set = <K extends keyof FinderProfileInput>(k: K, x: FinderProfileInput[K]) => setV((s) => ({ ...s, [k]: x }));
  const toggleProduct = (k: string) => set("products", v.products.includes(k) ? v.products.filter((x) => x !== k) : [...v.products, k]);
  const ok = v.name.trim().length >= 2 && v.products.length > 0;
  return (
    <Card className="p-4 border-amber/40 space-y-3">
      <p className="text-sm font-semibold text-ink">{v.id ? "Edit profile" : "New profile"} — what kind of customers?</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-ink-2">Name<Input value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="SME Delhi NCR" /></label>
        <label className="text-xs text-ink-2">City / area<Input value={v.cities} onChange={(e) => set("cities", e.target.value)} placeholder="Gurgaon, Delhi NCR, Noida" /></label>
        <label className="text-xs text-ink-2 md:col-span-2">Industry<Input value={v.industries} onChange={(e) => set("industries", e.target.value)} placeholder="IT services, CA / law firms, real estate, manufacturing, clinics" /></label>
        <label className="text-xs text-ink-2">Company size<Input value={v.company_size} onChange={(e) => set("company_size", e.target.value)} placeholder="10-200 employees" /></label>
        <label className="text-xs text-ink-2">New companies per day<Input type="number" min={1} max={200} value={v.daily_limit} onChange={(e) => set("daily_limit", Math.max(1, Math.min(200, Number(e.target.value) || 1)))} /></label>
        <div className="text-xs text-ink-2 md:col-span-2">What to sell
          <div className="mt-1 flex flex-wrap gap-2">
            {PRODUCTS.map((k) => <button key={k} type="button" onClick={() => toggleProduct(k)} className={cn("rounded-full border px-3 py-1 text-xs", v.products.includes(k) ? "bg-amber-soft border-amber text-amber-ink" : "border-hairline text-ink-3")}>{PRODUCT_LABEL[k]}</button>)}
          </div>
        </div>
        <label className="text-xs text-ink-2">Must have (optional)<Textarea rows={2} value={v.must_have} onChange={(e) => set("must_have", e.target.value)} placeholder="own domain, 2+ years old, hiring" /></label>
        <label className="text-xs text-ink-2">Exclude (optional)<Textarea rows={2} value={v.exclude} onChange={(e) => set("exclude", e.target.value)} placeholder="MNC, government, IT resellers (competitors)" /></label>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" onClick={() => save.mutate(v, { onSuccess: onClose })} loading={save.isPending} disabled={!ok}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {v.id && <Button variant="ghost" className="text-rose ml-auto" onClick={async () => { if (await confirm({ title: "Delete profile?", body: "Companies already found stay; only the profile is removed." })) del.mutate(v.id!, { onSuccess: onClose }); }}>Delete</Button>}
      </div>
      <p className="text-xs text-ink-3">Every enabled profile runs nightly at 03:30. The Gemini API key is set in Settings → Integrations → AI; each run uses ~2 AI calls + {v.daily_limit} DNS/website checks.</p>
    </Card>
  );
}

function CandidateRow({ c, onApprove, onReject, onUndo, onFindContact, onFindPerson, busy, finding }: { c: FinderCandidate; onApprove: () => void; onReject: () => void; onUndo: () => void; onFindContact: () => void; onFindPerson: () => void; busy: boolean; finding: boolean }) {
  const [open, setOpen] = React.useState(false);
  const contact = readContact(c.signals);
  const score = c.score ?? 0;
  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        <div className={cn("shrink-0 w-12 h-12 rounded-lg flex items-center justify-center font-serif text-xl tabular-nums", score >= 70 ? "bg-emerald-soft text-emerald" : score >= 50 ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-3")}>{score}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">{c.company}</span>
            <a href={c.website ?? `https://${c.domain}`} target="_blank" rel="noreferrer" className="text-xs text-ink-3 underline">{c.domain}</a>
            {c.city && <span className="text-xs text-ink-3">· {c.city}</span>}
            {c.product && <Badge kind="info" size="sm">{PRODUCT_LABEL[c.product]?.split(" (")[0] ?? c.product}</Badge>}
            {c.status === "converted" && c.lead_id && <Link href={`/leads?lead=${c.lead_id}` as Route} className="text-xs underline text-emerald">Lead {c.lead_id} →</Link>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span className={cn(c.on_workspace === false ? "text-emerald" : c.on_workspace ? "text-rose" : "text-ink-3")}>✉ {c.mx_provider ? MX_LABEL[c.mx_provider] : "—"}</span>
            <span className={cn(c.site_https === false ? "text-emerald" : "text-ink-3")}>🌐 {c.site_note ?? "—"}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {contact?.person && (
              <span className="text-ink font-medium" title={contact.person.from === "email" ? "Name guessed from the email address — confirm on a call" : contact.person.from === "search" ? "From public records (MCA / ICAI / news) — may be out of date, confirm on a call" : "Shown on the company website"}>
                👤 {contact.person.name}{contact.person.role ? ` · ${contact.person.role}` : ""}{contact.person.from === "email" ? " (from email)" : contact.person.from === "search" ? (contact.person.verified === false ? " (from search · link not verified)" : " (from search)") : ""}
              </span>
            )}
            {contact?.person?.from === "search" && contact.person.source_url && <a href={contact.person.source_url} target="_blank" rel="noreferrer" className="text-ink-3 underline">name source</a>}
            {contact && (contact.email || contact.phone) && !contact.person && (
              <button type="button" className="text-amber-ink underline disabled:opacity-50" onClick={onFindPerson} disabled={finding}>
                {contact.person_searched ? "No name found — search again" : "Find name"}
              </button>
            )}
            {contact?.email && <a href={`mailto:${contact.email}`} className="text-ink underline">✉ {contact.email}</a>}
            {contact?.phone && <a href={`tel:${contact.phone}`} className="text-ink underline tabular-nums">☎ {contact.phone}</a>}
            {contact && !contact.email && !contact.phone && <span className="text-amber-ink">{(c.signals as { auto_rejected?: string } | null)?.auto_rejected ? "Auto-rejected — no email/phone on the website" : "No email/phone on the website"}</span>}
            {!contact && <span className="text-ink-3">Contact not checked</span>}
            {(!contact || (!contact.email && !contact.phone)) && (
              <button type="button" className="text-amber-ink underline disabled:opacity-50" onClick={onFindContact} disabled={finding}>{contact ? "Check again" : "Find contact"}</button>
            )}
            {contact?.source_url && <a href={contact.source_url} target="_blank" rel="noreferrer" className="text-ink-3 underline">source</a>}
          </div>
          {c.fit_reason && <p className="text-sm text-ink-2 mt-1">{c.fit_reason}</p>}
          {open && (
            <div className="mt-2 text-xs text-ink-2 space-y-1 rounded-md bg-paper-2 p-3">
              {c.description && <p><b>About:</b> {c.description}</p>}
              {c.pitch && <p><b>Pitch:</b> {c.pitch}</p>}
              {contact && (contact.emails.length > 1 || contact.phones.length > 1) && <p><b>More contacts:</b> {[...contact.emails.slice(1), ...contact.phones.slice(1)].join(" · ")}</p>}
              {c.source_url && <p><b>Source:</b> <a href={c.source_url} target="_blank" rel="noreferrer" className="underline break-all">{c.source_url}</a></p>}
              <p className="text-ink-3">Found {formatDate(c.created_at)}</p>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {c.status === "new" || c.status === "approved" ? (
              <>
                <Button size="sm" variant="primary" icon="check" onClick={onApprove} disabled={busy}>Approve → lead</Button>
                <Button size="sm" variant="ghost" onClick={onReject} disabled={busy}>Reject</Button>
              </>
            ) : c.status === "rejected" ? (
              <Button size="sm" variant="ghost" onClick={onUndo} disabled={busy}>Back to review</Button>
            ) : null}
            <button type="button" className="text-xs text-ink-3 underline" onClick={() => setOpen((v) => !v)}>{open ? COPY.showLess : "Pitch & details"}</button>
          </div>
        </div>
      </div>
    </li>
  );
}
