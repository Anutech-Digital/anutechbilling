import { describe, it, expect } from "vitest";
import { planForward, passThroughHeaders, pageField } from "./app-forward";

const STAGING = "https://resellersos-staging-test.example.invalid/api/enquiry";
const LIVE = "https://reselleros.anutech.in/api/enquiry";

describe("planForward (R-1598) — never a different deployment by default", () => {
  it("no env → handled locally, on staging and on live", () => {
    expect(planForward(STAGING, {})).toEqual({ kind: "local" });
    expect(planForward(LIVE, {})).toEqual({ kind: "local" });
    expect(planForward("http://localhost:3001/api/enquiry", {})).toEqual({ kind: "local" });
  });

  it("ignores NEXT_PUBLIC_RESELLEROS_URL — only the server-side variable can forward", () => {
    expect(planForward(STAGING, { NEXT_PUBLIC_RESELLEROS_URL: "https://reselleros.anutech.in" })).toEqual({ kind: "local" });
  });

  it("staging → live is refused, whichever production host is named", () => {
    for (const t of ["https://reselleros.anutech.in", "https://anutech.in/", "https://WWW.anutech.in"]) {
      expect(planForward(STAGING, { RESELLEROS_FORWARD_URL: t }).kind).toBe("refused");
    }
    expect(planForward("http://localhost:3001/api/enquiry", { RESELLEROS_FORWARD_URL: "https://reselleros.anutech.in" }).kind).toBe("refused");
  });

  it("pointing at itself is local; live → live elsewhere is allowed", () => {
    expect(planForward(LIVE, { RESELLEROS_FORWARD_URL: "https://reselleros.anutech.in" })).toEqual({ kind: "local" });
    expect(planForward("https://anutech.in/api/enquiry", { RESELLEROS_FORWARD_URL: "https://reselleros.anutech.in/x" }))
      .toEqual({ kind: "remote", base: "https://reselleros.anutech.in" });
  });

  it("a non-production target is forwarded; junk is refused", () => {
    expect(planForward(STAGING, { RESELLEROS_FORWARD_URL: "https://app.other.example.invalid" }))
      .toEqual({ kind: "remote", base: "https://app.other.example.invalid" });
    expect(planForward(STAGING, { RESELLEROS_FORWARD_URL: "not a url" }).kind).toBe("refused");
    expect(planForward(STAGING, { RESELLEROS_FORWARD_URL: "ftp://x.example.invalid" }).kind).toBe("refused");
  });
});

describe("passThroughHeaders / pageField", () => {
  it("keeps attribution, IP and bot-check headers; drops cookies", () => {
    const h = passThroughHeaders({ headers: new Headers({ referer: "https://anutech.in/quote?gclid=a", "x-forwarded-for": "1.2.3.4", "x-turnstile-token": "t", cookie: "sb=secret" }) });
    expect(h.get("referer")).toBe("https://anutech.in/quote?gclid=a");
    expect(h.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(h.get("x-turnstile-token")).toBe("t");
    expect(h.get("cookie")).toBeNull();
    expect(h.get("content-type")).toBe("application/json");
  });

  it("pageField keeps the URL whole (gclid/utm) and caps it", () => {
    expect(pageField("https://anutech.in/quote?utm_source=g&gclid=x")).toBe("https://anutech.in/quote?utm_source=g&gclid=x");
    expect(pageField("")).toBeUndefined();
    expect(pageField(5)).toBeUndefined();
    expect(pageField("x".repeat(2000))).toHaveLength(1000);
  });
});
