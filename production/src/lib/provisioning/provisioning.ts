/**
 * Whether a paid quote may activate seats by itself.
 *
 * Pure, and it says NO for two reasons that are both facts about this deployment rather than
 * caution in general. Both were measured on 25 Aug 2026.
 *
 * ─── REASON ONE: THE PAYMENT MAY NOT BE MONEY ───────────────────────────────
 * `tenant_secrets.razorpay_key_id` on production starts `rzp_test_`. A test-mode payment
 * behaves exactly like a real one from the code's point of view: the customer completes a
 * checkout, Razorpay fires `payment.captured`, the webhook verifies the signature, and the
 * amount matches the quote. Nothing distinguishes it except the key prefix — and it settles
 * ZERO RUPEES.
 *
 * "Auto-provision on payment received" therefore means, today: anybody who reaches a test
 * checkout gets seats activated for free, automatically, in seconds, with no human in the loop
 * to notice. That is not a risk to be weighed against convenience; it is the feature working
 * exactly as specified and giving the product away.
 *
 * So the key prefix is a HARD gate. Not a dial, not a config, not overridable — `mode: "test"`
 * can never reach `activate`. The dial gates whether we may act unattended; this gates whether
 * the thing we would be acting on is real.
 *
 * ─── REASON TWO: THERE IS NOTHING TO CALL ───────────────────────────────────
 * `src/lib/google-csp/` does not exist. The Google Workspace Reseller API needs an approved
 * reseller agreement and OAuth credentials, and the setup wizard's own step 4 describes it as
 * "preview of the 5–7 day application" — the application has not been made. "Seats activate ho
 * jayengi 5 seconds mein" has no endpoint behind it.
 *
 * What this module does instead is QUEUE the activation with everything needed to perform it,
 * so that the day CSP access exists it is one adapter away — and meanwhile the desk sees "paid,
 * awaiting activation" instead of the nothing it sees today. A queue that a person drains is
 * not the feature that was asked for; it is the honest version of it, and it is strictly better
 * than the current state where a paid quote produces no activation signal at all.
 */

/**
 * `hosting` and `domain` joined the list with merge brick #4 (2 Sep 2026), and
 * they are a different KIND of case from Microsoft and Zoho. Those two are
 * activated in someone else's console and always will be. Hosting and domains
 * are OURS — DirectAdmin and ResellerClub, behind the Anutech engine — so the
 * only thing between a paid order and an automatic account is a connection this
 * app does not have yet. The queue should say that, not "go to the vendor".
 */
export type ProvisioningVendor =
  | "google" | "microsoft" | "zoho"
  | "hosting" | "domain"
  | "other";

/** Vendors provisioned by our own engine rather than a third party's console. */
export const ENGINE_VENDORS: readonly ProvisioningVendor[] = ["hosting", "domain"];

export type ProvisioningOutcome =
  /** Everything is real and wired — go. Cannot be reached today; see the header. */
  | { action: "activate"; reason: string }
  /** Write the request and leave it for a person. */
  | { action: "queue"; reason: string; blocker: ProvisioningBlocker }
  /** Do not even queue — the payment is not something to act on. */
  | { action: "refuse"; reason: string };

export type ProvisioningBlocker =
  | "test_mode_payment"
  | "vendor_api_not_configured"
  | "dial_not_auto"
  | "vendor_unsupported"
  /** Ours to provision (hosting/domain), but the engine isn't reachable from here yet. */
  | "engine_not_connected";

