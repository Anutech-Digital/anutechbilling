/**
 * AI Lead Finder — the run. Discovery (Gemini + Google Search grounding) → dedupe against
 * leads, customers and earlier candidates → public signals (MX via DNS-over-HTTPS, website
 * fetch, published contacts from the company's own site) → baseline score + AI wording →
 * lead_finder_candidates. A run never touches `leads`; only enrichCandidateContacts fills an
 * already-approved lead's empty email/phone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveGeminiConfig, geminiJson, geminiGroundedText } from "@/lib/ai/gemini";
import { resolveDoh, DNS_TYPE } from "@/lib/dns/doh";
import { cronTenantAllowed } from "@/lib/automation/cron-gate";
import {
  discoveryPrompt, parseDiscovery, mxProvider, siteNote, baselineScore, scoringPrompt, mergeScores, spreadByIndustryCity,
  type FinderProfile, type DiscoveredCompany, type ScoreInput, type SiteAudit, type MxProvider,
} from "@/lib/leads/lead-finder";
import {
  CONTACT_PATHS, contactBonus, extractContacts, nameFromEmail, pageText, parsePersonSearch, personIsGrounded, personPrompt, personSearchPrompt, pickEmail, pickPhone,
  reachable, readContact, roleSnippets, sourceVerdict, teamLinks, type ContactResult, type ContactPerson,
} from "@/lib/leads/lead-contacts";

type Admin = SupabaseClient<Database>;

export interface FinderRunResult { discovered: number; skippedDupe: number; saved: number; noContact: number; errors: string[] }

async function mxLookup(domain: string): Promise<{ provider: MxProvider; hosts: string[] | null }> {
  const r = await resolveDoh(domain, DNS_TYPE.MX, 5000);
  if (!r.ok) return r.kind === "nxdomain" ? { provider: "none", hosts: [] } : { provider: "unknown", hosts: null };
  return { provider: mxProvider(r.data), hosts: r.data };
}

async function probe(url: string): Promise<{ ok: boolean; status: number | null; server: string | null; generator: string | null; title: string | null }> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; ResellerOS-LeadFinder/1.0)" } });
    let generator: string | null = null, title: string | null = null;
    if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
      const html = (await res.text()).slice(0, 60_000);
      generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1] ?? null;
      title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim() ?? null;
    }
    return { ok: res.ok, status: res.status, server: res.headers.get("server"), generator, title };
  } catch { return { ok: false, status: null, server: null, generator: null, title: null }; }
}

const UA = { "user-agent": "Mozilla/5.0 (compatible; ResellerOS-LeadFinder/1.0)" };

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000), headers: UA });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    return (await res.text()).slice(0, 200_000);
  } catch { return null; }
}

type Snip = { url: string; text: string };
/** Contacts plus the role-word snippets the contact-person step reads (not stored). */
export type SiteScan = ContactResult & { snippets: Snip[] };

