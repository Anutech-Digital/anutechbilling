/**
 * R-1437: Bolna as the third telecalling vendor. No Bolna account exists yet, so every Bolna
 * response here is a fixture shaped from its API docs (POST /call, GET /executions/{id}).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOLNA_API_BASE,
  fetchBolnaExecution,
  missingTelecallEnv,
  placeCall,
  resolveTelecallProvider,
  type TelecallProviderConfig,
} from "./provider";
import { bolnaReasons, looksLikeBolnaExecution, normalisePostCall, sentimentOf } from "./inbound";
import { statusFromDisposition } from "@/lib/ai/telecall";

const EXEC_ID = "123e4567-e89b-12d3-a456-426614174000";
const BOLNA: TelecallProviderConfig = {
  name: "bolna", apiKey: "test-key", fromNumber: "+918000000000", agentId: "agent-1",
};

afterEach(() => vi.unstubAllGlobals());

describe("resolveTelecallProvider — bolna", () => {
  it("needs all three Bolna values", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", TELECALL_PROVIDER: "bolna", BOLNA_API_KEY: "k", BOLNA_FROM_NUMBER: "+918000000000", BOLNA_AGENT_ID: "a" };
    expect(resolveTelecallProvider(env)).toEqual({ name: "bolna", apiKey: "k", fromNumber: "+918000000000", agentId: "a" });
    expect(resolveTelecallProvider({ ...env, BOLNA_AGENT_ID: "" })).toBeNull();
  });

  it("the number is optional — a placeholder or no number means Bolna's default number", () => {
    const base: NodeJS.ProcessEnv = { NODE_ENV: "test", TELECALL_PROVIDER: "bolna", BOLNA_API_KEY: "k", BOLNA_AGENT_ID: "a" };
    expect(resolveTelecallProvider(base)?.fromNumber).toBe("");
    expect(resolveTelecallProvider({ ...base, BOLNA_FROM_NUMBER: "+91..." })?.fromNumber).toBe("");
    expect(resolveTelecallProvider({ ...base, BOLNA_FROM_NUMBER: "+918000000000" })?.fromNumber).toBe("+918000000000");
  });

  it("names the missing Bolna variables", () => {
    expect(missingTelecallEnv({ NODE_ENV: "test", TELECALL_PROVIDER: "bolna", BOLNA_API_KEY: "k" }))
      .toEqual(["BOLNA_AGENT_ID"]);
  });
});

describe("placeCall — bolna", () => {
  it("POSTs /call with the agent, both numbers and everything in user_data, and keeps execution_id", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ message: "done", status: "queued", execution_id: EXEC_ID }), { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await placeCall(BOLNA, {
      toNumber: "+919000000001",
      systemPrompt: "You are Riya from Demo Co.",
      dynamicVariables: { customer_name: "Pankaj" },
      metadata: { tenant_id: "t1", lead_id: "L-1", call_type: "lead_qualification" },
    });

    expect(result).toEqual({ ok: true, providerCallId: EXEC_ID });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BOLNA_API_BASE}/call`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      agent_id: "agent-1",
      recipient_phone_number: "+919000000001",
      from_phone_number: "+918000000000",
      user_data: {
        customer_name: "Pankaj", tenant_id: "t1", lead_id: "L-1", call_type: "lead_qualification",
        system_prompt: "You are Riya from Demo Co.",
      },
    });
  });

  it("with no number of our own, from_phone_number is left out (Bolna's default)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "queued", execution_id: EXEC_ID }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await placeCall({ ...BOLNA, fromNumber: "" }, { toNumber: "+919000000001", systemPrompt: "", dynamicVariables: {}, metadata: {} });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("from_phone_number");
  });

  it("a refusal from Bolna is a failed result with Bolna's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("balance low", { status: 402 })));
    const result = await placeCall(BOLNA, { toNumber: "+919000000001", systemPrompt: "", dynamicVariables: {}, metadata: {} });
    expect(result).toEqual({ ok: false, error: "bolna refused the call (402): balance low" });
  });
});

describe("fetchBolnaExecution", () => {
  it("GETs /executions/{id} with our key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: EXEC_ID, status: "completed" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBolnaExecution(BOLNA, EXEC_ID);
    expect(r).toEqual({ ok: true, execution: { id: EXEC_ID, status: "completed" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BOLNA_API_BASE}/executions/${EXEC_ID}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("refuses an id that is not a UUID before it reaches a URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchBolnaExecution(BOLNA, "../agents")).toEqual({ ok: false, error: "not a Bolna execution id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const completed = {
  id: EXEC_ID,
  agent_id: "agent-1",
  status: "completed",
  conversation_duration: 74,
  transcript: "assistant: Namaste...\nuser: 10 users chahiye...",
  summary: "Customer wants 10 Google Workspace users and a quotation.",
  extracted_data: { General: { customer_asked_for_quote: "yes", seats_discussed: "10", sentiment: "positive" } },
  context_details: { recipient_data: { tenant_id: "t1", lead_id: "L-1", call_type: "lead_qualification" } },
  telephony_data: { duration: "80", recording_url: "https://example.test/r.mp3" },
};

describe("normalisePostCall — bolna execution", () => {
  it("reads a completed call, including grouped extraction", () => {
    expect(looksLikeBolnaExecution(completed)).toBe(true);
    const n = normalisePostCall(completed);
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      provider: "bolna", providerCallId: EXEC_ID, tenantId: "t1", leadId: "L-1",
      callType: "lead_qualification", analysisMissing: false,
    });
    expect(n?.signals).toMatchObject({
      disposition: "completed", durationSec: 74, customerAskedForQuote: true, seatsDiscussed: 10,
      summary: "Customer wants 10 Google Workspace users and a quotation.",
    });
    expect(sentimentOf(completed)).toBe("positive");
  });

  it("ignores statuses that are not final yet (call-disconnected comes before completed)", () => {
    for (const status of ["queued", "ringing", "in-progress", "call-disconnected"]) {
      expect(normalisePostCall({ ...completed, status })).toBeNull();
    }
  });

  it("files a voicemail as no answer, and Bolna's other endings map to our statuses", () => {
    const vm = normalisePostCall({ ...completed, answered_by_voice_mail: true });
    expect(statusFromDisposition(vm?.signals.disposition ?? "")).toBe("no_answer");
    expect(statusFromDisposition("no-answer")).toBe("no_answer");
    expect(statusFromDisposition("busy")).toBe("busy");
    expect(statusFromDisposition("balance-low")).toBe("failed");
  });

  it("no extraction means nothing is concluded", () => {
    const n = normalisePostCall({ ...completed, extracted_data: null });
    expect(n?.analysisMissing).toBe(true);
    expect(n?.signals.customerAskedForQuote).toBe(false);
  });

  it("Retell and Vapi bodies are still told apart from Bolna", () => {
    expect(looksLikeBolnaExecution({ call: { call_id: "x" } })).toBe(false);
    expect(looksLikeBolnaExecution({ message: { type: "end-of-call-report" } })).toBe(false);
  });
});

describe("listBolnaAgents", () => {
  it("reads GET /v2/agent/all (a bare array) into id + name, dropping anything without a uuid", async () => {
    const { listBolnaAgents } = await import("./provider");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { id: EXEC_ID, agent_name: "Anutech Sales Agent", agent_status: "processed" },
      { id: "not-a-uuid", agent_name: "Broken" },
      { id: "223e4567-e89b-12d3-a456-426614174000", agent_name: "" },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await listBolnaAgents(BOLNA);
    expect(r).toEqual({ ok: true, agents: [
      { id: EXEC_ID, name: "Anutech Sales Agent" },
      { id: "223e4567-e89b-12d3-a456-426614174000", name: "Unnamed agent" },
    ] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BOLNA_API_BASE}/v2/agent/all`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });
});

/* The shape real calls returned on 19 Oct 2026: every answer wrapped in {objective, subjective,
   reasoning…} and grouped under "Sales" / "General". Read as plain values it filed a customer
   who asked for a quote for 20 users as merely "talked". */
