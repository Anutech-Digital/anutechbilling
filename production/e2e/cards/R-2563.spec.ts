/**
 * Card test — R-2563 "Website /trial: 'Change the request' ke baad pehli trial lead aur draft quote
 * server par band nahi hote — ek customer ki do leads" (R-2550 card tests).
 *
 * The owner's path with REAL clicks on the public /trial page and the REAL local /api/enquiry (no
 * stub — the point is what the server does): Business Starter → Request → "← Change the request" →
 * Business Standard → Request. Then the local DB must hold ONE open lead for that customer (the
 * Standard one); the Starter lead is closed ("Replaced by …") and its never-sent draft quote is
 * expired and points at the new quote. Two safety steps: a forged reference sent with ANOTHER
 * contact changes nothing, and a quote that was already sent is never touched.
 *
 * Local only: the DB is read through the local Supabase Postgres (127.0.0.1:54322, refused for any
 * other host) and every row this test made (leads, quotes, activities, consent, notifications) is
 * deleted in afterAll. Emails: dev:local blanks the mail keys, so nothing is sent.
 * Run: `node scripts/ops/card-tests.mjs R-2563` (BASE_URL = a server running this code).
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { onlyInCardTests } from "./card-steps";

const DB_URL = process.env.LOCAL_DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
function localDb(): pg.Client {
  const host = new URL(DB_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`R-2563 card test refuses a non-local DB (${host})`);
  return new pg.Client({ connectionString: DB_URL });
}

const RUN = Date.now().toString(36);
const EMAIL = `r2563-${RUN}@example.test`;
const PHONE = `98${String(Date.now()).slice(-8)}`;
const OTHER_EMAIL = `r2563-other-${RUN}@example.test`;

type Lead = { id: string; is_junk: boolean; junk_note: string | null; plan: string | null };
type Quote = { id: string; lead_id: string; status: string; superseded_by: string | null };

test.describe("R-2563 trial 'Change the request' closes the earlier lead on the server", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let db: pg.Client;
  const refs: string[] = [];
  const tokens: string[] = [];
  const bodies: Record<string, unknown>[] = [];

  const leads = async (email = EMAIL) =>
    (await db.query<Lead>("select id, is_junk, junk_note, plan from leads where lower(contact_email) = $1 order by created_at", [email])).rows;
  const quotesOf = async (leadIds: string[]) =>
    (await db.query<Quote>("select id, lead_id, status::text as status, superseded_by from quotes where lead_id = any($1) order by created_at", [leadIds])).rows;

  async function requestTrial(): Promise<string> {
    const resP = page.waitForResponse((r) => r.url().endsWith("/api/enquiry") && r.request().method() === "POST", { timeout: 90_000 });
    await page.getByRole("button", { name: /Request the free trial/ }).first().click();
    const res = await resP;
    bodies.push(JSON.parse(res.request().postData() ?? "{}"));
    const json = (await res.json()) as { ok?: boolean; reference?: string | null; error?: string; replaceToken?: string | null };
    expect(json.ok, json.error).toBe(true);
    expect(json.reference).toBeTruthy();
    expect(json.replaceToken, "every trial request gets a signed replace token back").toMatch(/^L-[A-Z0-9]+\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    tokens.push(json.replaceToken as string);
    await expect(page.getByRole("link", { name: "Send on WhatsApp" })).toBeVisible({ timeout: 30_000 });
    return json.reference as string;
  }

  test.beforeAll(async ({ browser, baseURL }) => {
    db = localDb();
    await db.connect();
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await context.route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ status: 204, body: "" }));
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!db) return;
    const ids = (await db.query<{ id: string }>("select id from leads where lower(contact_email) in ($1, $2)", [EMAIL, OTHER_EMAIL])).rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.query("delete from lead_activities where lead_id = any($1)", [ids]);
      await db.query("delete from consent_events where lead_id = any($1)", [ids]);
      await db.query("delete from notifications where entity_id = any($1)", [ids]).catch(() => undefined);
      await db.query("update quotes set superseded_by = null where lead_id = any($1)", [ids]);
      await db.query("delete from quote_send_log where quote_id in (select id from quotes where lead_id = any($1))", [ids]);
      await db.query("delete from quotes where lead_id = any($1)", [ids]);
      await db.query("delete from leads where id = any($1)", [ids]);
    }
    const left = (await db.query("select count(*)::int as n from leads where lower(contact_email) in ($1, $2)", [EMAIL, OTHER_EMAIL])).rows[0].n;
    await db.end();
    expect(left, "test leads left in the local DB").toBe(0);
  });

  test("Step 1: /trial — ask for Business Starter, then '← Change the request' → Business Standard", async () => {
    await page.goto("/trial", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByRole("radio", { name: /Google Workspace Business Starter/ }).click();
    await page.getByRole("button", { name: /Continue to details/ }).click();
    await page.getByLabel(/^Company/).first().fill("R2563 Card Test Traders");
    await page.getByLabel(/Your name/).first().fill("Card Tester");
    await page.getByLabel(/Domain/).first().fill("r2563test.in");
    await page.getByLabel(/Email — the logins go here/).first().fill(EMAIL);
    await page.getByLabel(/^Mobile/).first().fill(PHONE);
    refs.push(await requestTrial());

    await page.getByRole("button", { name: /Change the request/ }).click();
    await page.getByRole("radio", { name: /Google Workspace Business Standard/ }).click();
    await page.getByRole("button", { name: /Continue to details/ }).click();
    refs.push(await requestTrial());
    // The second request hands the first request's signed token back to the server.
    expect(bodies[1].replaces).toEqual([tokens[0]]);
    expect(bodies[0].replaces).toBeUndefined();
  });

  test("Step 2: Leads — only ONE open lead for this customer (Standard); the first draft quote is closed", async () => {
    const all = await leads();
    expect(all).toHaveLength(2);
    const open = all.filter((l) => !l.is_junk);
    expect(open.map((l) => l.plan)).toEqual(["google-workspace-standard"]);
    const old = all.find((l) => l.is_junk)!;
    expect(old.plan).toBe("google-workspace-starter");
    expect(old.junk_note).toContain(`Replaced by ${open[0].id}`);
    const qs = await quotesOf(all.map((l) => l.id));
    const oldQ = qs.find((q) => q.lead_id === old.id)!;
    const newQ = qs.find((q) => q.lead_id === open[0].id)!;
    expect(oldQ).toMatchObject({ id: refs[0], status: "expired", superseded_by: newQ.id });
    expect(newQ).toMatchObject({ id: refs[1], status: "draft", superseded_by: null });
  });

  test("Step 3: a forged replace from ANOTHER contact changes nothing — not even with the real token", async () => {
    const res = await page.request.post("/api/enquiry", {
      data: { fullName: "Someone Else", companyName: "Other Co", email: OTHER_EMAIL, phone: "9123456780",
        seats: 1, edition: "GW Business Starter", term: "annual", trial: true,
        requirement: "TRIAL: forged replace test", replaces: [tokens[1], refs[1]] },
    });
    expect((await res.json()).ok).toBe(true);
    const open = (await leads()).filter((l) => !l.is_junk);
    expect(open).toHaveLength(1);
    const [q] = await db.query<Quote>("select id, lead_id, status::text as status, superseded_by from quotes where id = $1", [refs[1]]).then((r) => r.rows);
    expect(q).toMatchObject({ status: "draft", superseded_by: null });
  });

  test("Step 4: a quote that was already sent is never touched — the lead stays open with a note", async () => {
    await db.query("update quotes set status = 'sent' where id = $1", [refs[1]]);
    await page.getByRole("button", { name: /Change the request/ }).click();
    await page.getByRole("radio", { name: /Google Workspace Business Starter/ }).click();
    await page.getByRole("button", { name: /Continue to details/ }).click();
    refs.push(await requestTrial());
    expect(bodies[2].replaces).toEqual([tokens[0], tokens[1]]);
    const [q] = await db.query<Quote>("select id, lead_id, status::text as status, superseded_by from quotes where id = $1", [refs[1]]).then((r) => r.rows);
    expect(q).toMatchObject({ status: "sent", superseded_by: null });
    const open = (await leads()).filter((l) => !l.is_junk);
    expect(open).toHaveLength(2);
    const note = await db.query("select detail from lead_activities where lead_id = $1 and detail like 'The customer sent a new trial request%'", [q.lead_id]);
    expect(note.rowCount).toBe(1);
  });
});
