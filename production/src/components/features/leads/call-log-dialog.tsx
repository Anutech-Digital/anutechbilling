/**
 * CallLogDialog — "Call log" ka ek hi popup, jise HAR surface use karta hai.
 *
 * ─── YE ALAG FILE KYUN HAI ──────────────────────────────────────────────────
 * 26 Aug 2026. Pehle ye popup seedha lead drawer ke JSX me tha. Nateeja: drawer ka
 * "Call log" popup kholta tha aur row ka ⋯ menu wahi naam dabane par seedha log kar deta
 * tha — ek naam, do bartaav. Pardeep ne pakda: "jaise panel me voice ke through typing
 * hoti vaise hi chahiye".
 *
 * Aasan hal — row ke menu me bhi ek popup bana dena — us bug ka DOOSRA roop hota: do
 * popup, jo kuch hafte me shakl aur bartaav me alag ho jate (isi file me aaj hi teen baar
 * wahi hua: stage badalne ki saat jagah, "Log call" ke do darwaze, mic ke do button).
 *
 * Isliye popup ek hai. Surface sirf ye kehte hain "iske liye kholo" — kya dikhta hai aur
 * kya likha jata hai, wo yahan ek hi jagah tay hota hai.
 *
 * ─── AUR MIC IS FILE ME HI ──────────────────────────────────────────────────
 * `useDictation` ka ek instance ek hi "sun raha hoon" state rakhta hai. Do jagah mic
 * dikhane par ek dabta hai aur doosra bhi laal ho jata hai. Popup ek hai, to mic bhi ek —
 * aur wo sawaal hi khatm.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useDictation } from "@/lib/voice/use-dictation";
import type { LeadOutcome } from "@/lib/leads/outcomes";
import { leadTitle } from "@/lib/leads/display-name";

export interface CallLogDialogProps {
  /** Kis lead ka call — `null` matlab popup band. */
  companyName: string | null;
  onClose: () => void;
  /** Popup ka text, jaisa hai waisa. Khaali bhi ho sakta hai. */
  onSave: (note: string) => void;
}

