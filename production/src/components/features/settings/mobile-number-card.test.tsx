// @vitest-environment jsdom
/* R-1903 slice 1 — Settings → Security → Mobile number. The owner's path on localhost:
   saved number "Not verified" → Verify → the Local test box shows the code → type it →
   Confirm code → "Verified". A wrong code shows the server's message; with no dev code from the
   server (staging/live) no box appears; "SMS is not set up yet" is shown as it is. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileNumberCard } from "./mobile-number-card";

const st = {
  status: { phone: "+919876543210", verifiedAt: null as string | null, smsReady: true, devMode: true },
  send: { status: 200, body: { ok: true, sentTo: "+91 98*****210", resendAfterSeconds: 30, devCode: "482913" } as Record<string, unknown> },
  verify: { status: 200, body: { ok: true, verifiedAt: "2026-10-25T09:00:00Z" } as Record<string, unknown> },
  posts: [] as Array<{ url: string; body: unknown }>,
};

beforeEach(() => {
  st.status = { phone: "+919876543210", verifiedAt: null, smsReady: true, devMode: true };
  st.send = { status: 200, body: { ok: true, sentTo: "+91 98*****210", resendAfterSeconds: 30, devCode: "482913" } };
  st.verify = { status: 200, body: { ok: true, verifiedAt: "2026-10-25T09:00:00Z" } };
  st.posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (init?.method === "POST") {
      st.posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/send")) return json(st.send.status, st.send.body);
      if (url.endsWith("/verify")) {
        if (st.verify.status === 200) st.status = { ...st.status, verifiedAt: "2026-10-25T09:00:00Z" };
        return json(st.verify.status, st.verify.body);
      }
    }
    return json(200, st.status);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderCard = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MobileNumberCard />
  </QueryClientProvider>,
);

describe("MobileNumberCard (R-1903)", () => {
  it("owner's path: Not verified → Verify → local code shown → Confirm code → Verified", async () => {
    renderCard();
    expect(await screen.findByText("Not verified")).toBeTruthy();
    expect((screen.getByLabelText("Mobile number") as HTMLInputElement).value).toBe("9876543210");

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    const box = await screen.findByTestId("dev-otp");
    expect(box.textContent).toContain("482913");
    expect(box.textContent).toContain("no SMS was sent");
    expect(st.posts[0]).toEqual({ url: "/api/settings/mobile/send", body: { phone: "+919876543210" } });
    expect(screen.getByRole("button", { name: /Resend code in 30s/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Code sent to/), { target: { value: "482913" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm code" }));
    expect(await screen.findByText("+91 98765 43210 is verified.")).toBeTruthy();
    expect(st.posts[1]).toEqual({ url: "/api/settings/mobile/verify", body: { phone: "+919876543210", code: "482913" } });
    await waitFor(() => expect(screen.getByText("Verified")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
  });

  it("a wrong code shows the server's message and keeps the code box", async () => {
    st.verify = { status: 400, body: { error: "That code is not right — 2 tries left. Check the latest SMS and type it again." } };
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await screen.findByTestId("dev-otp");
    fireEvent.change(screen.getByLabelText(/Code sent to/), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/2 tries left/);
    expect(screen.getByLabelText(/Code sent to/)).toBeTruthy();
  });

  it("no dev code from the server (staging/live) → no Local test box", async () => {
    st.send = { status: 200, body: { ok: true, sentTo: "+91 98*****210", resendAfterSeconds: 30 } };
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    await screen.findByLabelText(/Code sent to/);
    expect(screen.queryByTestId("dev-otp")).toBeNull();
  });

  it("SMS not set up: says so, no code box", async () => {
    st.send = { status: 503, body: { error: "SMS is not set up yet, so no code was sent. Mobile verification starts working once the SMS provider (MSG91) is connected — ask your owner.", code: "sms_not_set_up" } };
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/SMS is not set up yet, so no code was sent/);
    expect(screen.queryByLabelText(/Code sent to/)).toBeNull();
  });

  it("a verified number shows Verified; typing a new one offers Verify and keeps the old one", async () => {
    st.status = { ...st.status, verifiedAt: "2026-10-25T08:00:00Z" };
    renderCard();
    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(screen.getByText("This number is verified.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "9811111111" } });
    expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
    expect(screen.getByText(/\+91 98765 43210 stays saved until the new number is verified/)).toBeTruthy();
  });

  it("an invalid number is stopped on the screen", async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText("Mobile number"), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/10-digit Indian mobile/);
    expect(st.posts).toHaveLength(0);
  });
});
