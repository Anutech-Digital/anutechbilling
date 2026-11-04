/**
 * R-2165 (G-ADS-AI, AI-09) — neoAsk: Neo's small LangGraph graph for one chat question.
 *
 *   START → makePlan → runQuery → writeAnswer → END
 *                  └─(no plan)────────────────────→ END
 *
 *   makePlan    the rules reader first (free, cannot be talked into anything); when it finds no
 *           number to show, the AI planner (if the route gave one). Whatever comes back is
 *           parsed with QueryPlanSchema (strict) — an AI reply with any other field, metric
 *           or dimension is refused, never "repaired" into SQL.
 *   runQuery    the typed plan → public.marketing_metrics_query (allowlisted, read-only, RLS).
 *   writeAnswer summary + chart JSON + table, from the returned numbers only (answer.ts).
 *
 * No checkpointer: a chat question is one run, nothing waits for a person. Dependencies are
 * passed in, so tests run the real graph with an in-memory query.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { buildAnswer, type NeoAnswer } from "./answer";
import {
  QueryPlanSchema, rangeProblem, resolveNeoRange, rpcArgs,
  type MetricsResult, type MetricsRpcArgs, type QueryPlan, type ResolvedRange,
} from "./plan";
import { planFromRules } from "./rules";
import { istToday } from "@/lib/dates/ist";

export const NEO_QUESTION_MAX = 500;

export type NeoPlanSource = "rules" | "ai";

/** Thrown by a planner/query for a reason the person should read (400 / 403 / 429). */
export class NeoError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 429 = 400) { super(message); }
}

export interface NeoDeps {
  /** The plan as the AI reads it (unchecked JSON), or null when no AI is available/answered. */
  aiPlan?: (question: string) => Promise<unknown | null>;
  /** Runs the checked plan through public.marketing_metrics_query. */
  runQuery: (args: MetricsRpcArgs) => Promise<MetricsResult>;
  /** IST date (YYYY-MM-DD); tests pin it. */
  today?: () => string;
}

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_old, next) => next, default: fallback });

export const NeoState = Annotation.Root({
  question: Annotation<string>,
  plan: last<QueryPlan | null>(() => null),
  planSource: last<NeoPlanSource | null>(() => null),
  range: last<ResolvedRange | null>(() => null),
  notes: last<string[]>(() => []),
  result: last<MetricsResult | null>(() => null),
  answer: last<NeoAnswer | null>(() => null),
  problem: last<string | null>(() => null),
});
export type NeoGraphState = typeof NeoState.State;

export const NEO_EXAMPLES = ["Last 7 days ROAS", "Top ads this month", "Spend by platform last 30 days"] as const;

const NO_PLAN =
  `I could not turn that into a question about your marketing numbers. Try "${NEO_EXAMPLES[0]}", "${NEO_EXAMPLES[1]}" or "${NEO_EXAMPLES[2]}".`;

export function buildNeoGraph(deps: NeoDeps) {
  const today = deps.today ?? (() => istToday());

  async function plan(state: NeoGraphState): Promise<Partial<NeoGraphState>> {
    const q = state.question.trim();
    if (!q) return { problem: "Type a question first." };
    if (q.length > NEO_QUESTION_MAX) return { problem: `Keep the question under ${NEO_QUESTION_MAX} characters.` };
    const t = today();
    const rules = planFromRules(q, t);
    let chosen: QueryPlan = rules.plan;
    let source: NeoPlanSource = "rules";
    let notes = rules.notes;
    if (!rules.confident && deps.aiPlan) {
      const raw = await deps.aiPlan(q);
      if (raw !== null && raw !== undefined) {
        const parsed = QueryPlanSchema.safeParse(raw);
        if (parsed.success) {
          chosen = parsed.data;
          source = "ai";
          notes = [];
        } else {
          return { problem: NO_PLAN };
        }
      } else {
        return { problem: NO_PLAN };
      }
    } else if (!rules.confident) {
      return { problem: NO_PLAN };
    }
    const checked = QueryPlanSchema.safeParse(chosen);
    if (!checked.success) return { problem: checked.error.issues[0]?.message ?? NO_PLAN };
    const range = resolveNeoRange(checked.data.range, t);
    const bad = rangeProblem(range);
    if (bad) return { problem: bad };
    return { plan: checked.data, planSource: source, range, notes };
  }

  async function query(state: NeoGraphState): Promise<Partial<NeoGraphState>> {
    return { result: await deps.runQuery(rpcArgs(state.plan!, state.range!)) };
  }

  function answer(state: NeoGraphState): Partial<NeoGraphState> {
    return { answer: buildAnswer(state.plan!, state.range!, state.result!, state.notes) };
  }

  return new StateGraph(NeoState)
    .addNode("makePlan", plan)
    .addNode("runQuery", query)
    .addNode("writeAnswer", answer)
    .addEdge(START, "makePlan")
    .addConditionalEdges("makePlan", (s: NeoGraphState) => (s.problem ? END : "runQuery"), ["runQuery", END])
    .addEdge("runQuery", "writeAnswer")
    .addEdge("writeAnswer", END)
    .compile({ name: "neo-ask" });
}

export interface NeoReply {
  question: string;
  plan: QueryPlan;
  planSource: NeoPlanSource;
  range: ResolvedRange;
  answer: NeoAnswer;
}

/** One question through the graph. Throws NeoError(400) when there is nothing to ask. */
export async function askNeo(question: string, deps: NeoDeps): Promise<NeoReply> {
  const out = await buildNeoGraph(deps).invoke({ question });
  if (out.problem || !out.plan || !out.range || !out.answer || !out.planSource) {
    throw new NeoError(out.problem ?? NO_PLAN, 400);
  }
  return { question: question.trim(), plan: out.plan, planSource: out.planSource, range: out.range, answer: out.answer };
}
