/**
 * R-1137 — customer-facing pages (sign-in, password reset, sign-up, quote accept, buy)
 * toasted raw error text, and three attendance API routes returned the raw database /
 * storage message as `error`. §24: what happened, why, what to do next.
 */
import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import { readFileSync } from "fs";
import { describeAuthError } from "./auth-error";
import { apiFailure } from "./api-error";
const { countRaw } = require("../../../scripts/count-raw-toast-errors.cjs");

const SRC = join(process.cwd(), "src");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("R-1137 — no bare error toasts on public and sign-in pages", () => {
  const { rawByFile } = countRaw(SRC) as { rawByFile: Map<string, number> };
  const files = [...rawByFile.keys()].filter((f) => /[\\/]app[\\/]\((public|auth)\)[\\/]/.test(f));
  it("0 bare toast.error under app/(public) and app/(auth)", () => {
    expect(files.map((f) => `${f}: ${rawByFile.get(f)}`)).toEqual([]);
  });

  it.each([
    "src/app/(public)/quote/[id]/accept/quote-accept-view.tsx",
    "src/app/(auth)/login/page.tsx",
    "src/app/(auth)/forgot-password/page.tsx",
  ])("%s pastes no raw .message into a toast", (file) => {
    const code = strip(readFileSync(join(process.cwd(), file), "utf8"));
    // Denominator: the file still shows an error toast.
    expect(code).toMatch(/toast\.error\(|toastError\(/);
    // The thrown / returned error's own text (e, err, error) — not a mapped copy object.
    expect(code).not.toMatch(/toast\.error\(\s*\(?\s*(e|err|error)(\s+as\s+Error)?\s*\)?\.message/);
  });
});

describe("R-1137 — attendance routes never return raw DB / storage text", () => {
  it.each([
    "src/app/api/attendance/consent/route.ts",
    "src/app/api/attendance/device/approve/route.ts",
    "src/app/api/attendance/face/enroll/route.ts",
  ])("%s", (file) => {
    const code = strip(readFileSync(join(process.cwd(), file), "utf8"));
    expect(code).toMatch(/NextResponse\.json\(/);
    expect(code).not.toMatch(/error:\s*[\w.]*error\.message/);
  });
});

describe("describeAuthError", () => {
  it("wrong password says so and offers a reset", () => {
    const d = describeAuthError({ message: "Invalid login credentials" }, "sign-in");
    expect(d.message).toBe("Email or password is wrong.");
    expect(d.description).toMatch(/Forgot password/);
    expect(d.next).toBe("forgot-password");
  });
  it("rate limit says wait", () => {
    const d = describeAuthError({ message: "For security purposes, you can only request this after 47 seconds." }, "reset");
    expect(d.message).toMatch(/Too many/);
    expect(d.description).toMatch(/minute/);
  });
  it("unknown auth text is never shown raw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = describeAuthError({ message: 'relation "auth.flow_state" does not exist' }, "reset");
    expect(d.message).not.toMatch(/relation|flow_state/);
    expect(d.description).toMatch(/try again/i);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("apiFailure", () => {
  it("returns a stable code + sentence and logs the raw detail", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = apiFailure("FACE_SAVE_FAILED", "Could not save the face photo.", { message: "duplicate key value" }, "face/enroll");
    expect(body).toEqual({ error: "Could not save the face photo.", code: "FACE_SAVE_FAILED" });
    expect(spy.mock.calls[0].join(" ")).toMatch(/face\/enroll.*duplicate key/);
    spy.mockRestore();
  });
});
