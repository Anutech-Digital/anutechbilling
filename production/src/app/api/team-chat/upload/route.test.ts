/**
 * R-2297 (G-TEAMCHAT TC-04): POST /api/team-chat/upload stores ONE chat file in the documents
 * bucket under {tenant}/chat/{channel}/{uuid}_{safe-name} and returns that path. The message
 * row (chat_attachments) is written later by chat_post_message (R-2295), not here.
 *
 * The route must refuse, before anything is stored: a file over 10 MB (a plain "max 10 MB"
 * message), a type outside the Company Documents list (.html, .svg …), a file whose bytes are
 * not what its type says (a "PDF" that is not a PDF, an SVG named .png), a non-member of the
 * channel, and logins that have no team chat (partner_agent, personal).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, fakeServerModule, signInAs, TENANT_A, type FakeDb } from "@/test/fake-route-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeServerModule(h.db).createClient(),
  createAdminClientFor: () => fakeServerModule(h.db).createAdminClientFor(),
  createAdminClient: () => fakeServerModule(h.db).createAdminClient(),
}));

import { POST } from "./route";
import { CHAT_FILE_MAX_BYTES, chatFileSignedUrl, CHAT_FILE_SIGNED_URL_SECONDS, safeChatFileName } from "./chat-files";

const CH = "cccccccc-0000-4000-8000-000000000001";
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0]);

/** A browser sends a multipart upload with its Content-Length — so does this. */
async function post(fd: FormData) {
  const r = new Request("http://x/api/team-chat/upload", { method: "POST", body: fd });
  const body = await r.arrayBuffer();
  return POST(new NextRequest("http://x/api/team-chat/upload", {
    method: "POST",
    body,
    headers: { "content-type": r.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
  }));
}

function call(bytes: BlobPart, name: string, type: string, channelId: string | null = CH) {
  const fd = new FormData();
  if (channelId !== null) fd.append("channelId", channelId);
  fd.append("file", new File([bytes], name, { type }));
  return post(fd);
}

const uploads = () => h.db.writes.filter(([, , op]) => op === "upload");

beforeEach(() => {
  h.db = newFakeDb();
  h.db.rpcResult = { data: true, error: null }; // is_chat_member → true unless a test says no
});

describe("team chat upload — who may upload (R-2297)", () => {
  it("signed out → 401, nothing stored", async () => {
    const res = await call(PDF, "a.pdf", "application/pdf");
    expect(res.status).toBe(401);
    expect(uploads()).toHaveLength(0);
  });

  for (const role of ["partner_agent", "personal"]) {
    it(`${role} → 403, nothing stored, no membership lookup`, async () => {
      signInAs(h.db, role);
      const res = await call(PDF, "a.pdf", "application/pdf");
      expect(res.status).toBe(403);
      expect(uploads()).toHaveLength(0);
      expect(h.db.rpcCalls).toHaveLength(0);
    });
  }

  it("a non-member of the channel → 403 with a plain message, nothing stored", async () => {
    signInAs(h.db, "sales");
    h.db.rpcResult = { data: false, error: null };
    const res = await call(PDF, "a.pdf", "application/pdf");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You are not a member of this conversation, so you cannot share a file here. Ask its admin to add you.");
    expect(h.db.rpcCalls).toEqual([["is_chat_member", { p_channel_id: CH }]]);
    expect(uploads()).toHaveLength(0);
  });

  it("no channel / a channel that is not an id → 400, nothing stored", async () => {
    signInAs(h.db, "sales");
    for (const ch of [null, "general", "../x"]) {
      const res = await call(PDF, "a.pdf", "application/pdf", ch);
      expect(res.status).toBe(400);
    }
    expect(uploads()).toHaveLength(0);
  });

  it("no file → 400", async () => {
    signInAs(h.db, "sales");
    const fd = new FormData();
    fd.append("channelId", CH);
    const res = await post(fd);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Choose a file to share.");
  });
});

describe("team chat upload — size and type (R-2297)", () => {
  beforeEach(() => signInAs(h.db, "sales"));

  it("an 11 MB file → 413 'max 10 MB', nothing stored", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(PDF);
    const res = await call(big, "big.pdf", "application/pdf");
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("This file is larger than 10 MB. Team chat takes files up to 10 MB — make it smaller or share a link to it instead.");
    expect(uploads()).toHaveLength(0);
  });

  it("exactly 10 MB is still accepted", async () => {
    const ok = new Uint8Array(CHAT_FILE_MAX_BYTES);
    ok.set(PDF);
    const res = await call(ok, "ten.pdf", "application/pdf");
    expect(res.status).toBe(200);
  });

  const TYPE_MSG = "This file type cannot be shared in team chat. Use PDF, JPG, PNG, WEBP, Word, Excel, TXT or ZIP.";
  for (const [name, type, body] of [
    ["page.html", "text/html", "<html><script>alert(1)</script></html>"],
    ["logo.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"],
    ["page.html", "text/plain", "<html><script>alert(1)</script></html>"],
    ["run.exe", "application/octet-stream", "MZ\x90\x00"],
  ] as const) {
    it(`${name} (${type}) → 415, nothing stored`, async () => {
      const res = await call(body, name, type);
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe(TYPE_MSG);
      expect(uploads()).toHaveLength(0);
    });
  }

  for (const [name, type, body, what] of [
    ["invoice.pdf", "application/pdf", "hello, I am not a pdf", "a PDF"],
    ["photo.png", "image/png", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "a PNG image"],
    ["photo.jpg", "image/jpeg", PNG, "a JPG image"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "not a zip", "an Excel file"],
    ["notes.txt", "text/plain", "<script>alert(1)</script>", "a text file"],
  ] as const) {
    it(`${name} with fake bytes → 415, nothing stored`, async () => {
      const res = await call(body, name, type);
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe(`This file is not really ${what} — its contents do not match its type. Save it again as ${what} and retry.`);
      expect(uploads()).toHaveLength(0);
    });
  }
});

