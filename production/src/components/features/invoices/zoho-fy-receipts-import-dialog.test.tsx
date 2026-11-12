// @vitest-environment jsdom
/* R-2547 (G-FY2526) — FY receipts from Zoho: a part that fails (staging 7 Nov: "canceling statement due
   to statement timeout" on part 2) is named with its reason and STAYS on screen after the preview
   refresh that follows the import; what the earlier parts saved is shown; every skip reason is listed
   (not only the first 8). fetch is mocked; names and numbers are made up. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFyReceiptsImportDialog, partFailedMessage, readStatusText, accountedText, BOOKED_EARLIER_PREFIX } from "./zoho-fy-receipts-import-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reasons = Array.from({ length: 11 }, (_, i) => ({ reason: `Reason number ${i + 1}`, count: i + 1 }));
const preview = {
  ok: true, parts: 3,
  counts: { scanned: 160, import: 120, already: 0, alreadyNotBanked: 0, skip: 40 },
  totals: { cash: 100000, tds: 0, excess: 0 },
  deposits: [], accounts: [], skipReasons: reasons, skipped: [], batches: [], canRemove: true,
};
const partOk = (n: number) => ({ ok: true, result: { imported: n, already: 0, banked: n, bank_later: 0, skipped: [] } });

describe("R-2547 FY receipts dialog", () => {
  it("names the failed part and its reason, keeps it after the refresh, and shows what earlier parts saved", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let failOnce = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.action === "preview") return { ok: true, json: async () => preview } as Response;
      if (b.dryRun === false && b.part === 1 && failOnce) {
        failOnce = false;
        return { ok: false, json: async () => ({ ok: false, error: "canceling statement due to statement timeout" }) } as Response;
      }
      return { ok: true, json: async () => partOk(50) } as Response;
    }));

    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    const importBtn = await screen.findByRole("button", { name: /Import 120 receipts/ });
    await waitFor(() => expect(importBtn.hasAttribute("disabled")).toBe(false));
    fireEvent.click(importBtn);

    await waitFor(() => expect(bodies.filter((b) => b.action === "preview").length).toBe(2));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Part 2 of 3/);
    expect(alert.textContent).toMatch(/took too long/);
    expect(alert.textContent).toMatch(/nothing is booked twice/);
    /* part 3 was never sent once part 2 failed */
    expect(bodies.some((b) => b.action === "import" && b.dryRun === false && b.part === 2)).toBe(false);
    expect(alert.textContent).toMatch(/Part 1 is done \(50 new receipts\)/);
    expect(screen.getByText(/Recorded: 50 new receipts \(50 matched to bank lines · 0 wait/)).toBeTruthy();

    /* Carry on: starts at the failed part (part 1 is not sent again), no new check needed */
    const sent = bodies.length;
    const carry = await screen.findByRole("button", { name: /Carry on from part 2/ });
    expect(carry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(carry);
    await waitFor(() => expect(bodies.filter((b) => b.action === "preview").length).toBe(3));
    const again = bodies.slice(sent).filter((b) => b.action === "import");
    expect(again.map((b) => [b.part, b.dryRun])).toEqual([[1, false], [2, false]]);
    expect(screen.queryByTestId("fy-receipts-part-error")).toBeNull();
    expect(screen.getByText(/Recorded: 100 new receipts \(100 matched to bank lines · 0 wait/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Carry on/ })).toBeNull();
  });

  it("lists every skip reason (11), not only the first 8", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => preview }) as Response));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Reason number 11/)).toBeTruthy();
    expect(screen.getByText(/Reason number 9/)).toBeTruthy();
  });

  it("partFailedMessage: plain words for the timeout; other refusals as the database gave them", () => {
    const none = { imported: 0, already: 0 };
    expect(partFailedMessage(0, 4, "canceling statement due to statement timeout", none))
      .toMatch(/^Part 1 of 4 stopped: the database took too long on this part\. Nothing from this part was saved\. Press "Carry on from part 1"/);
    /* a lock wait is not "too slow" — the database's own words */
    expect(partFailedMessage(0, 4, "canceling statement due to lock timeout", none)).toMatch(/stopped: canceling statement due to lock timeout\./);
    const m = partFailedMessage(2, 4, "Only the owner or an accountant can import FY receipts from Zoho.", { imported: 100, already: 0 });
    expect(m).toMatch(/^Part 3 of 4 stopped: Only the owner/);
    expect(m).toMatch(/from Zoho\. Parts 1–2 are done \(100 new receipts\)\./);
    /* a resumed run whose earlier parts were all booked before: "already", not "0 saved" */
    expect(partFailedMessage(5, 9, "Too many payments ", { imported: 0, already: 250 }))
      .toMatch(/^Part 6 of 9 stopped: Too many payments\. Parts 1–5 are done \(0 new receipts, 250 already recorded\)/);
    expect(partFailedMessage(1, 2, "boom", null)).toMatch(/This was the check — nothing was saved/);
  });
});

