/**
 * Shared assessment types + grading — one source of truth used by the public
 * submit route AND the owner UI, so a score always maps to the same grade.
 */

export interface AssessmentQuestion {
  q: string;
  options: string[];   // 2–5 choices
  correct: number;     // index of the correct option
  // Optional Hinglish versions — present when the test is bilingual. The
  // correct-answer index is the SAME across languages, so grading is unaffected.
  q_hi?: string;
  options_hi?: string[];
}

/** A question as sent to the public take-page — correct answer stripped out. */
export type PublicQuestion = { q: string; options: string[]; q_hi?: string; options_hi?: string[] };

export type TestLang = "en" | "hi" | "both";

export type Grade = "A" | "B" | "C" | "D";

/** Grade band: A ≥80, B 60–79, C 40–59, D <40. */
export function gradeFor(pct: number): Grade {
  if (pct >= 80) return "A";
  if (pct >= 60) return "B";
  if (pct >= 40) return "C";
  return "D";
}

export const GRADE_TONE: Record<Grade, "emerald" | "amber" | "rose"> = {
  A: "emerald", B: "emerald", C: "amber", D: "rose",
};

/** Score answers[] against the questions' correct indices. */
export function scoreAttempt(
  questions: AssessmentQuestion[], answers: number[],
): { score: number; total: number; pct: number; grade: Grade } {
  const total = questions.length;
  let score = 0;
  questions.forEach((qn, i) => { if (answers[i] === qn.correct) score++; });
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  return { score, total, pct, grade: gradeFor(pct) };
}
