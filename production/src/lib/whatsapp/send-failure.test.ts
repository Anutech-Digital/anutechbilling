import { describe, it, expect } from "vitest";
import { classifySendFailure, WhatsAppNotConfiguredError } from "./send-failure";

/* The exact string from the live Cloud Run log, 2026-08-12T06:38:19Z, which was
   served as a 502 in the ERROR bucket. */
const LIVE_MESSAGE =
  "WhatsApp credentials are not configured for this workspace. Settings → Integrations → WhatsApp Business.";

describe("classifySendFailure", () => {
  it("calls the 12 Aug 2026 credentials failure a 409, not a 502", () => {
    expect(classifySendFailure(new WhatsAppNotConfiguredError(LIVE_MESSAGE)).status).toBe(409);
  });

  it("keeps that failure OUT of the error log", () => {
    /* The reason this module exists. Four 5xx events in a fortnight and one was a
       settings page nobody filled in — an error bucket carrying config notices
       stops being read as errors. */
    expect(classifySendFailure(new WhatsAppNotConfiguredError(LIVE_MESSAGE)).level).toBe("warn");
  });

  it("recognises the failure by its message too, not only its prototype", () => {
    /* `instanceof` stops holding across a re-throw or a structured clone; the
       sentence survives. Both paths must reach the same status, or the status
       depends on how the error travelled rather than on what went wrong. */
    expect(classifySendFailure(new Error(LIVE_MESSAGE)).status).toBe(409);
    expect(classifySendFailure(LIVE_MESSAGE).status).toBe(409);
  });

  it("still calls a real upstream failure a 502 in the error log", () => {
    /* The point is classification, not downgrading everything. Meta being down IS
       a bad gateway, and IS worth an error line. */
    for (const e of [
      new Error("Meta API 500: internal error"),
      new Error("fetch failed"),
      new Error("media upload rejected"),
      new Error(""),
    ]) {
      const out = classifySendFailure(e);
      expect(out.status, e.message).toBe(502);
      expect(out.level, e.message).toBe("error");
    }
  });

  it("passes the message through untouched, because the UI shows it verbatim", () => {
    /* useSendWhatsApp() toasts `json.error` as-is, so this string is what the user
       reads — and it is the half that tells them where to go (§24). */
    expect(classifySendFailure(new WhatsAppNotConfiguredError(LIVE_MESSAGE)).message).toBe(LIVE_MESSAGE);
  });

  it("survives a non-Error throw without losing the status", () => {
    expect(classifySendFailure({ weird: true }).status).toBe(502);
    expect(classifySendFailure(undefined).status).toBe(502);
  });
});

describe("WhatsAppNotConfiguredError", () => {
  it("is an Error, so every existing catch still catches it", () => {
    const e = new WhatsAppNotConfiguredError(LIVE_MESSAGE);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("WhatsAppNotConfiguredError");
    expect(e.message).toBe(LIVE_MESSAGE);
  });
});

describe("R-897: customer messages switched off", () => {
  it("is a 409 warning, not a 502", () => {
    const e = Object.assign(new Error("Customer messages are switched off for this company. The owner can turn them on in Automation."), { name: "CustomerMessageRefusedError" });
    expect(classifySendFailure(e)).toMatchObject({ status: 409, level: "warn" });
  });
});
