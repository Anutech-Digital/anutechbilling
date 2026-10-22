import { describe, it, expect, vi } from "vitest";
import { runPerTenantBackup, isMissingFunction, type PerTenantDeps, type TenantRow } from "./per-tenant";
import type { OffsiteSnapshot } from "./offsite";

/* ─────────────────────────────────────────────────────────────────────────────
   S15 (28 Sep 2026). Raat ka backup ab ek-ek tenant karke. Ye tests wo cheezein pakadte hain
   jo purane "sab ek saath" raaste me chhupi thi: ek tenant ka fail hona baaki sabki off-site
   copy rok deta tha, aur sab tenants ek hi object me RAM me banate the.
   ───────────────────────────────────────────────────────────────────────────── */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const TENANTS: TenantRow[] = [
  { id: A, name: "ANUTECH" },
  { id: B, name: "Beta" },
  { id: C, name: "Gamma" },
];

const snap = (id: string, payload: unknown = { leads: [] }): OffsiteSnapshot => ({
  tenant_id: id, tenant_name: id, snapshot_id: `s-${id}`, created_at: "2026-08-29T00:00:00Z", payload,
});

function deps(over: Partial<PerTenantDeps> = {}) {
  const uploads = new Map<string, string>();
  const d: PerTenantDeps = {
    now: new Date("2026-08-28T18:30:00Z"), // 29 Aug 00:00 IST
    projectRef: "api",
    listTenants: async () => ({ ok: true, data: TENANTS }),
    backupTenant: async (id) => ({ ok: true, data: { id: `s-${id}`, bytes: 100, table_count: 144, label: "Automated Daily Backup - 2026-08-29" } }),
    exportTenant: async (id) => ({ ok: true, data: snap(id) }),
    upload: async (name, body) => { uploads.set(name, body); return null; },
    sleep: async () => {},
    ...over,
  };
  return { d, uploads };
}

