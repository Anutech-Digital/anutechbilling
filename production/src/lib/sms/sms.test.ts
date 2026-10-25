/**
 * R-1903 — the SMS gateway, OTP hashing and number rules.
 * The guard that matters most: the dev gateway (which prints the code and lets the screen show
 * it) is never chosen on a deployment — NODE_ENV=production, staging, live or Cloud Run.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { devGateway, devSmsAllowed, notSetUpGateway, smsGateway, SMS_NOT_SET_UP } from "./gateway";
import { createMsg91Gateway, msg91Configured, MSG91_ENV } from "./msg91";
import { generateOtp, hashOtp, isOtpShape, otpHashSecret, otpSmsText } from "./otp";
import { formatIndianMobile, localDigits, maskPhone, normalizeIndianMobile } from "./phone";
import { otpMessage, otpStatus } from "./otp-messages";

afterEach(() => vi.restoreAllMocks());

describe("smsGateway — dev only off a deployment", () => {
  it.each([
    [{ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "local" }, "dev"],
    [{ NODE_ENV: "test" }, "dev"],
    [{ NODE_ENV: "production", NEXT_PUBLIC_APP_ENV: "local" }, "none"],   // dev:local --prod build
    [{ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "staging" }, "none"],
    [{ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "production" }, "none"],
    [{ NODE_ENV: "development", K_SERVICE: "reselleros" }, "none"],
    // MSG91 keys present on a deployment still do not send anything until slice 3 wires it.
    [{ NODE_ENV: "production", MSG91_AUTH_KEY: "x", MSG91_OTP_TEMPLATE_ID: "y", MSG91_SENDER_ID: "z" }, "none"],
  ])("%o → %s", (env, name) => {
    expect(smsGateway(env).name).toBe(name);
    expect(devSmsAllowed(env)).toBe(name === "dev");
  });

  it("the not-set-up gateway never pretends: ok=false with the plain message", async () => {
    expect(notSetUpGateway.ready).toBe(false);
    await expect(notSetUpGateway.send("+919876543210", "123456 is your code")).resolves.toEqual({
      ok: false, reason: "not_configured", message: SMS_NOT_SET_UP,
    });
  });

  it("the dev gateway prints to the console with a masked number and sends nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(devGateway.send("+919876543210", "111222 is your OTP")).resolves.toEqual({ ok: true, provider: "dev" });
    expect(info.mock.calls[0][0]).toBe("[sms:dev] not sent — to +91 98*****210: 111222 is your OTP");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("MSG91 stub (slice 3) — names only, not wired", () => {
  it("is configured only when all three names have values", () => {
    expect(Object.values(MSG91_ENV)).toEqual(["MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID", "MSG91_SENDER_ID"]);
    expect(msg91Configured({})).toBe(false);
    expect(msg91Configured({ MSG91_AUTH_KEY: "a", MSG91_OTP_TEMPLATE_ID: "b", MSG91_SENDER_ID: " " })).toBe(false);
    expect(msg91Configured({ MSG91_AUTH_KEY: "a", MSG91_OTP_TEMPLATE_ID: "b", MSG91_SENDER_ID: "c" })).toBe(true);
  });
  it("refuses every send", async () => {
    const g = createMsg91Gateway();
    expect(g.ready).toBe(false);
    expect((await g.send("+919876543210", "x")).ok).toBe(false);
  });
});

describe("OTP code and hash", () => {
  it("6 digits, zero-padded", () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
    expect(isOtpShape("012345")).toBe(true);
    expect(isOtpShape("12345")).toBe(false);
    expect(isOtpShape(123456)).toBe(false);
  });
  it("hash is 64-hex, never contains the code, and is bound to user + number", () => {
    const h = hashOtp("k", "u-a", "+919876543210", "123456");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("123456");
    expect(hashOtp("k", "u-b", "+919876543210", "123456")).not.toBe(h);
    expect(hashOtp("k", "u-a", "+919876543211", "123456")).not.toBe(h);
    expect(hashOtp("k2", "u-a", "+919876543210", "123456")).not.toBe(h);
  });
  it("secret: a deployment with none → null (routes say not set up); locally a fixed key", () => {
    expect(otpHashSecret({ NODE_ENV: "production" })).toBeNull();
    expect(otpHashSecret({ NODE_ENV: "production", AUTH_SECRET: "s" })).toBe("s");
    expect(otpHashSecret({ NODE_ENV: "production", AUTH_SECRET: "s", OTP_HASH_SECRET: "o" })).toBe("o");
    expect(otpHashSecret({ NODE_ENV: "development" })).toBeTruthy();
  });
  it("SMS text carries the code and the 5-minute validity", () => {
    expect(otpSmsText("123456")).toBe("123456 is your ResellerOS OTP to verify your mobile number. Valid 5 min. Do not share. - Anutech");
  });
});

describe("Indian mobile numbers", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["+91-98765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["(987) 654-3210", "+919876543210"],
    ["5876543210", null],
    ["98765", null],
    ["+1 415 555 0100", null],
    ["", null],
  ])("%s → %s", (raw, out) => expect(normalizeIndianMobile(raw)).toBe(out));

  it("mask matches public.mask_phone()", () => {
    expect(maskPhone("+919876543210")).toBe("+91 98*****210");
    expect(maskPhone("12345678")).toBe("*****678");
    expect(maskPhone("")).toBe("");
  });
  it("own number shown readable; input box gets the 10 digits", () => {
    expect(formatIndianMobile("+919876543210")).toBe("+91 98765 43210");
    expect(localDigits("+919876543210")).toBe("9876543210");
    expect(localDigits(null)).toBe("");
  });
});

describe("refusal messages (§24: what, why, next)", () => {
  it("statuses", () => {
    expect(otpStatus("cooldown")).toBe(429);
    expect(otpStatus("locked")).toBe(429);
    expect(otpStatus("taken")).toBe(409);
    expect(otpStatus("wrong_code")).toBe(400);
  });
  it("locked says how long and what next", () => {
    expect(otpMessage({ reason: "locked", retry_after_seconds: 900 })).toBe(
      "Too many wrong codes, so this number is locked. Wait 15 min, then ask for a new code.");
  });
  it("an unknown reason still gives a next step", () => {
    expect(otpMessage({ reason: "???" })).toMatch(/Try again/);
  });
});
