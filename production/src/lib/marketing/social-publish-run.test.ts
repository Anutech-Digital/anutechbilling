import { describe, expect, it, vi } from "vitest";
import { runScheduledPublish, type DueRow, type PublishPorts } from "./social-publish-run";

const NOW = new Date("2026-11-06T04:00:00Z");
const row = (over: Partial<DueRow> = {}): DueRow => ({
  id: "p1", tenant_id: "t1", platform: "facebook", format: "post", caption: "Hello", media_url: null,
  status: "approved", scheduled_at: "2026-11-06T03:30:00Z", ...over,
});

function ports(rows: DueRow[], over: Partial<PublishPorts> = {}) {
  const taken = new Set<string>();
  const p = {
    listDue: vi.fn(async () => rows),
    claim: vi.fn(async (id: string) => { if (taken.has(id)) return false; taken.add(id); return true; }),
    connection: vi.fn(async () => ({ pageId: "page", pageToken: "token" })),
    publish: vi.fn(async (r: DueRow) => `ext-${r.id}`),
    complete: vi.fn(async () => {}),
    ...over,
  };
  return p;
}

describe("R-2510 scheduled social publish", () => {
  it("publishes an approved post whose time has come and marks it published", async () => {
    const p = ports([row()]);
    expect(await runScheduledPublish(p, NOW)).toEqual({ due: 1, published: 1, failed: 0, skipped: 0 });
    expect(p.publish).toHaveBeenCalledOnce();
    expect(p.complete).toHaveBeenCalledWith("p1", "ext-p1", null);
  });

  it("never publishes a draft, a post in review, or one whose time has not come", async () => {
    const p = ports([
      row({ id: "d", status: "draft" }), row({ id: "r", status: "review" }),
      row({ id: "later", scheduled_at: "2026-11-06T05:00:00Z" }), row({ id: "none", scheduled_at: null }),
    ]);
    expect((await runScheduledPublish(p, NOW)).published).toBe(0);
    expect(p.claim).not.toHaveBeenCalled();
    expect(p.publish).not.toHaveBeenCalled();
  });

  it("a row another run already claimed is skipped — a post goes out at most once", async () => {
    const p = ports([row()], { claim: vi.fn(async () => false) });
    expect(await runScheduledPublish(p, NOW)).toMatchObject({ published: 0, skipped: 1 });
    expect(p.publish).not.toHaveBeenCalled();
  });

  it("a Meta failure marks the post failed with the reason, and the next post still goes", async () => {
    const p = ports([row({ id: "a" }), row({ id: "b" })], {
      publish: vi.fn(async (r: DueRow) => { if (r.id === "a") throw new Error("(#200) Permissions error"); return "ext-b"; }),
    });
    expect(await runScheduledPublish(p, NOW)).toMatchObject({ published: 1, failed: 1 });
    expect(p.complete).toHaveBeenCalledWith("a", null, "(#200) Permissions error");
    expect(p.complete).toHaveBeenCalledWith("b", "ext-b", null);
  });

  it("reads each company's Page connection once per run", async () => {
    const p = ports([row({ id: "a" }), row({ id: "b" }), row({ id: "c", tenant_id: "t2" })]);
    await runScheduledPublish(p, NOW);
    expect(p.connection).toHaveBeenCalledTimes(2);
  });

  it("a company outside the cron's allowed list is left alone", async () => {
    const p = ports([row()], { tenantAllowed: () => false });
    expect(await runScheduledPublish(p, NOW)).toMatchObject({ published: 0, skipped: 1 });
    expect(p.claim).not.toHaveBeenCalled();
  });
});