/* R-2565 — Razorpay fee payments: importable, the fee shown apart (preview and the check), never taken off the receipts. */
describe("R-2565 FY receipts dialog — Razorpay fee shown apart", () => {
  it("preview shows the Razorpay payments and their fee as Bank Charges; the check result shows the fee too", async () => {
    const withFee = { ...preview, parts: 1, counts: { ...preview.counts, import: 130, withFee: 130 }, totals: { ...preview.totals, cash: 3500000, fee: 70123 } };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      if (b.action === "preview") return { ok: true, json: async () => withFee } as Response;
      return { ok: true, json: async () => ({ ok: true, result: { imported: 130, already: 0, banked: 0, bank_later: 130, with_fee: 130, fee: 70123, skipped: [] } }) } as Response;
    }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    const fee = await screen.findByTestId("fy-receipts-fee");
    expect(fee.textContent).toMatch(/130 Razorpay payments · fee ₹70,123 booked as Bank Charges/);
    expect(screen.getByTestId("fy-receipts-summary").textContent).toMatch(/130.*to record \(₹35,00,000 received/);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    expect((await screen.findByTestId("fy-receipts-part-fee")).textContent).toMatch(/130 Razorpay payments · fee ₹70,123/);
  });

  it("no fee line when nothing has a fee (an older server sends no fee fields)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => preview }) as Response));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-receipts-summary");
    expect(screen.queryByTestId("fy-receipts-fee")).toBeNull();
  });
});

/* R-2607 — the read runs on the server: the dialog only starts it and shows progress; reopened, it
   picks up where the server is; closing while it reads is allowed. */
describe("R-2607 FY receipts dialog — server read", () => {
  it("progress line: on the server, can close; stopped; complete", () => {
    expect(readStatusText({ listed: 2576, detailed: 87, complete: false, running: true })).toBe("Read 87 of 2,576 — on the server; you can close this window and come back.");
    expect(readStatusText({ listed: 0, detailed: 0, complete: false, running: true })).toMatch(/^Reading the list from Zoho — on the server/);
    expect(readStatusText({ listed: 2576, detailed: 900, complete: false, running: false })).toBe("Read 900 of 2,576 — stopped.");
    expect(readStatusText({ listed: 2576, detailed: 2576, complete: true })).toBe("Read all 2,576 payments.");
  });

  it("opened while the server reads: follows it with server passes (never the old read loop), then shows the preview", async () => {
    const actions: string[] = [];
    let steps = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      actions.push(String(b.action));
      if (b.action === "status") return { ok: true, json: async () => ({ ok: true, listed: 2576, detailed: 87, complete: false, running: true, error: null }) } as Response;
      if (b.action === "step") {
        steps += 1;
        const done = steps >= 2;
        return { ok: true, json: async () => ({ ok: true, listed: 2576, detailed: done ? 2576 : 1200, complete: done, running: !done, error: null }) } as Response;
      }
      if (b.action === "preview") return { ok: true, json: async () => preview } as Response;
      return { ok: false, json: async () => ({ ok: false, error: "unexpected" }) } as Response;
    }));
    const closed = vi.fn();
    render(<ZohoFyReceiptsImportDialog open onOpenChange={closed} />);
    expect(await screen.findByText(/^Read (87|1,200) of 2,576 — on the server; you can close this window/)).toBeTruthy();
    /* closing while it reads is allowed — the server carries on */
    const closeBtn = screen.getAllByRole("button", { name: "Close" }).find((x) => x.textContent === "Close")!;
    expect(closeBtn.hasAttribute("disabled")).toBe(false);
    fireEvent.click(closeBtn);
    expect(closed).toHaveBeenCalledWith(false);
    await screen.findByText("Read all 2,576 payments.", undefined, { timeout: 12_000 });
    await waitFor(() => expect(actions).toContain("preview"));
    expect(actions.filter((a) => a === "read")).toEqual([]);
    expect(actions.slice(0, 3)).toEqual(["status", "step", "step"]);
  }, 20_000);

  it("a read the server stopped shows why (e.g. reconnect Zoho)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      if (b.action === "status") return { ok: true, json: async () => ({ ok: true, listed: 2576, detailed: 900, complete: false, running: false, error: "Zoho Books did not let ResellerOS read customer payments — Reconnect." }) } as Response;
      return { ok: false, json: async () => ({ ok: false, error: "Read the year from Zoho first (Read from Zoho) — it is not complete yet." }) } as Response;
    }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText("Read 900 of 2,576 — stopped.")).toBeTruthy();
  });
});

