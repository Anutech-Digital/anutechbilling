/**
 * Sending a command to the DMS engine — the WRITE half of the integration.
 *
 * The read client (`client.ts`) holds a key that can only read. This one holds
 * `DMS_ENGINE_COMMAND_KEY`, which maps to DMS's `BILLING_COMMAND_API_KEY` and can
 * spend money (it can register a domain), so it lives in its own module with
 * one caller per command, never imported by anything that merely displays data.
 *
 * The engine's contract (DMS app/api/integrations/engine/commands):
 *   - `commandId` is the idempotency key. The SAME id replays the stored result
 *     and never runs again; a different id asks for new work.
 *   - a lost response is `needs_reconciliation`: the work may have happened, the
 *     subject is locked, and it must NOT be sent again under a new id.
 *
 * `classifyCommandResponse` turns the engine's answer into the few outcomes a
 * caller acts on. It is pure so every branch is tested.
 */
const BASE_URL = (process.env.DMS_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
const COMMAND_KEY = (process.env.DMS_ENGINE_COMMAND_KEY ?? "").trim();

/** Prefix DMS puts on a refusal that means "wait for a person", not "broken". */
export const HOLD_PREFIX = "[held]";

/**
 * R-1780: money and GST invoices come only from ResellerOS. Every command says
 * so, and the hosting panel (anutech-hosting, was DMS) then only switches the
 * service on — it never charges that hosting itself and raises no "no bill"
 * flag (its lib/billing/billed-by.ts). Set here, at the one sender, so no
 * caller can forget it or send another owner.
 */
export const BILLED_BY_RESELLEROS = "reselleros";

export interface EngineCommand {
  commandId: string;
  command: string;
  subject: string;
  mode: "test" | "live";
  payload: Record<string, unknown>;
}

export type CommandOutcome =
  /** The work is done (now, or by an earlier run of the same commandId). */
  | { kind: "done"; result: Record<string, unknown>; replayed: boolean }
  /** Refused before anything was written; a person decides. Retry later is safe. */
  | { kind: "held"; reason: string }
  /** Sent, no answer. May have happened. The subject is locked on the engine. */
  | { kind: "needs_reconciliation"; reason: string }
  /** The provider answered no. Nothing happened. */
  | { kind: "refused"; reason: string }
  /** The engine's own gate for this command is closed. */
  | { kind: "gate_closed"; reason: string }
  /** Another command holds this subject. */
  | { kind: "busy"; reason: string }
  /** Could not reach the engine, or it answered something unrecognised. */
  | { kind: "unreachable"; reason: string };

export function commandsConfigured(): boolean {
  return BASE_URL.length > 0 && COMMAND_KEY.length > 0;
}

export function classifyCommandResponse(httpStatus: number, body: unknown): CommandOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // `detail` is the engine handler's own sentence (a hold starts with "[held]");
  // `error` is the route's summary. Both are read.
  const error = [b.error, b.detail].filter((x): x is string => typeof x === "string" && x.length > 0).join(" — ");
  const status = typeof b.status === "string" ? b.status : "";

  if (httpStatus === 200 && status === "succeeded") {
    return { kind: "done", result: (b.result as Record<string, unknown>) ?? {}, replayed: b.replayed === true };
  }
  // A replay of an earlier run reports that run's outcome, with 200.
  if (httpStatus === 200 && b.replayed === true) {
    const priorError = typeof b.error === "string" ? b.error : "";
    if (status === "needs_reconciliation") return { kind: "needs_reconciliation", reason: priorError || "an earlier run is awaiting reconciliation" };
    if (priorError.includes(HOLD_PREFIX)) return { kind: "held", reason: priorError };
    return { kind: "refused", reason: priorError || `an earlier run ended ${status || "without a result"}` };
  }
  if (status === "needs_reconciliation") return { kind: "needs_reconciliation", reason: error };
  if (httpStatus === 409) return { kind: "busy", reason: error };
  if (httpStatus === 503) return { kind: "gate_closed", reason: error };
  if (error.includes(HOLD_PREFIX)) return { kind: "held", reason: error };
  if (status === "failed" && b.transport === "responded") return { kind: "refused", reason: error };
  if (status === "failed" && b.transport === "not_sent") return { kind: "held", reason: error };
  return { kind: "unreachable", reason: error || `engine answered HTTP ${httpStatus}` };
}

export async function sendEngineCommand(cmd: EngineCommand): Promise<CommandOutcome> {
  if (!commandsConfigured()) {
    return { kind: "unreachable", reason: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set on this server" };
  }
  try {
    const res = await fetch(`${BASE_URL}/api/integrations/engine/commands`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json", "x-integration-key": COMMAND_KEY },
      body: JSON.stringify({ ...cmd, payload: { ...cmd.payload, billedBy: BILLED_BY_RESELLEROS } }),
      /* Generous: a registration is a registrar round trip. A timeout here does
         NOT mean it failed — the same commandId is sent again next run and the
         engine replays whatever happened. */
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    return classifyCommandResponse(res.status, body);
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  }
}
