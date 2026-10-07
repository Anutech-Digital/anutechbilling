"use client";

/**
 * Agent tooling for a support ticket — DSP-merge brick 1b (7 Sep 2026).
 *
 * Three quiet tools the person answering a ticket actually uses all day,
 * ported (as behaviour, not code) from DSP:
 *
 *   · Internal notes — what the team knows that the customer must never see.
 *     Append-only by design; the matching RLS refuses UPDATE/DELETE, so the UI
 *     doesn't offer them. A wrong note gets a correcting note, like a ledger.
 *   · Time log — whole minutes per sitting, per agent. Sums at the top because
 *     "how long has this ticket cost us" is the question, the rows are evidence.
 *   · Canned replies — the snippets agents paste all day. Picking one INSERTS
 *     into the reply box (via onInsertText) rather than sending, because a
 *     canned answer is a starting point, not an answer.
 *
 * All three tables are tenant-scoped with composite-FK guards
 * (20260907120000_support_agent_tooling.sql); this component supplies
 * tenant_id/author from useCurrentUser and lets RLS be the wall.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { RatingStars } from "@/components/features/support/ticket-rating";

interface TicketNote {
  id: string;
  author_name: string;
  body: string;
  created_at: string;
}

interface TimeLog {
  id: string;
  user_name: string;
  minutes: number;
  note: string | null;
  created_at: string;
}

interface CannedResponse {
  id: string;
  title: string;
  body: string;
  usage_count: number;
}

interface AgentToolingPanelProps {
  ticketId: string;
  /** Called with the canned body — the page decides where the text lands. */
  onInsertText: (text: string) => void;
}

