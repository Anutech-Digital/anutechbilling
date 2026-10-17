/**
 * R-731: the one place set_config is written must tell the database the session's aal, so
 * public.session_mfa_ok() can refuse tenant data to a half-signed-in MFA user. Unknown → "".
 */
import { describe, expect, test } from "vitest";
import { setContext } from "./context";

const USER = "8b14edad-578d-4fca-8f9a-747c6276177a";

function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " "), values });
      return Promise.resolve(1);
    },
  };
  return { tx: tx as never, calls };
}

describe("setContext (R-731 app.aal)", () => {
  test("aal2 session → app.aal = aal2 in the same transaction-local set_config", async () => {
    const { tx, calls } = fakeTx();
    await setContext(tx, USER, "", "aal2");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("set_config('app.user_id', ?, true)");
    expect(calls[0].sql).toContain("set_config('app.aal', ?, true)");
    expect(calls[0].values).toEqual([USER, "", "aal2"]);
  });

  test("aal1 session → aal1", async () => {
    const { tx, calls } = fakeTx();
    await setContext(tx, USER, "t", "aal1");
    expect(calls[0].values).toEqual([USER, "t", "aal1"]);
  });

  test("no level (jobs, service, old callers) → empty, which the database treats as aal1", async () => {
    const { tx, calls } = fakeTx();
    await setContext(tx, null, "t");
    expect(calls[0].values).toEqual(["", "t", ""]);
  });
});
