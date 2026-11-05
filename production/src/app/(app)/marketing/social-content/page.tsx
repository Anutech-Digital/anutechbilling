"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { ArrowUpRight, CalendarClock, Check, Facebook, Instagram, PenLine, Send, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingPageHeader } from "@/components/features/marketing-hub/workspace-links";
import { formatIst, quickTimes, toIstLocal } from "@/lib/marketing/social-schedule";

type Platform = "facebook" | "instagram";
type Item = { id: string; platform: Platform; format: "post" | "story"; caption: string; media_url: string | null;
  topic: string; origin: string; status: string; created_at: string; published_at: string | null; error: string | null;
  scheduled_at: string | null };
type State = { items: Item[]; canReview: boolean; canManage: boolean;
  facebook: { name: string } | null; instagram: { name: string; type: string | null } | null;
  settings: { auto_drafts: boolean; brief: string } };

/* R-2513: the queue is split the way the work is done — what waits for the approver comes first. */
const TABS = [
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
  const [tab, setTab] = React.useState<TabKey>("review");
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
  const times = React.useMemo(() => quickTimes(), []);

  const load = React.useCallback(async () => {
    const response = await fetch("/api/marketing/social-content", { cache: "no-store" });
    const data = await response.json() as State & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load content.");
    setState(data); setBrief(data.settings.brief); setAutoDrafts(data.settings.auto_drafts); setError(null);
    return data;
  }, []);
  React.useEffect(() => {
    void load().then((data) => {
      // Open on the tab that has work in it, so nobody lands on an empty list.
      const first = TABS.find((t) => data.items.some(t.match));
      if (first) setTab(first.key);
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
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: platforms[0], format: story ? "story" : "post", topic, caption: "", mediaUrl: null, ai: true, previewOnly: true }) });
      const data = await response.json() as { caption?: string; error?: string };
      if (!response.ok || !data.caption) throw new Error(data.error ?? "AI could not write the post.");
      setCaption(data.caption);
      toast.success("AI wrote the post. Read it, change anything, then send it for approval.");
    } catch (e) { toastError(e, { fallback: "AI could not write the post.", description: "Try a clearer topic, or write the post yourself." }); }
    finally { setBusy(false); }
  }

  async function send(submit: boolean) {
    if (when === "custom" && !customAt) { toast.error("Choose the post time.", { description: "Pick a date and time, or choose Tomorrow 9 AM." }); return; }
    if (hasInstagram && !mediaUrl) { toast.error("Instagram needs a picture.", { description: "Paste a public image link, or untick Instagram." }); return; }
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
        : action === "submit" ? "Sent for approval." : action === "return" ? "Sent back to drafts." : "Saved.");
      setEditing(null); setConfirmPublish(null); await load();
      if (action === "approve") setTab("scheduled");
      if (action === "publish") setTab("published");
    } catch (e) { toastError(e, { fallback: "Could not update draft.", description: "Refresh the page to see its current stage, then try again." }); }
    finally { setBusy(false); }
  }

  async function saveSettings() {
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content/settings", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoDrafts, brief }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not save settings.");
      toast.success("Weekly AI drafts saved."); await load();
    } catch (e) { toastError(e, { fallback: "Could not save settings.", description: "Nothing was saved. Try again." }); }
    finally { setBusy(false); }
  }

  const count = (key: TabKey) => state?.items.filter(TABS.find((t) => t.key === key)!.match).length ?? 0;
  const items = state?.items.filter(TABS.find((t) => t.key === tab)!.match) ?? [];

  return <div className="mx-auto max-w-[1240px] space-y-6 p-4 md:p-6 lg:p-8">
    <MarketingPageHeader title="Social content" description="Write a Facebook or Instagram post, get it approved, and it posts itself at the time you choose." />
    {error && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-sm text-rose-ink">{error}</p><Button onClick={() => void load()}>Try again</Button></div></Card>}
    {!state && !error && <Card><p className="p-6 text-sm text-ink-3">Loading…</p></Card>}
    {state && <>
      <ol className="grid gap-3 sm:grid-cols-3" aria-label="How it works">
        {[
          { icon: <PenLine size={18} />, title: "1. Write", text: "Type the post or let AI write it. Pick when it should go out." },
          { icon: <Check size={18} />, title: "2. Approve", text: "The owner or a manager reads it and presses Approve." },
          { icon: <CalendarClock size={18} />, title: "3. It posts itself", text: "At the chosen time it appears on your Page. Nothing posts without approval." },
        ].map((s) => <li key={s.title} className="flex gap-3 rounded-xl border border-hairline bg-paper p-4"><span className="mt-0.5 text-amber-ink">{s.icon}</span><div><p className="text-sm font-semibold">{s.title}</p><p className="mt-0.5 text-xs leading-5 text-ink-3">{s.text}</p></div></li>)}
      </ol>

      {(!state.facebook || !state.instagram) && <Card><div className="flex flex-wrap items-center justify-between gap-3 p-1">
        <p className="text-sm text-ink-2">{!state.facebook ? "Connect your Facebook Page first — posts go out from it." : "Instagram is not linked yet. Link a professional Instagram account to your Facebook Page, then press Reconnect."}</p>
        <Button asChild variant="outline"><a href="/marketing/facebook">{!state.facebook ? "Connect Facebook Page" : "Open connection"} <ArrowUpRight size={14} /></a></Button>
      </div></Card>}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card><div className="space-y-5 p-1 md:p-2">
          <h2 className="text-lg font-semibold">New post</h2>

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
            <Button className="mt-2" variant="outline" disabled={busy || !topic.trim()} onClick={() => void writeWithAi()}><Sparkles size={15} /> Write with AI</Button>
          </div>

          <label className="block text-xs font-medium text-ink-2">Post text<textarea className={`${inputClass} mt-1 min-h-36 resize-y`} value={caption} maxLength={2200} onChange={e => setCaption(e.target.value)} placeholder="Type the post here, or press Write with AI" /><span className="mt-1 block text-right font-normal text-ink-3">{caption.length}/2200</span></label>

          <label className="block text-xs font-medium text-ink-2">Picture link {hasInstagram ? "(needed for Instagram)" : "(optional)"}<input type="url" className={`${inputClass} mt-1`} value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://… (a public image link)" /></label>
          {mediaUrl && <div className="overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={mediaUrl} alt="Picture preview" className="max-h-60 w-full object-contain" /></div>}

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
          {items.length === 0 && <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">{tab === "review" ? "Nothing is waiting for approval." : tab === "scheduled" ? "No approved posts waiting to go out." : "Nothing here yet."}</div>}
          <div className="max-h-[850px] space-y-3 overflow-y-auto pr-1">{items.map(item => <div key={item.id} className="rounded-xl border border-hairline bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">{item.platform === "facebook" ? <Facebook size={17} className="text-[#1877f2]" /> : <Instagram size={17} className="text-[#c13584]" />}<span className="text-sm font-medium">{item.platform === "facebook" ? "Facebook" : "Instagram"} {item.format === "story" ? "Story" : "post"}</span>{item.origin !== "manual" && <Badge kind="muted">AI</Badge>}</div>
              <span className="text-xs text-ink-2">{item.status === "published" && item.published_at ? `Posted ${formatIst(item.published_at)}`
                : item.scheduled_at ? (item.status === "approved" && new Date(item.scheduled_at).getTime() <= Date.now() ? "Posting in a few minutes" : `${item.status === "approved" ? "Posts" : "To post"} ${formatIst(item.scheduled_at)}`)
                : item.status === "approved" ? "Approved — post by hand" : "No post time"}</span></div>
            {editing === item.id ? <div className="mt-3 space-y-2"><textarea aria-label="Post text" className={`${inputClass} min-h-28`} value={editCaption} maxLength={2200} onChange={e => setEditCaption(e.target.value)} /><input type="url" aria-label="Picture link" className={inputClass} value={editMediaUrl} onChange={e => setEditMediaUrl(e.target.value)} placeholder="Picture link (https://…)" /><label className="block text-xs font-medium text-ink-2">Post time, India time<input type="datetime-local" className={`${inputClass} mt-1`} value={editPostAt} onChange={e => setEditPostAt(e.target.value)} /></label><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act(item.id, "save", { caption: editCaption, mediaUrl: editMediaUrl || null, scheduledAt: editPostAt || null })}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></div>
              : <><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-2">{item.caption || (item.format === "story" ? "Picture-only Story" : "No text")}</p>{item.media_url && <div className="mt-3 overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={item.media_url} alt="Post picture" className="max-h-80 w-full object-contain" /></div>}</>}
            {item.error && <p className="mt-2 rounded-lg bg-rose-soft p-2 text-xs text-rose-ink">Meta said: {item.error} — fix it, then send for approval again.</p>}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
              {item.status === "review" && state.canReview && <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "approve")}><Check size={14} /> Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(item.id, "return")}>Send back</Button></>}
              {item.status === "review" && !state.canReview && <span className="self-center text-xs text-ink-3">Waiting for the owner or a manager.</span>}
              {["draft", "failed"].includes(item.status) && <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "submit")}><Send size={14} /> Send for approval</Button>}
              {["draft", "review", "failed"].includes(item.status) && editing !== item.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(item.id); setEditCaption(item.caption); setEditMediaUrl(item.media_url ?? ""); setEditPostAt(item.scheduled_at ? toIstLocal(item.scheduled_at) : ""); }}>Edit</Button>}
              {item.status === "approved" && state.canReview && (confirmPublish === item.id ? <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "publish")}><Send size={14} /> Yes, post now</Button><Button size="sm" variant="ghost" onClick={() => setConfirmPublish(null)}>Cancel</Button></> : <Button size="sm" variant={item.scheduled_at ? "outline" : "primary"} disabled={busy} onClick={() => setConfirmPublish(item.id)}>{item.scheduled_at ? "Post now instead" : "Publish now"}</Button>)}
            </div>
          </div>)}</div>
        </div></Card>
      </div>

      {state.canManage && <Card><div className="grid gap-4 p-1 md:grid-cols-[1fr_auto] md:items-end md:p-2"><div><h2 className="text-lg font-semibold">Weekly AI drafts</h2><p className="mt-1 text-sm text-ink-3">Every Monday AI writes one draft for each connected place. You still approve each one — nothing posts without approval.</p><label className="mt-4 block text-xs font-medium text-ink-2">What should AI write about?<textarea className={`${inputClass} mt-1 min-h-20`} maxLength={1000} value={brief} onChange={e => setBrief(e.target.value)} placeholder="Your products, who you sell to, tone, and claims to avoid" /></label><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={autoDrafts} onChange={e => setAutoDrafts(e.target.checked)} /> Write weekly AI drafts</label></div><Button disabled={busy} onClick={() => void saveSettings()}>Save</Button></div></Card>}
    </>}
  </div>;
}
