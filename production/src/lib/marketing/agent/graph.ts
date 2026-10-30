/**
 * R-2157 (G-ADS-AI, AI-01) — the marketing agent graph, foundation version.
 *
 *   START → intake → humanGate (interrupt) → END
 *
 * This card builds the frame the real nodes slot into; it does not plan, write or spend:
 *   - intake: checks the thread is the plan, counts the run, keeps the deployment in Draft.
 *   - humanGate: stops with interrupt() and waits for a person (approve / edit / reject),
 *     sent back from the UI as Command({ resume }). Nothing after it acts on the answer yet.
 * Later G-ADS-AI cards put xenoPlan → pixeoCreate before the gate, route the answer to
 * publish / xeno / pixeo (review-gate card) and add the monitor loop.
 */
import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { CampaignState, ReviewDecisionSchema, type CampaignGraphState, type CampaignGraphUpdate } from "./state";

/** What the UI shows while the graph waits at the gate. */
export interface GatePrompt {
  kind: "review";
  planId: string;
  question: string;
  options: Array<"approve" | "edit" | "reject">;
}

export function intake(state: CampaignGraphState): CampaignGraphUpdate {
  if (state.threadId !== state.planId) throw new Error("The thread is the plan: threadId must equal planId.");
  return {
    iteration: state.iteration + 1,
    deployment: { ...state.deployment, status: "Draft" },
  };
}

export function humanGate(state: CampaignGraphState): CampaignGraphUpdate {
  const prompt: GatePrompt = {
    kind: "review",
    planId: state.planId,
    question: "Review this campaign: approve, ask for changes, or reject.",
    options: ["approve", "edit", "reject"],
  };
  const answer = ReviewDecisionSchema.parse(interrupt(prompt));
  return { lastDecision: { ...answer, at: new Date().toISOString() } };
}

export function buildCampaignGraph() {
  return new StateGraph(CampaignState)
    .addNode("intake", intake)
    .addNode("humanGate", humanGate)
    .addEdge(START, "intake")
    .addEdge("intake", "humanGate")
    .addEdge("humanGate", END);
}

export function compileCampaignGraph(checkpointer: BaseCheckpointSaver) {
  return buildCampaignGraph().compile({ checkpointer, name: "marketing-agent" });
}
export type CampaignGraph = ReturnType<typeof compileCampaignGraph>;