/* R-2693 (p0) — nothing left out silently: Check first accounts for EVERY scanned payment (to record +
   already + refused by the check + left out before it = scanned), groups the refusals by reason with a
   count, lists all of them, and a USD payment shows its dollars (not as rupees). */
describe("R-2693 FY receipts — every payment accounted for", () => {
  const usdRow = { number: "201", date: "2025-12-02", customer: "Overseas Buyer LLC", amount: 58481, currency: "USD", foreignAmount: 663.05, reason: "Received in USD in Zoho — not imported yet." };
  const oldUsdRow = { number: "202", date: "2025-12-03", customer: "Overseas Buyer LLC", amount: null, currency: "USD", foreignAmount: 663, reason: "Received in USD in Zoho — book a foreign-currency receipt by hand." };
  const pv = { ...preview, parts: 1, skipped: [usdRow, oldUsdRow], skippedMore: 3 };
  const refused = Array.from({ length: 250 }, (_, i) => ({ number: `R${i + 1}`, reason: i < 249 ? `INV/25-26/${1000 + i} has only ₹${i} due here, but Zoho settles ₹${i + 5} with this payment.` : "Its invoices belong to different customers here." }));
  const stub = (result: Record<string, unknown>) => vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    if (b.action === "preview") return { ok: true, json: async () => pv } as Response;
    return { ok: true, json: async () => ({ ok: true, result }) } as Response;
  }));

  it("left-out list: a USD payment shows its dollars (+ ₹ at Zoho's rate when known); says how many more are not listed", async () => {
    stub({ imported: 120, already: 0, banked: 0, bank_later: 120, skipped: [] });
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    const list = await screen.findByTestId("fy-receipts-left-out");
    expect(list.textContent).toMatch(/201 · .* · Overseas Buyer LLC · \$663\.05 \(₹58,481\) — Received in USD/);
    expect(list.textContent).toMatch(/202 · .* · \$663\.00 — Received in USD/);
    expect(list.textContent).not.toMatch(/₹663/);
    expect(list.textContent).toMatch(/and 3 more not listed here/);
  });

  it("Check first: every scanned payment accounted for; refusals grouped with a count and ALL listed (250, not 200)", async () => {
    stub({ imported: 0, already: 0, banked: 0, bank_later: 0, skipped: refused });
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    const acc = await screen.findByTestId("fy-receipts-accounted");
    /* 0 + 0 + 250 refused + 40 left out ≠ 160 scanned — never hidden: the screen says the numbers do not add up */
    expect(acc.textContent).toMatch(/do not add up/);
    const groups = screen.getByTestId("fy-receipts-refused-reasons");
    expect(groups.textContent).toMatch(/249 · … has only … due here/);
    expect(groups.textContent).toMatch(/1 · Its invoices belong to different customers here\./);
    expect(screen.getByText(/^R250$/)).toBeTruthy();
  });

  it("Check first: the sum line names each bucket when it adds up", async () => {
    stub({ imported: 115, already: 0, banked: 100, bank_later: 15, skipped: refused.slice(0, 5) });
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    const acc = await screen.findByTestId("fy-receipts-accounted");
    expect(acc.textContent).toBe("All 160 Zoho payments accounted for: 115 to record · 0 already recorded · 5 refused by the check · 40 left out before the check (reasons above).");
  });
});

describe("R-2693 review fixes — sum line", () => {
  it("a payment recorded earlier whose bank line failed to link is counted ONCE (already), not also as refused", () => {
    const r = { imported: 0, already: 1, skipped: [{ number: "p1", reason: `${BOOKED_EARLIER_PREFIX}: lock timeout` }] };
    expect(accountedText(1, 0, r)).toMatch(/^All 1 Zoho payments accounted for: 0 to record · 1 already recorded · 0 refused by the check/);
  });

  it("the check uses the counts of the plan the server checked (not an older preview)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      if (b.action === "preview") return { ok: true, json: async () => ({ ...preview, parts: 1 }) } as Response;
      /* the scan grew to 161 since the preview (a new payment, left out) */
      return { ok: true, json: async () => ({ ok: true, scanned: 161, leftOut: 41, result: { imported: 120, already: 0, banked: 0, bank_later: 120, skipped: [] } }) } as Response;
    }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    expect((await screen.findByTestId("fy-receipts-accounted")).textContent).toMatch(/^All 161 Zoho payments accounted for: 120 to record · 0 already recorded · 0 refused by the check · 41 left out/);
  });
});

