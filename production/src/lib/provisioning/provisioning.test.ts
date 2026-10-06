import { describe, it, expect } from "vitest";
import {
  UNDERPAYMENT_TOLERANCE,
  decideProvisioning,
  queuedLine,
  testPaymentProvisioningAllowed,
  type ProvisioningInput,
} from "./provisioning";

/** Everything real and wired — the only shape that can reach `activate`. */
const READY: ProvisioningInput = {
  paymentMode: "live",
  paymentVerified: true,
  amountPaid: 146_811,
  amountExpected: 146_811,
  vendor: "google",
  seats: 12,
  vendorApiConfigured: true,
  dialMode: "auto",
};

describe("the hard gate: a test-mode payment can never activate", () => {
  it("QUEUES a test-mode payment even with the dial on auto and the API connected", () => {
    /* THE TEST THIS MODULE EXISTS FOR. Production's razorpay_key_id starts rzp_test_, and a
       test-mode payment is indistinguishable from a real one everywhere except that prefix: the
       customer completes checkout, payment.captured fires, the signature verifies, the amount
       matches — and zero rupees settle.

       "Auto-provision on payment received" therefore means, today, that anybody reaching a test
       checkout gets seats for free in seconds with nobody watching. */
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    expect(out.action).toBe("queue");
    if (out.action === "queue") {
      expect(out.blocker).toBe("test_mode_payment");
      expect(out.reason).toContain("no money settled");
      expect(out.reason).toContain("at any dial setting");
    }
  });

  it("is checked BEFORE the dial, so no setting can override it", () => {
    /* The dial answers "may we act unattended". This answers "is there anything real to act
       on". Ordering them the other way round would make a config change enough to give the
       product away. */
    for (const dialMode of ["off", "hold", "auto"] as const) {
      const out = decideProvisioning({ ...READY, paymentMode: "test", dialMode });
      expect(out.action).toBe("queue");
      if (out.action === "queue") expect(out.blocker).toBe("test_mode_payment");
    }
  });

  it("names the fix rather than just refusing", () => {
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    if (out.action === "queue") expect(out.reason).toContain("Settings → Integrations");
  });
});

describe("what it refuses outright", () => {
  it("refuses an unverified payment event", () => {
    const out = decideProvisioning({ ...READY, paymentVerified: false });
    expect(out.action).toBe("refuse");
  });

  it("REFUSES a part payment rather than queueing it", () => {
    /* A queued request means "activate this once you can", and a part-paid quote should not be
       activated later either. Seats handed over against half the money are seats somebody has
       to claw back, and the customer has done nothing wrong. */
    const out = decideProvisioning({ ...READY, amountPaid: 100_000 });
    expect(out.action).toBe("refuse");
    if (out.action === "refuse") expect(out.reason).toContain("part payment is a conversation");
  });

  it(`tolerates exactly ${UNDERPAYMENT_TOLERANCE} rupees of shortfall`, () => {
    expect(decideProvisioning({ ...READY, amountPaid: 146_810 }).action).toBe("refuse");
    expect(decideProvisioning({ ...READY, amountPaid: 146_811 }).action).toBe("activate");
  });

  it("accepts an OVERpayment, because that is not a reason to withhold seats", () => {
    /* Rounding at the gateway, or a customer paying a round figure. The shortfall check is
       one-directional on purpose. */
    expect(decideProvisioning({ ...READY, amountPaid: 146_900 }).action).toBe("activate");
  });

  it.each([0, -5, 2.5])("refuses %s as a seat count", (seats) => {
    expect(decideProvisioning({ ...READY, seats }).action).toBe("refuse");
  });
});

describe("what it queues, and why", () => {
  it("queues when the Google reseller API is not connected", () => {
    /* src/lib/google-csp/ does not exist, and the setup wizard's step 4 calls it a "preview of
       the 5–7 day application" — the application has not been made. */
    const out = decideProvisioning({ ...READY, vendorApiConfigured: false });
    expect(out.action).toBe("queue");
    if (out.action === "queue") {
      expect(out.blocker).toBe("vendor_api_not_configured");
      expect(out.reason).toContain("5–7 day application");
    }
  });

  it("queues Microsoft and Zoho by name rather than failing generically", () => {
    for (const vendor of ["microsoft", "zoho"] as const) {
      const out = decideProvisioning({ ...READY, vendor });
      expect(out.action).toBe("queue");
      if (out.action === "queue") {
        expect(out.blocker).toBe("vendor_unsupported");
        expect(out.reason).toContain(vendor);
      }
    }
  });

  it("queues when the dial is not on auto", () => {
    for (const dialMode of ["off", "hold"] as const) {
      const out = decideProvisioning({ ...READY, dialMode });
      expect(out.action).toBe("queue");
      if (out.action === "queue") expect(out.blocker).toBe("dial_not_auto");
    }
  });

  it("reports the test-mode blocker ahead of a missing API", () => {
    /* Both are true today. The one that matters is the one about the money — an operator who
       fixes the API first still cannot safely activate. */
    const out = decideProvisioning({ ...READY, paymentMode: "test", vendorApiConfigured: false });
    if (out.action === "queue") expect(out.blocker).toBe("test_mode_payment");
  });
});

