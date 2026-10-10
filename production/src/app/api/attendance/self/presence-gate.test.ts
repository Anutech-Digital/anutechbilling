import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { presenceGateReply, WRONG_CODE_MESSAGE } from "./presence-gate";

describe("R-440 presenceGateReply", () => {
  it("lets a correct code through", () => {
    expect(presenceGateReply({ data: true, error: null })).toBeNull();
  });

  it("refuses a wrong code with the same message as before", () => {
    expect(presenceGateReply({ data: false, error: null })).toEqual({
      status: 400,
      body: { error: WRONG_CODE_MESSAGE, code: "PRESENCE_CODE_WRONG" },
    });
  });

  it("fails closed when the database gives no answer", () => {
    expect(presenceGateReply({ data: null, error: null })?.status).toBe(400);
    expect(presenceGateReply({ data: null, error: { message: "boom", code: "XX000" } })?.status).toBe(400);
  });

  it("refuses a login with no company (28000) with 403", () => {
    expect(presenceGateReply({ data: null, error: { message: "No company", code: "28000" } })?.status).toBe(403);
  });

  it("tells a locked-out user to wait, with the time from the database hint", () => {
    const r = presenceGateReply({
      data: null,
      error: { message: "PRESENCE_CODE_LOCKED", code: "P0001", hint: "Try again after 16:05 IST." },
    });
    expect(r).toEqual({ status: 429, body: { error: "Try again after 16:05 IST.", code: "PRESENCE_CODE_LOCKED" } });
  });
});

describe("R-440 /api/attendance/self never reads the office-code seed", () => {
  const src = readFileSync("src/app/api/attendance/self/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("does not select presence_secret through any client", () => {
    expect(src).not.toMatch(/presence_secret/);
  });

  it("checks the code through validate_presence_code with the caller's own login", () => {
    expect(src).toMatch(/supabase\.rpc\("validate_presence_code"/);
    expect(src).not.toMatch(/validateCode\(/);
  });
});