describe("team chat upload — stored path (R-2297)", () => {
  beforeEach(() => signInAs(h.db, "sales"));

  it("a real PDF from a member → stored as the caller in {tenant}/chat/{channel}/{uuid}_{safe-name}", async () => {
    const res = await call(PDF, "Quote Oct (final).pdf", "application/pdf");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.path).toMatch(new RegExp(`^${TENANT_A}/chat/${CH}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_Quote_Oct_final_.pdf$`));
    expect(out).toMatchObject({ fileName: "Quote Oct (final).pdf", mime: "application/pdf", sizeBytes: PDF.length });
    // the caller's own session, so the storage rule (member + uploader) decides too
    expect(uploads()).toEqual([["user", "documents", "upload", out.path]]);
  });

  it("a PNG and a Word .docx are stored with their real type", async () => {
    const png = await (await call(PNG, "shot.png", "image/png")).json();
    expect(png.mime).toBe("image/png");
    const docx = await (await call(ZIP, "letter.docx", "")).json();
    expect(docx.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("safe names never carry '..', slashes or odd characters, and keep the extension", () => {
    expect(safeChatFileName("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(safeChatFileName("a..b...pdf")).toBe("a.b.pdf");
    expect(safeChatFileName("..pdf")).toBe("file.pdf");
    expect(safeChatFileName("रिपोर्ट.pdf")).toBe("file.pdf");
    expect(safeChatFileName(`${"x".repeat(300)}.xlsx`)).toMatch(/^x{1,115}\.xlsx$/);
    expect(safeChatFileName(`${"x".repeat(300)}.xlsx`).length).toBeLessThanOrEqual(120);
  });

  it("downloads use a 5-minute signed URL from the documents bucket, never a public URL", async () => {
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "/signed?token=t" }, error: null }));
    const from = vi.fn(() => ({ createSignedUrl }));
    const url = await chatFileSignedUrl({ storage: { from } }, `${TENANT_A}/chat/${CH}/x_a.pdf`);
    expect(CHAT_FILE_SIGNED_URL_SECONDS).toBe(300);
    expect(from).toHaveBeenCalledWith("documents");
    expect(createSignedUrl).toHaveBeenCalledWith(`${TENANT_A}/chat/${CH}/x_a.pdf`, 300);
    expect(url).toBe("/signed?token=t");
  });
});