function minutesLabel(total: number): string {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function AgentToolingPanel({ ticketId, onInsertText }: AgentToolingPanelProps) {
  const { data: me } = useCurrentUser();
  const queryClient = useQueryClient();

  const [noteDraft, setNoteDraft] = useState("");
  const [minutesDraft, setMinutesDraft] = useState("");
  const [minutesNote, setMinutesNote] = useState("");
  const [newCannedTitle, setNewCannedTitle] = useState("");
  const [newCannedBody, setNewCannedBody] = useState("");
  const [showNewCanned, setShowNewCanned] = useState(false);

  // ── Reads ──────────────────────────────────────────────────────────────────
  const notesQ = useQuery({
    queryKey: ["support-ticket-notes", ticketId],
    queryFn: async (): Promise<TicketNote[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("support_ticket_notes")
        .select("id, author_name, body, created_at")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!ticketId,
  });

  const timeQ = useQuery({
    queryKey: ["support-ticket-time", ticketId],
    queryFn: async (): Promise<TimeLog[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("support_ticket_time_logs")
        .select("id, user_name, minutes, note, created_at")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!ticketId,
  });

  /* The customer's verdict on this ticket, if they gave one (CSAT, brick 3).
     Read-only here by design — RLS refuses agent writes, and the panel never
     offers what the wall refuses. */
  const ratingQ = useQuery({
    queryKey: ["support-ticket-rating", ticketId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("support_ticket_ratings")
        .select("score, comment, rated_by_email, created_at")
        .eq("ticket_id", ticketId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!ticketId,
  });

  const cannedQ = useQuery({
    queryKey: ["support-canned-responses"],
    queryFn: async (): Promise<CannedResponse[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("support_canned_responses")
        .select("id, title, body, usage_count")
        .order("usage_count", { ascending: false })
        .order("title", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  // ── Writes ─────────────────────────────────────────────────────────────────
  const addNote = useMutation({
    mutationFn: async (body: string) => {
      if (!me) throw new Error("profile-not-loaded");
      const supabase = createClient();
      const { error } = await supabase.from("support_ticket_notes").insert({
        tenant_id: me.tenantId,
        ticket_id: ticketId,
        author_id: me.userId,
        author_name: me.fullName ?? "Agent",
        body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNoteDraft("");
      queryClient.invalidateQueries({ queryKey: ["support-ticket-notes", ticketId] });
    },
    onError: () =>
      toast.error("Note save nahi hua", {
        description: "Network ya permission ka masla ho sakta hai — text abhi box me hi hai.",
        action: { label: "Retry", onClick: () => addNote.mutate(noteDraft.trim()) },
      }),
  });

  const addTime = useMutation({
    mutationFn: async ({ minutes, note }: { minutes: number; note: string }) => {
      if (!me) throw new Error("profile-not-loaded");
      const supabase = createClient();
      const { error } = await supabase.from("support_ticket_time_logs").insert({
        tenant_id: me.tenantId,
        ticket_id: ticketId,
        user_id: me.userId,
        user_name: me.fullName ?? "Agent",
        minutes,
        note: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMinutesDraft("");
      setMinutesNote("");
      queryClient.invalidateQueries({ queryKey: ["support-ticket-time", ticketId] });
    },
    onError: () =>
      toast.error("Time log save nahi hua", {
        description: "1 se 1440 minute ke beech hona chahiye; network bhi jaanch lein.",
        action: {
          label: "Retry",
          onClick: () => {
            const m = parseInt(minutesDraft, 10);
            if (m >= 1 && m <= 1440) addTime.mutate({ minutes: m, note: minutesNote });
          },
        },
      }),
  });

  const addCanned = useMutation({
    mutationFn: async ({ title, body }: { title: string; body: string }) => {
      if (!me) throw new Error("profile-not-loaded");
      const supabase = createClient();
      const { error } = await supabase.from("support_canned_responses").insert({
        tenant_id: me.tenantId,
        title,
        body,
        created_by: me.userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewCannedTitle("");
      setNewCannedBody("");
      setShowNewCanned(false);
      queryClient.invalidateQueries({ queryKey: ["support-canned-responses"] });
    },
    onError: (err: { code?: string }) =>
      toast.error("Canned reply bana nahi", {
        description:
          err?.code === "23505"
            ? "Is naam ki canned reply pehle se hai — naya title chunein."
            : "Network ya permission ka masla — dobara koshish karein.",
        action: { label: "Retry", onClick: () => addCanned.mutate({ title: newCannedTitle.trim(), body: newCannedBody.trim() }) },
      }),
  });

  const useCanned = useMutation({
    mutationFn: async (c: CannedResponse) => {
      onInsertText(c.body);
      // Usage count is a convenience ranking, not money — best-effort update.
      const supabase = createClient();
      await supabase
        .from("support_canned_responses")
        .update({ usage_count: c.usage_count + 1, updated_at: new Date().toISOString() })
        .eq("id", c.id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["support-canned-responses"] }),
  });

  const totalMinutes = (timeQ.data ?? []).reduce((s, r) => s + r.minutes, 0);
  const notes = notesQ.data ?? [];
  const canned = cannedQ.data ?? [];

  return (
    <div className="space-y-4 pt-2 border-t border-hairline">
      {/* ── Customer verdict (CSAT) — shown only when one exists ── */}
      {ratingQ.data && (
        <div className="rounded-md border border-hairline bg-paper-2/60 px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-ink-3 uppercase tracking-wider">Customer verdict</span>
          <RatingStars score={ratingQ.data.score} />
          {ratingQ.data.comment && (
            <span className="text-xs text-ink-2">“{ratingQ.data.comment}”</span>
          )}
          <span className="text-2xs text-ink-3 ml-auto">
            {ratingQ.data.rated_by_email} · {formatDate(ratingQ.data.created_at, "short")}
          </span>
        </div>
      )}

      {/* ── Canned replies ── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p id="canned-replies-heading" className="block text-xs font-bold text-ink-3 uppercase tracking-wider">
            Canned replies
          </p>
          <button
            type="button"
            onClick={() => setShowNewCanned((v) => !v)}
            aria-expanded={showNewCanned}
            className="text-2xs font-semibold text-amber hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink rounded"
          >
            {showNewCanned ? "Cancel" : "+ New"}
          </button>
        </div>

        {canned.length === 0 && !showNewCanned && (
          <p className="text-xs text-ink-3">
            Koi canned reply nahi hai abhi —{" "}
            <button
              type="button"
              onClick={() => setShowNewCanned(true)}
              className="text-amber font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink rounded"
            >
              pehli banayein
            </button>
            . Baar-baar likhe jaane wale jawab yahan ek click ban jaate hain.
          </p>
        )}

        {canned.length > 0 && (
          <div role="group" aria-labelledby="canned-replies-heading" className="flex flex-wrap gap-1.5">
            {canned.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => useCanned.mutate(c)}
                title={c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body}
                className="text-xs px-2.5 py-1 rounded-md border border-hairline bg-paper hover:bg-amber-soft hover:border-amber/40 text-ink transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
              >
                {c.title}
              </button>
            ))}
          </div>
        )}

        {showNewCanned && (
          <div className="space-y-1.5 rounded-md border border-hairline bg-paper-2/50 p-2.5">
            <label htmlFor="cannedTitle" className="sr-only">Canned reply title</label>
            <input
              id="cannedTitle"
              type="text"
              value={newCannedTitle}
              onChange={(e) => setNewCannedTitle(e.target.value)}
              maxLength={120}
              placeholder="Title — e.g. MX records kaise set karein"
              className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <label htmlFor="cannedBody" className="sr-only">Canned reply body</label>
            <textarea
              id="cannedBody"
              rows={3}
              value={newCannedBody}
              onChange={(e) => setNewCannedBody(e.target.value)}
              maxLength={8000}
              placeholder="Jawab ka text — pick karne par reply box me aa jayega"
              className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <Button
              size="sm"
              variant="outline"
              loading={addCanned.isPending}
              disabled={!newCannedTitle.trim() || !newCannedBody.trim()}
              onClick={() => addCanned.mutate({ title: newCannedTitle.trim(), body: newCannedBody.trim() })}
            >
              Save canned reply
            </Button>
          </div>
        )}
      </div>

      {/* ── Internal notes ── */}
      <div className="space-y-1.5">
        <label htmlFor="internalNote" className="block text-xs font-bold text-ink-3 uppercase tracking-wider">
          Internal notes
          <span className="ml-2 normal-case tracking-normal font-semibold text-amber-ink bg-amber-soft rounded px-1.5 py-0.5">
            sirf team ko dikhta hai
          </span>
        </label>

        {notesQ.isLoading ? (
          <p className="text-xs text-ink-3">Loading notes…</p>
        ) : notes.length > 0 ? (
          <ul className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md bg-paper-2/60 border border-hairline px-2.5 py-1.5">
                <p className="text-xs text-ink whitespace-pre-wrap break-words">{n.body}</p>
                <p className="mt-0.5 text-2xs text-ink-3">
                  {n.author_name} · {formatDate(n.created_at, "short")}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">Abhi koi note nahi. Jo customer ko nahi dikhna chahiye, wo yahan likhein.</p>
        )}

        <div className="flex gap-2">
          <textarea
            id="internalNote"
            rows={2}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            maxLength={8000}
            placeholder="Note likhein — append-only hai, edit/delete nahi hota (audit trail)"
            className="flex-1 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            size="sm"
            variant="outline"
            loading={addNote.isPending}
            disabled={!noteDraft.trim()}
            onClick={() => addNote.mutate(noteDraft.trim())}
          >
            Add note
          </Button>
        </div>
      </div>

      {/* ── Time log ── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="timeMinutes" className="block text-xs font-bold text-ink-3 uppercase tracking-wider">
            Time log
          </label>
          {totalMinutes > 0 && (
            <span className="text-xs font-semibold text-ink font-mono" title="Is ticket par ab tak ka kul samay">
              Total: {minutesLabel(totalMinutes)}
            </span>
          )}
        </div>

        {(timeQ.data ?? []).length > 0 && (
          <ul className="space-y-1 max-h-[120px] overflow-y-auto pr-1">
            {(timeQ.data ?? []).map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-ink-2 truncate" title={t.note ?? undefined}>
                  {t.user_name}
                  {t.note ? ` — ${t.note}` : ""}
                </span>
                <span className="font-mono text-ink shrink-0">{minutesLabel(t.minutes)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <input
            id="timeMinutes"
            type="number"
            min={1}
            max={1440}
            value={minutesDraft}
            onChange={(e) => setMinutesDraft(e.target.value)}
            placeholder="min"
            aria-label="Minutes spent"
            className="w-20 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          <input
            type="text"
            value={minutesNote}
            onChange={(e) => setMinutesNote(e.target.value)}
            maxLength={500}
            placeholder="kya kiya (optional)"
            aria-label="What was done in this time"
            className="flex-1 min-w-[140px] rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            size="sm"
            variant="outline"
            loading={addTime.isPending}
            disabled={(() => {
              const m = parseInt(minutesDraft, 10);
              return !(m >= 1 && m <= 1440);
            })()}
            onClick={() => {
              const m = parseInt(minutesDraft, 10);
              addTime.mutate({ minutes: m, note: minutesNote });
            }}
          >
            Log time
          </Button>
        </div>
      </div>
    </div>
  );
}
