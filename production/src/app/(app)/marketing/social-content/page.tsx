"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { ArrowUpRight, Bot, Check, Facebook, ImagePlus, Instagram, Linkedin, Send, Sparkles, User } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingPageHeader } from "@/components/features/marketing-hub/workspace-links";
import { formatIst, quickTimes, toIstLocal } from "@/lib/marketing/social-schedule";
import { pagePhotoId } from "@/lib/marketing/social-autopilot";
import { LENGTHS, POST_TYPES, type StrategyPlan, type StrategyPlatform } from "@/lib/marketing/social-strategy";

type Platform = "facebook" | "instagram";
type Item = { id: string; platform: Platform; format: "post" | "story"; caption: string; media_url: string | null;
  topic: string; origin: string; status: string; created_at: string; published_at: string | null; error: string | null;
  scheduled_at: string | null; media_preview?: string | null; post_type?: string | null;
  stats?: { reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null } | null };
type StrategyRow = { platform: StrategyPlatform; version: number; plan: StrategyPlan; reason: string; created_by: string | null; created_at: string };
type Strategies = Record<StrategyPlatform, { active: StrategyRow | null; proposed: StrategyRow | null }>;
const PLATFORM_NAME: Record<StrategyPlatform, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };
const hourText = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
/** R-2706: a post's results in words. */
function statsLine(st: NonNullable<Item["stats"]>): string {
  const parts: string[] = [];
  const add = (n: number | null, one: string, many: string) => { if (n !== null) parts.push(`${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`); };
  add(st.reach, "person reached", "people reached"); add(st.likes, "like", "likes"); add(st.comments, "comment", "comments"); add(st.shares, "share", "shares"); add(st.saves, "save", "saves");
  return parts.join(" · ");
}
type Activity = { id: string; at: string; actor: "ai" | "person" | "system"; user_name: string | null; platform: string | null;
  action: string; detail: string; content_id: string | null; result: "ok" | "failed" | "waiting" };
type State = { items: Item[]; canReview: boolean; canManage: boolean; aiReady: boolean;
  facebook: { name: string; id?: string } | null; instagram: { name: string; type: string | null } | null; linkedin: { name: string } | null;
  followers: { facebook: number | null; instagram: number | null }; activity: Activity[]; strategies: Strategies | null;
  trends: Record<StrategyPlatform, Trend> | null; report: { report: Report; summary: string; created_at: string } | null;
  comments: Comment[]; todo: TodoItem[] | null;
  settings: { auto_drafts: boolean; brief: string; autopilot: boolean; posts_per_week: number; picture_urls: string[]; last_generated_on: string | null; ai_paused: boolean;
    comment_mode: "off" | "ask" | "auto"; comments_problem: string | null } };
/* R-2689 / R-2690 / R-2691 */
type Trend = { now: number | null; change7: number | null; change30: number | null; series: { day: string; followers: number }[] };
type Report = { weekStart: string; followers: Record<StrategyPlatform, { now: number | null; change7: number | null }>; posts: { facebook: number; instagram: number };
  best: { platform: string; caption: string; score: number } | null; comments: { received: number; answered: number } };
type Comment = { id: string; platform: Platform; author: string; message: string; commented_at: string | null; kind: string | null; status: "new" | "draft" | "replied" | "failed";
  ai_reply: string | null; reply: string | null; replied_by: "ai" | "person" | null; replied_at: string | null; error: string | null; content_id: string | null };
type TodoItem = { id: string; text: string; why: string; done: boolean; doneBy?: string | null };
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString("en-IN")}` : n.toLocaleString("en-IN"));
/** R-2690: a tiny line of the last 30 days' followers. */
function Sparkline({ series }: { series: Trend["series"] }) {
  if (series.length < 2) return null;
  const vals = series.map((p) => p.followers);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - lo) / span) * 24}`).join(" ");
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-8 w-full" role="img" aria-label={`Followers over the last ${series.length} days: from ${vals[0]} to ${vals[vals.length - 1]}`}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className="text-amber-ink" /></svg>;
}

/* R-2513: the queue is split the way the work is done — what waits for the approver comes first. */
const STRATEGY_KEYS: StrategyPlatform[] = ["facebook", "instagram", "linkedin"];
const TABS = [
  { key: "activity", label: "Activity", match: () => false },
  { key: "comments", label: "Comments", match: () => false },
  { key: "review", label: "Waiting for approval", match: (i: Item) => i.status === "review" },
  { key: "scheduled", label: "Scheduled", match: (i: Item) => i.status === "approved" || i.status === "publishing" },
  { key: "draft", label: "Drafts", match: (i: Item) => i.status === "draft" },
  { key: "published", label: "Posted", match: (i: Item) => i.status === "published" },
  { key: "failed", label: "Needs attention", match: (i: Item) => i.status === "failed" },
] as const;
type TabKey = typeof TABS[number]["key"];
type When = "morning" | "evening" | "custom" | "manual";

const inputClass = "w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent";
const chip = (on: boolean) => `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? "border-ink bg-ink text-paper" : "border-hairline bg-paper text-ink-2 hover:border-ink-3"}`;

