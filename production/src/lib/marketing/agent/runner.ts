/**
 * R-2157 (G-ADS-AI, AI-01) — start / resume / read one agent thread (thread = ad_plans.id).
 *
 * Storage-free: the caller hands in a compiled graph whose checkpointer is already bound to
 * the signed-in company (routes) or an in-memory store (tests). One call = one graph run up
 * to the next interrupt or the end; nothing loops here — the monitor cron (later card) wakes
 * a thread the same way, one step at a time.
 */
import { Command } from "@langchain/langgraph";
import type { CampaignGraph, GatePrompt } from "./graph";
import { CampaignStateSchema, type CampaignStateValue, type ReviewDecision, type XenoAnswers } from "./state";

/** An answer to whichever gate the thread waits at: review (decision) or Xeno's questions (answers). */
export type GateAnswer = ReviewDecision | XenoAnswers;
const isAnswers = (a: GateAnswer): a is XenoAnswers => "answers" in a;

export type AgentRunStatus = "not_started" | "waiting" | "running" | "done";

export interface AgentRunView {
  planId: string;
  status: AgentRunStatus;
  /** Next node(s) the graph will run; empty when done or not started. */
  next: string[];
  /** What the graph is waiting for (status "waiting"). */
  waitingFor: GatePrompt[];
  state: CampaignStateValue | null;
  updatedAt: string | null;
}

/** start on a thread that already ran, or resume on one that is not waiting. */
export class AgentConflictError extends Error {
  constructor(message: string, readonly view: AgentRunView) { super(message); }
}

const configFor = (planId: string) => ({ configurable: { thread_id: planId } });

export async function readRun(graph: CampaignGraph, planId: string): Promise<AgentRunView> {
  const snap = await graph.getState(configFor(planId));
  const started = !!snap.config?.configurable?.checkpoint_id && Object.keys(snap.values ?? {}).length > 0;
  if (!started) return { planId, status: "not_started", next: [], waitingFor: [], state: null, updatedAt: null };
  const waitingFor = (snap.tasks ?? []).flatMap((t) => (t.interrupts ?? []).map((i) => i.value as GatePrompt));
  const next = [...(snap.next ?? [])];
  const parsed = CampaignStateSchema.safeParse(snap.values);
  return {
    planId,
    status: waitingFor.length > 0 ? "waiting" : next.length > 0 ? "running" : "done",
    next,
    waitingFor,
    // A checkpoint that no longer fits the schema is not shown (it is data the AI helped write).
    state: parsed.success ? parsed.data : null,
    updatedAt: snap.createdAt ?? null,
  };
}

/** Start a new thread from its first state. A thread runs once; resume carries it on. */
export async function startRun(graph: CampaignGraph, seed: CampaignStateValue): Promise<AgentRunView> {
  const first = CampaignStateSchema.parse(seed);
  const before = await readRun(graph, first.planId);
  if (before.status !== "not_started") throw new AgentConflictError("This campaign's agent has already started.", before);
  await graph.invoke(first, configFor(first.planId));
  return readRun(graph, first.planId);
}

/** Answer the gate the thread is waiting at (the answer must fit that gate — R-2159). */
export async function resumeRun(graph: CampaignGraph, planId: string, answer: GateAnswer): Promise<AgentRunView> {
  const before = await readRun(graph, planId);
  if (before.status !== "waiting") {
    throw new AgentConflictError(
      before.status === "not_started" ? "Start the campaign's agent first." : "The agent is not waiting for an answer.",
      before,
    );
  }
  const gate = before.waitingFor[0]?.kind;
  if (gate === "questions" && !isAnswers(answer)) {
    throw new AgentConflictError("The agent is waiting for answers to its questions, not a review.", before);
  }
  if (gate === "review" && isAnswers(answer)) {
    throw new AgentConflictError("The agent is waiting for a review (approve, edit or reject), not answers.", before);
  }
  await graph.invoke(new Command({ resume: answer }), configFor(planId));
  return readRun(graph, planId);
}