/** Read the company's own site — home, up to 3 contact pages, up to 2 team pages — for published contacts and names. At most 6 fetches. */
export async function findContacts(domain: string, website?: string | null): Promise<SiteScan> {
  const emails: string[] = [], phones: string[] = [];
  const snippets: Snip[] = [];
  const fetched = new Set<string>();
  let source: string | null = null;
  const take = (html: string, url: string) => {
    fetched.add(url);
    for (const text of roleSnippets(pageText(html), 4)) if (snippets.length < 8) snippets.push({ url, text });
    const got = extractContacts(html, domain);
    const before = emails.length + phones.length;
    for (const e of got.emails) if (!emails.includes(e)) emails.push(e);
    for (const ph of got.phones) if (!phones.includes(ph)) phones.push(ph);
    if (!source && emails.length + phones.length > before) source = url;
  };

  // Home page; a site with no working HTTPS is tried once over HTTP.
  let base = `https://${domain}`;
  let home = website || base;
  let html = await fetchHtml(home);
  if (!html) { base = `http://${domain}`; home = base; html = await fetchHtml(home); }
  if (html) take(html, home);
  else return { email: null, phone: null, emails: [], phones: [], source_url: null, checked_at: new Date().toISOString(), snippets };

  // Then up to 3 contact/about pages, stopping once we have both an email and a phone.
  for (const path of CONTACT_PATHS.slice(0, 3)) {
    if (emails.length && phones.length) break;
    const url = base + path;
    const page = await fetchHtml(url);
    if (page) take(page, url);
  }
  // Where the firm lists its people: up to 2 team/people/partners pages the home page links
  // to; only if it links none, the usual paths. Names were mostly found there (29 Sep).
  const linked = teamLinks(html, home).filter((u) => !fetched.has(u));
  const guesses = ["/team", "/our-team", "/about-us", "/about"].map((p) => base + p).filter((u) => !fetched.has(u));
  let teamPages = 0;
  for (const url of linked.length ? linked : guesses) {
    if (teamPages >= 2) break;
    const page = await fetchHtml(url);
    if (page) { take(page, url); teamPages++; }
  }
  return { email: pickEmail(emails, domain), phone: pickPhone(phones), emails: emails.slice(0, 5), phones: phones.slice(0, 5), source_url: source, checked_at: new Date().toISOString(), snippets };
}

/** Open a cited page. `finalUrl` is where it landed — grounding links are Google redirects that expire. */
async function checkSource(url: string, name: string): Promise<{ verdict: "ok" | "blocked" | "bad"; finalUrl: string }> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: UA });
    const body = res.ok ? (await res.text()).slice(0, 400_000) : null;
    return { verdict: sourceVerdict(res.status, body, name), finalUrl: res.url || url };
  } catch { return { verdict: sourceVerdict(null, null, name), finalUrl: url }; }
}

/** SiteScan → what is stored: the snippets stay out of the database. */
function stored(scan: SiteScan): ContactResult { const { snippets: _s, ...c } = scan; return c; }

/**
 * Contact person for many companies in ONE AI call. A name the model returns is kept only if
 * it is written in the snippets sent for that company; otherwise a first.last@ email gives a
 * name marked "from: email". Without an AI key only the email rule runs.
 */
export async function attachPersons(ai: { apiKey: string; model: string } | null, items: { company: string; scan: SiteScan }[], onFailure?: (why: string) => void): Promise<void> {
  const ask = items.map((x, i) => ({ i, company: x.company, snippets: x.scan.snippets.map((s) => s.text) })).filter((x) => x.snippets.length);
  let picked: { i: number; name: string | null; role: string | null }[] = [];
  if (ai?.apiKey && ask.length) {
    const pp = personPrompt(ask);
    const res = await geminiJson<unknown>({ apiKey: ai.apiKey, model: ai.model, system: pp.system, user: pp.user, temperature: 0, timeoutMs: 30_000, label: "leads/finder-person", onFailure });
    if (Array.isArray(res)) picked = res.filter((r): r is { i: number; name: string | null; role: string | null } => !!r && typeof (r as { i?: unknown }).i === "number");
  }
  items.forEach((x, i) => {
    const got = picked.find((p) => p.i === i);
    let person: ContactPerson | null = null;
    if (got?.name && personIsGrounded(got.name, x.scan.snippets.map((s) => s.text))) {
      const src = x.scan.snippets.find((s) => s.text.toLowerCase().includes(got.name!.trim().toLowerCase().split(" ").slice(-1)[0]))?.url ?? null;
      person = { name: got.name.trim().replace(/\s+/g, " ").slice(0, 80), role: got.role?.trim().slice(0, 60) || null, from: "page", source_url: src };
    } else {
      const guess = nameFromEmail(x.scan.email);
      if (guess) person = { name: guess, role: null, from: "email", source_url: x.scan.source_url };
    }
    x.scan.person = person;
    x.scan.person_checked = true;
  });
}

/**
 * Contacts for candidates found before this step existed (or re-check one). Fills the
 * lead too when the candidate was already approved and the lead has no email/phone yet.
 */
