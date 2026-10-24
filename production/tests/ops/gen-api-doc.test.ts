import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { urlPathOf, groupOf, methodsOf, authHint, collectRoutes, renderApiDoc, main, DOC_FILE } from "../../scripts/ops/gen-api-doc.mjs";

/* R-1665 (19 Oct 2026): docs/API.md is generated from src/app/**\/route.ts. This test keeps it
   fresh — a new, removed or changed route fails here until `node scripts/ops/gen-api-doc.mjs`
   is re-run — and pins the path/method/auth-hint rules on small fixtures. */

describe("docs/API.md is fresh", () => {
  it("matches what gen-api-doc.mjs generates now (run `node scripts/ops/gen-api-doc.mjs` from production/)", () => {
    const onDisk = fs.readFileSync(DOC_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk === renderApiDoc(collectRoutes()), "docs/API.md is stale — cd production && node scripts/ops/gen-api-doc.mjs").toBe(true);
  });

  it("--check exits 0 on the committed doc", () => {
    expect(main(["--check"], { log: () => {} })).toBe(0);
  });
});

describe("gen-api-doc rules", () => {
  it("turns file paths into URL paths", () => {
    expect(urlPathOf("api/cron/renewals/route.ts")).toBe("/api/cron/renewals");
    expect(urlPathOf("api/v1/customers/[id]/route.ts")).toBe("/api/v1/customers/:id");
    expect(urlPathOf("api/sb/rest/v1/[...path]/route.ts")).toBe("/api/sb/rest/v1/:path*");
    expect(urlPathOf("(auth)/callback/route.ts")).toBe("/callback");
    expect(urlPathOf("x/[[...slug]]/route.js")).toBe("/x/:slug*?");
  });

  it("groups by top-level folder", () => {
    expect(groupOf("/api/cron/renewals")).toBe("api/cron");
    expect(groupOf("/auth/sign-out")).toBe("auth");
  });

  it("reads every export form of a method, and ignores commented-out ones", () => {
    expect(methodsOf("export async function GET() {}\nexport const POST = withRoute({}, h);")).toEqual(["GET", "POST"]);
    expect(methodsOf('export { handle as GET, handle as DELETE }')).toEqual(["GET", "DELETE"]);
    expect(methodsOf('export { POST } from "./webhook.server";')).toEqual(["POST"]);
    expect(methodsOf("// export async function PUT() {}\nexport function PATCH() {}")).toEqual(["PATCH"]);
  });

  it("gives a conservative who-may-call hint", () => {
    expect(authHint("export const GET = gatedCron('x', h)", "/api/cron/x")).toBe("cron secret");
    expect(authHint("const a = await authenticateApiKey(req)", "/api/v1/customers")).toBe("API key");
    expect(authHint("export const POST = withRoute({ route: 'r', roles: OM }, h)", "/api/x")).toBe("session + role");
    expect(authHint("export const GET = withRoute({ route: 'r' }, h)", "/api/x")).toBe("session");
    expect(authHint("export async function POST() {}", "/api/public/form")).toBe("public");
    expect(authHint("export async function GET() {}", "/api/x")).toBe("?");
    // A guard that is only mentioned in a comment does not count.
    expect(authHint("// checks CRON_SECRET\nexport async function GET() {}", "/api/x")).toBe("?");
  });

  it("is deterministic and flags a new route as stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-doc-"));
    try {
      const app = path.join(dir, "app");
      fs.mkdirSync(path.join(app, "api", "a"), { recursive: true });
      fs.writeFileSync(path.join(app, "api", "a", "route.ts"), "export async function GET() {}");
      const doc = path.join(dir, "API.md");
      const quiet = { appDir: app, docFile: doc, log: () => {} };
      expect(main([], quiet)).toBe(0);
      const first = fs.readFileSync(doc, "utf8");
      expect(first).toContain("**1 route files**");
      expect(first).not.toMatch(/20\d\d-\d\d-\d\d/);
      expect(main(["--check"], quiet)).toBe(0);
      fs.mkdirSync(path.join(app, "api", "b"), { recursive: true });
      fs.writeFileSync(path.join(app, "api", "b", "route.ts"), "export async function POST() {}");
      expect(main(["--check"], quiet)).toBe(1);
      expect(fs.readFileSync(doc, "utf8")).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
