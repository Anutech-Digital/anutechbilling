/**
 * R-2157 (G-ADS-AI, AI-01) — CampaignState: the one typed state the marketing agent graph
 * (Xeno → Pixeo → review → publish → monitor) passes between its nodes and saves at every step.
 *
 * Two shapes of the same thing:
 *  - `CampaignState` (LangGraph `Annotation.Root`) — the channels the graph runs on.
 *  - `CampaignStateSchema` (zod) — what is allowed IN (start / resume input) and what is
 *    shown OUT (the /state route). A checkpoint is data the AI helped write, so it is parsed
 *    again before any screen reads it.
 *
 * Plan rule (snappy-painting-dragonfly §5): only ids and short summaries live in the state.
 * Images go to the private `ad-creatives` bucket (by path), analytics stay in the database.
 * Amounts are rupees (INR) of a PLAN — nothing here is booked money.
 *
 * The thread is the ad_plans row: threadId = planId = ad_plans.id
 * (agent_checkpoints FK, migration 20261030084415).
 */
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const UUID = z.string().uuid();
const money = z.number().finite().min(0).max(10_000_000);

export const AGENT_PLATFORMS = ["meta", "google"] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export const BriefSchema = z.object({
  goal: z.enum(["sales", "leads", "traffic"]),
  targetRoas: z.number().finite().positive().max(1000).nullable(),
  audience: z.object({
    geo: z.array(shortText(80)).max(20),
    ageMin: z.number().int().min(13).max(65).nullable(),
    ageMax: z.number().int().min(13).max(65).nullable(),
    interests: z.array(shortText(80)).max(30),
  }).refine((a) => a.ageMin == null || a.ageMax == null || a.ageMin <= a.ageMax, { message: "Age from must not be above age to." }),
  budget: z.object({
    daily: money.nullable(),
    total: money.nullable(),
    currency: z.literal("INR"),
  }),
  platforms: z.array(z.enum(AGENT_PLATFORMS)).min(1).max(2),
  itemIds: z.array(shortText(64)).max(20),
  landingUrl: z.string().url().max(2000).refine((u) => u.startsWith("https://"), { message: "Landing page must be https." }).nullable(),
  utmCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).nullable(),
});
export type Brief = z.infer<typeof BriefSchema>;

export const CreativeSchema = z.object({
  id: shortText(64),
  storagePath: shortText(500).nullable(),
  aspectRatio: z.enum(["1:1", "9:16"]),
  headline: z.string().max(300),
  description: z.string().max(2000),
  cta: z.string().max(60),
  channel: z.enum(AGENT_PLATFORMS),
  status: z.enum(["draft", "checked", "approved", "rejected"]),
  checks: z.array(z.object({ name: shortText(60), ok: z.boolean(), detail: z.string().max(300).optional() })).max(30),
});
export type Creative = z.infer<typeof CreativeSchema>;

export const DEPLOYMENT_STATUSES = ["Draft", "Pending_Approval", "Published", "Active", "Paused"] as const;
export const DeploymentSchema = z.object({
  status: z.enum(DEPLOYMENT_STATUSES),
  platformIds: z.object({ meta: shortText(100).optional(), google: shortText(100).optional() }),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

const metric = z.number().finite().min(0).nullable();
export const AnalyticsSchema = z.object({
  /** Paid orders in Billing ÷ spend (R-1980) — what the monitor decides on. */
  ourRoas: metric,
  /** What Meta / Google report — shown, never decided on. */
  platformRoas: metric,
  spend: metric,
  clicks: metric,
  cpc: metric,
  cpm: metric,
  conversions: metric,
  window: z.object({ from: z.string().date(), to: z.string().date() }).nullable(),
  enoughData: z.boolean(),
});
export type Analytics = z.infer<typeof AnalyticsSchema>;

export const PendingActionSchema = z.object({
  id: shortText(64),
  type: z.enum(["publish", "budget_up", "budget_down", "pause", "new_creative", "reallocate"]),
  /** Change in daily spend, rupees; + raises spend (always needs approval), − lowers it. */
  moneyDelta: z.number().finite().min(-10_000_000).max(10_000_000),
  reason: z.string().max(500),
  needsApproval: z.boolean(),
  approvalId: shortText(64).nullable(),
}).refine((a) => !(a.moneyDelta > 0 || a.type === "publish" || a.type === "new_creative") || a.needsApproval, {
  message: "Raising spend, publishing or a new creative always needs an approval.",
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const AgentErrorSchema = z.object({
  node: shortText(40),
  code: shortText(60),
  message: z.string().max(500),
  retryable: z.boolean(),
  at: z.string().datetime(),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

export const ReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "edit", "reject"]),
  note: z.string().trim().max(1000).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const CampaignStateSchema = z.object({
  tenantId: UUID,
  /** ad_plans.id — the row the graph works on. Also the checkpoint thread. */
  planId: UUID,
  threadId: UUID,
  /** marketing_campaigns.id (utm code + dates) once the plan has one. */
  campaignId: UUID.nullable(),
  userIntent: z.string().trim().max(4000),
  brief: BriefSchema.nullable(),
  creatives: z.array(CreativeSchema).max(40),
  deployment: DeploymentSchema,
  analytics: AnalyticsSchema.nullable(),
  pendingActions: z.array(PendingActionSchema).max(50),
  errors: z.array(AgentErrorSchema).max(100),
  lastDecision: ReviewDecisionSchema.extend({ at: z.string().datetime() }).nullable(),
  iteration: z.number().int().min(0).max(10_000),
}).refine((s) => s.threadId === s.planId, { message: "The thread is the plan: threadId must equal planId." });
export type CampaignStateValue = z.infer<typeof CampaignStateSchema>;

/** Most errors kept in the state; older ones live in the action log (safety-layer card). */
export const MAX_ERRORS = 100;

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_old, next) => next, default: fallback });

/** The graph's channels. Every field is last-write-wins except `errors`, which appends. */
export const CampaignState = Annotation.Root({
  tenantId: Annotation<string>,
  planId: Annotation<string>,
  threadId: Annotation<string>,
  campaignId: last<string | null>(() => null),
  userIntent: last<string>(() => ""),
  brief: last<Brief | null>(() => null),
  creatives: last<Creative[]>(() => []),
  deployment: last<Deployment>(() => ({ status: "Draft", platformIds: {} })),
  analytics: last<Analytics | null>(() => null),
  pendingActions: last<PendingAction[]>(() => []),
  errors: Annotation<AgentError[]>({
    reducer: (old, next) => [...old, ...next].slice(-MAX_ERRORS),
    default: () => [],
  }),
  lastDecision: last<(ReviewDecision & { at: string }) | null>(() => null),
  iteration: last<number>(() => 0),
});
export type CampaignGraphState = typeof CampaignState.State;
export type CampaignGraphUpdate = typeof CampaignState.Update;

/** What the runner needs from the ad_plans row to seed a new thread. */
export interface PlanSeed {
  tenantId: string;
  planId: string;
  campaignId: string | null;
  prompt: string;
}

/** The first state of a thread: the plan's ids and the person's words; Xeno fills the brief. */
export function initialState(plan: PlanSeed, intent?: string): CampaignStateValue {
  return CampaignStateSchema.parse({
    tenantId: plan.tenantId,
    planId: plan.planId,
    threadId: plan.planId,
    campaignId: plan.campaignId,
    userIntent: (intent ?? "").trim() || plan.prompt.trim(),
    brief: null,
    creatives: [],
    deployment: { status: "Draft", platformIds: {} },
    analytics: null,
    pendingActions: [],
    errors: [],
    lastDecision: null,
    iteration: 0,
  });
}
