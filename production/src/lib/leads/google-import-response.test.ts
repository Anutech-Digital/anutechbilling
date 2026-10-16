// R-1427: /leads → More → Import from Google. /api/contacts/google-fetch answers 410
// (contact importing was retired on 10 Sep 2026). The dialog showed the raw code
// "contact_import_retired" next to a "Try again" button that can only ever get the same
// 410 again. A 410 is final: it must become a calm "switched off" answer, never a retry.
import { describe, it, expect } from "vitest";
import { classifyGoogleFetch, parseJsonBody, GOOGLE_IMPORT_OFF_MESSAGE } from "./google-import-response";

describe("classifyGoogleFetch (R-1427)", () => {
  it("410 is final: 'unavailable', not an error the user can retry", () => {
    const out = classifyGoogleFetch(410, { error: "contact_import_retired", message: "retired" });
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") {
      expect(out.message).toBe(GOOGLE_IMPORT_OFF_MESSAGE);
      expect(out.message).not.toMatch(/contact_import_retired/);
    }
  });

  it("410 with no JSON body is still 'unavailable'", () => {
    expect(classifyGoogleFetch(410, null).kind).toBe("unavailable");
  });

  it("403 needs_reauth asks to connect Google", () => {
    const out = classifyGoogleFetch(403, { code: "needs_reauth", error: "Connect Google first" });
    expect(out).toEqual({ kind: "needs-connect", message: "Connect Google first" });
  });

  it("other failures are retryable errors with a readable message, never a raw code", () => {
    const out = classifyGoogleFetch(502, { error: "Google API error: 502" });
    expect(out).toEqual({ kind: "error", message: "Google API error: 502" });
    const bare = classifyGoogleFetch(500, null);
    expect(bare.kind).toBe("error");
    if (bare.kind === "error") expect(bare.message).toMatch(/Google/);
  });

  it("200 returns only well-formed contacts", () => {
    const out = classifyGoogleFetch(200, {
      contacts: [
        { resourceName: "people/1", fullName: "Asha", email: "a@x.in", phone: null, company: null, title: null, notes: null },
        { nonsense: true },
      ],
    });
    expect(out.kind).toBe("preview");
    if (out.kind === "preview") expect(out.contacts.map((c) => c.resourceName)).toEqual(["people/1"]);
  });

  it("200 without a contacts array is an empty preview, not a crash", () => {
    const out = classifyGoogleFetch(200, {});
    expect(out).toEqual({ kind: "preview", contacts: [] });
  });
});

describe("parseJsonBody (R-1427)", () => {
  it("returns null for HTML / empty bodies instead of throwing", () => {
    expect(parseJsonBody("<html>Gone</html>")).toBeNull();
    expect(parseJsonBody("")).toBeNull();
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });
});
