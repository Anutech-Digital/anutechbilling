/**
 * Public reasoning-test page (no login). An employee opens the shared link,
 * picks their name, answers the MCQs, and gets an instant score + grade.
 * Grading is done server-side; correct answers are never sent to this page.
 *
 * Lightweight proctoring (transparent to the candidate):
 *   • a live timer — total time is recorded,
 *   • tab / window switches are counted + timed (opening ChatGPT in another
 *     tab shows up here), and
 *   • paste events are counted.
 * These signals are sent with the submission so the owner can spot likely
 * AI / lookup use. No camera, no screen recording.
 */
"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import type { PublicQuestion, Grade } from "@/lib/assessments/grade";

type Loaded = {
  title: string; topic: string | null;
  questions: PublicQuestion[];
  employees: { id: string; name: string }[];
};
type Result = { score: number; total: number; pct: number; grade: Grade };

const GRADE_COLOR: Record<Grade, string> = { A: "#059669", B: "#059669", C: "#C2410C", D: "#e11d48" };

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function TakeAssessmentPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [data, setData] = React.useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const [empId, setEmpId] = React.useState("");
  const [name, setName] = React.useState("");
  const [answers, setAnswers] = React.useState<Record<number, number>>({});
  const [lang, setLang] = React.useState<"en" | "hi">("en");
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  // ── Proctoring state ──────────────────────────────────────────────────────
  const [elapsed, setElapsed] = React.useState(0);        // live seconds, for display
  const [focusLost, setFocusLost] = React.useState(0);    // live count, for display
  const startRef = React.useRef<number | null>(null);     // ms timestamp when test opened
  const proctor = React.useRef({ focusLostCount: 0, focusLostSeconds: 0, pasteCount: 0, awaySince: 0 });
  const doneRef = React.useRef(false);                    // freeze tracking after submit

  // Load the test.
  React.useEffect(() => {
    let ok = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/assessment/${token}`);
        const json = await res.json();
        if (!res.ok) { if (ok) setLoadErr(json.error ?? "Test not found."); return; }
        if (ok) setData(json as Loaded);
      } catch { if (ok) setLoadErr("Couldn't load the test."); }
    })();
    return () => { ok = false; };
  }, [token]);

  // Start the clock once the test is on screen; tick every second.
  React.useEffect(() => {
    if (!data || result) return;
    if (startRef.current == null) startRef.current = Date.now();
    const id = setInterval(() => {
      if (doneRef.current || startRef.current == null) return;
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [data, result]);

  // Track tab/window switches + paste — the "did they use AI" signals.
  React.useEffect(() => {
    if (!data || result) return;
    const p = proctor.current;
    const onHide = () => {
      if (doneRef.current) return;
      if (document.visibilityState === "hidden") {
        p.awaySince = Date.now();
        p.focusLostCount += 1;
        setFocusLost(p.focusLostCount);
      } else if (p.awaySince) {
        p.focusLostSeconds += Math.round((Date.now() - p.awaySince) / 1000);
        p.awaySince = 0;
      }
    };
    const onPaste = () => { if (!doneRef.current) p.pasteCount += 1; };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onHide);
    window.addEventListener("focus", onHide);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onHide);
      window.removeEventListener("focus", onHide);
      document.removeEventListener("paste", onPaste);
    };
  }, [data, result]);

  const effectiveName = empId
    ? (data?.employees.find((e) => e.id === empId)?.name ?? "")
    : name.trim();
  const allAnswered = data ? Object.keys(answers).length === data.questions.length : false;
  // Bilingual: show the language toggle only when at least one question carries
  // a Hinglish version. Per-question fallback to English if a given one lacks it.
  const hasHinglish = data ? data.questions.some((q) => q.q_hi && q.options_hi) : false;
  function shown(qn: PublicQuestion): { q: string; options: string[] } {
    if (lang === "hi" && qn.q_hi && qn.options_hi) return { q: qn.q_hi, options: qn.options_hi };
    return { q: qn.q, options: qn.options };
  }

  async function submit() {
    if (!data) return;
    if (!effectiveName) { setErr("Apna naam chuno / likho."); return; }
    if (!allAnswered) { setErr("Sabhi questions ka jawab do."); return; }
    setErr(null); setSubmitting(true);
    // Freeze proctoring + settle any in-progress "away" span.
    doneRef.current = true;
    const p = proctor.current;
    if (p.awaySince) { p.focusLostSeconds += Math.round((Date.now() - p.awaySince) / 1000); p.awaySince = 0; }
    const duration = startRef.current ? Math.floor((Date.now() - startRef.current) / 1000) : undefined;
    try {
      const res = await fetch(`/api/public/assessment/${token}/submit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidate_name: effectiveName,
          employee_id: empId || undefined,
          answers: data.questions.map((_, i) => answers[i] ?? -1),
          duration_seconds: duration,
          focus_lost_count: p.focusLostCount,
          focus_lost_seconds: p.focusLostSeconds,
          paste_count: p.pasteCount,
        }),
      });
      const json = await res.json();
      if (!res.ok) { doneRef.current = false; setErr(json.error ?? "Submit failed."); return; }
      setResult(json as Result);
    } catch { doneRef.current = false; setErr("Submit failed — try again."); }
    finally { setSubmitting(false); }
  }

  // ── States ────────────────────────────────────────────────────────────────
  if (loadErr) return <Shell><p className="text-center text-rose text-sm">{loadErr}</p></Shell>;
  if (!data) return <Shell><p className="text-center text-ink-3 text-sm">Loading test…</p></Shell>;

  if (result) {
    return (
      <Shell>
        <div className="text-center py-4">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Your result</div>
          <div className="font-serif text-5xl mt-2" style={{ color: GRADE_COLOR[result.grade] }}>{result.grade}</div>
          <div className="text-2xl font-serif text-ink mt-1">{result.pct}%</div>
          <div className="text-sm text-ink-2 mt-1">{result.score} / {result.total} correct · {mmss(elapsed)} liya</div>
          <p className="text-[12px] text-ink-3 mt-4">Thanks, {effectiveName}! Aapka result save ho gaya.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl text-ink">{data.title}</h1>
            {data.topic && <p className="text-sm text-ink-3 mt-0.5">{data.topic}</p>}
            <p className="text-[12px] text-ink-3 mt-1">{data.questions.length} questions · har question ka ek sahi jawab.</p>
          </div>
          {/* Live timer */}
          <div className="shrink-0 text-right">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Time</div>
            <div className="font-mono tabular-nums text-lg text-ink leading-tight">{mmss(elapsed)}</div>
          </div>
        </div>
      </div>

      {/* Language toggle — only for bilingual tests. */}
      {hasHinglish && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Language</span>
          <div className="inline-flex rounded-md border border-hairline overflow-hidden">
            {(["en", "hi"] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)}
                className={`px-3 py-1 text-[12px] font-medium transition-colors ${lang === l ? "bg-amber text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"}`}>
                {l === "en" ? "English" : "Hinglish"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Transparency: candidate is told the test is monitored (honest by design). */}
      <div className="mb-4 rounded-md border border-amber/40 bg-amber-soft/40 px-3 py-2 text-[11px] text-amber-ink">
        Ye test timed + monitored hai — time, tab/window switch aur paste record hote hain. Kripya test isi tab me poora karein, kisi aur source (AI/Google) ki madad na lein.
        {focusLost > 0 && <span className="block mt-1 font-medium">⚠ Aap {focusLost} baar test se bahar gaye — ye record ho gaya hai.</span>}
      </div>

      {/* Who is taking */}
      <div className="mb-5 rounded-lg border border-hairline bg-paper-2/40 p-3">
        <label className="block text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Aap kaun ho?</label>
        {data.employees.length > 0 ? (
          <select value={empId} onChange={(e) => setEmpId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-hairline bg-paper">
            <option value="">— apna naam chuno —</option>
            {data.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        ) : null}
        {!empId && (
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="ya apna naam likho"
            className="mt-2 w-full px-3 py-2 text-sm rounded-md border border-hairline bg-paper" />
        )}
      </div>

      {/* Questions */}
      <ol className="space-y-4">
        {data.questions.map((qn, i) => {
          const s = shown(qn);
          return (
          <li key={i} className="rounded-lg border border-hairline p-3">
            <div className="text-sm font-medium text-ink mb-2">{i + 1}. {s.q}</div>
            <div className="space-y-1.5">
              {s.options.map((o, oi) => (
                <label key={oi} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors ${answers[i] === oi ? "border-amber bg-amber-soft/50 text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2"}`}>
                  <input type="radio" name={`q${i}`} checked={answers[i] === oi} onChange={() => setAnswers((a) => ({ ...a, [i]: oi }))} className="accent-amber" />
                  {o}
                </label>
              ))}
            </div>
          </li>
          );
        })}
      </ol>

      {err && <p className="text-[12px] text-rose mt-3">{err}</p>}
      <button type="button" onClick={submit} disabled={submitting}
        className="mt-4 w-full rounded-md bg-amber text-paper font-medium py-2.5 text-sm hover:bg-amber/90 disabled:opacity-60">
        {submitting ? "Submitting…" : "Submit test"}
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-2/40 py-8 px-4">
      <div className="max-w-xl mx-auto bg-paper rounded-xl border border-hairline shadow-sm p-5 md:p-6">
        {children}
      </div>
    </div>
  );
}
