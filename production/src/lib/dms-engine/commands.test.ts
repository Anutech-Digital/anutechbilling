/**
 * R-1780 — money and GST invoices come only from ResellerOS. Every command we
 * send the hosting panel (anutech-hosting, was DMS) says so with
 * `payload.billedBy: "reselleros"`, and the panel then only switches the
 * domain/hosting on: it never charges that hosting itself and raises no
 * "no bill" alarm. No network: fetch is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DMS_ENGINE_URL", "https://hosting.example.invalid/");
  vi.stubEnv("DMS_ENGINE_COMMAND_KEY", "test-command-key");
  fetchMock.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ status: "succeeded", result: { ok: true } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("sendEngineCommand — billed by ResellerOS (R-1780)", () => {
  it("stamps billedBy: reselleros on the payload, keeping every field the caller sent", async () => {
    const { sendEngineCommand, BILLED_BY_RESELLEROS } = await import("./commands");
    const out = await sendEngineCommand({
      commandId: "c-1",
      command: "hosting.provision",
      subject: "acme.in",
      mode: "live",
      payload: { planId: "starter", months: 12, paymentMode: "live", sourceRef: "Q-1" },
    });
    expect(out.kind).toBe("done");
    expect(BILLED_BY_RESELLEROS).toBe("reselleros");
    const body = sentBody();
    expect(body.payload).toEqual({
      planId: "starter",
      months: 12,
      paymentMode: "live",
      sourceRef: "Q-1",
      billedBy: "reselleros",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://hosting.example.invalid/api/integrations/engine/commands");
  });

  it("a caller cannot send a different billing owner", async () => {
    const { sendEngineCommand } = await import("./commands");
    await sendEngineCommand({
      commandId: "c-2",
      command: "hosting.renew",
      subject: "acme.in",
      mode: "live",
      payload: { months: 12, billedBy: "dms" },
    });
    expect((sentBody().payload as Record<string, unknown>).billedBy).toBe("reselleros");
  });

  it("not configured → nothing is sent", async () => {
    vi.stubEnv("DMS_ENGINE_URL", "");
    const { sendEngineCommand } = await import("./commands");
    const out = await sendEngineCommand({ commandId: "c-3", command: "hosting.renew", subject: "acme.in", mode: "live", payload: {} });
    expect(out.kind).toBe("unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