export async function enrichCandidateContacts(admin: Admin, tenantId: string, opts: { ids?: string[]; limit?: number; force?: boolean } = {}): Promise<{ checked: number; found: number; removed: number }> {
  let q = admin.from("lead_finder_candidates").select("id, domain, website, signals, lead_id, status").eq("tenant_id", tenantId);
  // A re-check of one card may be an auto-rejected one; the bulk pass skips anything rejected.
  q = opts.ids?.length ? q.in("id", opts.ids) : q.neq("status", "rejected");
  const { data } = await q.order("score", { ascending: false }).limit(200);
  // Never checked; checked before the contact-person step existed; or still unreachable
  // while sitting in Review (sites add a contact page later).
  const todo = (data ?? []).filter((c) => {
    const prev = readContact(c.signals);
    return opts.force || !prev || !prev.person_checked || (c.status === "new" && !reachable(prev));
  }).slice(0, opts.limit ?? 25);

  const scans: { c: (typeof todo)[number]; scan: SiteScan }[] = [];
  for (let i = 0; i < todo.length; i += 4) {
    scans.push(...await Promise.all(todo.slice(i, i + 4).map(async (c) => ({ c, scan: await findContacts(c.domain, c.website) }))));
  }
  const ai = await resolveGeminiConfig(admin, tenantId);
  const { data: names } = await admin.from("lead_finder_candidates").select("id, company").in("id", todo.map((c) => c.id));
  await attachPersons(ai.apiKey ? { apiKey: ai.apiKey, model: ai.model } : null,
    scans.map((x) => ({ company: names?.find((n) => n.id === x.c.id)?.company ?? x.c.domain, scan: x.scan })));

  let found = 0, removed = 0;
  for (const { c, scan } of scans) {
    const contact = stored(scan);
    if (contact.email || contact.phone) found++;
    else if (c.status === "new") removed++;
    const prev = (c.signals as Record<string, unknown>) ?? {};
    const ok = reachable(contact);
    const signals: Record<string, unknown> = { ...prev, contact };
    // Same rule as a run: nothing to call or write to → out of Review; found later → back in.
    let status = c.status;
    if (!ok && c.status === "new") { status = "rejected"; signals.auto_rejected = "no-contact"; }
    if (ok && c.status === "rejected" && prev.auto_rejected) { status = "new"; delete signals.auto_rejected; }
    await admin.from("lead_finder_candidates").update({ signals: signals as never, status }).eq("id", c.id).eq("tenant_id", tenantId);
    if (c.lead_id) await fillLead(admin, tenantId, c.lead_id, contact);
  }
  return { checked: todo.length, found, removed };
}

/** Put what we learned onto an already-approved lead: empty contact fields, and the name on its open tasks. */
async function fillLead(admin: Admin, tenantId: string, leadId: string, contact: ContactResult): Promise<void> {
  if (!contact.email && !contact.phone && !contact.person) return;
  const { data: lead } = await admin.from("leads").select("contact_email, contact_phone, contact_name").eq("id", leadId).eq("tenant_id", tenantId).maybeSingle();
  if (!lead) return;
  const patch: { contact_email?: string; contact_phone?: string; contact_name?: string } = {};
  if (!lead.contact_email && contact.email) patch.contact_email = contact.email;
  if (!lead.contact_phone && contact.phone) patch.contact_phone = contact.phone;
  if (!lead.contact_name && contact.person) patch.contact_name = contact.person.name;
  if (Object.keys(patch).length) await admin.from("leads").update(patch).eq("id", leadId).eq("tenant_id", tenantId);
  // The approve-time call/email task was written before we knew who to ask for.
  if (!contact.person) return;
  const { data: open } = await admin.from("tasks").select("id, notes").eq("tenant_id", tenantId).eq("lead_id", leadId).eq("status", "pending");
  for (const t of open ?? []) {
    if ((t.notes ?? "").includes("Kisse baat karni hai")) continue;
    const p = contact.person;
    const who = `Kisse baat karni hai: ${p.name}${p.role ? ` (${p.role})` : ""}${p.from === "email" ? " — naam email se andaza hai" : p.from === "search" ? ` — public record se, call par confirm karo (${p.source_url ?? ""})` : ""}`;
    const rest = (t.notes ?? "").split("\n").filter((l) => !l.startsWith("Naam nahi pata")).join("\n");
    await admin.from("tasks").update({ notes: rest ? `${who}\n${rest}` : who }).eq("id", t.id).eq("tenant_id", tenantId);
  }
}

