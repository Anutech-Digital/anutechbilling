"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { ArrowUpRight, Check, Facebook, Instagram, Send, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingPageHeader } from "@/components/features/marketing-hub/workspace-links";
import { formatIst, toIstLocal } from "@/lib/marketing/social-schedule";

type Item = { id: string; platform: "facebook" | "instagram"; format: "post" | "story"; caption: string; media_url: string | null;
  topic: string; origin: string; status: string; created_at: string; published_at: string | null; error: string | null;
  scheduled_at: string | null };
type State = { items: Item[]; canReview: boolean; canManage: boolean;
  facebook: { name: string } | null; instagram: { name: string; type: string | null } | null;
  settings: { auto_drafts: boolean; brief: string } };
const statusLabel: Record<string, string> = { draft: "Draft", review: "Needs review", approved: "Approved", publishing: "Publishing", published: "Published", failed: "Needs attention" };
const inputClass = "w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent";

export default function SocialContentPage() {
  const [state, setState] = React.useState<State | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState("all");
  const [platform, setPlatform] = React.useState<"facebook" | "instagram">("facebook");
  const [format, setFormat] = React.useState<"post" | "story">("post");
  const [topic, setTopic] = React.useState("");
  const [caption, setCaption] = React.useState("");
  const [mediaUrl, setMediaUrl] = React.useState("");
  const [postAt, setPostAt] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editCaption, setEditCaption] = React.useState("");
  const [editMediaUrl, setEditMediaUrl] = React.useState("");
  const [editPostAt, setEditPostAt] = React.useState("");
  const [confirmPublish, setConfirmPublish] = React.useState<string | null>(null);
  const [brief, setBrief] = React.useState("");
  const [autoDrafts, setAutoDrafts] = React.useState(false);

  const load = React.useCallback(async () => {
    const response = await fetch("/api/marketing/social-content", { cache: "no-store" });
    const data = await response.json() as State & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load content.");
    setState(data); setBrief(data.settings.brief); setAutoDrafts(data.settings.auto_drafts); setError(null);
  }, []);
  React.useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);

  async function create(ai: boolean) {
    setBusy(true);
    try {
      const response = await fetch("/api/marketing/social-content", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, format, topic, caption, mediaUrl: mediaUrl || null, ai, scheduledAt: postAt || null }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not save draft.");
      toast.success(ai ? "AI draft ready for review." : "Draft saved.");
      setTopic(""); setCaption(""); setMediaUrl(""); setPostAt(""); await load();
    } catch (e) { toastError(e, { fallback: "Could not save draft.", description: "Your text is still in the form. Fix what the message says and save again." }); }
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
      toast.success(action === "publish" ? "Published to Meta."
        : action === "approve" ? (item?.scheduled_at ? `Approved. It posts on ${formatIst(item.scheduled_at)}.` : "Approved. Press Publish now when you are ready.")
        : "Content updated.");
      setEditing(null); setConfirmPublish(null); await load();
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
      toast.success("Draft automation saved."); await load();
    } catch (e) { toastError(e, { fallback: "Could not save settings.", description: "Nothing was saved. Try again." }); }
    finally { setBusy(false); }
  }

  const items = state?.items.filter(x => filter === "all" || x.status === filter) ?? [];
  const needsReview = state?.items.filter(x => x.status === "review").length ?? 0;
  const published = state?.items.filter(x => x.status === "published").length ?? 0;
  return <div className="mx-auto max-w-[1240px] space-y-6 p-4 md:p-6 lg:p-8">
    <MarketingPageHeader title="Social content" description="Plan Facebook and Instagram content. Every post is reviewed by a person before publishing." />
    {error && <Card><div role="alert" className="flex items-center justify-between gap-3"><p className="text-sm text-rose-ink">{error}</p><Button onClick={() => void load()}>Try again</Button></div></Card>}
    {!state && !error && <Card><p className="p-6 text-sm text-ink-3">Loading content workspace…</p></Card>}
    {state && <>
      <div className="grid gap-3 md:grid-cols-3">
        <Card><div className="flex items-center gap-3 p-1"><Facebook className="text-[#1877f2]" size={24} /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-ink-3">Facebook Page</p><p className="truncate font-medium">{state.facebook?.name ?? "Not connected"}</p></div></div></Card>
        <Card><div className="flex items-center gap-3 p-1"><Instagram className="text-[#c13584]" size={24} /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-ink-3">Instagram</p><p className="truncate font-medium">{state.instagram ? `@${state.instagram.name}` : "Not linked to Page"}</p></div></div></Card>
        <Card><div className="flex justify-between gap-3 p-1"><div><p className="text-xs uppercase tracking-wide text-ink-3">Review queue</p><p className="mt-1 text-xl font-semibold">{needsReview} waiting</p></div><div className="text-right text-xs text-ink-3">{published} published</div></div></Card>
      </div>
      {(!state.facebook || !state.instagram) && <Card><div className="flex flex-wrap items-center justify-between gap-3 p-1"><p className="text-sm text-ink-2">{!state.facebook ? "Connect a Facebook Page first." : "Link a professional Instagram account to this Facebook Page, then reconnect Meta."}</p><Button asChild variant="outline"><a href="/marketing/facebook">Manage connection <ArrowUpRight size={14} /></a></Button></div></Card>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card><div className="space-y-4 p-1 md:p-2">
          <div><h2 className="text-lg font-semibold">Create content</h2><p className="mt-1 text-sm text-ink-3">Write a post or give AI a topic. Save it as a draft before review.</p></div>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-ink-2">Platform<select className={`${inputClass} mt-1`} value={platform} onChange={e => { setPlatform(e.target.value as "facebook" | "instagram"); if (e.target.value === "facebook") setFormat("post"); }}><option value="facebook">Facebook Page</option><option value="instagram">Instagram</option></select></label>
            <label className="text-xs font-medium text-ink-2">Format<select className={`${inputClass} mt-1`} value={format} onChange={e => setFormat(e.target.value as "post" | "story")}><option value="post">Feed post</option>{platform === "instagram" && <option value="story">Story</option>}</select></label></div>
          <label className="block text-xs font-medium text-ink-2">Topic or brief<input className={`${inputClass} mt-1`} value={topic} maxLength={500} onChange={e => setTopic(e.target.value)} placeholder="Example: 3 useful Google Workspace tips for small teams" /></label>
          <label className="block text-xs font-medium text-ink-2">Caption<textarea className={`${inputClass} mt-1 min-h-32 resize-y`} value={caption} maxLength={2200} onChange={e => setCaption(e.target.value)} placeholder="Write your caption, or generate one with AI" /><span className="mt-1 block text-right text-ink-3">{caption.length}/2200</span></label>
          <label className="block text-xs font-medium text-ink-2">Public HTTPS image URL {platform === "instagram" ? "(required)" : "(optional)"}<input type="url" className={`${inputClass} mt-1`} value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://example.com/image.jpg" /></label>
          <label className="block text-xs font-medium text-ink-2">Post time, India time (optional)<input type="datetime-local" className={`${inputClass} mt-1`} value={postAt} onChange={e => setPostAt(e.target.value)} /><span className="mt-1 block font-normal text-ink-3">After the owner or a manager approves it, the post goes out at this time. Leave empty to publish by hand.</span></label>
          <p className="text-xs text-ink-3">Instagram needs a professional account linked to the Facebook Page. Its image must be available at a public HTTPS URL so Meta can fetch it. Use media you own or have permission to publish.</p>
          {mediaUrl && <div className="overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={mediaUrl} alt="Draft media preview" className="max-h-72 w-full object-contain" /></div>}
          <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy} onClick={() => void create(false)}>Save draft</Button><Button variant="outline" disabled={busy || !topic.trim()} onClick={() => void create(true)}><Sparkles size={15} /> Generate AI draft</Button></div>
        </div></Card>
        <Card><div className="space-y-4 p-1 md:p-2">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Content queue</h2><p className="mt-1 text-sm text-ink-3">Review the caption and image before approving or publishing.</p></div><select aria-label="Filter content" className="rounded-lg border border-hairline bg-paper px-3 py-2 text-sm" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All content</option><option value="draft">Drafts</option><option value="review">Needs review</option><option value="approved">Approved</option><option value="published">Published</option><option value="failed">Needs attention</option></select></div>
          {items.length === 0 && <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-3">No content in this view yet.</div>}
          <div className="max-h-[850px] space-y-3 overflow-y-auto pr-1">{items.map(item => <div key={item.id} className="rounded-xl border border-hairline bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">{item.platform === "facebook" ? <Facebook size={17} className="text-[#1877f2]" /> : <Instagram size={17} className="text-[#c13584]" />}<span className="text-sm font-medium">{item.platform === "facebook" ? "Facebook" : "Instagram"} {item.format === "story" ? "Story" : "post"}</span><Badge kind={item.status === "published" ? "success" : "muted"}>{item.status === "approved" && item.scheduled_at ? "Scheduled" : statusLabel[item.status] ?? item.status}</Badge></div><time className="text-xs text-ink-3">{new Date(item.created_at).toLocaleDateString()}</time></div>
            {editing === item.id ? <div className="mt-3 space-y-2"><textarea className={`${inputClass} min-h-28`} value={editCaption} maxLength={2200} onChange={e => setEditCaption(e.target.value)} /><input type="url" className={inputClass} value={editMediaUrl} onChange={e => setEditMediaUrl(e.target.value)} placeholder="Public HTTPS image URL" /><label className="block text-xs font-medium text-ink-2">Post time, India time (optional)<input type="datetime-local" className={`${inputClass} mt-1`} value={editPostAt} onChange={e => setEditPostAt(e.target.value)} /></label><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act(item.id, "save", { caption: editCaption, mediaUrl: editMediaUrl || null, scheduledAt: editPostAt || null })}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></div> : <><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-2">{item.caption || (item.format === "story" ? "Image Story" : "No caption")}</p>{item.media_url && <div className="mt-3 overflow-hidden rounded-lg border border-hairline bg-paper-2"><img src={item.media_url} alt="Content awaiting review" className="max-h-80 w-full object-contain" /></div>}{item.media_url && <a href={item.media_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-amber-ink underline">Open original image <ArrowUpRight size={12} /></a>}</>}
            {item.scheduled_at && ["draft", "review", "approved", "failed"].includes(item.status) && <p className="mt-2 text-xs text-ink-2">{item.status === "approved"
              ? (new Date(item.scheduled_at).getTime() <= Date.now() ? "Posting in the next few minutes." : `Posts on ${formatIst(item.scheduled_at)}.`)
              : `Post time: ${formatIst(item.scheduled_at)} — goes out only after approval.`}</p>}
            {item.error && <p className="mt-2 rounded-lg bg-rose-soft p-2 text-xs text-rose-ink">{item.error}</p>}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
              {["draft", "review", "failed"].includes(item.status) && editing !== item.id && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(item.id); setEditCaption(item.caption); setEditMediaUrl(item.media_url ?? ""); setEditPostAt(item.scheduled_at ? toIstLocal(item.scheduled_at) : ""); }}>Edit</Button>}
              {["draft", "failed"].includes(item.status) && <Button size="sm" disabled={busy} onClick={() => void act(item.id, "submit")}>Submit for review</Button>}
              {item.status === "review" && state.canReview && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(item.id, "return")}>Return to draft</Button><Button size="sm" disabled={busy} onClick={() => void act(item.id, "approve")}><Check size={14} /> Approve</Button></>}
              {item.status === "approved" && state.canReview && (confirmPublish === item.id ? <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act(item.id, "publish")}><Send size={14} /> Confirm publish</Button><Button size="sm" variant="ghost" onClick={() => setConfirmPublish(null)}>Cancel</Button></> : <Button size="sm" variant={item.scheduled_at ? "outline" : "primary"} disabled={busy} onClick={() => setConfirmPublish(item.id)}>{item.scheduled_at ? "Publish now instead" : "Publish now"}</Button>)}
              {item.status === "published" && item.published_at && <span className="self-center text-xs text-ink-3">Published {formatIst(item.published_at)}</span>}
            </div>
          </div>)}</div>
        </div></Card>
      </div>
      {state.canManage && <Card><div className="grid gap-4 p-1 md:grid-cols-[1fr_auto] md:items-end md:p-2"><div><h2 className="text-lg font-semibold">Automatic draft preparation</h2><p className="mt-1 text-sm text-ink-3">Prepare one draft for each connected platform every Monday. Nothing publishes automatically.</p><label className="mt-4 block text-xs font-medium text-ink-2">Topics and brand guidance<textarea className={`${inputClass} mt-1 min-h-20`} maxLength={1000} value={brief} onChange={e => setBrief(e.target.value)} placeholder="Products, audience, tone, and claims to avoid" /></label><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={autoDrafts} onChange={e => setAutoDrafts(e.target.checked)} /> Prepare weekly AI drafts</label></div><Button disabled={busy} onClick={() => void saveSettings()}>Save automation</Button></div></Card>}
    </>}
  </div>;
}