describe("Bolna grouped extraction (objective/subjective leaves)", () => {
  const leaf = (objective: string | null, subjective: string | null, why = "") =>
    ({ objective, subjective, confidence: 0.95, validation: null, confidence_label: "High", reasoning_objective: why, reasoning_subjective: why });
  const exec = (sales: Record<string, unknown>) => ({
    id: "3f6c2a10-1111-4222-8333-444455556666", agent_id: "agent-1", status: "completed",
    conversation_duration: 61, transcript: "assistant: Namaste\nuser: bees", summary: "Wants 20 users.",
    extracted_data: { Sales: sales, General: { "Call Summary": { subjective: "Wants 20 users." } } },
  });

  it("reads a quote request and seats said in words", () => {
    const n = normalisePostCall(exec({
      seats_discussed: leaf(null, "Customer requested email accounts for 20 users."),
      customer_not_interested: leaf("no", null),
      customer_asked_for_quote: leaf("yes", null, "Customer asked to send the quote by email."),
      customer_asked_for_callback: leaf("no", null),
      customer_confirmed_renewal: leaf("no", null),
    }));
    expect(n?.signals.customerAskedForQuote).toBe(true);
    expect(n?.signals.customerNotInterested).toBe(false);
    expect(n?.signals.seatsDiscussed).toBe(20);
  });

  it("reads 'wrong person' as not interested", () => {
    const n = normalisePostCall(exec({
      seats_discussed: leaf(null, ""),
      customer_not_interested: leaf("yes", null, "Said it was the wrong person."),
      customer_asked_for_quote: leaf("no", null),
    }));
    expect(n?.signals.customerNotInterested).toBe(true);
    expect(n?.signals.seatsDiscussed).toBeNull();
  });

  it("gives the reasons behind every yes, and the seats heard", () => {
    const r = bolnaReasons(exec({
      seats_discussed: leaf(null, "Customer requested email accounts for 20 users."),
      customer_asked_for_quote: leaf("yes", null, "Customer asked to send the quote by email."),
      customer_not_interested: leaf("no", null, "Was cooperative."),
    }).extracted_data);
    expect(r).toEqual(["Customer requested email accounts for 20 users.", "Customer asked to send the quote by email."]);
  });
});
