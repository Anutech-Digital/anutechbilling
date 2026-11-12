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

type Platform = "facebook" | "instagram";
type Item = { id: string; platform: Platform; format: "post" | "story"; caption: string; media_url: string | null;
  topic: string; origin: string; status: string; created_at: string; published_at: string | null; error: string | null;
  scheduled_at: string | null; media_preview?: string | null };
type Activity = { id: string; at: string; actor: "ai" | "person" | "system"; user_name: string | null; platform: string | null;
  action: string; detail: string; content_id: string | null; result: "ok" | "failed" | "waiting" };
type State = { items: Item[]; canReview: boolean; canManage: boolean; aiReady: boolean;
  facebook: { name: string } | null; instagram: { name: string; type: string | null } | null; linkedin: { name: string } | null;
  followers: { facebook: number | null; instagram: number | null }; activity: Activity[];
  settings: { auto_drafts: boolean; brief: string; autopilot: boolean; posts_per_week: number; picture_urls: string[]; last_generated_on: string | null; ai_paused: boolean } };

/* R-2513: the queue is split the way the work is done — what waits for the approver comes first. */
const TABS = [
  { key: "activity", label: "Activity", match: () => false },
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
  const [caption, setCaption] = React.useState("");
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
        body: JSON.stringify({ platform: platforms[0], format: story ? "story" : "post", topic, caption: "", mediaUrl: null, ai: true, previewOnly: true }) });
      const data = await response.json() as { caption?: string; error?: string; description?: string };
      // R-2672: the reason stays on screen under the button (a toast vanished before anyone read it).
      if (!response.ok || !data.caption) { setAiProblem([data.error ?? "AI could not write the post.", data.description].filter(Boolean).join(" ")); return; }
      setCaption(data.caption);
      toast.success("AI wrote the post. Read it, change anything, then send it for approval.");
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

  async function send(submit: boolean) {
    if (when === "custom" && !customAt) { toast.error("Choose the post time.", { description: "Pick a date and time, or choose Tomorrow 9 AM." }); return; }
    if (hasInstagram && !mediaUrl) { toast.error("Instagram needs a picture.", { description: "Press Make picture with AI, paste a public image link, or untick Instagram." }); return; }
    if (!story && !caption.trim()) { toast.error("Write the post first.", { description: "Type it in the box, or press Write with AI." }); return; }
    setBusy(true);
    try {
      for (const platform of platforms) {
        const response = await fetch("/api/marketing/social-content", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ platform, format: platform === "instagram" && story ? "story" : "post", topic, caption, mediaUrl: mediaUrl || null, scheduledAt: postAt || null, submit }) });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`${platform === "facebook" ? "Facebook" : "Instagram"}: ${data.error ?? "Could not save."}`);
      }
      toast.success(submit ? "Sent for approval." : "Saved as a draft.", { description: submit ? (postAt ? `Once approved it posts on ${formatIst(postAt + ":00+05:30")}.` : "Once approved, press Publish now.") : undefined });
      setTopic(""); setCaption(""); setMediaUrl(""); setCustomAt("");
      await load(); setTab(submit ? "review" : "draft");
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
        : action === "submit" ? "Sent for approval." : action === "return" ? "Sent back to drafts." : action === "stop" ? "Stopped. It will not go out; it is in Drafts now." : "Saved.");
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
      const data = await response.json() as { error?: string; description?: string; created?: number; autopilot?: boolean; instagramSkipped?: boolean; aiPictures?: number; pictureProblem?: string | null };
      if (!response.ok) { setPlanNote({ text: [data.error ?? "Could not plan the week.", data.description].filter(Boolean).join(" "), warn: true }); return; }
      const n = data.created ?? 0;
      setPlanNote({ text: `${n} post${n === 1 ? "" : "s"} planned for the next 7 days. ${data.autopilot ? "They go out by themselves at their time (see Scheduled). Press Stop on any you do not want." : "They are waiting for your approval (see Waiting for approval)."}${data.aiPictures ? ` The AI made ${data.aiPictures === 1 ? "a picture" : `${data.aiPictures} pictures`} for them.` : ""}${data.instagramSkipped ? ` Instagram was skipped for posts without a picture${data.pictureProblem ? ` (${data.pictureProblem})` : ""}.` : ""}`, warn: Boolean(data.instagramSkipped) });
      await load();
      setTab(data.autopilot ? "scheduled" : "review");
    } catch (e) { toastError(e, { fallback: "Could not plan the week.", description: "Nothing was posted. Try again." }); }
    finally { setBusy(false); }
  }

  const count = (key: TabKey) => state?.items.filter(TABS.find((t) => t.key === key)!.match).length ?? 0;
  const items = state?.items.filter(TABS.find((t) => t.key === tab)!.match) ?? [];

  return <div className="mx-auto max-w-[1240px] space-y-6 p-4 md:p-6 lg:p-8">
    <MarketingPageHeader title="Social growth" description="Grow your Facebook, Instagram and LinkedIn audience. Let the AI do the work, watch what it does, stop it any time — or do it yourself." />
    {error && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-sm text-rose-ink">{error}</p><Button onClick={() => void load()}>Try again</Button></div></Card>}
    {!state && !error && <Card><p className="p-6 text-sm text-ink-3">Loading…</p></Card>}
    {state && <>
      <section aria-label="Your accounts" className="grid gap-3 sm:grid-cols-3">
        {[
          { key: "facebook", label: "Facebook", icon: <Facebook size={18} className="text-[#1877f2]" aria-hidden="true" />, name: state.facebook?.name ?? null, count: state.followers.facebook, href: "/marketing/facebook", connect: "Connect Facebook Page" },
          { key: "instagram", label: "Instagram", icon: <Instagram size={18} className="text-[#c13584]" aria-hidden="true" />, name: state.instagram ? `@${state.instagram.name}` : null, count: state.followers.instagram, href: "/marketing/facebook", connect: "Link Instagram to your Page" },
          { key: "linkedin", label: "LinkedIn", icon: <Linkedin size={18} className="text-[#0a66c2]" aria-hidden="true" />, name: state.linkedin?.name ?? null, count: null, href: "/marketing/linkedin", connect: "Connect LinkedIn Page" },
        ].map((a) => <div key={a.key} className="rounded-xl border border-hairline bg-paper p-4">
          <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">{a.icon}{a.label}</span>{a.name ? <Badge kind="success" dot>Connected</Badge> : <Badge kind="muted">Not connected</Badge>}</div>
          {a.name ? <>
            <p className="mt-2 truncate text-xs text-ink-3" title={a.name}>{a.name}</p>
            <p className="mt-1 font-serif text-2xl tabular-nums text-ink">{a.count !== null ? a.count.toLocaleString("en-IN") : "—"}<span className="ml-1.5 font-sans text-xs text-ink-3">{a.count !== null ? "followers" : a.key === "linkedin" ? "followers shown soon" : "followers not shared by Meta"}</span></p>
          </> : <a href={a.href} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-ink underline">{a.connect} <ArrowUpRight size={13} aria-hidden="true" /></a>}
        </div>)}
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
          {[["Comment replies", "AI answers comments on your posts"], ["Follower report", "Weekly growth and what worked"], ["Daily to-do", "5 quick things only a person may do"]].map(([title, text]) => <div key={title} className="grid gap-3 p-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-center">
            <div><p className="text-sm font-semibold text-ink">{title}</p><p className="text-xs text-ink-3">{text}</p></div>
            <p className="text-xs text-ink-3">Coming next</p><span />
          </div>)}
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
          <div><h2 className="text-lg font-semibold">Post it yourself</h2><p className="mt-0.5 text-xs text-ink-3">Write a post by hand (or with one AI press). It follows the normal approval.</p></div>

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

          <label className="block text-xs font-medium text-ink-2">Post text<textarea className={`${inputClass} mt-1 min-h-36 resize-y`} value={caption} maxLength={2200} onChange={e => setCaption(e.target.value)} placeholder="Type the post here, or press Write with AI" /><span className="mt-1 block text-right font-normal text-ink-3">{caption.length}/2200</span></label>

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
            <Button variant="primary" disabled={busy} onClick={() => void send(true)}><Send size={15} /> Send for approval</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void send(false)}>Save as draft</Button>
          </div>
          {platforms.length > 1 && <p className="-mt-2 text-xs text-ink-3">One post is made for each place you picked.</p>}
        </div></Card>

        <Card><div className="space-y-4 p-1 md:p-2">
          <div role="tablist" aria-label="Posts" className="flex flex-wrap gap-2">
            {TABS.map((t) => { const n = count(t.key); return <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} className={chip(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}{n > 0 && <span className={`rounded-full px-1.5 text-xs ${tab === t.key ? "bg-paper text-ink" : t.key === "review" || t.key === "failed" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2"}`}>{n}</span>}</button>; })}
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
          {tab !== "activity" && items.length === 0 && <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">{tab === "review" ? "Nothing is waiting for approval." : tab === "scheduled" ? "No approved posts waiting to go out." : "Nothing here yet."}</div>}
          {tab !== "activity" && <div className="max-h-[850px] space-y-3 overflow-y-auto pr-1">{items.map(item => <div key={item.id} className="rounded-xl border border-hairline bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">{item.platform === "facebook" ? <Facebook size={17} className="text-[#1877f2]" /> : <Instagram size={17} className="text-[#c13584]" />}<span className="text-sm font-medium">{item.platform === "facebook" ? "Facebook" : "Instagram"} {item.format === "story" ? "Story" : "post"}</span>{item.origin !== "manual" && <Badge kind="muted">AI</Badge>}</div>
              <span className="text-xs text-ink-2">{item.status === "published" && item.published_at ? `Posted ${formatIst(item.published_at)}`
                : item.scheduled_at ? (item.status === "approved" && new Date(item.scheduled_at).getTime() <= Date.now() ? "Posting in a few minutes" : `${item.status === "approved" ? "Posts" : "To post"} ${formatIst(item.scheduled_at)}`)
                : item.status === "approved" ? "Approved — post by hand" : "No post time"}</span></div>
            {editing === item.id ? <div className="mt-3 space-y-2"><textarea aria-label="Post text" className={`${inputClass} min-h-28`} value={editCaption} maxLength={2200} onChange={e => setEditCaption(e.target.value)} />{pictureBox(item.id, editMediaUrl, setEditMediaUrl, item.topic, editCaption, "Picture", editMediaUrl === item.media_url ? item.media_preview : null)}<label className="block text-xs font-medium text-ink-2">Post time, India time<input type="datetime-local" className={`${inputClass} mt-1`} value={editPostAt} onChange={e => setEditPostAt(e.target.value)} /></label><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act(item.id, "save", { caption: editCaption, mediaUrl: editMediaUrl || null, scheduledAt: editPostAt || null })}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></div>
              : <><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-2">{item.caption || (item.format === "story" ? "Picture-only Story" : "No text")}</p>{item.media_url && (pagePhotoId(item.media_url) && !item.media_preview
                ? <p className="mt-3 text-xs text-ink-3">AI picture saved in your Facebook Page&apos;s photos (Facebook did not send a preview just now).</p>
                : <div className="mt-3 overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={pagePhotoId(item.media_url) ? item.media_preview! : item.media_url} alt="Post picture" className="max-h-80 w-full object-contain" /></div>)}</>}
            {item.error && <p className="mt-2 rounded-lg bg-rose-soft p-2 text-xs text-rose-ink">Meta said: {item.error} — fix it, then send for approval again.</p>}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
              {item.status === "review" && state.canReview && <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "approve")}><Check size={14} /> Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(item.id, "return")}>Send back</Button></>}
              {item.status === "review" && !state.canReview && <span className="self-center text-xs text-ink-3">Waiting for the owner or a manager.</span>}
              {["draft", "failed"].includes(item.status) && <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "submit")}><Send size={14} /> Send for approval</Button>}
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