export interface ProvisioningInput {
  /** From `razorpayMode(key_id)`. The HARD gate — see the header. */
  paymentMode: "live" | "test";
  /** True only when the webhook verified the signature AND the amount matched the quote. */
  paymentVerified: boolean;
  /** ₹ received, whole rupees. */
  amountPaid: number;
  /** ₹ the quote asked for, whole rupees. */
  amountExpected: number;
  vendor: ProvisioningVendor;
  seats: number;
  /** Does a reseller-API adapter exist and hold credentials for this vendor? */
  vendorApiConfigured: boolean;
  /** `provisioning.activate` resolved from the autonomy dial. */
  dialMode: "off" | "hold" | "auto";
  /**
   * The name being registered or hosted, for the engine vendors. A domain order
   * without one cannot be acted on by anybody — see the refusal in
   * decideProvisioning. Ignored for seat vendors.
   */
  domainName?: string | null;
  /**
   * True only when this app can actually reach the Anutech engine AND holds a
   * credential to order on it. Hardcoded false at the call sites today: the
   * engine's public read APIs answer 404 on the deployed build, and no
   * server-to-server credential exists for its ordering endpoints. Like
   * `vendorApiConfigured`, it is passed in rather than read from config, so a
   * config cannot claim a connection that isn't there.
   */
  engineConnected?: boolean;
  /**
   * Local testing only (Pawan, 3 Oct 2026: "even in test mode allow me to create hosting —
   * otherwise how will I test"). From `testPaymentProvisioningAllowed()`, which is false in
   * every production build. Lets a TEST-mode payment set up HOSTING, so the whole paid flow
   * can be tried on a laptop; a domain is never registered on a test payment, because that
   * spends real money at the registrar.
   */
  allowTestPayment?: boolean;
}

/**
 * Whether this app may set up hosting against a TEST-mode payment: only with
 * ALLOW_TEST_PAYMENT_PROVISIONING=1 AND outside a production build. The live site still runs
 * on test keys (see the test file), so the key prefix cannot be the guard — the build is.
 */
export function testPaymentProvisioningAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.ALLOW_TEST_PAYMENT_PROVISIONING?.trim() === "1";
}

/**
 * How much less than the quote we will still act on.
 *
 * Zero. A part payment is a conversation, not an activation: seats handed over against half the
 * money are seats somebody has to claw back, and the customer has done nothing wrong. Written as
 * a named constant rather than a bare `!==` so the intent is not mistaken for an oversight.
 */
export const UNDERPAYMENT_TOLERANCE = 0;

