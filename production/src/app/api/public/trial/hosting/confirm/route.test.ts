/**
 * The trial confirm link (25 Sep 2026: the trial account is created by the DMS engine,
 * not by this app writing to DirectAdmin). Pinned: the engine command and its trial
 * payload; the gate; each engine answer lands on the right page. No owner email in any branch
 * (owner, 30 Sep 2026); a setup that failed becomes a task on the lead instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const token = vi.hoisted(() => ({ verifyTrialToken: vi.fn() }));
vi.mock("@/lib/hosting/trial-token", () => token);
const engine = vi.hoisted(() => ({ sendEngineCommand: vi.fn(), commandsConfigured: vi.fn() }));
vi.mock("@/lib/dms-engine/commands", () => engine);
vi.mock("@/lib/dms-engine/client", () => ({ dmsPanelUrl: () => "https://panel.example.invalid" }));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), loadOwnerAlert: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: mail.loadOwnerAlert }));

const db = vi.hoisted(() => ({ lead: null as unknown, updates: [] as Record<string, unknown>[], inserts: [] as { table: string; row: Record<string, unknown> }[] }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.lead, error: null }) }) }) }),
      update: (row: Record<string, unknown>) => { db.updates.push(row); return { eq: async () => ({ error: null }) }; },
      insert: async (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return { error: null }; },
    }),
  }),
}));

import { GET } from "./route";

const req = () => new NextRequest("https://site.example.invalid/api/public/trial/hosting/confirm?token=t");
const lead = {
  id: "L-T1", company: "Trial Co", contact_name: "Asha Verma", contact_email: "asha@example.invalid", contact_phone: "+91 98765 43210",
  plan: "hosting-starter", domain: "trialco.in", source: "buy-hosting-trial", trial_converted_at: null,
  notes: "HOSTING TRIAL REQUEST\nAfter the trial: Starter billed monthly",
};
const ENV = { ...process.env };
beforeEach(() => {
  for (const f of [token.verifyTrialToken, engine.sendEngineCommand, engine.commandsConfigured, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  db.lead = { ...lead }; db.updates = []; db.inserts = [];
  process.env.HOSTING_TRIAL_LIVE = "1";
  token.verifyTrialToken.mockReturnValue({ ok: true, leadId: "L-T1" });
  engine.commandsConfigured.mockReturnValue(true);
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid", ownerName: "Owner" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
});
afterEach(() => { process.env = { ...ENV }; });

const landed = (res: Response) => new URL(res.headers.get("location") ?? "").searchParams.get("confirmed");

describe("the trial account is created by the DMS engine", () => {
  it("sends hosting.provision as a Starter TRIAL, with the cycle the customer chose and its own trial ref", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "trialc1" }, replayed: false });
    const res = await GET(req());
    expect(landed(res)).toBe("provisioned");
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ commandId: "rsos-hosttrial-L-T1", command: "hosting.provision", subject: "trialco.in", mode: "live" });
    expect(cmd.payload).toMatchObject({ planId: "starter", trial: true, paymentMode: "trial", cycle: "monthly", trialRef: "L-T1", sourceRef: "L-T1" });
    expect(cmd.payload.customer).toMatchObject({ firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210" });
  });

  it("sends the customer nothing itself: DMS sends the one 'trial is live' email when it creates the account (3 Oct 2026)", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "trialc1" }, replayed: false });
    const res = await GET(req());
    expect(landed(res)).toBe("provisioned");
    expect(mail.sendEmail.mock.calls.map((c) => c[0].to)).not.toContain("asha@example.invalid");
  });

  it("a second click replays: no second customer email", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "trialc1" }, replayed: true });
    const res = await GET(req());
    expect(landed(res)).toBe("already");
    expect(mail.sendEmail.mock.calls.map((c) => c[0].to)).not.toContain("asha@example.invalid");
  });
});

describe("nothing is created while the switch is off, and a failure is never hidden", () => {
  it("HOSTING_TRIAL_LIVE not 1 → no command, the owner is told to provision by hand", async () => {
    process.env.HOSTING_TRIAL_LIVE = "";
    const res = await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(landed(res)).toBe("pending");
  });
  it("no engine key → no command", async () => {
    engine.commandsConfigured.mockReturnValue(false);
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("the engine refuses (e.g. an earlier trial) → pending page, the reason on the lead, the owner alerted", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "already had a free trial" });
    const res = await GET(req());
    expect(landed(res)).toBe("pending");
    expect(String(db.updates.at(-1)?.notes)).toContain("NOT created automatically (refused: already had a free trial)");
    // No owner email (30 Sep 2026): the failure becomes a task on the lead.
    expect(mail.sendEmail.mock.calls.map((c) => c[0].to)).not.toContain("owner@example.invalid");
    const task = db.inserts.find((i) => i.table === "tasks")?.row;
    expect(task).toMatchObject({ lead_id: "L-T1", kind: "followup" });
    expect(String(task?.title)).toMatch(/NOT created automatically: Trial Co/);
  });
  it("a lost answer → the error page, and the owner is told to check DMS before creating by hand", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "socket closed" });
    const res = await GET(req());
    expect(landed(res)).toBe("error");
    expect(mail.sendEmail.mock.calls.map((c) => c[0].to)).not.toContain("owner@example.invalid");
    expect(String(db.inserts.find((i) => i.table === "tasks")?.row.notes)).toMatch(/Check DMS for a partly created account/);
  });
});