describe("activate is reachable, but only with everything true", () => {
  it("activates when the payment is live and verified, the amount matches, and the API is wired", () => {
    const out = decideProvisioning(READY);
    expect(out.action).toBe("activate");
  });

  it("cannot be reached from this deployment's actual state", () => {
    /* Production today: test keys, no CSP adapter. Written as a test so that the day either
       changes, somebody sees this line and thinks about the other one. */
    const asDeployedToday: ProvisioningInput = {
      ...READY,
      paymentMode: "test",
      vendorApiConfigured: false,
      dialMode: "off",
    };
    expect(decideProvisioning(asDeployedToday).action).toBe("queue");
  });
});

describe("queuedLine", () => {
  it("says what was paid, what is waiting, and what is blocking it", () => {
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    if (out.action !== "queue") throw new Error("expected a queue outcome");
    const line = queuedLine({
      customerName: "Rahul Solutions",
      seats: 12,
      amountPaid: 146_811,
      outcome: out,
    });
    expect(line).toContain("Rahul Solutions");
    expect(line).toContain("Rs 1,46,811");
    expect(line).toContain("12 seats");
    expect(line).toContain("TEST-mode");
  });

  it("copes with a customer we have no name for", () => {
    const out = decideProvisioning({ ...READY, dialMode: "hold" });
    if (out.action !== "queue") throw new Error("expected a queue outcome");
    expect(queuedLine({ customerName: "", seats: 1, amountPaid: 100, outcome: out })).toContain("A customer");
  });
});

/* ── Merge brick #4: hosting and domains, which are OURS to provision ────────
   Bricks #1–#3 made these sellable and put them through the money spine. What
   they must NOT do is provision themselves: registering a domain is irreversible
   spend, and the engine that would do it is not connected to this app. These
   tests pin that, and pin that the queue tells the truth about why. */

/** A paid domain registration with everything except an engine connection. */
const DOMAIN_ORDER: ProvisioningInput = {
  paymentMode: "live",
  paymentVerified: true,
  amountPaid: 799,
  amountExpected: 799,
  vendor: "domain",
  seats: 0,                       // a domain has no seats — deliberately 0
  vendorApiConfigured: false,     // the Google adapter; irrelevant here
  dialMode: "auto",
  domainName: "anutechdemo.in",
  engineConnected: false,
};

describe("hosting and domain orders queue on the engine, not a vendor console", () => {
  it("a domain order queues with engine_not_connected, naming the domain", () => {
    const out = decideProvisioning(DOMAIN_ORDER);
    expect(out.action).toBe("queue");
    if (out.action !== "queue") return;
    expect(out.blocker).toBe("engine_not_connected");
    expect(out.reason).toContain("anutechdemo.in");
    expect(out.reason).toContain("ResellerClub");
    /* The old wording sent the desk to "the vendor's own console" — wrong for a
       product we fulfil ourselves. */
    expect(out.reason).not.toContain("vendor's own console");
  });

  it("a hosting order queues the same way, naming DirectAdmin", () => {
    const out = decideProvisioning({ ...DOMAIN_ORDER, vendor: "hosting", domainName: null });
    expect(out.action).toBe("queue");
    if (out.action !== "queue") return;
    expect(out.blocker).toBe("engine_not_connected");
    expect(out.reason).toContain("DirectAdmin");
  });

  it("seats=0 does NOT refuse a hosting order — hosting has no seats", () => {
    /* The seat guard used to refuse anything with seats<=0, which would have
       dropped a paid hosting order on the floor. */
    const out = decideProvisioning({ ...DOMAIN_ORDER, vendor: "hosting", seats: 0, domainName: null });
    expect(out.action).not.toBe("refuse");
  });

  it("REFUSES a domain order that carries no domain name", () => {
    /* Nothing to register, so a queued row would be work nobody can ever drain. */
    for (const name of [null, undefined, "", "   "]) {
      const out = decideProvisioning({ ...DOMAIN_ORDER, domainName: name });
      expect(out.action, `domainName=${JSON.stringify(name)}`).toBe("refuse");
      if (out.action !== "refuse") continue;
      expect(out.reason).toContain("needs the domain name");
    }
  });

  it("a TEST-mode payment still cannot register a domain — real money, irreversibly", () => {
    /* The hard gate applies with more force here than to seats: a domain
       registration spends money that cannot be clawed back. */
    const out = decideProvisioning({ ...DOMAIN_ORDER, paymentMode: "test", engineConnected: true });
    expect(out.action).toBe("queue");
    if (out.action !== "queue") return;
    expect(out.blocker).toBe("test_mode_payment");
  });

  it("a part-paid domain order is refused, not queued", () => {
    const out = decideProvisioning({ ...DOMAIN_ORDER, amountPaid: 400 });
    expect(out.action).toBe("refuse");
  });

  it("the Google-API blocker never speaks for an engine vendor", () => {
    /* vendorApiConfigured describes the CSP adapter. A connected engine order
       must not be blocked by a sentence about a Google application. */
    const out = decideProvisioning({ ...DOMAIN_ORDER, engineConnected: true, vendorApiConfigured: false });
    expect(out.action).toBe("activate");
    if (out.action !== "activate") return;
    expect(out.reason).toContain("engine connected");
    expect(out.reason).toContain("anutechdemo.in");
  });

  it("the dial still holds a connected engine order", () => {
    const out = decideProvisioning({ ...DOMAIN_ORDER, engineConnected: true, dialMode: "hold" });
    expect(out.action).toBe("queue");
    if (out.action !== "queue") return;
    expect(out.blocker).toBe("dial_not_auto");
  });
});