export function decideProvisioning(input: ProvisioningInput): ProvisioningOutcome {
  if (!input.paymentVerified) {
    return {
      action: "refuse",
      reason: "the payment was not verified — nothing is provisioned on an unverified event",
    };
  }

  const isEngineVendor = ENGINE_VENDORS.includes(input.vendor);

  /* Seat vendors must carry a real seat count. Hosting and a domain are not
     seats — one account, one registration — so a hosting quote that never had a
     `seats` value is normal, not a defect, and refusing it would drop a paid
     order on the floor. Quantity is only checked for what is actually counted. */
  if (!isEngineVendor && (input.seats <= 0 || !Number.isInteger(input.seats))) {
    return { action: "refuse", reason: `${input.seats} is not a seat count that can be activated` };
  }

  /* A domain order with no name is unactionable by anyone: there is nothing to
     register. Refused rather than queued, because a queued row a person cannot
     drain is worse than none — it sits in the desk's list forever looking like
     work. Hosting can be set up and pointed at a domain later, so it is exempt. */
  if (input.vendor === "domain" && !input.domainName?.trim()) {
    return {
      action: "refuse",
      reason: "a domain registration needs the domain name — the order does not carry one, so there is nothing to register",
    };
  }

  const shortfall = input.amountExpected - input.amountPaid;
  if (shortfall > UNDERPAYMENT_TOLERANCE) {
    /* Refuse rather than queue: a queued request implies "activate this once you can", and a
       part-paid quote should not be activated later either. It needs a person and a
       conversation. */
    return {
      action: "refuse",
      reason:
        `Rs ${shortfall.toLocaleString("en-IN")} short of the quoted amount — a part payment is ` +
        "a conversation, not an activation",
    };
  }

  /* ── THE HARD GATE ──────────────────────────────────────────────────────────
     Checked before the dial, and not overridable by it. The dial answers "may we act
     unattended"; this answers "is there anything real to act on". A test-mode payment settles
     nothing, so activating against it gives the product away — and it looks identical to a real
     payment everywhere except the key prefix. */
  const testHostingAllowed = input.paymentMode === "test" && input.allowTestPayment === true && input.vendor === "hosting";
  if (input.paymentMode === "test" && !testHostingAllowed) {
    return {
      action: "queue",
      blocker: "test_mode_payment",
      reason:
        "this payment came through a TEST-mode Razorpay key, so no money settled — the seats " +
        "are queued and will not be activated automatically at any dial setting. Switch to live " +
        "keys in Settings → Integrations before this can complete on its own.",
    };
  }

  if (isEngineVendor && !input.engineConnected) {
    /* Ours to fulfil, so the true next step is "connect the engine", not "go to
       a vendor console". Merge brick #4: the queue carries the plan and the name
       so the order can be placed the moment that connection exists. */
    const what = input.vendor === "domain"
      ? `the registration of ${input.domainName?.trim()}`
      : "the hosting account";
    return {
      action: "queue",
      blocker: "engine_not_connected",
      reason:
        `${what} is set up on our own engine (${input.vendor === "domain" ? "ResellerClub" : "DirectAdmin"}), ` +
        "which this app cannot order on yet — app.anutech.in has not been deployed with the ordering " +
        "connection. The order is queued with the plan and name it needs.",
    };
  }

  if (input.vendor !== "google" && !isEngineVendor) {
    /* Microsoft and Zoho have their own partner APIs and their own agreements. Naming the
       limitation beats a generic failure that reads like a bug. */
    return {
      action: "queue",
      blocker: "vendor_unsupported",
      reason: `${input.vendor} seats are activated in the vendor's own console — no reseller API is wired for it`,
    };
  }

  /* Google only. An engine vendor that reached this line HAS its connection —
     `vendorApiConfigured` describes the CSP adapter and says nothing about
     DirectAdmin or ResellerClub, so letting it answer for them would block a
     hosting order with a sentence about a Google application. */
  if (input.vendor === "google" && !input.vendorApiConfigured) {
    return {
      action: "queue",
      blocker: "vendor_api_not_configured",
      reason:
        "the Google Workspace Reseller API is not connected — the reseller agreement and OAuth " +
        "credentials are a 5–7 day application that has not been made. The activation is queued " +
        "with everything it needs.",
    };
  }

  if (input.dialMode !== "auto") {
    return {
      action: "queue",
      blocker: "dial_not_auto",
      reason: `provisioning is set to "${input.dialMode}" for this workspace — queued for a person to release`,
    };
  }

  const subject = input.vendor === "domain"
    ? `${input.domainName?.trim()} registration`
    : input.vendor === "hosting"
      ? "hosting account"
      : `${input.seats} seats`;
  return {
    action: "activate",
    reason: testHostingAllowed
      ? `TEST-mode payment — hosting set up anyway because this is a local machine with test provisioning switched on, ${subject}, engine connected`
      : `payment verified in live mode, ${subject}, ${isEngineVendor ? "engine connected" : "reseller API connected"}`,
  };
}

/**
 * The line the desk reads on a queued activation.
 *
 * Says what was paid, what is waiting, and what is blocking it — in that order, because the
 * operator's first question is "has the money arrived" and their second is "what do I do".
 */
export function queuedLine(input: {
  customerName: string;
  seats: number;
  amountPaid: number;
  outcome: Extract<ProvisioningOutcome, { action: "queue" }>;
  /** Omit for seat sales; both are used to name a hosting/domain order properly. */
  vendor?: ProvisioningVendor;
  domainName?: string | null;
}): string {
  /* "3 seats waiting to be activated" is wrong for a domain — a domain has no
     seats, and a desk reading it wonders which product this even is. */
  const waiting =
    input.vendor === "domain"
      ? `${input.domainName?.trim() || "a domain"} waiting to be registered`
      : input.vendor === "hosting"
        ? "a hosting account waiting to be set up"
        : `${input.seats} seat${input.seats === 1 ? "" : "s"} waiting to be activated`;

  return (
    `${input.customerName || "A customer"} paid Rs ${input.amountPaid.toLocaleString("en-IN")} — ` +
    `${waiting}. ` +
    input.outcome.reason
  );
}
