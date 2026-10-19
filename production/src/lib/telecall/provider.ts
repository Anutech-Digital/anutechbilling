/**
 * The telephony vendor, behind one door.
 *
 * Retell and Vapi do the same job with different nouns. Everything above this file speaks in
 * `PlaceCallRequest` / `PlaceCallResult`; only this file knows that one calls it
 * `retell_llm_dynamic_variables` and the other `assistantOverrides.variableValues`.
 *
 * ─── WHY THE CREDENTIALS ARE ENV AND NOT tenant_secrets ─────────────────────
 * WhatsApp credentials live in `tenant_secrets` because each reseller brings their OWN Meta
 * Business account — their number, their template approvals, their bill. A telephony account
 * is not that shape: there is one vendor contract, one verified caller ID, and one number that
 * shows on the customer's phone, all belonging to the deployment. Per-tenant rows would model
 * a fact that is not true and would need a migration plus a Database-type regeneration to say
 * it (AGENTS.md L31 — registering one extra table took typecheck from 4 errors to 2,722).
 *
 * If a second reseller ever brings their own caller ID, that is the day this becomes a
 * `tenant_secrets` read, and the interface below does not change when it does.
 *
 * ─── NOT CONFIGURED IS NOT AN ERROR ─────────────────────────────────────────
 * `resolveTelecallProvider` returns null rather than throwing when nothing is set up. Today
 * nothing is: no Retell or Vapi account exists for this deployment. The whole feature must
 * therefore behave sanely at zero configuration — record what it WOULD have done and say so —
 * rather than filling the logs with exceptions on every cron run.
 */

export type TelecallProviderName = "retell" | "vapi" | "bolna";

export interface TelecallProviderConfig {
  name: TelecallProviderName;
  apiKey: string;
  /** Retell / Bolna: the E.164 number we call from. Vapi: the phoneNumberId. */
  fromNumber: string;
  /** The configured voice agent / assistant on the vendor's side. */
  agentId: string;
}

/**
 * Read the vendor configuration out of the environment.
 *
 * All four values or nothing. A half-configured provider — key but no agent id — would fail at
 * the vendor with a 4xx that reads like an outage; refusing here names the missing variable
 * instead.
 */
export function resolveTelecallProvider(
  env: NodeJS.ProcessEnv = process.env,
): TelecallProviderConfig | null {
  const requested = env.TELECALL_PROVIDER?.trim().toLowerCase();

  if (requested === "vapi") {
    const apiKey = env.VAPI_API_KEY?.trim();
    const fromNumber = env.VAPI_PHONE_NUMBER_ID?.trim();
    const agentId = env.VAPI_ASSISTANT_ID?.trim();
    if (!apiKey || !fromNumber || !agentId) return null;
    return { name: "vapi", apiKey, fromNumber, agentId };
  }

  /* R-1437: Bolna (bolna.ai) — Indian numbers and Hinglish voices on one account. */
  if (requested === "bolna") {
    const apiKey = env.BOLNA_API_KEY?.trim();
    const agentId = env.BOLNA_AGENT_ID?.trim();
    if (!apiKey || !agentId) return null;
    /* Optional for Bolna: with no number of our own (trial plan), Bolna dials from the
       account's default number. Anything that is not a full E.164 number — "+91...", a
       placeholder — counts as not set rather than being sent to Bolna. */
    const rawFrom = env.BOLNA_FROM_NUMBER?.trim() ?? "";
    const fromNumber = /^\+[1-9][0-9]{7,14}$/.test(rawFrom) ? rawFrom : "";
    return { name: "bolna", apiKey, fromNumber, agentId };
  }

  /* Retell is the default when TELECALL_PROVIDER is unset, matching the migration's column
     default. An unrecognised value falls here too — and then fails the key check below, which
     is the intended outcome: a typo in the provider name must not silently dial through the
     other vendor. */
  if (requested && requested !== "retell") return null;

  const apiKey = env.RETELL_API_KEY?.trim();
  const fromNumber = env.RETELL_FROM_NUMBER?.trim();
  const agentId = env.RETELL_AGENT_ID?.trim();
  if (!apiKey || !fromNumber || !agentId) return null;
  return { name: "retell", apiKey, fromNumber, agentId };
}

/** Which environment variables are missing, for an operator-facing message. */
export function missingTelecallEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const requested = env.TELECALL_PROVIDER?.trim().toLowerCase();
  const needed =
    requested === "vapi"
      ? ["VAPI_API_KEY", "VAPI_PHONE_NUMBER_ID", "VAPI_ASSISTANT_ID"]
      : requested === "bolna"
        ? ["BOLNA_API_KEY", "BOLNA_AGENT_ID"]
        : ["RETELL_API_KEY", "RETELL_FROM_NUMBER", "RETELL_AGENT_ID"];
  return needed.filter((k) => !env[k]?.trim());
}

export interface PlaceCallRequest {
  toNumber: string;
  /** Overrides the vendor-side agent's prompt for this one call. */
  systemPrompt: string;
  /** Flat string map — both vendors interpolate `{{key}}` from exactly this. */
  dynamicVariables: Record<string, string>;
  /** Echoed back on the post-call webhook so the row can be found without a lookup table. */
  metadata: Record<string, string>;
}

export type PlaceCallResult =
  | { ok: true; providerCallId: string }
  | { ok: false; error: string };

/** Vendor-side timeout. A dial that hangs must not hold a cron's connection open. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Place one outbound call.
 *
 * Never throws. Every caller is a route or a cron, and neither may 500 because a vendor was
 * slow — the row is written either way, and a `failed` row with a reason is a better outcome
 * than a stack trace nobody reads.
 */