/**
 * Contact person from public records for reachable companies whose own site names nobody.
 * One grounded search per company (it costs), so each company is searched once — pass ids
 * to search specific cards again. At most `limit` per call.
 */
export async function searchPeople(admin: Admin, tenantId: string, opts: { ids?: string[]; limit?: number } = {}): Promise<{ searched: number; found: number }> {
  const ai = await resolveGeminiConfig(admin, tenantId);
  if (!ai.apiKey) throw new Error("Name search needs a Gemini key — Settings → Integrations → AI.");
  let q = admin.from("lead_finder_candidates").select("id, company, domain, city, signals, lead_id, status").eq("tenant_id", tenantId).neq("status", "rejected");
  if (opts.ids?.length) q = q.in("id", opts.ids);
  const { data } = await q.order("score", { ascending: false }).limit(200);
  const todo = (data ?? []).filter((c) => {
    const k = readContact(c.signals);
    return k && reachable(k) && !k.person && (opts.ids?.length || !k.person_searched);
  }).slice(0, opts.limit ?? 10);

  let found = 0;
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (c) => {
      const pp = personSearchPrompt({ company: c.company, domain: c.domain, city: c.city });
      const text = await geminiGroundedText({ apiKey: ai.apiKey!, model: ai.model, system: pp.system, user: pp.user, temperature: 0, timeoutMs: 45_000, label: "leads/finder-person-search" }).catch(() => null);
      let hit = parsePersonSearch(text, c.company);
      // Open the cited page: a made-up link (it happened — a Tracxn 404) takes its name with it.
      let verified = false;
      if (hit) {
        const { verdict, finalUrl } = await checkSource(hit.source_url, hit.name);
        if (verdict === "bad") hit = null;
        else hit = { ...hit, source_url: finalUrl.slice(0, 500) };
        verified = verdict === "ok";
      }
      const contact: ContactResult = { ...readContact(c.signals)!, person_searched: true, ...(hit ? { person: { name: hit.name, role: hit.role, from: "search" as const, source_url: hit.source_url, verified } } : {}) };
      if (hit) found++;
      const signals = { ...((c.signals as Record<string, unknown>) ?? {}), contact };
      await admin.from("lead_finder_candidates").update({ signals: signals as never }).eq("id", c.id).eq("tenant_id", tenantId);
      if (hit && c.lead_id) await fillLead(admin, tenantId, c.lead_id, contact);
    }));
  }
  return { searched: todo.length, found };
}

async function auditSite(domain: string): Promise<SiteAudit> {
  const https = await probe(`https://${domain}`);
  const http = https.ok ? { ok: true, status: https.status, server: https.server, generator: https.generator, title: https.title } : await probe(`http://${domain}`);
  return siteNote({ httpsOk: https.ok, httpOk: http.ok, status: https.status ?? http.status, server: https.server ?? http.server, generator: https.generator ?? http.generator, title: https.title ?? http.title });
}

async function knownDomains(admin: Admin, tenantId: string): Promise<Set<string>> {
  const [leads, customers, cands] = await Promise.all([
    admin.from("leads").select("domain, contact_email").eq("tenant_id", tenantId),
    admin.from("customers").select("domain, contact_email").eq("tenant_id", tenantId),
    admin.from("lead_finder_candidates").select("domain").eq("tenant_id", tenantId),
  ]);
  const out = new Set<string>();
  const add = (d: string | null | undefined) => { const x = d?.trim().toLowerCase().replace(/^www\./, ""); if (x) out.add(x); };
  for (const r of leads.data ?? []) { add(r.domain); add(r.contact_email?.split("@")[1]); }
  for (const r of customers.data ?? []) { add(r.domain); add(r.contact_email?.split("@")[1]); }
  for (const r of cands.data ?? []) add(r.domain);
  return out;
}