export function CallLogDialog({ companyName, onClose, onSave }: CallLogDialogProps) {
  const [note, setNote] = React.useState("");
  const dictation = useDictation(setNote, () => note);

  /* Naya lead khulne par purana likha hua saaf. Bina iske ek lead ka note doosre ke
     popup me pada milta hai — aur wo galat lead par darj ho jata. */
  React.useEffect(() => { if (companyName) setNote(""); }, [companyName]);

  const close = () => {
    /* Mic band, warna popup band hone ke baad bhi Chrome ka recording indicator jalta
       rehta hai — aur wo bharosa todta hai. */
    if (dictation.listening) dictation.toggle();
    onClose();
  };

  return (
    <Dialog open={Boolean(companyName)} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log call — {companyName}</DialogTitle>
          <DialogDescription>
            Kya baat hui? Bolkar ya likhkar darj kariye. Khaali chhod dein to bhi call darj
            ho jayegi.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              autoFocus
              placeholder="Needs 20 seats, budget in March…"
              aria-label="Call notes"
              className="min-w-0 flex-1 resize-y rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-amber focus:outline-none focus:ring-1 focus:ring-amber"
            />
            {dictation.supported && (
              <button
                type="button"
                onClick={dictation.toggle}
                aria-pressed={dictation.listening}
                title={dictation.listening ? "Listening — click to stop" : "Dictate"}
                className={cn(
                  "shrink-0 rounded-md border p-2 transition-colors",
                  dictation.listening
                    ? "animate-pulse border-rose bg-rose-soft text-rose-ink"
                    : "border-hairline-strong bg-paper text-ink-2 hover:bg-paper-2",
                )}
              >
                <Icon name={dictation.listening ? "mic_off" : "mic"} size={16} />
                <span className="sr-only">
                  {dictation.listening ? "Stop dictation" : "Dictate"}
                </span>
              </button>
            )}
          </div>

          {dictation.listening && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-rose-ink">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose" />
              Listening…
              {dictation.interim && <span className="italic text-ink-3">{dictation.interim}</span>}
            </p>
          )}

          {dictation.error && (
            <div className="space-y-1">
              <p className="text-xs text-rose-ink">{dictation.error}</p>
              {/* `chrome://settings` ka link bekaar hota — Chrome kisi web page se aise link
                  ko jaan-boojh kar mara hua rakhta hai. Ye button `getUserMedia` se Chrome
                  ka APNA prompt laata hai, jo asli "activate" hai. */}
              {dictation.needsPermission && (
                <button
                  type="button"
                  onClick={dictation.requestMic}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber bg-amber-soft px-2 py-1 text-xs font-semibold text-amber-ink hover:bg-amber-soft/70"
                >
                  <Icon name="mic" size={12} /> Turn on mic
                </button>
              )}
              {dictation.permission && (
                <p className="text-xs text-ink-3">
                  Chrome mic permission:{" "}
                  <b className={dictation.permission === "granted" ? "text-emerald-ink" : "text-rose-ink"}>
                    {dictation.permission}
                  </b>
                </p>
              )}
            </div>
          )}

          {/* Bhasha ka chunav USER ka hai, mera nahi: `en-IN` angrezi saaf rakhta hai par
              Hindi shabd todta hai; `hi-IN` Hindi saaf deta hai par Devanagari me. Kaun sa
              behtar hai, ye us pal par nirbhar hai ki wo kya bol raha hai. */}
          {dictation.supported && (
            <div className="flex items-center gap-1 text-xs text-ink-3">
              <span>Speech language:</span>
              {([["en-IN", "Hinglish (Roman script)"], ["hi-IN", "Hindi (Devanagari)"]] as const).map(([code, label]) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={dictation.lang === code}
                  onClick={() => dictation.setLang(code)}
                  title={code === "en-IN"
                    ? "Types in Roman script (20 seats chahiye)"
                    : "Types in Devanagari (20 सीट्स चाहिए)"}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-semibold",
                    dictation.lang === code ? "bg-ink text-paper" : "hover:bg-paper-2",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (dictation.listening) dictation.toggle();
              onSave(note);
              setNote("");
              onClose();
            }}
          >
            Log call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * useCallLog — har surface ka ek hi darwaza.
 *
 * Chaar jagah se outcome chalte hain: call queue, drawer, row ka ⋯ menu, aur mobile card.
 * Popup ko sirf ek jagah jodna aur baaki teen ko chhod dena wahi bug wapas laata hai jo
 * aaj mila — isliye ye hook `run()` deta hai jise SAB use karte hain, aur `talked` ko
 * popup par bhejna uske andar hai.
 *
 * Matlab: agli baar koi naya surface joddega, to sahi bartaav use MUFT milega. Use kuch
 * yaad rakhna nahi padega — aur jo yaad rakhna padta hai, wahi bhoola jata hai.
 */
export function useCallLog<T extends { company: string }>(
  runOutcome: (outcome: LeadOutcome, lead: T, note?: string) => Promise<void>,
) {
  const [pending, setPending] = React.useState<T | null>(null);

  const run = React.useCallback(
    (outcome: LeadOutcome, lead: T) => {
      /* Sirf `talked` rukta hai — kyunki wahi ek outcome hai jiske paas kehne layak kuch
         hota hai. "No answer" par popup kholna user se khaali form bharwana hai. */
      if (outcome === "talked") { setPending(lead); return; }
      void runOutcome(outcome, lead);
    },
    [runOutcome],
  );

  const dialog = (
    <CallLogDialog
      companyName={pending ? leadTitle(pending).label : null}
      onClose={() => setPending(null)}
      onSave={(note) => { if (pending) void runOutcome("talked", pending, note); }}
    />
  );

  return { run, dialog };
}
