/** R-1496: a 42501 caused by a pending second sign-in step says so — not "another workspace". */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/gateway", () => ({ withIdentity: vi.fn() }));

import { explainMfaPending } from "./mfa-pending";
import { PgrstError } from "./parse";
import { MFA_PENDING_DATA_REFUSAL } from "@/lib/auth/mfa-gate";
import { describeError } from "@/lib/errors/toast-error";

const denied = () => new PgrstError(403, "42501", 'new row violates row-level security policy for table "employees"');
const user = (aal?: "aal1" | "aal2") => ({ mode: "user" as const, userId: "11111111-1111-1111-1111-111111111111", aal });

describe("explainMfaPending", () => {
  it("verified factor + aal1 session → clear second-step message, still 403/42501", async () => {
    const e = await explainMfaPending(denied(), user("aal1"), async () => false);
    expect(e.status).toBe(403);
    expect(e.code).toBe("42501");
    expect(e.message).toBe(MFA_PENDING_DATA_REFUSAL);
    const d = describeError({ message: e.message });
    expect(d.message).toMatch(/Doosra sign-in step baaki/);
    expect(`${d.message} ${d.description ?? ""}`).not.toMatch(/another workspace/);
  });

  it("aal2 session → untouched (never even asks the database)", async () => {
    const check = vi.fn(async () => false);
    const e = await explainMfaPending(denied(), user("aal2"), check);
    expect(e.message).toMatch(/row-level security/);
    expect(check).not.toHaveBeenCalled();
  });

  it("no MFA pending (role / other workspace) → the original refusal stays", async () => {
    const e = await explainMfaPending(denied(), user("aal1"), async () => true);
    expect(describeError({ message: e.message }).description).toMatch(/another workspace/);
  });

  it("cannot tell (function missing) → original refusal, never a guess", async () => {
    expect((await explainMfaPending(denied(), user(), async () => null)).message).toMatch(/row-level security/);
  });

  it("other errors and non-users are left alone", async () => {
    const dup = new PgrstError(409, "23505", "duplicate key value");
    expect(await explainMfaPending(dup, user("aal1"), async () => false)).toBe(dup);
    const d = denied();
    expect(await explainMfaPending(d, { mode: "anon" }, async () => false)).toBe(d);
  });
});