export async function runLeadFinder(admin: Admin, tenantId: string, profileId: string, trigger: "manual" | "cron"): Promise<FinderRunResult> {
  const { data: profile } = await admin.from("lead_finder_profiles").select("*").eq("id", profileId).eq("tenant_id", tenantId).maybeSingle();
  if (!profile) throw new Error("Profile not found.");
  const { data: run } = await admin.from("lead_finder_runs").insert({ tenant_id: tenantId, profile_id: profileId, trigger }).select("id").single();
  const result: FinderRunResult = { discovered: 0, skippedDupe: 0, saved: 0, noContact: 0, errors: [] };
  const finish = async (ok: boolean, error?: string) => {
    if (run?.id) await admin.from("lead_finder_runs").update({ finished_at: new Date().toISOString(), ok, error: error ?? (result.errors.join(" | ") || null), discovered: result.discovered, skipped_dupe: result.skippedDupe, saved: result.saved }).eq("id", run.id);
    await admin.from("lead_finder_profiles").update({ last_run_at: new Date().toISOString() }).eq("id", profileId);
  };

  try {
    const cfg = await resolveGeminiConfig(admin, tenantId);
    if (!cfg.apiKey) {
      // dev:local blanks every live key on purpose (scripts/dev-local.mjs), so on a laptop
      // "go to Settings" sends people hunting for a key that was switched off deliberately.
      throw new Error(process.env.NEXT_PUBLIC_APP_ENV === "local"
        ? "AI is off in local mode (dev:local). To test AI, add a Gemini key in this app's Settings → Integrations → AI."
        : "No Gemini API key — add one in Settings → Integrations → AI.");
    }
    const p: FinderProfile = { name: profile.name, cities: profile.cities, industries: profile.industries, company_size: profile.company_size, products: profile.products, must_have: profile.must_have, exclude: profile.exclude, daily_limit: profile.daily_limit };
    const known = await knownDomains(admin, tenantId);

    // Ask for well over the cap: some are duplicates, and about a third publish no phone/email.
    const want = Math.min(60, Math.ceil(p.daily_limit * 2.5));
    const dp = discoveryPrompt(p, [...known].slice(-150), want);
    const text = await geminiGroundedText({ apiKey: cfg.apiKey, model: cfg.model, system: dp.system, user: dp.user, label: "leads/finder-discovery" });
    const found: DiscoveredCompany[] = parseDiscovery(text);
    result.discovered = found.length;
    if (found.length === 0) { await finish(false, "Gemini found no companies — make the profile more specific (city + industry)."); return result; }

    // Industry × city round-robin, so the day's limit is a mix even if the answer is lopsided.
    const fresh = spreadByIndustryCity(found.filter((c) => !known.has(c.domain)));
    result.skippedDupe = found.length - fresh.length;

    // Signals, a few at a time (DNS + site + contact pages each). Keep going until the day's
    // cap of REACHABLE companies is met; the unreachable ones are still saved (so they are not
    // suggested again) but straight into Rejected, with the reason on the card.
    const batch: DiscoveredCompany[] = [];
    const inputs: ScoreInput[] = [];
    const extras: { mx_hosts: string[] | null; site: SiteAudit; contact: SiteScan }[] = [];
    const maxChecks = Math.min(fresh.length, p.daily_limit * 3, 60);
    let reachableCount = 0;
    for (let i = 0; i < maxChecks && reachableCount < p.daily_limit; i += 5) {
      const chunk = fresh.slice(i, Math.min(i + 5, maxChecks));
      const sig = await Promise.all(chunk.map(async (c) => ({ mx: await mxLookup(c.domain), site: await auditSite(c.domain), contact: await findContacts(c.domain, c.website) })));
      chunk.forEach((c, k) => {
        if (reachable(sig[k].contact)) { if (reachableCount >= p.daily_limit) return; reachableCount++; }
        batch.push(c);
        inputs.push({ company: c.company, domain: c.domain, city: c.city ?? null, description: c.description ?? null, mx: sig[k].mx.provider, site: sig[k].site, products: p.products });
        extras.push({ mx_hosts: sig[k].mx.hosts, site: sig[k].site, contact: sig[k].contact });
      });
    }

    // Who to ask for — one AI call for the reachable ones; unreachable go to Rejected anyway.
    const withContact = extras.map((x, k) => ({ company: inputs[k].company, scan: x.contact })).filter((x) => reachable(x.scan));
    await attachPersons(cfg.apiKey ? { apiKey: cfg.apiKey, model: cfg.model } : null, withContact, (why) => result.errors.push(`Contact person skip: ${why}`));

    const baselines = inputs.map(baselineScore);
    const sp = scoringPrompt(inputs, baselines);
    const ai = inputs.length ? await geminiJson<unknown>({ apiKey: cfg.apiKey, model: cfg.model, system: sp.system, user: sp.user, temperature: 0.3, timeoutMs: 45_000, label: "leads/finder-score", onFailure: (why) => result.errors.push(`AI scoring skip: ${why}`) }) : null;
    const scores = mergeScores(inputs, baselines, ai);

    const rows = inputs.map((inp, k) => {
      const ok = reachable(extras[k].contact);
      return {
      tenant_id: tenantId, profile_id: profileId, run_id: run?.id ?? null,
      company: inp.company, domain: inp.domain, website: batch[k].website ?? `https://${inp.domain}`, city: inp.city, description: inp.description, source_url: batch[k].source_url ?? null,
      mx_provider: inp.mx, on_workspace: inp.mx === "google" ? true : inp.mx === "unknown" ? null : false,
      site_https: inp.site.https, site_status: inp.site.status, site_note: inp.site.note,
      signals: ok
        ? { mx_hosts: extras[k].mx_hosts, server: extras[k].site.server ?? null, generator: extras[k].site.generator ?? null, contact: stored(extras[k].contact) }
        : { mx_hosts: extras[k].mx_hosts, server: extras[k].site.server ?? null, generator: extras[k].site.generator ?? null, contact: stored(extras[k].contact), auto_rejected: "no-contact" },
      score: Math.min(100, scores[k].score + contactBonus(extras[k].contact)), product: scores[k].product, fit_reason: scores[k].fit_reason, pitch: scores[k].pitch,
      status: (ok ? "new" : "rejected") as "new" | "rejected",
      };
    });
    result.noContact = rows.filter((r) => r.status === "rejected").length;
    if (rows.length) {
      const { error } = await admin.from("lead_finder_candidates").upsert(rows, { onConflict: "tenant_id,domain", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      result.saved = rows.length - result.noContact;
    }
    await finish(result.errors.length === 0);
    return result;
  } catch (e) {
    await finish(false, (e as Error).message);
    throw e;
  }
}

/** Every enabled profile of every tenant — the nightly cron. */
export async function runAllLeadFinders(admin: Admin): Promise<{ profiles: number; saved: number; errors: string[] }> {
  const { data: profiles } = await admin.from("lead_finder_profiles").select("id, tenant_id").eq("enabled", true);
  const out = { profiles: 0, saved: 0, errors: [] as string[] };
  for (const p of profiles ?? []) {
    /* R-897 */ if (!cronTenantAllowed(p.tenant_id)) continue;
    try { const r = await runLeadFinder(admin, p.tenant_id, p.id, "cron"); out.profiles++; out.saved += r.saved; out.errors.push(...r.errors); }
    catch (e) { out.errors.push(`${p.id}: ${(e as Error).message}`); }
  }
  return out;
}