describe("the desk's queue line names the right product", () => {
  it("says the domain, not a seat count", () => {
    const out = decideProvisioning(DOMAIN_ORDER);
    if (out.action !== "queue") throw new Error("expected a queue");
    const line = queuedLine({
      customerName: "Nirvaan Clinics",
      seats: 0,
      amountPaid: 799,
      outcome: out,
      vendor: "domain",
      domainName: "anutechdemo.in",
    });
    expect(line).toContain("anutechdemo.in waiting to be registered");
    expect(line).not.toContain("0 seats");
  });

  it("says the hosting account, not a seat count", () => {
    const out = decideProvisioning({ ...DOMAIN_ORDER, vendor: "hosting", domainName: null });
    if (out.action !== "queue") throw new Error("expected a queue");
    const line = queuedLine({ customerName: "Studio Anka", seats: 0, amountPaid: 599, outcome: out, vendor: "hosting" });
    expect(line).toContain("hosting account waiting to be set up");
    expect(line).not.toContain("seat");
  });

  it("still says seats for a seat sale", () => {
    const out = decideProvisioning({ ...READY, paymentMode: "test" });
    if (out.action !== "queue") throw new Error("expected a queue");
    const line = queuedLine({ customerName: "Acme", seats: 12, amountPaid: 146_811, outcome: out });
    expect(line).toContain("12 seats waiting to be activated");
  });
});

describe("test-mode HOSTING on a local machine (Pawan, 3 Oct 2026)", () => {
  const HOSTING: ProvisioningInput = { ...READY, vendor: "hosting", seats: 1, engineConnected: true, domainName: "acme.in" };

  it("with the local switch, a test payment sets up hosting", () => {
    const out = decideProvisioning({ ...HOSTING, paymentMode: "test", allowTestPayment: true });
    expect(out.action).toBe("activate");
    expect(out.reason).toMatch(/TEST-mode payment/);
  });

  it("never a domain: registering one on a test payment spends real money", () => {
    const out = decideProvisioning({ ...READY, vendor: "domain", seats: 1, engineConnected: true, domainName: "acme.in", paymentMode: "test", allowTestPayment: true });
    expect(out.action === "queue" && out.blocker).toBe("test_mode_payment");
  });

  it("still obeys the dial and the engine connection", () => {
    const held = decideProvisioning({ ...HOSTING, paymentMode: "test", allowTestPayment: true, dialMode: "hold" });
    expect(held.action === "queue" && held.blocker).toBe("dial_not_auto");
    const off = decideProvisioning({ ...HOSTING, paymentMode: "test", allowTestPayment: true, engineConnected: false });
    expect(off.action === "queue" && off.blocker).toBe("engine_not_connected");
  });

  it("without the switch, the hard gate is unchanged", () => {
    const out = decideProvisioning({ ...HOSTING, paymentMode: "test" });
    expect(out.action === "queue" && out.blocker).toBe("test_mode_payment");
  });

  it("the switch is dead in a production build, whatever the variable says", () => {
    expect(testPaymentProvisioningAllowed({ NODE_ENV: "development", ALLOW_TEST_PAYMENT_PROVISIONING: "1" })).toBe(true);
    expect(testPaymentProvisioningAllowed({ NODE_ENV: "production", ALLOW_TEST_PAYMENT_PROVISIONING: "1" })).toBe(false);
    expect(testPaymentProvisioningAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(testPaymentProvisioningAllowed({ NODE_ENV: "development", ALLOW_TEST_PAYMENT_PROVISIONING: "true" })).toBe(false);
  });
});
