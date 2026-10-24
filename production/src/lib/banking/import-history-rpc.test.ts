/* R-1623 — the two hooks send what the database functions take. remove_bank_import has no
   defaults, so a null batch id / range must travel as null (an omitted key finds no function). */
import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (o: unknown) => o,
  useQuery: (o: unknown) => o,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { useBankImportHistory, useRemoveBankImport } from "@/lib/queries/bank";

describe("R-1623 hooks", () => {
  it("remove sends every argument, nulls included", async () => {
    rpc.mockResolvedValueOnce({ data: { removed: 4 }, error: null });
    const m = useRemoveBankImport() as unknown as { mutationFn: (a: unknown) => Promise<{ removed: number }> };
    const out = await m.mutationFn({ p_account_id: "acc1", p_batch_id: "b1", p_legacy_from: null, p_legacy_to: null, p_reason: "galat" });
    expect(out).toEqual({ removed: 4 });
    expect(rpc).toHaveBeenCalledWith("remove_bank_import", {
      p_account_id: "acc1", p_batch_id: "b1", p_legacy_from: null, p_legacy_to: null, p_reason: "galat",
    });
  });

  it("a refusal is thrown, not turned into 0 removed", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "2 of this import's 4 lines are reconciled — un-reconcile them first." } });
    const m = useRemoveBankImport() as unknown as { mutationFn: (a: unknown) => Promise<unknown> };
    await expect(m.mutationFn({ p_account_id: "acc1", p_batch_id: "b1", p_legacy_from: null, p_legacy_to: null, p_reason: "galat" }))
      .rejects.toMatchObject({ message: expect.stringContaining("un-reconcile them first") });
  });

  it("history comes back newest first", async () => {
    rpc.mockResolvedValueOnce({ data: [
      { kind: "legacy", imported_at: "2026-10-17T11:29:00+00:00", legacy_from: "a", removed_at: null },
      { kind: "batch", imported_at: "2026-10-19T11:29:00+00:00", batch_id: "b", removed_at: null },
    ], error: null });
    const q = useBankImportHistory("acc1") as unknown as { queryFn: () => Promise<{ kind: string }[]> };
    expect((await q.queryFn()).map((r) => r.kind)).toEqual(["batch", "legacy"]);
    expect(rpc).toHaveBeenLastCalledWith("bank_import_history", { p_account_id: "acc1" });
  });
});
