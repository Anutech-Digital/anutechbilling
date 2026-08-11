/**
 * Assessments — owner view. Create an AI-generated reasoning test, share its
 * public link with the team, and see each employee's score + grade.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import {
  useAssessments, useCreateAssessment, useAssessmentAttempts, useDeleteAssessment,
  generateQuestions, type Assessment,
} from "@/lib/queries/assessments";
import { GRADE_TONE, type AssessmentQuestion, type Grade } from "@/lib/assessments/grade";

function testLink(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/assessment/${token}`;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function AssessmentsPage() {
  const q = useAssessments();
  const del = useDeleteAssessment();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const [results, setResults] = React.useState<Assessment | null>(null);

  const rows = q.data ?? [];

  async function copyLink(token: string) {
    try { await navigator.clipboard.writeText(testLink(token)); toast.success("Link copied — share it with your team."); }
    catch { toast.error("Copy failed — select the link manually."); }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Reasoning Tests</h1>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">AI banata hai reasoning MCQs — link share karo, employee test de, auto grade (A/B/C/D) mil jaye.</p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex shrink-0" onClick={() => setAddOpen(true)}>Create test</Button>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="sparkles" title="No tests yet"
            body="Create an AI reasoning test, share the link with your team, and grade them automatically."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Create your first test</Button>} />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((t) => (
            <li key={t.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-ink">{t.title}</span>
                      <Badge kind="muted" size="sm">{t.questions.length} Qs</Badge>
                      <Badge kind="muted" size="sm">{t.difficulty}</Badge>
                      {t.topic && <span className="text-[11px] text-ink-3">· {t.topic}</span>}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-1">{t.attempts} attempt{t.attempts === 1 ? "" : "s"} · created {formatDate(t.created_at)}</div>
                    {/* Share link */}
                    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                      <code className="text-[11px] font-mono bg-paper-2 rounded px-2 py-1 text-ink-2 truncate max-w-[280px]">{testLink(t.public_token)}</code>
                      <Button variant="default" className="h-7 px-2 text-[11px]" icon="copy" onClick={() => copyLink(t.public_token)}>Copy link</Button>
                      <a href={testLink(t.public_token)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-amber-ink hover:underline inline-flex items-center gap-1"><Icon name="external" size={11} /> Open</a>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="default" className="h-8 px-3 text-[12px]" icon="chart" onClick={() => setResults(t)}>Results ({t.attempts})</Button>
                    <Button variant="ghost" className="h-8 px-2 text-[12px]"
                      onClick={async () => { if (await confirm({ title: `Delete "${t.title}"?`, body: "The test + its attempts are removed.", danger: true, confirmLabel: "Delete" })) del.mutate(t.id); }}>Delete</Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <FAB icon="plus" label="Test" onClick={() => setAddOpen(true)} ariaLabel="Create test" />
      {addOpen && <CreateTestDialog onClose={() => setAddOpen(false)} />}
      {results && <ResultsDialog test={results} onClose={() => setResults(null)} />}
    </div>
  );
}

function CreateTestDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateAssessment();
  const [subject, setSubject] = React.useState<"reasoning" | "software">("reasoning");
  const [title, setTitle] = React.useState("Reasoning test");
  const [topic, setTopic] = React.useState("");
  const [difficulty, setDifficulty] = React.useState("medium");
  const [language, setLanguage] = React.useState<"en" | "hi" | "both">("both");
  const [count, setCount] = React.useState("8");
  const [questions, setQuestions] = React.useState<AssessmentQuestion[]>([]);
  const [generating, setGenerating] = React.useState(false);
  const [stub, setStub] = React.useState(false);

  // Switching test type resets the AI preview + gives a sensible default title.
  function pickSubject(s: "reasoning" | "software") {
    setSubject(s);
    setQuestions([]);
    setTitle((t) =>
      t === "Reasoning test" || t === "Software knowledge test"
        ? (s === "software" ? "Software knowledge test" : "Reasoning test")
        : t,
    );
  }

  async function generate() {
    setGenerating(true);
    try {
      const r = await generateQuestions({ subject, topic: topic.trim() || undefined, difficulty, count: Number(count) || 8, language });
      setQuestions(r.questions);
      setStub(r.mode === "stub");
    } catch (e) { toast.error((e as Error).message); }
    finally { setGenerating(false); }
  }

  async function save() {
    if (questions.length === 0) { toast.error("Generate questions first."); return; }
    await create.mutateAsync({ title, topic: topic.trim() || undefined, difficulty, questions });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Create reasoning test</DialogTitle>
          <DialogDescription>AI reasoning MCQs banayega. Preview dekho, phir Save karke link share karo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto -mx-1 px-1">
          <FormField label="Test about" htmlFor="at_subject">
            <Select value={subject} onValueChange={(v) => pickSubject(v as "reasoning" | "software")}>
              <SelectTrigger id="at_subject"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reasoning">Reasoning / IQ</SelectItem>
                <SelectItem value="software">This software (ResellerOS)</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Test title" required htmlFor="at_title">
            <Input id="at_title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
          <FormField label={subject === "software" ? "Focus area (optional)" : "Topic (optional)"} htmlFor="at_topic">
            <Input id="at_topic" placeholder={subject === "software" ? "e.g. billing, leads, GST, accounting" : "e.g. IQ, logical reasoning, verbal, numerical"} value={topic} onChange={(e) => setTopic(e.target.value)} />
          </FormField>
          {subject === "software" && (
            <p className="text-[11px] text-ink-3">App ke features + money-flow ke aadhaar par questions banenge — jaanne ke liye ki employee software kitna samajh chuka hai.</p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Language" htmlFor="at_lang" className="col-span-1">
              <Select value={language} onValueChange={(v) => setLanguage(v as "en" | "hi" | "both")}>
                <SelectTrigger id="at_lang"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">English + Hinglish</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="hi">Hinglish</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Difficulty" htmlFor="at_diff" className="col-span-1">
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger id="at_diff"><SelectValue /></SelectTrigger>
                <SelectContent>{["easy", "medium", "hard"].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label="Questions" htmlFor="at_count" className="col-span-1">
              <Input id="at_count" type="number" min={3} max={25} value={count} onChange={(e) => setCount(e.target.value)} />
            </FormField>
          </div>
          {language === "both" && (
            <p className="text-[11px] text-ink-3">Dono bhasha me banega — employee test lete waqt English/Hinglish choose kar sakta hai.</p>
          )}
          <Button variant="default" icon="sparkles" loading={generating} onClick={generate} className="w-full justify-center">
            {questions.length ? "Regenerate with AI" : "Generate with AI"}
          </Button>
          {stub && questions.length > 0 && (
            <p className="text-[11px] text-amber-ink">AI key nahi mili — sample questions dikha rahe hain. Real AI ke liye Settings → Integrations → AI me Gemini key daalo.</p>
          )}
          {questions.length > 0 && (
            <div className="rounded-lg border border-hairline divide-y divide-hairline">
              {questions.map((qn, i) => (
                <div key={i} className="p-3">
                  <div className="text-[13px] font-medium text-ink">{i + 1}. {qn.q}</div>
                  <ul className="mt-1.5 space-y-0.5">
                    {qn.options.map((o, oi) => (
                      <li key={oi} className={`text-[12px] flex items-center gap-1.5 ${oi === qn.correct ? "text-emerald font-medium" : "text-ink-2"}`}>
                        {oi === qn.correct ? <Icon name="check_circle" size={12} /> : <span className="w-3 inline-block" />}
                        {o}
                      </li>
                    ))}
                  </ul>
                  {qn.q_hi && (
                    <div className="mt-2 pl-2 border-l-2 border-hairline">
                      <div className="text-[12px] text-ink-2">{qn.q_hi}</div>
                      {qn.options_hi && qn.options_hi[qn.correct] != null && (
                        <div className="text-[11px] text-emerald mt-0.5 flex items-center gap-1"><Icon name="check_circle" size={11} /> {qn.options_hi[qn.correct]}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={create.isPending} disabled={questions.length === 0} onClick={save}>Save &amp; get link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultsDialog({ test, onClose }: { test: Assessment; onClose: () => void }) {
  const q = useAssessmentAttempts(test.id);
  const rows = q.data ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Results — {test.title}</DialogTitle>
          <DialogDescription>{rows.length} attempt{rows.length === 1 ? "" : "s"} · {test.questions.length} questions</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-3 py-6 text-center">Abhi kisi ne test nahi diya. Link share karo.</p>
        ) : (
          <div className="rounded-lg border border-hairline divide-y divide-hairline max-h-[55vh] overflow-y-auto">
            {rows.map((a) => {
              const flags: string[] = [];
              if (a.focus_lost_count > 0) flags.push(`Left test ${a.focus_lost_count}×${a.focus_lost_seconds ? ` · ${mmss(a.focus_lost_seconds)} away` : ""}`);
              if (a.paste_count > 0) flags.push(`Pasted ${a.paste_count}×`);
              return (
                <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{a.candidate_name}</div>
                    <div className="text-[11px] text-ink-3">
                      {formatDate(a.submitted_at)} · {a.score}/{a.total}
                      {a.duration_seconds != null && <> · took {mmss(a.duration_seconds)}</>}
                    </div>
                    {flags.length > 0 && (
                      <div className="text-[11px] text-rose mt-0.5 flex items-center gap-1">
                        <Icon name="alert" size={11} /> {flags.join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono tabular-nums text-ink-2 text-[13px]">{a.pct}%</span>
                    <Badge kind={GRADE_TONE[a.grade as Grade] === "emerald" ? "success" : GRADE_TONE[a.grade as Grade] === "amber" ? "warning" : "danger"} size="sm">Grade {a.grade}</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
