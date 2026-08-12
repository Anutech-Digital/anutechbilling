/**
 * POST /api/ai/plan-project
 *
 * Given a project's details, Gemini writes (1) a detailed plain-language
 * explanation of the scope + approach with concrete examples, and (2) a task
 * breakdown to complete it — each task optionally suggested to a team member.
 * Auth required (owner/manager). Falls back to a generic stub without a key.
 *
 * Body: { title, customer?, value?, startDate?, targetDate?, details?, team?: string[] }
 * Returns: { explanation: string, tasks: [{ title, phase?, assignee? }], mode }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action:     z.enum(["questions", "plan"]).optional().default("plan"),
  title:      z.string().min(1).max(200),
  customer:   z.string().max(200).optional(),
  value:      z.number().optional(),
  startDate:  z.string().optional(),
  targetDate: z.string().optional(),
  details:    z.string().max(4000).optional(),
  qaAnswers:  z.string().max(4000).optional(),
  team:       z.array(z.string()).max(50).optional(),
});

export type PlannedTask = { title: string; phase?: string; assignee?: string };
export type QuestionOption = { labelEn: string; labelHi: string };
export type QuestionItem = { en: string; hi: string; options: QuestionOption[] };

export type ProjectPlan = {
  explanation: string;
  clientProposal?: string;
  tasks: PlannedTask[];
  questions?: QuestionItem[];
  mode: string;
};

function buildQuestionsPrompt(b: z.infer<typeof bodySchema>): string {
  return (
    `You are a Senior Technical Project Manager & Solution Architect at an Indian IT consultancy.\n` +
    `A project description has been submitted for: "${b.title}" (Client: ${b.customer || "Prospect Client"}).\n` +
    `Project Details: "${b.details || "Standard IT / Software project"}"\n\n` +
    `Formulate 4-5 concise, highly relevant, project-specific clarifying questions.\n` +
    `CRITICAL REQUIREMENT: For EACH question, provide 3-4 distinct OBJECTIVE MULTIPLE-CHOICE OPTIONS so the user can answer with a 1-click selection!\n` +
    `Provide each question AND its options in BOTH English ("en", "labelEn") AND Hinglish ("hi", "labelHi").\n\n` +
    `Return ONLY JSON in this exact format (no prose, no markdown code blocks):\n` +
    `{\n` +
    `  "questions": [\n` +
    `    {\n` +
    `      "en": "1. What is the target scope for the initial MVP release?",\n` +
    `      "hi": "1. Shuru ke Go-Live (MVP) ke liye kitna scope pehle chahiye?",\n` +
    `      "options": [\n` +
    `        { "labelEn": "Core Modules Only (Fast Launch)", "labelHi": "Sirf Main Core Modules (Fast Launch)" },\n` +
    `        { "labelEn": "Full Feature Suite (Complete Scope)", "labelHi": "Full Complete Feature Suite" },\n` +
    `        { "labelEn": "Phased Step-by-Step Release", "labelHi": "Phased Step-by-Step Release" }\n` +
    `      ]\n` +
    `    }\n` +
    `  ]\n` +
    `}`
  );
}

function buildPlanPrompt(b: z.infer<typeof bodySchema>): string {
  const team = (b.team ?? []).filter(Boolean);
  return (
    `You are an expert Delivery Manager & Solution Architect at an Indian IT consultancy.\n` +
    `Generate a comprehensive, client-ready Project Proposal & Phase-Wise Delivery Plan for the following project.\n\n` +
    `PROJECT TITLE: ${b.title}\n` +
    (b.customer ? `CLIENT: ${b.customer}\n` : "") +
    (b.value ? `CONTRACT VALUE: ₹${b.value.toLocaleString("en-IN")}\n` : "") +
    (b.startDate ? `START DATE: ${b.startDate}\n` : "") +
    (b.targetDate ? `TARGET DEADLINE: ${b.targetDate}\n` : "") +
    (b.details ? `PROJECT BRIEF: ${b.details}\n` : "") +
    (b.qaAnswers ? `CLIENT CLARIFICATIONS & REQUIREMENTS: ${b.qaAnswers}\n` : "") +
    (team.length ? `AVAILABLE TEAM MEMBERS FOR TASK ASSIGNMENT: ${team.join(", ")}\n` : "") +
    `\nReturn ONLY JSON (no prose, no markdown code fences) in this exact shape:\n` +
    `{\n` +
    `  "clientProposal": "Executive Client Proposal & Presentation Document in clean Markdown format with headers (## Executive Summary, ## Project Scope & Architecture, ## Phase Milestones & Deliverables, ## Key Value Proposition). Professional and persuasive for client presentation.",\n` +
    `  "explanation": "Summary strategy and approach breakdown for internal team execution.",\n` +
    `  "tasks": [\n` +
    `    { "title": "Specific task title", "phase": "Phase 1: Discovery & Requirements", "assignee": "team member name or empty string" },\n` +
    `    { "title": "Specific task title", "phase": "Phase 2: Architecture & Setup", "assignee": "team member name or empty string" },\n` +
    `    { "title": "Specific task title", "phase": "Phase 3: Core Development", "assignee": "team member name or empty string" },\n` +
    `    { "title": "Specific task title", "phase": "Phase 4: QA, Testing & UAT", "assignee": "team member name or empty string" },\n` +
    `    { "title": "Specific task title", "phase": "Phase 5: Deployment & Handover", "assignee": "team member name or empty string" }\n` +
    `  ]\n` +
    `}\n\n` +
    `Provide 10-18 practical, actionable tasks categorized strictly into 4-5 sequential delivery phases.\n` +
    `If team member names are provided (${team.join(", ")}), distribute tasks logically to the most suitable team member based on task type.`
  );
}

async function genWithGemini(apiKey: string, model: string, prompt: string): Promise<any> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[ai/plan-project] Gemini crashed:", err);
    return null;
  }
}

const STUB_QUESTIONS: QuestionItem[] = [
  {
    en: "1. What is the target scope for the initial Go-Live (MVP) release?",
    hi: "1. Shuru ke Go-Live (MVP) ke liye kitna scope pehle chahiye?",
    options: [
      { labelEn: "Core Modules Only (Fast Launch)", labelHi: "Sirf Main Core Modules (Fast Launch)" },
      { labelEn: "Full Feature Suite (Complete Scope)", labelHi: "Full Complete Feature Suite" },
      { labelEn: "Phased Step-by-Step Release", labelHi: "Phased Step-by-Step Release" },
    ],
  },
  {
    en: "2. What is the existing data migration requirement?",
    hi: "2. Existing data migration ki kya zaroorat hai?",
    options: [
      { labelEn: "Excel / CSV Data Import", labelHi: "Excel / CSV Data Import" },
      { labelEn: "Direct Database Migration", labelHi: "Direct Database Migration" },
      { labelEn: "Fresh Setup (No Migration)", labelHi: "Fresh Setup (No Migration)" },
    ],
  },
  {
    en: "3. What third-party integrations are required for Phase 1?",
    hi: "3. Phase 1 ke liye konsi third-party APIs integrate karni hain?",
    options: [
      { labelEn: "Razorpay & WhatsApp APIs", labelHi: "Razorpay & WhatsApp APIs" },
      { labelEn: "Google Workspace & M365 APIs", labelHi: "Google Workspace & M365 APIs" },
      { labelEn: "No External Integrations Needed", labelHi: "No External Integrations Needed" },
    ],
  },
  {
    en: "4. What is the preferred client milestone & demo schedule?",
    hi: "4. Client ko demo aur milestone updates ki frequency kya rakhni hai?",
    options: [
      { labelEn: "Weekly Milestone Demos", labelHi: "Weekly Milestone Demos" },
      { labelEn: "Bi-Weekly (Every 2 Weeks)", labelHi: "Har 2 Hafte Me (Bi-Weekly)" },
      { labelEn: "Monthly Major Phase Releases", labelHi: "Monthly Major Phase Releases" },
    ],
  },
];

const STUB = (title: string, customer?: string): ProjectPlan => ({
  clientProposal:
    `# 🚀 Client Project Proposal & Presentation\n\n` +
    `**Project**: ${title}\n` +
    `**Prepared For**: ${customer || "Valued Client"}\n\n` +
    `## 1. Executive Summary\n` +
    `This proposal outlines the strategic delivery roadmap for **${title}**. Our objective is to deliver a robust, scalable, and high-performance solution tailored to your operational requirements.\n\n` +
    `## 2. Project Scope & Architecture\n` +
    `- **Core Module Development**: Building robust backend services & intuitive UI/UX workflows.\n` +
    `- **System Integrations**: Secure API integration with third-party providers & databases.\n` +
    `- **Security & Access**: Role-based permissions, data encryption, and automated audit logs.\n\n` +
    `## 3. Phase Milestones & Timeline\n` +
    `- **Phase 1: Discovery & Architecture** (Requirements, Database Design & Wireframes)\n` +
    `- **Phase 2: Core Development** (User Management, Business Logic & API Development)\n` +
    `- **Phase 3: Integration & Testing** (Module Integration, QA & Performance Tuning)\n` +
    `- **Phase 4: Client UAT & Go-Live** (User Training, Staging Demo & Production Launch)\n\n` +
    `## 4. Key Value Proposition\n` +
    `- End-to-end delivery transparency with bi-weekly client demos.\n` +
    `- Dedicated engineering team with post-launch support and warranty.`,

  explanation:
    `Plan for "${title}":\n` +
    `- Phase 1 (Discovery): Requirements gathering, database schema, wireframes.\n` +
    `- Phase 2 (Core Build): Backend APIs, frontend UI, authentication & state management.\n` +
    `- Phase 3 (Integration & QA): Third-party integrations, end-to-end testing, bug fixing.\n` +
    `- Phase 4 (Deployment & Handover): Staging demo, UAT signoff, production release & training.`,

  tasks: [
    { title: "Project Kick-off & Detailed Requirements Gathering", phase: "Phase 1: Discovery & Requirements" },
    { title: "Define Technical Architecture & Database Design", phase: "Phase 1: Discovery & Requirements" },
    { title: "Develop UI/UX Wireframes & Interactive Mockups", phase: "Phase 1: Discovery & Requirements" },
    { title: "Set up Development & Testing Environments", phase: "Phase 2: Architecture & Setup" },
    { title: "Implement Core User Management & Authentication", phase: "Phase 2: Architecture & Setup" },
    { title: "Develop Main Business Logic & API Modules", phase: "Phase 3: Core Development" },
    { title: "Build Interactive Frontend Dashboard & Workflows", phase: "Phase 3: Core Development" },
    { title: "Integrate Third-Party Services & Payment/Notification APIs", phase: "Phase 3: Core Development" },
    { title: "Conduct Quality Assurance (QA) & Bug Fixing", phase: "Phase 4: QA, Testing & UAT" },
    { title: "Perform Client Demo & Conduct User Acceptance Testing (UAT)", phase: "Phase 4: QA, Testing & UAT" },
    { title: "Final Production Deployment & Client Handover", phase: "Phase 5: Deployment & Handover" },
  ],
  mode: "stub",
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body;
  try { body = bodySchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  if (body.action === "questions") {
    if (gemini.apiKey) {
      const qRes = await genWithGemini(gemini.apiKey, gemini.model, buildQuestionsPrompt(body));
      if (qRes && Array.isArray(qRes.questions) && qRes.questions.length > 0) {
        return NextResponse.json({ questions: qRes.questions, mode: "gemini" });
      }
    }
    return NextResponse.json({ questions: STUB_QUESTIONS, mode: "stub" });
  }

  if (gemini.apiKey) {
    const planRes = await genWithGemini(gemini.apiKey, gemini.model, buildPlanPrompt(body));
    if (planRes && (planRes.explanation || planRes.clientProposal || (Array.isArray(planRes.tasks) && planRes.tasks.length > 0))) {
      return NextResponse.json({
        clientProposal: planRes.clientProposal || "",
        explanation: planRes.explanation || "",
        tasks: Array.isArray(planRes.tasks) ? planRes.tasks : [],
        mode: "gemini",
      });
    }
  }

  return NextResponse.json(STUB(body.title, body.customer));
}