export async function placeCall(
  config: TelecallProviderConfig,
  req: PlaceCallRequest,
): Promise<PlaceCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { url, body } = buildRequest(config, req);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      /* The vendor's own message, truncated. It is the only thing that distinguishes "number
         is on a do-not-call registry" from "your card was declined", and both arrive as a
         4xx. Truncated because a vendor error page can be an entire HTML document. */
      return { ok: false, error: `${config.name} refused the call (${res.status}): ${text.slice(0, 300)}` };
    }

    const callId = extractCallId(text);
    if (!callId) {
      /* Accepted but unidentifiable. Treated as a failure on purpose: without the id the
         post-call webhook cannot be matched to this row, so the call would happen and the app
         would never learn what was said. */
      return {
        ok: false,
        error: `${config.name} accepted the call but returned no call id — the outcome could not be tracked`,
      };
    }

    return { ok: true, providerCallId: callId };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `${config.name} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s` : why,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface VendorRequest {
  url: string;
  body: Record<string, unknown>;
}

/** The one place the two vendors' vocabularies differ. */
function buildRequest(config: TelecallProviderConfig, req: PlaceCallRequest): VendorRequest {
  if (config.name === "vapi") {
    return {
      url: "https://api.vapi.ai/call",
      body: {
        phoneNumberId: config.fromNumber,
        assistantId: config.agentId,
        customer: { number: req.toNumber },
        assistantOverrides: {
          variableValues: req.dynamicVariables,
          model: { messages: [{ role: "system", content: req.systemPrompt }] },
        },
        metadata: req.metadata,
      },
    };
  }

  if (config.name === "bolna") {
    /* Bolna has no per-call system-prompt override and echoes no metadata. Everything goes in
       `user_data`, which the agent's prompt on Bolna interpolates as {{variable}} — so the agent
       there must be set up with a prompt of `{{system_prompt}}` (docs/telecall-bolna.md). The
       call row is still found by execution_id, never by anything echoed back. */
    return {
      url: `${BOLNA_API_BASE}/call`,
      body: {
        agent_id: config.agentId,
        recipient_phone_number: req.toNumber,
        ...(config.fromNumber ? { from_phone_number: config.fromNumber } : {}),
        user_data: { ...req.dynamicVariables, ...req.metadata, system_prompt: req.systemPrompt },
      },
    };
  }

  return {
    url: "https://api.retellai.com/v2/create-phone-call",
    body: {
      from_number: config.fromNumber,
      to_number: req.toNumber,
      override_agent_id: config.agentId,
      retell_llm_dynamic_variables: req.dynamicVariables,
      metadata: { ...req.metadata, system_prompt: req.systemPrompt },
    },
  };
}

/**
 * Pull the call id out of whichever field the vendor used.
 *
 * Hand-parsed rather than typed against a vendor SDK: the response is somebody else's JSON and
 * may carry fields we have never seen. Reading the two keys we need and ignoring the rest
 * cannot break when they add a third.
 */
function extractCallId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    /* Bolna answers `{ status: "queued", execution_id }`; Retell `call_id`; Vapi `id`. */
    const candidate = obj.execution_id ?? obj.call_id ?? obj.id;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

export const BOLNA_API_BASE = "https://api.bolna.ai";

/** Bolna execution ids are UUIDs; anything else is refused before it reaches a URL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FetchExecutionResult =
  | { ok: true; execution: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * R-1437: read one Bolna call back from Bolna itself (`GET /executions/{id}`).
 *
 * Bolna documents no webhook signature, so the post-call webhook body is never trusted for
 * what was SAID: the route takes only the execution id from it and asks Bolna, with our own
 * API key, what happened. A forged webhook can at most make us re-read a real call of ours.
 * Never throws.
 */
export async function fetchBolnaExecution(
  config: TelecallProviderConfig,
  executionId: string,
): Promise<FetchExecutionResult> {
  if (config.name !== "bolna") return { ok: false, error: "not a Bolna configuration" };
  if (!UUID_RE.test(executionId)) return { ok: false, error: "not a Bolna execution id" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BOLNA_API_BASE}/executions/${encodeURIComponent(executionId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `bolna refused the lookup (${res.status}): ${text.slice(0, 300)}` };
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "bolna returned no execution" };
    return { ok: true, execution: parsed as Record<string, unknown> };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `bolna did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`
        : err instanceof Error ? err.message : "unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface BolnaAgent {
  id: string;
  name: string;
}

export type ListAgentsResult = { ok: true; agents: BolnaAgent[] } | { ok: false; error: string };

/**
 * R-1661: the agents on this Bolna account (`GET /v2/agent/all`, a bare JSON array) — the
 * dropdown on Cold Calling and on a lead's "AI call". Read live rather than stored, so an agent
 * added or renamed on Bolna shows up without a deploy. Never throws.
 */
export async function listBolnaAgents(config: TelecallProviderConfig): Promise<ListAgentsResult> {
  if (config.name !== "bolna") return { ok: false, error: "not a Bolna configuration" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BOLNA_API_BASE}/v2/agent/all`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `bolna refused the agent list (${res.status}): ${text.slice(0, 200)}` };
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [];
    const agents = list.flatMap((a): BolnaAgent[] => {
      if (typeof a !== "object" || a === null) return [];
      const o = a as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (!UUID_RE.test(id)) return [];
      const name = typeof o.agent_name === "string" && o.agent_name.trim() ? o.agent_name.trim() : "Unnamed agent";
      return [{ id, name }];
    });
    return { ok: true, agents };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `bolna did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`
        : err instanceof Error ? err.message : "unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}
