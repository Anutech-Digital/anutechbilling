/**
 * R-2157 (G-ADS-AI, AI-01) — the marketing agent graph. R-2159 (AI-03) adds Xeno:
 *
 *   START → intake → xenoPlan ─┬─ (budget / goal missing, < MAX_QUESTION_ROUNDS) → xenoAsk (interrupt) → xenoPlan
 *                              └─ otherwise → humanGate (interrupt) → END
 *
 *   - xenoPlan: the words (+ answers) → a checked Brief (xeno.ts). One AI call per run, and
 *     only through the brain, which reserves the AI cap first. Never interrupts itself, so a
 *     resume never repeats an AI call it already paid for.
 *   - xenoAsk: stops with interrupt() and fixed questions; the answers come back as
 *     Command({ resume: { answers } }) and Xeno drafts again.
 *
 *   - intake: checks the thread is the plan, counts the run, keeps the deployment in Draft.
 *   - humanGate: stops with interrupt() and waits for a person (approve / edit / reject),
 *     sent back from the UI as Command({ resume }). Nothing after it acts on the answer yet.
 * Nothing here writes, spends or publishes. Later G-ADS-AI cards put pixeoCreate between Xeno
 * and the gate, route the answer to publish / xeno / pixeo (review-gate card) and add the
 * monitor loop.
 */
import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ItemOption } from "@/lib/marketing/copilot/plan-draft";
import {
  CampaignState, ReviewDecisionSchema, XenoAnswersSchema,
  type CampaignGraphState, type CampaignGraphUpdate, type XenoMeta,
} from "./state";
import { MAX_QUESTION_ROUNDS, XENO_QUESTIONS, draftBrief, type XenoAnswer, type XenoBrain, type XenoQuestion } from "./xeno";

/** What the UI shows while the graph waits at the review gate. */
export interface ReviewGatePrompt {
  kind: "review";
  planId: string;
  question: string;
  options: Array<"approve" | "edit" | "reject">;
}

/** R-2159: what the UI shows while Xeno waits for answers. */
export interface QuestionsGatePrompt {
  kind: "questions";
  planId: string;
  questions: XenoQuestion[];
}

export type GatePrompt = ReviewGatePrompt | QuestionsGatePrompt;

/** What the graph needs from outside: the company's products and the AI door (none = words only). */
export interface CampaignGraphDeps {
  xeno?: { items: readonly ItemOption[]; brain?: XenoBrain };
}

export function intake(state: CampaignGraphState): CampaignGraphUpdate {
  if (state.threadId !== state.planId) throw new Error("The thread is the plan: threadId must equal planId.");
  return {
    iteration: state.iteration + 1,
    deployment: { ...state.deployment, status: "Draft" },
  };
}

export function xenoPlanNode(deps: CampaignGraphDeps) {
  return async function xenoPlan(state: CampaignGraphState): Promise<CampaignGraphUpdate> {
    const before = state.xeno;
    const answers: XenoAnswer[] = before?.answers ?? [];
    const draft = await draftBrief({ intent: state.userIntent, answers, items: deps.xeno?.items ?? [] }, deps.xeno?.brain);
    const xeno: XenoMeta = {
      source: draft.source,
      missing: draft.missing,
      rounds: before?.rounds ?? 0,
      answers,
      notes: draft.notes,
    };
    return { brief: draft.brief, xeno, ...(draft.error ? { errors: [draft.error] } : {}) };
  };
}

/** After Xeno: ask (while something is missing and rounds are left) or go to review. */
export function afterXeno(state: CampaignGraphState): "xenoAsk" | "humanGate" {
  const x = state.xeno;
  return x && x.missing.length > 0 && x.rounds < MAX_QUESTION_ROUNDS ? "xenoAsk" : "humanGate";
}

export function xenoAsk(state: CampaignGraphState): CampaignGraphUpdate {
  const x = state.xeno;
  const prompt: QuestionsGatePrompt = {
    kind: "questions",
    planId: state.planId,
    questions: (x?.missing ?? []).map((id) => XENO_QUESTIONS[id]),
  };
  const { answers } = XenoAnswersSchema.parse(interrupt(prompt));
  const given: XenoAnswer[] = [];
  if (answers.budget !== undefined) given.push({ id: "budget", answer: answers.budget });
  if (answers.goal !== undefined) given.push({ id: "goal", answer: answers.goal });
  return {
    xeno: {
      source: x?.source ?? "words",
      missing: x?.missing ?? [],
      notes: x?.notes ?? [],
      rounds: (x?.rounds ?? 0) + 1,
      answers: [...(x?.answers ?? []), ...given].slice(-20),
    },
  };
}

export function humanGate(state: CampaignGraphState): CampaignGraphUpdate {
  const prompt: ReviewGatePrompt = {
    kind: "review",
    planId: state.planId,
    question: "Review this campaign: approve, ask for changes, or reject.",
    options: ["approve", "edit", "reject"],
  };
  const answer = ReviewDecisionSchema.parse(interrupt(prompt));
  return { lastDecision: { ...answer, at: new Date().toISOString() } };
}

export function buildCampaignGraph(deps: CampaignGraphDeps = {}) {
  return new StateGraph(CampaignState)
    .addNode("intake", intake)
    .addNode("xenoPlan", xenoPlanNode(deps))
    .addNode("xenoAsk", xenoAsk)
    .addNode("humanGate", humanGate)
    .addEdge(START, "intake")
    .addEdge("intake", "xenoPlan")
    .addConditionalEdges("xenoPlan", afterXeno, ["xenoAsk", "humanGate"])
    .addEdge("xenoAsk", "xenoPlan")
    .addEdge("humanGate", END);
}

export function compileCampaignGraph(checkpointer: BaseCheckpointSaver, deps: CampaignGraphDeps = {}) {
  return buildCampaignGraph(deps).compile({ checkpointer, name: "marketing-agent" });
}
export type CampaignGraph = ReturnType<typeof compileCampaignGraph>;
