/**
 * R-1128 — the company's state can no longer contradict its GSTIN.
 * GSTIN 07… (Delhi) + state 27 (Maharashtra) is refused on both screens; matching saves.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidGstin } from "@/lib/utils";
import { companyGstinStateConflict } from "./company-state";

const DELHI_GSTIN = "07ABDCA0298H1ZP";

describe("companyGstinStateConflict", () => {
  it("fixture is checksum-valid", () => {
    expect(isValidGstin(DELHI_GSTIN)).toBe(true);
  });

  it("Delhi GSTIN + Maharashtra (27) → refused, with the GSTIN's state and a §24 message", () => {
    const c = companyGstinStateConflict("27", DELHI_GSTIN);
    expect(c).not.toBeNull();
    expect(c!.gstinCode).toBe("07");
    expect(c!.gstinState).toBe("Delhi");
    expect(c!.message).toMatch(/starts with 07.*Delhi/);
    expect(c!.message).toMatch(/Maharashtra/);
    expect(c!.message).toMatch(/Set state from GSTIN/);
  });

  it("matching state saves (code, unpadded code or name)", () => {
    expect(companyGstinStateConflict("07", DELHI_GSTIN)).toBeNull();
    expect(companyGstinStateConflict("7", DELHI_GSTIN)).toBeNull();
    expect(companyGstinStateConflict("Delhi", DELHI_GSTIN)).toBeNull();
  });

  it("either side unknown, or a GSTIN that is not checksum-valid → no block (silence, not a guess)", () => {
    expect(companyGstinStateConflict("27", "")).toBeNull();
    expect(companyGstinStateConflict("", DELHI_GSTIN)).toBeNull();
    expect(companyGstinStateConflict("27", "07ABDCA0298H1Z")).toBeNull();   // 14 chars, half-typed
    expect(companyGstinStateConflict("27", "07ABDCA0298H1ZQ")).toBeNull();  // wrong checksum
  });
});

describe("both screens use it before saving", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  it("Settings → Company: the form schema refuses a conflict and offers 'Set state from GSTIN'", () => {
    const s = read("src/app/(app)/settings/page.tsx");
    expect(s).toMatch(/superRefine\(\(v, ctx\) => \{[\s\S]{0,200}companyGstinStateConflict\(v\.state_code, v\.gstin\)/);
    expect(s).toContain("Set state from GSTIN");
  });

  it("Setup wizard: Continue refuses a conflict and offers 'Set state from GSTIN'", () => {
    const s = read("src/app/(app)/setup/page.tsx");
    const save = s.slice(s.indexOf("const saveCompanyAndAdvance"), s.indexOf("updateTenant.mutateAsync"));
    expect(save).toContain("companyGstinStateConflict(data.state, data.gstin)");
    expect(s).toContain("Set state from GSTIN");
  });

  it("the shared save hook refuses a conflict for every caller", () => {
    const s = read("src/lib/queries/tenant.ts");
    const fn = s.slice(s.indexOf("mutationFn"), s.indexOf(".from(\"tenants\")"));
    expect(fn).toContain("companyGstinStateConflict(patch.state_code, patch.gstin)");
  });
});

/* ── Server: the platform admin's PATCH /api/platform/signups/[id] ─────────────────────────── */

let currentRow: { gstin: string | null; state: string | null; state_code: string | null } | null = null;
let readError: { message: string } | null = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/platform", () => ({ isPlatformAdmin: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: "admin@anutech.in" } } }) } }),
  createAdminClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: currentRow, error: readError }),
        update: (u: Record<string, unknown>) => { updates.push(u); return chain; },
        single: async () => ({ data: { id: "t1" }, error: null }),
      };
      return chain;
    },
  }),
}));

describe("PATCH /api/platform/signups/[id] (server, fail closed)", () => {
  beforeEach(() => { currentRow = null; readError = null; updates.length = 0; });

  const patch = async (body: Record<string, unknown>) => {
    const { PATCH } = await import("@/app/api/platform/signups/[id]/route");
    return PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "t1" }) });
  };

  it("Delhi GSTIN onto a Maharashtra workspace → 400, nothing written", async () => {
    currentRow = { gstin: null, state: "Maharashtra", state_code: "27" };
    const res = await patch({ gstin: DELHI_GSTIN });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Set state from GSTIN/);
    expect(updates).toHaveLength(0);
  });

  it("matching GSTIN + state saves, and state_code follows the name", async () => {
    currentRow = { gstin: null, state: null, state_code: null };
    const res = await patch({ gstin: DELHI_GSTIN, state: "Delhi" });
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ gstin: DELHI_GSTIN, state: "Delhi", state_code: "07" });
  });

  it("row unreadable → refuses (fail closed)", async () => {
    readError = { message: "down" };
    const res = await patch({ gstin: DELHI_GSTIN });
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
  });
});