describe("runPerTenantBackup — ek tenant, ek object", () => {
  it("har tenant ka alag object, us din ke folder me, aur ek manifest", async () => {
    const { d, uploads } = deps();
    const r = await runPerTenantBackup(d);
    expect(r.backed_up).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.offsite_ok).toBe(3);
    expect(r.total_bytes).toBe(300);
    expect([...uploads.keys()].sort()).toEqual([
      "daily/2026-08-29/_manifest.json",
      `daily/2026-08-29/${A}.json`,
      `daily/2026-08-29/${B}.json`,
      `daily/2026-08-29/${C}.json`,
    ]);
  });

  it("har object me SIRF us tenant ka snapshot — purane envelope ki shakl me (restore script chale)", async () => {
    const { d, uploads } = deps();
    await runPerTenantBackup(d);
    const env = JSON.parse(uploads.get(`daily/2026-08-29/${B}.json`)!);
    expect(env.kind).toBe("resellersos-offsite-backup");
    expect(env.ist_date).toBe("2026-08-29");
    expect(env.tenant_count).toBe(1);
    expect(env.snapshots.map((s: OffsiteSnapshot) => s.tenant_id)).toEqual([B]);
  });

  it("EK tenant fail → baaki sabka backup AUR off-site dono hota hai — ASLI JAAL", async () => {
    /* Purana route: failed > 0 par seedha 500, off-site upload kisi ka nahi. */
    const { d, uploads } = deps({
      backupTenant: async (id) =>
        id === B ? { ok: false, message: "invalid input syntax for type json" }
                 : { ok: true, data: { bytes: 10, table_count: 144 } },
      /* Ek-ek karke, taaki C sach me B ke fail hone KE BAAD chale — saath chalte to "fail ke
         baad ruk jao" wali galti yahan dikhti hi nahi (mutation se naapa). */
      concurrency: 1,
    });
    const r = await runPerTenantBackup(d);
    expect(r.backed_up).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.results.find((x) => x.tenant_id === B)).toMatchObject({ ok: false, offsite: "skipped" });
    expect(uploads.has(`daily/2026-08-29/${A}.json`)).toBe(true);
    expect(uploads.has(`daily/2026-08-29/${C}.json`)).toBe(true);
    expect(uploads.has(`daily/2026-08-29/${B}.json`)).toBe(false);
    const manifest = JSON.parse(uploads.get("daily/2026-08-29/_manifest.json")!);
    expect(manifest.tenant_count).toBe(3);
    expect(manifest.missing.map((m: { tenant_id: string }) => m.tenant_id)).toEqual([B]);
  });

  it("ek tenant ka throw bhi baaki ko nahi girata", async () => {
    const { d } = deps({
      exportTenant: async (id) => { if (id === C) throw new Error("boom"); return { ok: true, data: snap(id) }; },
    });
    const r = await runPerTenantBackup(d);
    expect(r.results.find((x) => x.tenant_id === C)).toMatchObject({ ok: false, error: "boom" });
    expect(r.results.filter((x) => x.ok)).toHaveLength(2);
  });

  it("khaali payload upload nahi hota — off-site error ban kar digest me jaata hai", async () => {
    const { d, uploads } = deps({ exportTenant: async (id) => ({ ok: true, data: id === A ? snap(id, null) : snap(id) }) });
    const r = await runPerTenantBackup(d);
    expect(uploads.has(`daily/2026-08-29/${A}.json`)).toBe(false);
    expect(r.backed_up).toBe(3); // DB snapshot to hua
    expect(r.offsite_errors.join(" ")).toContain("payload");
  });

  it("snapshot mila hi nahi (null) → upload nahi, wajah ke saath", async () => {
    const { d, uploads } = deps({ exportTenant: async (id) => ({ ok: true, data: id === A ? null : snap(id) }) });
    const r = await runPerTenantBackup(d);
    expect(uploads.has(`daily/2026-08-29/${A}.json`)).toBe(false);
    expect(r.offsite_errors.some((e) => e.startsWith("ANUTECH:"))).toBe(true);
  });

  it("1 tareekh (IST) ko har tenant ki monthly copy bhi", async () => {
    const { d, uploads } = deps({ now: new Date("2026-09-30T18:30:00Z") });
    await runPerTenantBackup(d);
    expect(uploads.has(`monthly/2026-10/${A}.json`)).toBe(true);
    expect(uploads.has(`daily/2026-10-01/${A}.json`)).toBe(true);
    expect([...uploads.keys()].filter((k) => k.startsWith("monthly/"))).toHaveLength(3);
  });

  it("upload fail (403) → DB backup safal, off-site errors me har tenant", async () => {
    const { d } = deps({ upload: async () => "upload 403: forbidden" });
    const r = await runPerTenantBackup(d);
    expect(r.failed).toBe(0);
    expect(r.offsite_ok).toBe(0);
    expect(r.offsite_errors).toHaveLength(4); // 3 tenant + manifest
  });

  it("clock-skew jaisi galti par us tenant ko dobara koshish", async () => {
    let n = 0;
    const { d } = deps({
      backupTenant: async () => (++n === 1 ? { ok: false, message: "JWT issued at future" } : { ok: true, data: { bytes: 1 } }),
    });
    const r = await runPerTenantBackup(d);
    expect(r.failed).toBe(0);
    expect(r.results[0].retried).toEqual(["JWT issued at future"]);
  });

  it("ek saath zyada se zyada `concurrency` tenant (RAM me utne hi payload)", async () => {
    let live = 0, peak = 0;
    const many: TenantRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, name: `T${i}`,
    }));
    const { d } = deps({
      listTenants: async () => ({ ok: true, data: many }),
      exportTenant: async (id) => {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return { ok: true, data: snap(id) };
      },
      concurrency: 3,
    });
    const r = await runPerTenantBackup(d);
    expect(r.backed_up).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("migration abhi nahi lagi — purane raaste par", () => {
  it("pehle tenant par 'function nahi mila' → missingFunction, aur kuch upload nahi", async () => {
    const backupTenant = vi.fn(async () => ({
      ok: false as const,
      message: "Could not find the function public.backup_tenant(p_label, p_tenant) in the schema cache",
    }));
    const { d, uploads } = deps({ backupTenant });
    const r = await runPerTenantBackup(d);
    expect(r.missingFunction).toBe(true);
    expect(backupTenant).toHaveBeenCalledTimes(1); // baaki 2 par wahi galti nahi dohrayi
    expect(uploads.size).toBe(0);
  });

  it("isMissingFunction: PostgREST aur Postgres dono shakl, par tenant ki galti nahi", () => {
    expect(isMissingFunction("PGRST202")).toBe(true);
    expect(isMissingFunction("function public.backup_tenant(uuid, unknown) does not exist")).toBe(true);
    expect(isMissingFunction("backup_tenant: tenant x nahi mila")).toBe(false);
    expect(isMissingFunction("relation \"public.foo\" does not exist")).toBe(false);
  });

  it("tenants hi padh na paye → throw (route 500 deta hai, chup nahi)", async () => {
    const { d } = deps({ listTenants: async () => ({ ok: false, message: "permission denied" }) });
    await expect(runPerTenantBackup(d)).rejects.toThrow(/could not read tenants/);
  });
});
