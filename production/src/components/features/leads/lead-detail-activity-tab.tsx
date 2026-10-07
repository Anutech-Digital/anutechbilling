"use client";
/** The drawer's Activity tab — note box, call log, and the merged timeline (S35, moved verbatim). */
import * as React from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { useLogLeadActivity } from "@/lib/queries/lead-activities";
import type { useLeadOutcome } from "@/lib/leads/use-outcome";
import { timelineMeta, type buildTimeline } from "@/lib/leads/timeline";
import { fmtActTime } from "@/components/features/leads/lead-detail-format";

export interface LeadActivityTabProps {
  lead: Lead;
  noteDraft: string;
  setNoteDraft: (v: string) => void;
  logActivity: ReturnType<typeof useLogLeadActivity>;
  /** useCallLog(runOutcome) from the drawer — the ONE "Call log" popup. */
  callLog: { run: (outcome: Parameters<ReturnType<typeof useLeadOutcome>>[0], lead: Lead) => void; dialog: React.ReactNode };
  runOutcome: ReturnType<typeof useLeadOutcome>;
  timeline: ReturnType<typeof buildTimeline>;
}

export function LeadActivityTab({ lead, noteDraft, setNoteDraft, logActivity, callLog, runOutcome, timeline }: LeadActivityTabProps) {
  return (
          <div>
            {/* ── ADD TO THE THREAD ────────────────────────────────────────────
                Moved here 23 Aug 2026 out of a card that sat above all three tabs. These
                three do one job — put something into the conversation — so they belong to
                the conversation, not to Details and Follow-ups where they were only
                height. Above the timeline rather than below it because the timeline is
                newest-first: the newest entry and the box that creates the next one
                belong next to each other, and a composer below an unbounded list is a
                composer you have to scroll to find.

                LOG CALL IS NOT THE FOOTER'S CALL BUTTON. That one starts a call; these
                record a call that already happened — from a mobile, or before this lead
                existed here. A call made and never logged is invisible to the timeline,
                the stage-age badge and every forecast built on them, which is why this
                survived the card and "Generate quote" did not.

                Since 26 Aug 2026 it is TWO buttons, not one. The old single "Log call"
                wrote an activity and left the stage alone, while the row's "Baat hui" chip
                moved it — one act, two doors, two answers. The fix is not to make logging
                move the stage: "record a call you made elsewhere" never said whether
                anybody PICKED UP, and counting a rung-out phone as contact is the exact
                lie outcomes.ts exists to prevent. So the buttons ask instead of assuming,
                and both go through `runOutcome` — the same rule the row obeys.

                The note box stays inline rather than behind a dialog: a note nobody can
                write in two seconds is a note nobody writes. */}
            <div className="mb-3 space-y-2 rounded-lg border border-hairline bg-paper-2/40 p-3">
              <div className="flex items-start gap-2">
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={2}
                  placeholder="Add a note — what was said, what they asked for…"
                  aria-label={`Add a note about ${lead.company}`}
                  className="min-w-0 flex-1 resize-y rounded-md border border-hairline bg-paper px-2 py-1.5 text-xs text-ink placeholder:text-ink-4 focus:border-amber focus:outline-none focus:ring-1 focus:ring-amber"
                />
                {/* Mic yahan se hata diya gaya — wo ab "Call log" ke popup me hai
                    (`call-log-dialog.tsx`). Ek hi dictation ke do mic do jagah dikhane ka
                    matlab hota ek "sun raha hoon" state aur do button jo aapas me
                    jhagadte. Ye box ab saaf note ke liye hai (typing + Save); call ka
                    mazmoon popup me jata hai. */}
                <button
                  type="button"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    logActivity.mutate({ leadId: lead.id, kind: "note", detail: noteDraft.trim() });
                    setNoteDraft("");
                    toast.success("Note added");
                  }}
                  className={cn(
                    "shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors",
                    noteDraft.trim()
                      ? "border-hairline-strong bg-paper text-ink-2 hover:bg-paper-2"
                      : "cursor-not-allowed border-hairline text-ink-4",
                  )}
                >
                  Save
                </button>
              </div>

              {/* Ye hint line HATA di gayi. Wo kehti thi "Baat hui ya No answer dabaiye to
                  ye isi call ke saath record hoga" — aur "Call log" ke popup me jane ke
                  baad wo JHOOTH ho gayi: popup ka apna text hai, aur is box ka likha hua
                  wahan nahi jata. Ek galat hidayat kisi hidayat se bura hai; box ka apna
                  placeholder ("Add a note…") aur `Save` button hi kaafi hain. */}

              {/* flex, not a 2-col grid: the AI button is conditional on there being a
                  phone or an email, and in a fixed grid its absence left the call buttons
                  at half width against dead space. */}
              <div className="flex gap-2">
                {/* ── Ek "Log call" ki jagah do, aur wajah 26 Aug 2026 ki hai ──────────
                    Yahan pehle ek hi button tha: "Log call". Wo activity likhta tha aur
                    stage ko haath nahi lagata tha. Us din row ke chips stage badalna seekh
                    gaye, aur isse ek ajeeb haalat ban gayi — EK HI kaam, do darwaze, alag
                    nateeje. Pardeep ne wahi pakda: "jab is lead ne activity record ki to
                    ye contacted me kyon nahi gaya".

                    Aasan hal — "Log call ko bhi stage badalne do" — GALAT hota. Is button
                    ke apne tooltip me likha tha "record a call you made elsewhere", aur
                    usme ye kahin nahi tha ki BAAT HUI ya nahi. Bina uthi call ko sampark
                    ginna wahi jhooth hai jise outcomes.ts ka poora header rokta hai.

                    To button batata nahi, POOCHHTA hai. Dono `runOutcome` se guzarte hain,
                    yaani wahi niyam jo row par lagta hai — ek hi shabdawali, ek hi
                    bartaav, chahe rep kahin se bhi tap kare. */}
                {/* ── "Call log" — ek popup kholta hai (26 Aug 2026) ──────────────────
                    Pehle ye "Baat hui" tha aur seedha likh deta tha, us note ke saath jo
                    upar wale box me pada ho. Do dikkat thin: naam se pata nahi chalta tha
                    ki ye ek CALL darj karta hai, aur likhne ki jagah button se door thi —
                    to aksar khaali call log ho jati thi.

                    Popup dono theek karta hai: likhna aur bolna wahin, button ke saath,
                    aur "Call log" naam wahi kehta hai jo ye karta hai. */}
                <button
                  type="button"
                  onClick={() => callLog.run("talked", lead)}
                  title="Log a call by voice or text. First call moves the lead to Contacted."
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-amber/50 bg-paper text-xs font-semibold text-amber-ink transition-colors hover:bg-amber-soft/50"
                >
                  <Icon name="mobile" size={13} /> Log call
                </button>
                <button
                  type="button"
                  onClick={() => { void runOutcome("no_answer", lead, noteDraft); setNoteDraft(""); }}
                  disabled={!lead.contact_phone}
                  title={lead.contact_phone
                    ? "Called, no answer. Logs the attempt; lead returns tomorrow. Stage unchanged."
                    : "No phone number on this lead — add one first."}
                  className={cn(
                    "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border bg-paper text-xs font-semibold transition-colors",
                    lead.contact_phone
                      ? "border-hairline text-ink-2 hover:bg-paper-2"
                      : "cursor-not-allowed border-hairline text-ink-4 opacity-50",
                  )}
                >
                  <Icon name="mobile" size={13} /> No answer
                </button>
                {/* "✨ Draft with AI" yahan se hata diya gaya (26 Aug 2026, Pardeep ke
                    kehne par). Wo is jagah ka kaam nahi kar raha tha: ye teen button "jo
                    HUA use darj karo" ke liye hain, aur wo "ab kya KEHNA hai" ka auzaar
                    hai — do alag kaam ek hi kataar me.

                    Feature khatm nahi hua, sirf galat jagah se hata: `ReplyComposer` (Email
                    tab) me apna "Draft with AI" hai — reply-composer.tsx:210, jaancha gaya —
                    aur wahan wo apni jagah par hai, kyunki wahan padhne ke liye thread bhi
                    hoti hai. `AiDraftButton` khud renewals page par bhi zinda hai. */}
              </div>

              {/* ── Call log ka popup ─────────────────────────────────────────────────
                  Ye popup pehle yahin, is JSX ke andar likha tha. 26 Aug 2026 ko wo
                  `call-log-dialog.tsx` me chala gaya, kyunki row ke ⋯ menu ka "Call log"
                  isi naam se seedha log kar deta tha — ek naam, do bartaav. Popup ko
                  dono jagah alag-alag likhna us bug ka doosra roop hota.

                  Ab wo ek hi component hai aur `useCallLog` uska ek hi darwaza. Phone par
                  ye khud bottom-sheet ban jata hai (CLAUDE.md §20) — aur call ke turant
                  baad haath me phone hi hota hai. */}
              {callLog.dialog}
            </div>

            {/* No segmented control here any more, and no "Everything that has happened"
                heading either. Email became its own tab on 23 Aug 2026, so the control had
                nothing left to switch between — and with the tab strip above already
                reading "Activity (16)", a heading saying the same thing in more words was
                the third label in a stack of three.

                What the old control was FOR is still true and is now the tab split: this
                list is newest-first and answers "what happened last"; the Email tab is
                oldest-first and answers "how did the exchange go", which is what you need
                before writing the next line of it. */}
            {/* One stream, not three lists. The drawer already loaded activities, quotes
                and tasks; showing them separately made the rep do the interleaving in
                their head, and get it wrong — each list sorts alone, so a quote sent on
                the 3rd rendered above a call made on the 5th. */}
            {timeline.entries.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                Nothing recorded yet. Calls, WhatsApps, quotes, tasks and payments all
                appear here once they happen.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {timeline.entries.map((e) => {
                  const meta = timelineMeta(e);
                  /* R-341 (7 Oct 2026, Pardeep): "ye clickable hone chahiye aur related
                     document open kare click par". The WHOLE row is the link, not only the
                     title (the deal feed's pattern) — on a phone a title-only link is a
                     target the thumb misses. A row with no page of its own (call, note,
                     email, WhatsApp) stays plain text: a link to nowhere useful is worse
                     than no link, and the chevron is how the eye tells the two apart. */
                  const body = (
                    <>
                      <div className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2",
                        meta.tone,
                      )}>
                        <Icon name={meta.icon} size={12} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm text-ink">{e.title}</span>
                          {typeof e.amount === "number" && e.amount > 0 && (
                            <span className="shrink-0 font-mono text-xs font-semibold text-ink-2">
                              {rupee(e.amount)}
                            </span>
                          )}
                        </div>
                        {/* ── `truncate` NAHI, aur ye 26 Aug 2026 ko naapa gaya ──────────
                            Us din call ka note isi detail me aana shuru hua ("Baat hui ·
                            +91… · \"March me budget aayega\""). Ek-line truncate ne use
                            theek us jagah kaat diya jahan aadmi ke shabd shuru hote the —
                            screen par bacha "…— retrying tomor…". Baat record to hoti thi,
                            padhi nahi ja sakti thi, yaani poora maqsad hi mar jata.

                            3 line tak khulta hai (lamba paste timeline ko nigal na le), aur
                            `title` me poora text — accessibility-review §4: jo truncate
                            hua wo screen reader ke liye hamesha ke liye chala jata hai. */}
                        {e.detail && (
                          <div className="line-clamp-3 text-xs text-ink-2 break-words" title={e.detail}>
                            {e.detail}
                          </div>
                        )}
                        <div className="text-xs text-ink-3">
                          {formatDate(e.at)} {fmtActTime(e.at)}
                        </div>
                      </div>
                      {e.href && (
                        <Icon name="chevron-right" size={14} className="mt-1 shrink-0 text-ink-4 transition-colors group-hover:text-amber-ink" />
                      )}
                    </>
                  );
                  const row = "-mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-1";
                  return (
                    <li key={e.id}>
                      {e.href ? (
                        <Link
                          href={e.href as never}
                          className={cn(row, "group min-h-11 transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber")}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className={row}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* The gap, stated. An entry with no usable date is dropped rather than
                placed at a guessed position — a wrongly-ordered event invents a history
                that never happened. */}
            {timeline.undated > 0 && (
              <p className="mt-2 text-xs leading-relaxed text-ink-3">
                {timeline.undated} record{timeline.undated === 1 ? " has" : "s have"} no
                usable date and {timeline.undated === 1 ? "is" : "are"} not shown — placing
                {timeline.undated === 1 ? " it" : " them"} anywhere in this list would
                invent an order that never happened.
              </p>
            )}
          </div>
  );
}