export default function SocialContentPage() {
  const [state, setState] = React.useState<State | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<TabKey>("activity");
  const [platforms, setPlatforms] = React.useState<Platform[]>(["facebook"]);
  const [story, setStory] = React.useState(false);
  const [topic, setTopic] = React.useState("");
  /* R-2705: one text per place — the AI writes each from that platform's strategy. */
  const [texts, setTexts] = React.useState<Record<Platform, string>>({ facebook: "", instagram: "" });
  const [mediaUrl, setMediaUrl] = React.useState("");
  const [when, setWhen] = React.useState<When>("morning");
  const [customAt, setCustomAt] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editCaption, setEditCaption] = React.useState("");
  const [editMediaUrl, setEditMediaUrl] = React.useState("");
  const [editPostAt, setEditPostAt] = React.useState("");
  const [confirmPublish, setConfirmPublish] = React.useState<string | null>(null);
  const [brief, setBrief] = React.useState("");
  const [autoDrafts, setAutoDrafts] = React.useState(false);
  /* R-2672: the marketer picks — AI asks first (each post waits for Approve) or AI posts by itself. */
  const [autopilot, setAutopilot] = React.useState(false);
  const [postsPerWeek, setPostsPerWeek] = React.useState(3);
  const [pictures, setPictures] = React.useState("");
  const [aiProblem, setAiProblem] = React.useState<string | null>(null);
  const [planNote, setPlanNote] = React.useState<{ text: string; warn: boolean } | null>(null);
  const [aiWriting, setAiWriting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);
  /* R-2697: AI pictures — which box is waiting for one, and today's link of each new picture. */
  const [picturing, setPicturing] = React.useState<string | null>(null);
  const [pictureProblem, setPictureProblem] = React.useState<{ target: string; text: string } | null>(null);
  const [previews, setPreviews] = React.useState<Record<string, string>>({});
  /* R-2705 / R-2707: strategy editing. */
  const [strategyEdit, setStrategyEdit] = React.useState<{ platform: StrategyPlatform; plan: StrategyPlan } | null>(null);
  /* R-2689: the reply being written per comment (starts as the AI's draft). */
  const [replyText, setReplyText] = React.useState<Record<string, string>>({});
  const [todoBusy, setTodoBusy] = React.useState(false);
  const [showPostSettings, setShowPostSettings] = React.useState(false);
  /* R-2687: one control per AI action — Off / Ask me first / Autopilot (stored as auto_drafts + autopilot). */
  const postsMode: "off" | "ask" | "auto" = !autoDrafts ? "off" : autopilot ? "auto" : "ask";
  function setPostsMode(m: "off" | "ask" | "auto") { setAutoDrafts(m !== "off"); setAutopilot(m === "auto"); if (m !== "off" && !brief.trim()) setShowPostSettings(true); }
  const settingsDirty = Boolean(state) && (autoDrafts !== state!.settings.auto_drafts || autopilot !== Boolean(state!.settings.autopilot) || postsPerWeek !== (state!.settings.posts_per_week || 3) || brief !== state!.settings.brief || pictures !== (state!.settings.picture_urls ?? []).join("\n"));
  const times = React.useMemo(() => quickTimes(), []);

  const load = React.useCallback(async () => {
    const response = await fetch("/api/marketing/social-content", { cache: "no-store" });
    const data = await response.json() as State & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load content.");
    setState(data); setBrief(data.settings.brief); setAutoDrafts(data.settings.auto_drafts); setError(null);
    setAutopilot(Boolean(data.settings.autopilot)); setPostsPerWeek(data.settings.posts_per_week || 3); setPictures((data.settings.picture_urls ?? []).join("\n"));
    return data;
  }, []);
  React.useEffect(() => {
    void load().then((data) => {
      // Open on the tab that has work in it, so nobody lands on an empty list.
      // R-2687: open on waiting work first; otherwise on the activity list.
      const first = TABS.find((t) => t.key !== "activity" && t.key !== "published" && data.items.some(t.match));
      setTab(first ? first.key : "activity");
    }).catch(e => setError(e.message));
  }, [load]);

  const hasInstagram = platforms.includes("instagram");
  const caption = texts[platforms[0]];
  const postAt = when === "morning" ? times.tomorrowMorning : when === "evening" ? times.tomorrowEvening : when === "custom" ? customAt : "";

  function togglePlatform(p: Platform) {
    setPlatforms((cur) => {
      const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
      if (!next.includes("instagram")) setStory(false);
      return next.length ? next : cur; // at least one
    });
  }

  async function writeWithAi() {
    setBusy(true); setAiProblem(null); setAiWriting(true);
    try {
      const response = await fetch("/api/marketing/social-content", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: platforms[0], platforms, format: story ? "story" : "post", topic, caption: "", mediaUrl: null, ai: true, previewOnly: true }) });
      const data = await response.json() as { caption?: string; captions?: Partial<Record<Platform, string>>; error?: string; description?: string };
      // R-2672: the reason stays on screen under the button (a toast vanished before anyone read it).
      if (!response.ok || !data.caption) { setAiProblem([data.error ?? "AI could not write the post.", data.description].filter(Boolean).join(" ")); return; }
      setTexts((cur) => ({ ...cur, ...Object.fromEntries(platforms.map((p) => [p, data.captions?.[p] || data.caption || ""])) }));
      toast.success("AI wrote the post. Read it, change anything, then press Schedule post.");
    } catch (e) { toastError(e, { fallback: "AI could not write the post.", description: "Try a clearer topic, or write the post yourself." }); }
    finally { setBusy(false); setAiWriting(false); }
  }

  /** R-2697: "Make picture with AI" — target "new" is the Post it yourself form, else the post being edited. */
  async function makePicture(target: string, about: string, text: string) {
    if (!about.trim() && !text.trim()) { setPictureProblem({ target, text: "Write the post (or what it is about) first, then make the picture." }); return; }
    setBusy(true); setPicturing(target); setPictureProblem(null);
    try {
      const response = await fetch("/api/marketing/social-content/picture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: about, caption: text }) });
      const data = await response.json() as { mediaUrl?: string; previewUrl?: string | null; error?: string; description?: string };
      if (!response.ok || !data.mediaUrl) { setPictureProblem({ target, text: [data.error ?? "Could not make the picture.", data.description].filter(Boolean).join(" ") }); return; }
      if (data.previewUrl) setPreviews((cur) => ({ ...cur, [data.mediaUrl!]: data.previewUrl! }));
      if (target === "new") setMediaUrl(data.mediaUrl); else setEditMediaUrl(data.mediaUrl);
      toast.success("Picture made.", { description: "It is kept hidden in your Facebook Page's photos until the post goes out." });
    } catch (e) { toastError(e, { fallback: "Could not make the picture.", description: "Nothing was posted. Try again in a minute." }); }
    finally { setBusy(false); setPicturing(null); }
  }

  /** R-2697: the picture box — a link, or an AI picture kept on the Page (shown with today's link). */
  function pictureBox(target: string, value: string, setValue: (v: string) => void, about: string, text: string, label: string, knownPreview?: string | null) {
    const isAi = Boolean(pagePhotoId(value));
    const shown = isAi ? previews[value] ?? knownPreview ?? null : value;
    return <div className="space-y-2">
      {isAi
        ? <p className="text-xs font-medium text-ink-2">{label}: AI picture <span className="font-normal text-ink-3">(kept hidden in your Facebook Page&apos;s photos)</span></p>
        : <label className="block text-xs font-medium text-ink-2">{label}<input type="url" className={`${inputClass} mt-1`} value={value} onChange={e => setValue(e.target.value)} placeholder="https://… (a public image link)" /></label>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void makePicture(target, about, text)}><ImagePlus size={14} /> {isAi ? "Make another picture" : "Make picture with AI"}</Button>
        {value && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setValue("")}>Remove picture</Button>}
      </div>
      {picturing === target && <p role="status" className="text-xs text-ink-3">The AI is drawing the picture… about 15 seconds.</p>}
      {pictureProblem?.target === target && <p role="alert" className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-ink">{pictureProblem.text}</p>}
      {value && (shown
        ? <div className="overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={shown} alt="Picture preview" className="max-h-60 w-full object-contain" /></div>
        : isAi && <p className="text-xs text-ink-3">Picture saved. Facebook did not send a preview just now.</p>)}
    </div>;
  }

  /** R-2705 / R-2707: write the first strategies, save an edit, or answer the AI's suggested change. */
  async function strategyCall(method: "POST" | "PUT" | "PATCH", body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content/strategy", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; description?: string };
      if (!response.ok) throw Object.assign(new Error(data.error ?? "Could not save the strategy."), { description: data.description });
      toast.success(done); setStrategyEdit(null); await load();
    } catch (e) { toastError(e, { fallback: "Could not save the strategy.", description: "Nothing changed. Try again." }); }
    finally { setBusy(false); }
  }

  /** R-2705: one platform's strategy card — what the AI follows, why it last changed, and the AI's waiting suggestion. */
  function strategyCard(p: StrategyPlatform) {
    const st = state!.strategies?.[p];
    const row = st?.active;
    const plan = row?.plan;
    const editingThis = strategyEdit?.platform === p;
    return <div key={p} className="rounded-lg border border-hairline bg-paper p-3">
      <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold text-ink">{PLATFORM_NAME[p]}</p>{row && <span className="text-xs text-ink-3">Version {row.version}</span>}</div>
      {!plan ? <p className="mt-2 text-xs text-ink-3">No strategy yet.</p> : editingThis ? strategyForm(p) : <>
        <p className="mt-1 text-sm text-ink-2">{plan.summary}</p>
        <ul className="mt-2 space-y-0.5 text-xs text-ink-3">
          <li><span className="text-ink-2">Posts:</span> {plan.mix.map((m) => `${m.type} ${m.share}%`).join(" · ")}</li>
          <li><span className="text-ink-2">Style:</span> {plan.tone.replace(/[.;,\s]+$/, "")}; {plan.length} text; {plan.hashtags} hashtag{plan.hashtags === 1 ? "" : "s"}</li>
          <li><span className="text-ink-2">Posts at:</span> {hourText(plan.bestHourIst)} (India time)</li>
          {plan.avoid && <li><span className="text-ink-2">Avoid:</span> {plan.avoid}</li>}
        </ul>
        {row?.reason && <p className="mt-2 text-xs text-ink-3"><span className="text-ink-2">Why: </span>{row.reason}</p>}
        {p === "linkedin" && <p className="mt-2 text-xs text-ink-3">Used once LinkedIn posting is connected.</p>}
        {state!.canReview && <Button size="sm" variant="ghost" className="mt-1 px-0" disabled={busy} onClick={() => setStrategyEdit({ platform: p, plan: { ...plan, mix: plan.mix.map((m) => ({ ...m })) } })}>Change</Button>}
      </>}
      {st?.proposed && !editingThis && <div className="mt-2 rounded-lg bg-amber-soft p-2 text-xs text-amber-ink">
        <p className="font-semibold">The AI suggests a change (version {st.proposed.version})</p>
        <p className="mt-1">{st.proposed.reason}</p>
        <p className="mt-1">New: {st.proposed.plan.mix.map((m) => `${m.type} ${m.share}%`).join(" · ")}; posts at {hourText(st.proposed.plan.bestHourIst)}</p>
        {state!.canReview && <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" disabled={busy} onClick={() => void strategyCall("PATCH", { platform: p, accept: true }, "New strategy in use.")}>Use it</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void strategyCall("PATCH", { platform: p, accept: false }, "Kept the old strategy.")}>Keep old</Button></div>}
      </div>}
    </div>;
  }

  function strategyForm(p: StrategyPlatform) {
    const plan = strategyEdit!.plan;
    const set = (patch: Partial<StrategyPlan>) => setStrategyEdit({ platform: p, plan: { ...plan, ...patch } });
    const shareOf = (t: string) => plan.mix.find((m) => m.type === t)?.share ?? 0;
    const setShare = (t: (typeof POST_TYPES)[number], n: number) => set({ mix: [...plan.mix.filter((m) => m.type !== t), ...(n > 0 ? [{ type: t, share: n }] : [])] });
    const total = plan.mix.reduce((a, m) => a + m.share, 0);
    return <div className="mt-2 space-y-2">
      <label className="block text-xs font-medium text-ink-2">In one line<input className={`${inputClass} mt-1`} maxLength={300} value={plan.summary} onChange={e => set({ summary: e.target.value })} /></label>
      <label className="block text-xs font-medium text-ink-2">Tone<input className={`${inputClass} mt-1`} maxLength={200} value={plan.tone} onChange={e => set({ tone: e.target.value })} /></label>
      <fieldset><legend className="text-xs font-medium text-ink-2">Kinds of post, % of the week {total !== 100 && <span className="font-normal text-ink-3">(now {total}%, saved as 100%)</span>}</legend>
        <div className="mt-1 grid grid-cols-2 gap-1">{POST_TYPES.map((t) => <label key={t} className="flex items-center justify-between gap-2 text-xs text-ink-2">{t}<input type="number" min={0} max={100} step={5} aria-label={`${t} %`} className={`${inputClass} w-16 py-1`} value={shareOf(t)} onChange={e => setShare(t, Math.max(0, Math.min(100, Number(e.target.value) || 0)))} /></label>)}</div>
      </fieldset>
      <div className="grid grid-cols-3 gap-2">
        <label className="block text-xs font-medium text-ink-2">Length<select className={`${inputClass} mt-1`} value={plan.length} onChange={e => set({ length: e.target.value as StrategyPlan["length"] })}>{LENGTHS.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label className="block text-xs font-medium text-ink-2">Hashtags<input type="number" min={0} max={15} className={`${inputClass} mt-1`} value={plan.hashtags} onChange={e => set({ hashtags: Number(e.target.value) || 0 })} /></label>
        <label className="block text-xs font-medium text-ink-2">Post at<select className={`${inputClass} mt-1`} value={plan.bestHourIst} onChange={e => set({ bestHourIst: Number(e.target.value) })}>{Array.from({ length: 17 }, (_, i) => i + 6).map((h) => <option key={h} value={h}>{hourText(h)}</option>)}</select></label>
      </div>
      <label className="block text-xs font-medium text-ink-2">Avoid<input className={`${inputClass} mt-1`} maxLength={400} value={plan.avoid} onChange={e => set({ avoid: e.target.value })} /></label>
      <div className="flex gap-2"><Button size="sm" disabled={busy || plan.mix.length === 0} onClick={() => void strategyCall("PUT", { platform: p, plan }, `${PLATFORM_NAME[p]} strategy saved.`)}>Save strategy</Button><Button size="sm" variant="ghost" onClick={() => setStrategyEdit(null)}>Cancel</Button></div>
    </div>;
  }

  /** R-2689 / R-2690 / R-2691: one helper for the comment, to-do and report buttons. */
  async function call(url: string, method: string, body: Record<string, unknown> | null, done: string | null, fallback: string) {
    setBusy(true);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json() as { error?: string; description?: string; added?: number; drafted?: number; sent?: number };
      if (!response.ok) throw Object.assign(new Error(data.error ?? fallback), { description: data.description });
      if (done) toast.success(done, data.added !== undefined ? { description: `${data.added} new comment${data.added === 1 ? "" : "s"}${data.drafted ? `, ${data.drafted} repl${data.drafted === 1 ? "y" : "ies"} written by the AI` : ""}${data.sent ? `, ${data.sent} sent by the AI` : ""}.` } : undefined);
      await load();
      return true;
    } catch (e) {
      toastError(e, { fallback, description: "Nothing changed. Try again." });
      await load().catch(() => undefined); // e.g. a comment check that found a missing Meta permission shows its note
      return false;
    }
    finally { setBusy(false); }
  }
  async function openTodo(fresh: boolean) {
    setTodoBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content/today", fresh ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ make: "todo" }) } : { cache: "no-store" });
      const data = await response.json() as { items?: TodoItem[]; error?: string; description?: string };
      if (!response.ok || !data.items) throw Object.assign(new Error(data.error ?? "Could not make today's list."), { description: data.description });
      setState((cur) => cur ? { ...cur, todo: data.items! } : cur);
    } catch (e) { toastError(e, { fallback: "Could not make today's list.", description: "Try again in a minute." }); }
    finally { setTodoBusy(false); }
  }
  async function tick(id: string, done: boolean) {
    setState((cur) => cur && cur.todo ? { ...cur, todo: cur.todo.map((t) => t.id === id ? { ...t, done } : t) } : cur);
    const response = await fetch("/api/marketing/social-content/today", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, done }) }).catch(() => null);
    if (!response?.ok) { toast.error("Could not save the tick.", { description: "Refresh the page and tick it again." }); await load(); }
  }

  async function send(submit: boolean) {
    if (when === "custom" && !customAt) { toast.error("Choose the post time.", { description: "Pick a date and time, or choose Tomorrow 9 AM." }); return; }
    if (hasInstagram && !mediaUrl) { toast.error("Instagram needs a picture.", { description: "Press Make picture with AI, paste a public image link, or untick Instagram." }); return; }
    const empty = platforms.find((p) => !(p === "instagram" && story) && !texts[p].trim());
    if (empty) { toast.error(`Write the ${empty === "facebook" ? "Facebook" : "Instagram"} text first.`, { description: "Type it in the box, or press Write with AI." }); return; }
    setBusy(true);
    try {
      for (const platform of platforms) {
        const response = await fetch("/api/marketing/social-content", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ platform, format: platform === "instagram" && story ? "story" : "post", topic, caption: texts[platform], mediaUrl: mediaUrl || null, scheduledAt: postAt || null, submit }) });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`${platform === "facebook" ? "Facebook" : "Instagram"}: ${data.error ?? "Could not save."}`);
      }
      toast.success(submit ? (postAt ? "Post scheduled." : "Saved. Publish it when you are ready.") : "Saved as a draft.", { description: submit ? (postAt ? `It posts by itself on ${formatIst(postAt + ":00+05:30")}.` : "Press Publish now on it in Scheduled.") : undefined });
      setTopic(""); setTexts({ facebook: "", instagram: "" }); setMediaUrl(""); setCustomAt("");
      await load(); setTab(submit ? "scheduled" : "draft");
    } catch (e) { toastError(e, { fallback: "Could not save the post.", description: "Your text is still in the form. Fix what the message says and try again." }); }
    finally { setBusy(false); }
  }

  async function act(id: string, action: string, patch: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const response = await fetch(`/api/marketing/social-content/${id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...patch }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not update draft.");
      const item = state?.items.find(x => x.id === id);
      toast.success(action === "publish" ? "Posted to Meta."
        : action === "approve" ? (item?.scheduled_at ? `Approved. It posts on ${formatIst(item.scheduled_at)}.` : "Approved. Press Publish now when you are ready.")
        : action === "submit" ? "Post scheduled." : action === "return" ? "Sent back to drafts." : action === "stop" ? "Stopped. It will not go out; it is in Drafts now." : "Saved.");
      setEditing(null); setConfirmPublish(null); await load();
      if (action === "approve") setTab("scheduled");
      if (action === "submit") setTab("review");
      if (action === "return" || action === "stop") setTab("draft");
      if (action === "publish") setTab("published");
    } catch (e) { toastError(e, { fallback: "Could not update draft.", description: "Refresh the page to see its current stage, then try again." }); }
    finally { setBusy(false); }
  }

  async function saveSettings() {
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content/settings", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoDrafts, brief, autopilot, postsPerWeek, pictures }) });
      const data = await response.json() as { error?: string; description?: string };
      if (!response.ok) { setPlanNote({ text: [data.error ?? "Could not save.", data.description].filter(Boolean).join(" "), warn: true }); return; }
      setPlanNote({ text: autoDrafts ? `Saved. Every Monday the AI plans ${postsPerWeek} post${postsPerWeek === 1 ? "" : "s"}${autopilot ? ` and posts ${postsPerWeek === 1 ? "it" : "them"} by itself` : " for you to approve"}.` : "Saved. The Monday plan is off — press Plan this week now whenever you want posts.", warn: false });
      toast.success("AI posts settings saved."); await load();
    } catch (e) { toastError(e, { fallback: "Could not save settings.", description: "Nothing was saved. Try again." }); }
    finally { setBusy(false); }
  }

  /** R-2687: delete a post that has not gone out. */
  async function removePost(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/marketing/social-content/${id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string; description?: string };
      if (!response.ok) throw Object.assign(new Error(data.error ?? "Could not delete the post."), { description: data.description });
      toast.success("Post deleted."); setConfirmDelete(null); await load();
    } catch (e) { toastError(e, { fallback: "Could not delete the post.", description: "Nothing changed. Refresh the page and try again." }); }
    finally { setBusy(false); }
  }

  /** R-2687: "Stop all AI" / "Resume AI". */
  async function setAiPaused(paused: boolean) {
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ aiPaused: paused }) });
      const data = await response.json() as { error?: string; description?: string };
      if (!response.ok) throw Object.assign(new Error(data.error ?? "Could not change the AI switch."), { description: data.description });
      toast.success(paused ? "All AI stopped." : "AI resumed.", { description: paused ? "Nothing the AI planned will be posted until you resume." : "Scheduled AI posts will go out at their time." });
      await load(); setTab("activity");
    } catch (e) { toastError(e, { fallback: "Could not change the AI switch.", description: "Nothing changed. Try again." }); }
    finally { setBusy(false); }
  }

  /** R-2672: "Plan this week now" — the AI plans the week straight away (same as the Monday run). */
  async function planNow() {
    setBusy(true); setPlanNote({ text: "The AI is writing this week's posts and making their pictures… this takes up to a minute. Keep this page open.", warn: false });
    try {
      const response = await fetch("/api/marketing/social-content/settings", { method: "POST" });
      const data = await response.json() as { error?: string; description?: string; created?: number; autopilot?: boolean; instagramSkipped?: boolean; aiPictures?: number; pictureProblem?: string | null;
        resultsRead?: number; needsReconnect?: boolean; learned?: { platform: StrategyPlatform; outcome: "changed" | "proposed" | "kept" | "need-more"; have: number }[] };
      const learnedText = (data.learned ?? []).map((l) => `${PLATFORM_NAME[l.platform]}: ${l.outcome === "changed" ? "strategy improved from results" : l.outcome === "proposed" ? "the AI suggests a better strategy (see Strategy)" : l.outcome === "kept" ? "strategy kept, it is working" : `needs ${3 - l.have} more post${3 - l.have === 1 ? "" : "s"} with results before it can learn`}.`).join(" ");
      if (!response.ok) { setPlanNote({ text: [data.error ?? "Could not plan the week.", data.description].filter(Boolean).join(" "), warn: true }); return; }
      const n = data.created ?? 0;
      setPlanNote({ text: `${n} post${n === 1 ? "" : "s"} planned for the next 7 days. ${data.autopilot ? "They go out by themselves at their time (see Scheduled). Press Stop on any you do not want." : "They wait for the marketing team to approve them (see Waiting for approval)."}${data.aiPictures ? ` The AI made ${data.aiPictures === 1 ? "a picture" : `${data.aiPictures} pictures`} for them.` : ""}${data.instagramSkipped ? ` Instagram was skipped for posts without a picture${data.pictureProblem ? ` (${data.pictureProblem})` : ""}.` : ""}${data.resultsRead ? ` Read the results of ${data.resultsRead} post${data.resultsRead === 1 ? "" : "s"}.` : ""} ${learnedText}${data.needsReconnect ? " Likes, comments and shares are read; reach and saves need two more Meta permissions (read_insights, instagram_manage_insights) — ask Anutech support to switch them on." : ""}`, warn: Boolean(data.instagramSkipped || data.needsReconnect) });
      await load();
      setTab(data.autopilot ? "scheduled" : "review");
    } catch (e) { toastError(e, { fallback: "Could not plan the week.", description: "Nothing was posted. Try again." }); }
    finally { setBusy(false); }
  }

  const waitingComments = state?.comments.filter((c) => c.status !== "replied") ?? [];
  const count = (key: TabKey) => key === "comments" ? waitingComments.length : state?.items.filter(TABS.find((t) => t.key === key)!.match).length ?? 0;
  const items = state?.items.filter(TABS.find((t) => t.key === tab)!.match) ?? [];

  return <div className="mx-auto max-w-[1240px] space-y-6 p-4 md:p-6 lg:p-8">
    <MarketingPageHeader title="Social growth" description="Grow your Facebook, Instagram and LinkedIn audience. Let the AI do the work, watch what it does, stop it any time — or do it yourself." />
    {error && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-sm text-rose-ink">{error}</p><Button onClick={() => void load()}>Try again</Button></div></Card>}
    {!state && !error && <Card><p className="p-6 text-sm text-ink-3">Loading…</p></Card>}
    {state && <>
      <section aria-label="Your accounts" className="grid gap-3 sm:grid-cols-3">
        {[
          { key: "facebook", label: "Facebook", icon: <Facebook size={18} className="text-[#1877f2]" aria-hidden="true" />, name: state.facebook?.name ?? null, count: state.followers.facebook, href: "/marketing/facebook", connect: "Connect Facebook Page",
            open: state.facebook?.id ? `https://www.facebook.com/${encodeURIComponent(state.facebook.id)}` : null, openLabel: "Open Page" },
          { key: "instagram", label: "Instagram", icon: <Instagram size={18} className="text-[#c13584]" aria-hidden="true" />, name: state.instagram ? `@${state.instagram.name}` : null, count: state.followers.instagram, href: "/marketing/facebook", connect: "Link Instagram to your Page",
            open: state.instagram ? `https://www.instagram.com/${encodeURIComponent(state.instagram.name)}/` : null, openLabel: "Open profile" },
          { key: "linkedin", label: "LinkedIn", icon: <Linkedin size={18} className="text-[#0a66c2]" aria-hidden="true" />, name: state.linkedin?.name ?? null, count: null, href: "/marketing/linkedin", connect: "Connect LinkedIn Page", open: null as string | null, openLabel: "Open Page" },
        ].map((a) => <div key={a.key} className="rounded-xl border border-hairline bg-paper p-4">
          <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">{a.icon}{a.label}</span>{a.name ? <Badge kind="success" dot>Connected</Badge> : <Badge kind="muted">Not connected</Badge>}</div>
          {a.name ? <>
            {/* Open the connected Page / profile on Facebook or Instagram, in a new tab. */}
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-xs text-ink-3" title={a.name}>{a.name}</p>
              {a.open && <a href={a.open} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink underline hover:text-amber-ink" aria-label={`${a.openLabel} on ${a.label} (opens in a new tab)`}>{a.openLabel} <ArrowUpRight size={12} aria-hidden="true" /></a>}
            </div>
            <p className="mt-1 font-serif text-2xl tabular-nums text-ink">{a.count !== null ? a.count.toLocaleString("en-IN") : "—"}<span className="ml-1.5 font-sans text-xs text-ink-3">{a.count !== null ? "followers" : a.key === "linkedin" ? "followers shown soon" : "followers not shared by Meta"}</span></p>
            {(() => { const t = state.trends?.[a.key as StrategyPlatform]; if (!t || t.now === null) return null; return <>
              <p className="mt-1 text-xs text-ink-3">{t.change7 !== null ? <><span className={t.change7 > 0 ? "font-semibold text-emerald-ink" : t.change7 < 0 ? "font-semibold text-rose-ink" : "text-ink-2"}>{signed(t.change7)}</span> this week{t.change30 !== null ? ` · ${signed(t.change30)} in 30 days` : ""}</> : "Counting from today — the change shows after a week."}</p>
              <Sparkline series={t.series} />
            </>; })()}
          </> : <a href={a.href} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink underline">{a.connect} <ArrowUpRight size={13} aria-hidden="true" /></a>}
        </div>)}
      </section>

      <section aria-label="Today and this week" className="grid items-start gap-5 lg:grid-cols-2">
        <Card><div className="space-y-3 p-1 md:p-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h2 className="text-lg font-semibold">Today&apos;s 5 things</h2><p className="mt-0.5 text-xs text-ink-3">Meta and LinkedIn do not let software do these — a person does them in about 10 minutes.</p></div>
            {state.canReview && state.todo && <Button size="sm" variant="ghost" disabled={todoBusy} onClick={() => void openTodo(true)}>New list</Button>}
          </div>
          {!state.todo ? <div className="rounded-lg border border-dashed border-hairline p-6 text-center">
              <p className="text-sm text-ink-3">Today&apos;s list is not made yet.</p>
              {state.canReview && <Button className="mt-3" size="sm" variant="outline" disabled={todoBusy} onClick={() => void openTodo(false)}><Sparkles size={14} /> {todoBusy ? "Making the list…" : "Make today's list"}</Button>}
            </div>
            : <ul className="space-y-2">{state.todo.map((t) => <li key={t.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-hairline bg-paper p-3">
                  <input type="checkbox" className="mt-1 size-4 shrink-0" checked={t.done} disabled={!state.canReview} onChange={(e) => void tick(t.id, e.target.checked)} />
                  <span className="min-w-0"><span className={`block text-sm ${t.done ? "text-ink-3 line-through" : "text-ink"}`}>{t.text}</span>{t.why && <span className="mt-0.5 block text-xs text-ink-3">{t.why}</span>}{t.done && t.doneBy && <span className="mt-0.5 block text-xs text-emerald-ink">Done by {t.doneBy}</span>}</span>
                </label>
              </li>)}</ul>}
          {state.todo && <p className="text-xs text-ink-3">{state.todo.filter((t) => t.done).length} of {state.todo.length} done today.</p>}
        </div></Card>

        <Card><div className="space-y-3 p-1 md:p-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h2 className="text-lg font-semibold">This week</h2><p className="mt-0.5 text-xs text-ink-3">{state.report ? `Report of the week from ${formatIst(state.report.report.weekStart + "T00:00:00+05:30").split(",")[0]} · made ${formatIst(state.report.created_at)}` : "The AI writes a report every week with the plan."}</p></div>
            {state.canReview && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void call("/api/marketing/social-content/today", "POST", { make: "report" }, "Report made.", "Could not make the report.")}>Make report now</Button>}
          </div>
          {!state.report ? <p className="rounded-lg border border-dashed border-hairline p-6 text-center text-sm text-ink-3">No report yet. Press Make report now.</p> : <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["facebook", "instagram"] as const).map((p) => { const f = state.report!.report.followers[p]; return <div key={p} className="rounded-lg bg-paper-2 p-2"><dt className="text-xs text-ink-3">{PLATFORM_NAME[p]} followers</dt><dd className="text-sm font-semibold tabular-nums text-ink">{f.now ?? "—"}{f.change7 !== null && <span className="ml-1 text-xs font-normal text-ink-3">({signed(f.change7)})</span>}</dd></div>; })}
              <div className="rounded-lg bg-paper-2 p-2"><dt className="text-xs text-ink-3">Posts out</dt><dd className="text-sm font-semibold tabular-nums text-ink">{state.report.report.posts.facebook + state.report.report.posts.instagram}</dd></div>
              <div className="rounded-lg bg-paper-2 p-2"><dt className="text-xs text-ink-3">Comments answered</dt><dd className="text-sm font-semibold tabular-nums text-ink">{state.report.report.comments.answered} of {state.report.report.comments.received}</dd></div>
            </dl>
            {state.report.report.best && <p className="text-xs text-ink-2"><span className="font-semibold">Best post</span> ({PLATFORM_NAME[state.report.report.best.platform as StrategyPlatform] ?? state.report.report.best.platform}, score {state.report.report.best.score}): {state.report.report.best.caption}</p>}
            {state.report.summary && <p className="rounded-lg bg-amber-soft/50 p-3 text-sm text-ink-2"><span className="font-semibold text-ink">AI: </span>{state.report.summary}</p>}
          </>}
        </div></Card>
      </section>

      <Card><div className="space-y-4 p-1 md:p-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3"><Bot size={22} className="mt-0.5 shrink-0 text-amber-ink" aria-hidden="true" /><div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">AI agent</h2>{state.settings.ai_paused ? <Badge kind="danger" dot>Stopped</Badge> : <Badge kind="success" dot>Running</Badge>}</div>
            <p className="mt-1 text-sm text-ink-3">Choose what the AI does for each action. Everything it does shows in Activity, where you can stop it.</p>
          </div></div>
          {state.canReview && (state.settings.ai_paused
            ? <Button variant="primary" disabled={busy || !state.canManage} title={state.canManage ? undefined : "Only the owner can resume the AI"} onClick={() => void setAiPaused(false)}>Resume AI</Button>
            : <Button variant="danger" disabled={busy} onClick={() => void setAiPaused(true)}>Stop all AI</Button>)}
        </div>
        {state.settings.ai_paused && <p className="rounded-lg bg-rose-soft px-3 py-2 text-sm text-rose-ink">The AI is stopped. Nothing it planned will be posted, and it plans nothing new, until the owner presses Resume AI. Posts people wrote still go out.</p>}
        {!state.aiReady && <p className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-ink">AI is not set up yet. <a className="font-medium underline" href="/settings?tab=integrations">Add a Gemini key in Settings → Integrations (AI assistant → Setup)</a>, then come back.</p>}

        <div className="divide-y divide-hairline rounded-xl border border-hairline">
          <div className="grid gap-3 p-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-center">
            <div><p className="text-sm font-semibold text-ink">Posts</p><p className="text-xs text-ink-3">{postsPerWeek} a week, Facebook{state.instagram ? " + Instagram" : ""}</p></div>
            <div role="radiogroup" aria-label="AI posts" className="flex flex-wrap gap-2">
              {([["off", "Off"], ["ask", "Ask me first"], ["auto", "Autopilot"]] as const).map(([m, label]) => <button key={m} type="button" role="radio" aria-checked={postsMode === m} disabled={!state.canManage} onClick={() => setPostsMode(m)} className={chip(postsMode === m)}>{label}</button>)}
            </div>
            <div className="flex flex-wrap gap-2">
              {state.canReview && <Button size="sm" variant="outline" disabled={busy || state.settings.ai_paused} onClick={() => void planNow()}><Sparkles size={14} /> Plan this week now</Button>}
              {state.canManage && <Button size="sm" variant="ghost" aria-expanded={showPostSettings} onClick={() => setShowPostSettings((v) => !v)}>{showPostSettings ? "Hide settings" : "Settings"}</Button>}
            </div>
          </div>
          {state.canManage && showPostSettings && <div className="space-y-4 bg-paper-2/40 p-3">
            <label className="block text-xs font-medium text-ink-2">What should the AI write about?<textarea className={`${inputClass} mt-1 min-h-20`} maxLength={1000} value={brief} onChange={e => setBrief(e.target.value)} placeholder="Your products, who you sell to, tone, and claims to avoid" /></label>
            <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
              <label className="block text-xs font-medium text-ink-2">Posts per week<select className={`${inputClass} mt-1`} value={postsPerWeek} onChange={e => setPostsPerWeek(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <label className="block text-xs font-medium text-ink-2">Your own picture links (optional, one per line). Leave empty and the AI makes a picture for each post<textarea className={`${inputClass} mt-1 min-h-20 font-mono text-xs`} value={pictures} onChange={e => setPictures(e.target.value)} placeholder="https://… (a public image link)" /></label>
            </div>
          </div>}
          <div className="space-y-3 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="text-sm font-semibold text-ink">Strategy for each platform</p><p className="text-xs text-ink-3">The AI writes a different post for each platform from its strategy. Every week it reads the results, keeps what worked and changes what did not{autopilot ? "" : " (it asks you first)"}.</p></div>
              {state.canReview && STRATEGY_KEYS.some((p) => !state.strategies?.[p].active) && <Button size="sm" variant="outline" disabled={busy || state.settings.ai_paused || !state.aiReady} onClick={() => void strategyCall("POST", {}, "Strategies written.")}><Sparkles size={14} /> Write strategies</Button>}
            </div>
            <div className="grid gap-3 lg:grid-cols-3">{STRATEGY_KEYS.map((p) => strategyCard(p))}</div>
          </div>
          <div className="space-y-2 p-3">
            <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-center">
              <div><p className="text-sm font-semibold text-ink">Comment replies</p><p className="text-xs text-ink-3">AI answers comments on your posts. Complaints always wait for a person.</p></div>
              <div role="radiogroup" aria-label="AI comment replies" className="flex flex-wrap gap-2">
                {([["off", "Off"], ["ask", "Ask me first"], ["auto", "Autopilot"]] as const).map(([m, label]) => <button key={m} type="button" role="radio" aria-checked={state.settings.comment_mode === m} disabled={!state.canReview || busy} onClick={() => void call("/api/marketing/social-content/settings", "PATCH", { commentMode: m }, m === "off" ? "Comment replies are off." : m === "auto" ? "The AI now answers comments by itself." : "The AI writes replies; you send them.", "Could not change comment replies.")} className={chip(state.settings.comment_mode === m)}>{label}</button>)}
              </div>
              {state.canReview && <Button size="sm" variant="outline" disabled={busy || state.settings.comment_mode === "off"} onClick={() => void call("/api/marketing/social-content/comments", "POST", { action: "check" }, "Comments checked.", "Could not check comments.")}>Check comments now</Button>}
            </div>
            {state.settings.comments_problem && <p className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-ink">{state.settings.comments_problem}</p>}
          </div>
        </div>
        {state.canManage && <div className="flex flex-wrap items-center justify-end gap-2">
          {settingsDirty && <span className="text-xs text-amber-ink">Not saved yet</span>}
          <Button disabled={busy || !settingsDirty} onClick={() => void saveSettings()}>Save AI settings</Button>
        </div>}
        {!state.canManage && <p className="text-xs text-ink-3">Only the owner can change these settings.</p>}
        {planNote && <p role="status" className={planNote.warn ? "rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-ink" : "rounded-lg bg-paper-2 px-3 py-2 text-sm text-ink-2"}>{planNote.text}</p>}
      </div></Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card><div className="space-y-5 p-1 md:p-2">
          <div><h2 className="text-lg font-semibold">Post it yourself</h2><p className="mt-0.5 text-xs text-ink-3">Write a post by hand (or with one AI press). It is scheduled straight away — no approval needed.</p></div>

          <fieldset><legend className="text-xs font-medium text-ink-2">Where</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" aria-pressed={platforms.includes("facebook")} className={chip(platforms.includes("facebook"))} onClick={() => togglePlatform("facebook")}><Facebook size={15} /> Facebook{state.facebook ? "" : " (not connected)"}</button>
              <button type="button" aria-pressed={hasInstagram} className={chip(hasInstagram)} onClick={() => togglePlatform("instagram")}><Instagram size={15} /> Instagram{state.instagram ? "" : " (not linked)"}</button>
              {hasInstagram && <label className="ml-1 flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={story} onChange={(e) => setStory(e.target.checked)} /> Instagram Story</label>}
            </div>
          </fieldset>

          <div>
            <label className="block text-xs font-medium text-ink-2" htmlFor="social-topic">What is it about?</label>
            <input id="social-topic" className={`${inputClass} mt-1`} value={topic} maxLength={500} onChange={e => setTopic(e.target.value)} placeholder="Example: 3 Google Workspace tips for small teams" />
            <Button className="mt-2" variant="outline" disabled={busy} onClick={() => { if (topic.trim()) void writeWithAi(); else setAiProblem("Type what the post is about first, then press Write with AI."); }}><Sparkles size={15} /> Write with AI</Button>
            {aiWriting && <p role="status" className="mt-2 text-xs text-ink-3">The AI is writing the post… about 10 seconds.</p>}
            {aiProblem && <p role="alert" className="mt-2 rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-ink">{aiProblem}{!state.aiReady && <> <a className="font-medium underline" href="/settings?tab=integrations">Open Settings → Integrations</a></>}</p>}
          </div>

          {platforms.map((p) => <label key={p} className="block text-xs font-medium text-ink-2">{platforms.length > 1 ? `${p === "facebook" ? "Facebook" : "Instagram"} text` : "Post text"}<textarea className={`${inputClass} mt-1 ${platforms.length > 1 ? "min-h-28" : "min-h-36"} resize-y`} value={texts[p]} maxLength={2200} onChange={e => { const v = e.target.value; setTexts((cur) => ({ ...cur, [p]: v })); }} placeholder="Type the post here, or press Write with AI" /><span className="mt-1 block text-right font-normal text-ink-3">{texts[p].length}/2200</span></label>)}
          {platforms.length > 1 && <p className="-mt-2 text-xs text-ink-3">Write with AI makes a different text for each place, following its strategy.</p>}

          {pictureBox("new", mediaUrl, setMediaUrl, topic, caption, `Picture ${hasInstagram ? "(needed for Instagram)" : "(optional)"}`)}

          <fieldset><legend className="text-xs font-medium text-ink-2">When should it go out? (India time)</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" aria-pressed={when === "morning"} className={chip(when === "morning")} onClick={() => setWhen("morning")}>Tomorrow 9 AM</button>
              <button type="button" aria-pressed={when === "evening"} className={chip(when === "evening")} onClick={() => setWhen("evening")}>Tomorrow 6 PM</button>
              <button type="button" aria-pressed={when === "custom"} className={chip(when === "custom")} onClick={() => setWhen("custom")}>Pick a time</button>
              <button type="button" aria-pressed={when === "manual"} className={chip(when === "manual")} onClick={() => setWhen("manual")}>I&apos;ll post it myself</button>
            </div>
            {when === "custom" && <input type="datetime-local" aria-label="Post time" className={`${inputClass} mt-2`} value={customAt} onChange={e => setCustomAt(e.target.value)} />}
          </fieldset>

          <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
            <Button variant="primary" disabled={busy} onClick={() => void send(true)}><Send size={15} /> {when === "manual" ? "Save to publish" : "Schedule post"}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void send(false)}>Save as draft</Button>
          </div>
          {platforms.length > 1 && <p className="-mt-2 text-xs text-ink-3">One post is made for each place you picked.</p>}
        </div></Card>

        <Card><div className="space-y-4 p-1 md:p-2">
          <div role="tablist" aria-label="Posts" className="flex flex-wrap gap-2">
            {TABS.map((t) => { const n = count(t.key); return <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} className={chip(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}{n > 0 && <span className={`rounded-full px-1.5 text-xs ${tab === t.key ? "bg-paper text-ink" : t.key === "review" || t.key === "failed" || t.key === "comments" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2"}`}>{n}</span>}</button>; })}
          </div>
          {tab === "activity" && (state.activity.length === 0
            ? <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">Nothing has happened yet. Plan this week with the AI, or write a post yourself.</div>
            : <ol aria-label="Activity" className="max-h-[850px] space-y-2 overflow-y-auto pr-1">{state.activity.map((a) => {
              const post = a.content_id ? state.items.find((i) => i.id === a.content_id) : undefined;
              return <li key={a.id} className="flex gap-3 rounded-lg border border-hairline bg-paper p-3">
                <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${a.actor === "ai" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2"}`} aria-hidden="true">{a.actor === "ai" ? <Bot size={15} /> : <User size={15} />}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink"><span className="font-semibold">{a.actor === "ai" ? "AI" : a.actor === "system" ? "System" : a.user_name ?? "Someone"}</span> {a.action.charAt(0).toLowerCase() + a.action.slice(1)}{a.platform ? ` on ${a.platform === "facebook" ? "Facebook" : a.platform === "instagram" ? "Instagram" : "LinkedIn"}` : ""}</p>
                  {a.detail && <p className="mt-0.5 truncate text-xs text-ink-3" title={a.detail}>{a.detail}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3"><span>{formatIst(a.at)}</span>
                    {a.result === "failed" && <Badge kind="danger" size="sm">Failed</Badge>}
                    {post?.status === "review" && <Badge kind="warning" size="sm">Waiting for approval</Badge>}
                    {post?.status === "approved" && post.scheduled_at && <Badge kind="info" size="sm">Posts {formatIst(post.scheduled_at)}</Badge>}
                    {post?.status === "published" && <Badge kind="success" size="sm">Posted</Badge>}
                    {post && <button type="button" className="underline hover:text-ink" onClick={() => setTab((TABS.find((t) => t.key !== "activity" && t.match(post))?.key ?? "draft") as TabKey)}>Open</button>}
                    {post?.status === "approved" && post.scheduled_at && state.canReview && <button type="button" className="font-medium text-rose-ink underline" disabled={busy} onClick={() => void act(post.id, "stop")}>Stop</button>}
                  </div>
                </div>
              </li>;
            })}</ol>)}
          {tab === "comments" && (state.comments.length === 0
            ? <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">No comments yet. They show here a few minutes after people comment on your posts{state.settings.comment_mode === "off" ? " (comment replies are Off)" : ""}.</div>
            : <ul aria-label="Comments" className="max-h-[850px] space-y-3 overflow-y-auto pr-1">{state.comments.map((c) => {
              const open = c.status !== "replied";
              const text = replyText[c.id] ?? c.ai_reply ?? "";
              return <li key={c.id} className="rounded-xl border border-hairline bg-paper p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">{c.platform === "facebook" ? <Facebook size={16} className="text-[#1877f2]" aria-hidden="true" /> : <Instagram size={16} className="text-[#c13584]" aria-hidden="true" />}{c.author}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-3">{c.kind === "complaint" && <Badge kind="warning" size="sm">Complaint — answer yourself</Badge>}{c.kind === "spam" && <Badge kind="muted" size="sm">Looks like spam</Badge>}{c.commented_at ? formatIst(c.commented_at) : ""}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{c.message}</p>
                {open ? <div className="mt-3 space-y-2">
                  <label className="block text-xs font-medium text-ink-2">{c.ai_reply ? "Reply (written by the AI — change anything)" : "Your reply"}<textarea className={`${inputClass} mt-1 min-h-20`} maxLength={800} value={text} onChange={(e) => { const v = e.target.value; setReplyText((cur) => ({ ...cur, [c.id]: v })); }} placeholder={c.status === "new" ? "The AI has not read this yet — write a reply, or press Check comments now." : "Write a reply"} /></label>
                  {c.status === "failed" && c.error && <p className="rounded-lg bg-rose-soft p-2 text-xs text-rose-ink">Meta said: {c.error}</p>}
                  {state.canReview && <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void call("/api/marketing/social-content/comments", "POST", { action: "send", id: c.id, text }, "Reply sent.", "Could not send the reply.").then((ok) => { if (ok) setReplyText((cur) => { const n = { ...cur }; delete n[c.id]; return n; }); })}><Send size={14} /> Send reply</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void call("/api/marketing/social-content/comments", "POST", { action: "ignore", id: c.id }, "Comment ignored.", "Could not ignore the comment.")}>No reply needed</Button>
                  </div>}
                </div> : <p className="mt-3 rounded-lg bg-paper-2 p-2 text-xs text-ink-2"><span className="font-semibold">{c.replied_by === "ai" ? "AI replied" : "You replied"}{c.replied_at ? ` · ${formatIst(c.replied_at)}` : ""}: </span>{c.reply}</p>}
              </li>;
            })}</ul>)}
          {tab !== "activity" && tab !== "comments" && items.length === 0 && <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">{tab === "review" ? "Nothing is waiting for approval." : tab === "scheduled" ? "No approved posts waiting to go out." : "Nothing here yet."}</div>}
          {tab !== "activity" && tab !== "comments" && <div className="max-h-[850px] space-y-3 overflow-y-auto pr-1">{items.map(item => <div key={item.id} className="rounded-xl border border-hairline bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">{item.platform === "facebook" ? <Facebook size={17} className="text-[#1877f2]" /> : <Instagram size={17} className="text-[#c13584]" />}<span className="text-sm font-medium">{item.platform === "facebook" ? "Facebook" : "Instagram"} {item.format === "story" ? "Story" : "post"}</span>{item.origin !== "manual" && <Badge kind="muted">AI</Badge>}{item.post_type && <Badge kind="muted">{item.post_type}</Badge>}</div>
              <span className="text-xs text-ink-2">{item.status === "published" && item.published_at ? `Posted ${formatIst(item.published_at)}`
                : item.scheduled_at ? (item.status === "approved" && new Date(item.scheduled_at).getTime() <= Date.now() ? "Posting in a few minutes" : `${item.status === "approved" ? "Posts" : "To post"} ${formatIst(item.scheduled_at)}`)
                : item.status === "approved" ? "Approved — post by hand" : "No post time"}</span></div>
            {editing === item.id ? <div className="mt-3 space-y-2"><textarea aria-label="Post text" className={`${inputClass} min-h-28`} value={editCaption} maxLength={2200} onChange={e => setEditCaption(e.target.value)} />{pictureBox(item.id, editMediaUrl, setEditMediaUrl, item.topic, editCaption, "Picture", editMediaUrl === item.media_url ? item.media_preview : null)}<label className="block text-xs font-medium text-ink-2">Post time, India time<input type="datetime-local" className={`${inputClass} mt-1`} value={editPostAt} onChange={e => setEditPostAt(e.target.value)} /></label><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act(item.id, "save", { caption: editCaption, mediaUrl: editMediaUrl || null, scheduledAt: editPostAt || null })}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></div>
              : <><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-2">{item.caption || (item.format === "story" ? "Picture-only Story" : "No text")}</p>{item.media_url && (pagePhotoId(item.media_url) && !item.media_preview
                ? <p className="mt-3 text-xs text-ink-3">AI picture saved in your Facebook Page&apos;s photos (Facebook did not send a preview just now).</p>
                : <div className="mt-3 overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={pagePhotoId(item.media_url) ? item.media_preview! : item.media_url} alt="Post picture" className="max-h-80 w-full object-contain" /></div>)}</>}
            {item.status === "published" && (item.stats ? <p className="mt-2 text-xs text-ink-2">Results: {statsLine(item.stats) || "no numbers from Meta yet"}</p> : <p className="mt-2 text-xs text-ink-3">Results are read 2 days after posting, when the AI plans the week.</p>)}
            {item.error && <p className="mt-2 rounded-lg bg-rose-soft p-2 text-xs text-rose-ink">Meta said: {item.error} — fix it, then press Schedule again.</p>}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
              {item.status === "review" && state.canReview && <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "approve")}><Check size={14} /> Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(item.id, "return")}>Send back</Button></>}
              {item.status === "review" && !state.canReview && <span className="self-center text-xs text-ink-3">Waiting for the marketing team.</span>}
              {["draft", "failed"].includes(item.status) && <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "submit")}><Send size={14} /> Schedule</Button>}
              {(["draft", "review", "failed"].includes(item.status) || (item.status === "approved" && state.canReview)) && editing !== item.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(item.id); setEditCaption(item.caption); setEditMediaUrl(item.media_url ?? ""); setEditPostAt(item.scheduled_at ? toIstLocal(item.scheduled_at) : ""); }}>Edit</Button>}
              {item.status === "approved" && state.canReview && item.scheduled_at && confirmPublish !== item.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(item.id, "stop")}>Stop</Button>}
              {!["published", "publishing"].includes(item.status) && editing !== item.id && (confirmDelete === item.id
                ? <><Button size="sm" variant="danger" disabled={busy} onClick={() => void removePost(item.id)}>Yes, delete</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button></>
                : <Button size="sm" variant="ghost" className="text-rose-ink" disabled={busy} onClick={() => setConfirmDelete(item.id)}>Delete</Button>)}
              {item.status === "approved" && state.canReview && (confirmPublish === item.id ? <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "publish")}><Send size={14} /> Yes, post now</Button><Button size="sm" variant="ghost" onClick={() => setConfirmPublish(null)}>Cancel</Button></> : <Button size="sm" variant={item.scheduled_at ? "outline" : "primary"} disabled={busy} onClick={() => setConfirmPublish(item.id)}>{item.scheduled_at ? "Post now instead" : "Publish now"}</Button>)}
            </div>
          </div>)}</div>}
        </div></Card>
      </div>


    </>}
  </div>;
}
