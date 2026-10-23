/**
 * R-735 (23 Oct 2026): the server must not fetch a URL a tenant, a visitor or the AI chose
 * when it points inside our network (metadata server, localhost, private ranges) — SSRF.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isPrivateAddress, checkUrlShape, checkUrl, safeFetch, UnsafeUrlError,
  SANDBOX_HOSTS, sandboxBaseProblem,
} from "./safe-fetch";

const publicDns = async () => ["104.18.1.1"];
const privateDns = async () => ["10.0.0.5"];

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "104.18.1.1", "172.32.0.1", "2606:4700::1111"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false));
});

describe("checkUrlShape", () => {
  it("https only by default", () => {
    expect(checkUrlShape("http://example.com").ok).toBe(false);
    expect(checkUrlShape("https://example.com").ok).toBe(true);
    expect(checkUrlShape("ftp://example.com", { allowHttp: true }).ok).toBe(false);
    expect(checkUrlShape("http://example.com", { allowHttp: true }).ok).toBe(true);
  });
  it("refuses literal private IPs, localhost names and credentials", () => {
    for (const u of [
      "https://169.254.169.254/latest", "https://127.0.0.1", "https://[::1]/", "https://localhost",
      "https://metadata.google.internal", "https://user:pw@example.com", "https://0x7f000001",
    ]) expect(checkUrlShape(u).ok, u).toBe(false);
  });
  it("an allowlist admits only those hosts", () => {
    const p = { allowHosts: SANDBOX_HOSTS };
    expect(checkUrlShape("https://api.sandbox.co.in", p).ok).toBe(true);
    expect(checkUrlShape("https://test-api.sandbox.co.in/x", p).ok).toBe(true);
    expect(checkUrlShape("https://api.sandbox.co.in.evil.com", p).ok).toBe(false);
    expect(checkUrlShape("https://evil.com", p).ok).toBe(false);
  });
});

describe("checkUrl (after DNS)", () => {
  it("a public name that resolves to a private IP is refused", async () => {
    expect((await checkUrl("https://rebind.example", {}, privateDns)).ok).toBe(false);
    expect((await checkUrl("https://ok.example", {}, publicDns)).ok).toBe(true);
  });
  it("a name that does not resolve is refused", async () => {
    expect((await checkUrl("https://nx.example", {}, async () => { throw new Error("ENOTFOUND"); })).ok).toBe(false);
  });
});

describe("safeFetch", () => {
  it("never calls fetch for an unsafe URL", async () => {
    const f = vi.fn();
    await expect(safeFetch("http://169.254.169.254/", {}, { fetchImpl: f, lookup: publicDns })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(f).not.toHaveBeenCalled();
  });
  it("follows a redirect only after re-checking the new target", async () => {
    const f = vi.fn(async (u: string) =>
      u === "https://ok.example/"
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
        : new Response("secret"));
    await expect(safeFetch("https://ok.example/", {}, { fetchImpl: f, lookup: publicDns, allowHttp: true }))
      .rejects.toBeInstanceOf(UnsafeUrlError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
  it("a safe redirect is followed", async () => {
    const f = vi.fn(async (u: string) =>
      u === "https://ok.example/"
        ? new Response(null, { status: 301, headers: { location: "/home" } })
        : new Response("hello", { status: 200 }));
    const res = await safeFetch("https://ok.example/", {}, { fetchImpl: f, lookup: publicDns });
    expect(await res.text()).toBe("hello");
    expect(f.mock.calls[1][0]).toBe("https://ok.example/home");
  });
});

describe("callers that open URLs someone else chose go through safeFetch", () => {
  it("Lead Finder (AI-given and company-site URLs) has no raw fetch()", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const s = readFileSync(join(process.cwd(), "src/lib/leads/lead-finder.server.ts"), "utf8");
    expect(s).not.toMatch(/(?<![\w.])fetch\(/);
    expect(s).toMatch(/safeFetch\(/);
  });
});

describe("sandboxBaseProblem — what Settings refuses to save", () => {
  it("allows the two Sandbox hosts, refuses anything else with a next step", () => {
    expect(sandboxBaseProblem("https://api.sandbox.co.in")).toBeNull();
    expect(sandboxBaseProblem("https://test-api.sandbox.co.in/")).toBeNull();
    const msg = sandboxBaseProblem("http://169.254.169.254");
    expect(msg).toMatch(/https:\/\/api\.sandbox\.co\.in/);
    expect(msg).toMatch(/clear/i);
  });
});