/* R-2653 — Read again keeps what is read; it can be limited to one Zoho deposit account (Razorpay Clearing). */
describe("R-2653 FY receipts — Read again by deposit account", () => {
  const withDeposits = {
    ...preview,
    deposits: [
      { zohoAccountId: "ZA-RZP", zohoName: "Razorpay Clearing", count: 140, amount: 500000, appAccountId: null, suggested: false, leftOut: false },
      { zohoAccountId: "ZA-HDFC", zohoName: "HDFC 4523", count: 2436, amount: 9000000, appAccountId: null, suggested: false, leftOut: false },
      /* payments Zoho gave no account: never a Read-again choice (its value would equal All accounts) */
      { zohoAccountId: "", zohoName: "(no account in Zoho)", count: 3, amount: 3000, appAccountId: null, suggested: false, leftOut: false },
    ],
  };

  it("progress line while Read again checks the list; names the account it is limited to", () => {
    expect(readStatusText({ listed: 2576, detailed: 2576, complete: false, running: true }))
      .toBe("Checking Zoho for new or changed payments — on the server; you can close this window and come back.");
    expect(readStatusText({ listed: 2576, detailed: 2570, complete: false, running: true }, "Razorpay Clearing"))
      .toBe("Read 2,570 of 2,576 (Read again: only Razorpay Clearing) — on the server; you can close this window and come back.");
    expect(readStatusText({ listed: 2576, detailed: 2576, complete: true }, "Razorpay Clearing")).toBe("Read all 2,576 payments. (Read again: only Razorpay Clearing)");
  });

  it("choose Only Razorpay Clearing → Read again sends that account (the scan is not forgotten) and says what is left as it was", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.action === "status") return { ok: true, json: async () => ({ ok: true, listed: 2576, detailed: 2576, complete: true, running: false, error: null }) } as Response;
      if (b.action === "preview") return { ok: true, json: async () => withDeposits } as Response;
      if (b.action === "restart") return { ok: true, json: async () => ({ ok: true, listed: 0, detailed: 0, complete: false, running: false, error: null, onlyAccount: b.onlyAccount }) } as Response;
      if (b.action === "start") return { ok: true, json: async () => ({ ok: true, listed: 2576, detailed: 2576, complete: false, running: true, error: null, onlyAccount: "ZA-RZP" }) } as Response;
      if (b.action === "step") return { ok: true, json: async () => ({ ok: true, listed: 2577, detailed: 2577, complete: true, running: false, error: null, onlyAccount: "ZA-RZP" }) } as Response;
      return { ok: false, json: async () => ({ ok: false, error: "unexpected" }) } as Response;
    }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    const pick = await screen.findByTestId("fy-receipts-only-account");
    expect([...(pick as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["All accounts", "Only Razorpay Clearing", "Only HDFC 4523"]);
    fireEvent.change(pick, { target: { value: "ZA-RZP" } });
    expect(screen.getByTestId("fy-receipts-only-hint").textContent).toMatch(/Only payments deposited to Razorpay Clearing are checked in Zoho/);
    fireEvent.click(screen.getByRole("button", { name: /Read from Zoho again/ }));
    await screen.findByText("Read all 2,577 payments. (Read again: only Razorpay Clearing)", undefined, { timeout: 5_000 });
    const restart = bodies.find((x) => x.action === "restart")!;
    expect(restart).toMatchObject({ action: "restart", onlyAccount: "ZA-RZP" });
    expect(restart.fresh).toBeUndefined();
  });

  it("All accounts (default) → Read again sends no account", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.action === "status") return { ok: true, json: async () => ({ ok: true, listed: 10, detailed: 10, complete: true, running: false, error: null }) } as Response;
      if (b.action === "preview") return { ok: true, json: async () => withDeposits } as Response;
      return { ok: true, json: async () => ({ ok: true, listed: 10, detailed: 10, complete: true, running: false, error: null }) } as Response;
    }));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-receipts-only-account");
    expect(screen.queryByTestId("fy-receipts-only-hint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Read from Zoho again/ }));
    await waitFor(() => expect(bodies.some((x) => x.action === "restart")).toBe(true));
    expect(bodies.find((x) => x.action === "restart")!.onlyAccount).toBeNull();
  });
});
