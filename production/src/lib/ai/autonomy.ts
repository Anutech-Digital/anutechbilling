/**
 * How much the app is allowed to do on a customer's behalf without a person present.
 *
 * ─── WHY THIS EXISTS, AND THE MEASUREMENT THAT PROMPTED IT ───────────────────
 * Asked on 23 Aug 2026: "can an AI sales agent do a real salesperson's job?" The audit that
 * followed found something more urgent than the answer. **There is no way to stop this app
 * emailing customers from inside this app.** Five crons — invoice dunning, renewals, trial
 * expiry, compliance reminders, birthday greetings — send unattended today, and the only
 * way to stop any of them is to disable a Cloud Scheduler job in a Google console. Grepped
 * for `ai_enabled`, `emails_paused`, `sending_paused`, `DISABLE_EMAIL`: nothing.
 *
 * So this is not scaffolding for a future agent. It is the brake the current app is missing,
 * and it is worth having before anything else is automated.
 *
 * ─── THE MODES, AND WHY THREE ───────────────────────────────────────────────
 *   auto  — do it, nobody is watching
 *   hold  — prepare it and wait for a person. NOT the same as off: the work is done, the
 *           draft exists, and the operator's next action is one tap rather than a blank page
 *   off   — do not do it at all
 *
 * "hold" is the mode that makes a dial useful instead of binary. Every AI route in this repo
 * today is effectively `hold` — 13 of them draft and none of them send — and that has been
 * fine. The dial exists so moving one of them to `auto` is a decision somebody makes, in one
 * place, reversibly.
 *
 * ─── THE DEFAULTS ARE "WHAT THE APP DOES TODAY", DELIBERATELY ────────────────
 * The obvious design — default everything to `hold` and let config opt in — would have
 * SILENTLY STOPPED five working crons the moment this was wired, because no tenant has any
 * config yet. Dunning would quietly stop chasing money. So each action declares the mode
 * that is live right now, and that declaration is the fallback. Introducing the brake must
 * not itself change behaviour; that is a separate, visible decision.
 *
 * A new action added later declares its own default, and the review question for the author
 * is exactly the right one: is this safe to do while nobody is looking?
 */

export type AutonomyMode = "off" | "hold" | "auto";

export interface AiActionSpec {
  /** Shown in the UI and written into the audit log. */
  label: string;
  /**
   * What this action does TODAY, before anyone configures anything. See the header: this is
   * a record of current behaviour, not an aspiration.
   */
  today: AutonomyMode;
  /**
   * Which modes make sense for it. Creating a lead cannot be "held" — there is no draft
   * lead to hold — so a config asking for that is a mistake worth reporting rather than
   * silently rounding off.
   */
  supports: readonly AutonomyMode[];
  /**
   * R-1608 (19 Oct 2026): set when the code behind this dial exists but no page, route or cron
   * calls it yet. The dial stays declared (so the code type-checks and the default is recorded),
   * but /automation does not show it and the API refuses to change it: a control that controls
   * nothing reads as a brake the operator does not have. Remove the flag when the caller ships.
   */
  notWired?: string;
}

export const AI_ACTIONS = {
  "public_chat.learn": {
    label: "Learn from website chat conversations",
    /* The public agent distils ONE lesson from each finished conversation; approved lessons
       go back into its own prompt (lib/ai/public-chat-lessons.ts). R-727 (23 Oct 2026): `hold`,
       and `auto` is no longer a mode it supports — the conversation comes from an anonymous
       visitor, so a lesson could carry their instruction to every later visitor. Each lesson
       waits on /automation for Use lesson / Discard. A stored "auto" is reported and falls
       back to `hold` (resolveAutonomy). */
    today: "hold",
    supports: ["off", "hold"],
  },
  "lead.create": {
    label: "Create a lead from an inbound email",
    today: "auto",
    supports: ["off", "auto"],
  },
  "quote.draft": {
    label: "Draft a quote from an enquiry",
    today: "auto",
    supports: ["off", "auto"],
  },
  "quote.send": {
    label: "Email a drafted quote to the customer",
    /* Live since 23 Aug 2026, and already gated on the customer having stated the billing
       term — see lib/quotes/auto-send-quote.ts. That gate is a FACT check and stays whatever
       this dial says; the dial can only make it stricter. */
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  "reply.send": {
    label: "Send a written reply to a customer",
    /* WAS `off`, and that was a description rather than a policy: nothing could send a
       reply. Built on 23 Aug 2026 (lib/ai/run-auto-reply.ts), so `off` stopped being true
       and the default moved to `hold`.

       `hold`, not `auto`, and this is the whole shape of the rollout. The machinery works:
       the drafter runs, `decideAutoReply` checks seven conditions, and `findPromises` refuses
       anything naming a price, a date, a discount or a guarantee. What is missing is not code
       — it is Pardeep having watched it. So it prepares the reply, files the draft on the
       lead's timeline where he already looks, logs the decision, and sends nothing. He moves
       this to `auto` from /automation when he believes it.

       This is the first sentence the app would ever write to a customer unattended. A default
       of `auto` would have made that a side effect of a deploy instead of a decision. */
    today: "hold",
    supports: ["off", "hold", "auto"],
  },
  "followup.send": {
    label: "Send a follow-up nudge to a quiet lead",
    /* WAS `off`, and that was a description rather than a policy: nothing could send a
       follow-up, so `off` was simply true. Built on 24 Aug 2026 — `ai_sales_loops` plus
       api/cron/ai-sales-loop — so `off` stopped being true and the default moved to `hold`,
       exactly as `reply.send`'s did the day before.

       `hold`, not `auto`, and for a sharper reason than the reply path. A reply answers
       somebody who just wrote to you; a nudge writes to somebody who chose not to answer. If
       the agent misjudges the moment, a reply looks clumsy and a nudge looks like pestering —
       so this is the one Pardeep should watch longest before widening. It drafts onto the
       lead's timeline meanwhile, which is where he already looks. */
    today: "hold",
    supports: ["off", "hold", "auto"],
  },
  "support.reply.send": {
    label: "Answer a customer's support request",
    /* WAS not declared at all, because nothing could answer a support request: inbound mail to
       support@ opened a ticket and stopped there (api/webhooks/inbound-email, the `support`
       branch). Built on 24 Aug 2026 — lib/ai/support-agent.ts plus the two inbound routes — so
       the action exists now and has to be declarable.

       `hold`, and this is the one to watch longest of the three. A sales reply that misreads
       the customer loses a deal; a SUPPORT reply that misreads the customer is a set of
       instructions somebody follows, in their own DNS zone or their own admin console. The
       guards are real — no record value the tenant has not verified, no credential request, no
       price, and an outage backstop that overrules the model's own severity — but none of them
       is Pardeep having read twenty of these first. He moves this to `auto` from /automation
       when he believes it.

       Meanwhile the answer is drafted, filed on the ticket's transcript and visible on the
       Support screen, so the desk is faster even at `hold`. */
    today: "hold",
    supports: ["off", "hold", "auto"],
  },
  "payment.link.send": {
    label: "Send a customer a payment link",
    /* `hold`. The link itself is harmless — it collects the amount already on a quote the
       customer has seen — but it is a customer-facing message asking for money, and this
       deployment's Razorpay key is a TEST key (measured 25 Aug 2026). A test link takes a
       payment and settles nothing, so an unattended one would ask a real customer to pay into
       a sandbox and then tell them it worked.

       At `hold` the link is CREATED and filed on the quote's timeline, so the operator copies
       it into their own reply. Useful at hold, which is the bargain every dial in this file
       has made. */
    today: "hold",
    supports: ["off", "hold", "auto"],
    /* R-1608: createAndSendPaymentLink (lib/payments/payment-link.server.ts) has no caller yet. */
    notWired: "R-1608 — payment links are built but nothing sends one yet",
  },
  "agreement.esign.send": {
    label: "Send an agreement to a customer for digital signature",
    /* `off`, and like `provisioning.activate` this is a description rather than caution: there
       is nothing to switch on. Aadhaar eSign is not a link you can mint — under the IT Act 2000
       s.3A and its Second Schedule it runs through an eSign Service Provider licensed by the
       CCA, against a contract, with UIDAI authentication of the signer. No such provider is
       configured for any tenant here.

       It also stays off after one is. A signature is the most binding thing this application
       could ever cause: the moment it lands, the obligations exist, and nobody can un-sign it.
       Every other irreversible action here — a payment link, a provisioning activation — waits
       for a person, and `decideSignatureRequest` refuses at ANY dial setting unless somebody has
       read the specific rendered document. That check is deliberately not a config, for the same
       reason the test-key gate on provisioning is not: the dial answers "may we act unattended",
       and reading a contract before sending it is not a preference. */
    today: "off",
    supports: ["off", "hold"],
  },
  "provisioning.activate": {
    label: "Activate a customer's seats after payment",
    /* `off`, and unlike every other entry here that is not caution — it is a description.
       There is nothing to switch on: `src/lib/google-csp/` does not exist, the Google Workspace
       Reseller API needs an approved reseller agreement plus OAuth, and the setup wizard's own
       step 4 calls it "a preview of the 5–7 day application" — an application that has not been
       made. `off` is what this file's header asks for: the mode that is live right now.

       And even once it exists, `decideProvisioning` will refuse to activate against a test-mode
       payment at ANY dial setting. That gate is deliberately not a config: the dial answers
       "may we act unattended", and the test-key check answers "is there anything real to act
       on". Turning this to `auto` today would mean giving seats away to anybody who reaches a
       sandbox checkout. */
    today: "off",
    supports: ["off", "hold", "auto"],
  },
  "telecall.place": {
    label: "Ring a customer with the AI voice agent",
    /* WAS not declared at all, because nothing could ring anybody. Built on 25 Aug 2026 —
       lib/ai/telecaller-prompt.ts, lib/telecall/provider.ts and the two /api/v1/telecalling
       routes — so the action exists now and has to be declarable.

       `hold`, and of everything in this registry it is the one to leave there longest. Each
       action above sends TEXT: an email or a WhatsApp message, which the customer reads at
       their own moment, which can be followed by a correction sitting next to the original,
       and which exists as a draft a person can read before it goes. A phone call has none of
       those properties. It interrupts, it cannot be edited, it cannot be recalled, and the
       first draft a human ever sees is a transcript of something the customer already heard.

       So `hold` here means something specific and useful rather than "off with extra steps":
       the app resolves the number, reads the catalogue, builds the whole script and the
       dynamic variables, writes the row to `ai_telecall_logs` with status `held` — and dials
       nothing. The operator opens that row, sees exactly what would have been said and to
       whom, and rings by hand in the meantime. That is the same bargain `support.reply.send`
       made: useful at hold, so nobody is tempted to move the dial just to get the value.

       There is a second reason, and it is not ours to overrule. An unsolicited commercial
       call in India is the CALLER's regulatory problem, not the telephony vendor's. Moving
       this to `auto` is a decision about the company's exposure, and it belongs to Pardeep at
       /automation rather than to whoever merges this. */
    today: "hold",
    supports: ["off", "hold", "auto"],
  },
  /* There is deliberately NO entry for the escalation notice or the SLA breach alert, and it
     is the same rule that removed `compliance.send`: those go to OUR OWN support desk — "this
     ticket has waited 40 minutes and nobody has taken it" — not to a customer. This dial stops
     what the app sends OUT to other people; it must never be able to silence what the app says
     TO US. A kill switch that also muted the unassigned-escalation alarm would turn one busy
     morning into a customer discovering we never answered. */
  "dunning.send": {
    label: "Chase an overdue invoice",
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  "renewal.send": {
    label: "Send a renewal reminder",
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  "trial.send": {
    label: "Send a trial-expiry reminder",
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  /* `compliance.send` was listed here and then removed on the same day, deliberately.
     Compliance reminders go to the TENANT'S OWN TEAM — "your GSTR-1 is due" — not to a
     customer. This dial stops what the app sends OUT to other people; it must never be able
     to silence what the app says TO YOU. A kill switch that also muted the GST filing alarm
     would turn one bad afternoon into a late fee.

     Owner alerts in the crons are ungated for the same reason, and a registry entry nobody
     enforces is worse than no entry — so the action is gone rather than declared and
     ignored. There is a test asserting every remaining action IS wired. */
  "greeting.send": {
    label: "Send a birthday or anniversary greeting",
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  /* 25 Sep 2026. The register-domains worker tells the customer their domain is registered
     and where to manage it. `auto` because it states a fact that already happened and
     carries no price, date or promise; it is on this dial so it can be stopped like every
     other customer send (L62-L65). */
  "domain.registered.send": {
    label: "Tell a customer their domain is registered",
    today: "auto",
    supports: ["off", "hold", "auto"],
  },
  /* R-2158 (AI-02, goal G-ADS-AI, 30 Oct 2026) — the AI ad agent's money actions. Pardeep's
     decision D3: the AI RECOMMENDS; anything that raises spend waits for a person, so the three
     spend-up actions do not support `auto` at all (a stored "auto" is reported and falls back to
     hold). Lowering a budget or pausing may run alone — `auto` — but only inside the company's
     change-per-day cap, which the database holds (ad_agent_action_request, migration
     20261030084431); with no caps set they are held too. All five are `notWired` until the agent
     graph (AI-07 publish, AI-08 monitor) calls lib/marketing/ad-safety → requestAdAction. */
  "ads.publish": {
    label: "Publish an AI-made ad campaign to Google / Meta",
    today: "hold",
    supports: ["off", "hold"],
    notWired: "R-2158 — the ad agent's publish node is not built yet (AI-07)",
  },
  "ads.budget_up": {
    label: "Raise an ad campaign's daily budget",
    today: "hold",
    supports: ["off", "hold"],
    notWired: "R-2158 — the ad agent's monitor node is not built yet (AI-08)",
  },
  "ads.new_creative": {
    label: "Add a new AI-made ad to a running campaign",
    today: "hold",
    supports: ["off", "hold"],
    notWired: "R-2158 — the ad agent's monitor node is not built yet (AI-08)",
  },
  "ads.budget_down": {
    label: "Lower an ad campaign's daily budget (inside the company cap)",
    today: "auto",
    supports: ["off", "hold", "auto"],
    notWired: "R-2158 — the ad agent's monitor node is not built yet (AI-08)",
  },
  "ads.pause": {
    label: "Pause a losing ad campaign (inside the company cap)",
    today: "auto",
    supports: ["off", "hold", "auto"],
    notWired: "R-2158 — the ad agent's monitor node is not built yet (AI-08)",
  },
} as const satisfies Record<string, AiActionSpec>;

export type AiAction = keyof typeof AI_ACTIONS;

/** R-1608: the dials /automation shows — every action except those marked `notWired`. */
export function visibleAiActions(): AiAction[] {
  return (Object.keys(AI_ACTIONS) as AiAction[]).filter((id) => !(AI_ACTIONS[id] as AiActionSpec).notWired);
}

export interface AutonomyPolicy {
  /**
   * ONE switch that stops everything customer-facing, whatever the per-action modes say.
   *
   * The thing this app did not have. It outranks every other setting on purpose: the moment
   * somebody needs it, they need it to work without reading ten rows first — a wrong price
   * has gone out, or a template is broken, and the question is "how do I make it stop".
   */
  killSwitch: boolean;
  /** Per-action overrides. Anything absent falls back to that action's `today`. */
  modes?: Partial<Record<AiAction, AutonomyMode>>;
}

export interface AutonomyVerdict {
  mode: AutonomyMode;
  /** Always present, including on `auto` — the audit log records why, not just what. */
  reason: string;
}

export function resolveAutonomy(action: AiAction, policy: AutonomyPolicy): AutonomyVerdict {
  /* Widened to the interface on purpose. `as const satisfies` keeps AI_ACTIONS literal so
     the registry tests can iterate it, but that also narrows `supports` to a per-action
     tuple, and `includes` then refuses the wider AutonomyMode. Reading through the
     interface is the honest fix; a cast at the `includes` call would work and would be a
     lie about what is being compared. */
  const spec: AiActionSpec = AI_ACTIONS[action];

  if (policy.killSwitch) {
    return {
      mode: "off",
      reason:
        `automation is switched off for this workspace — "${spec.label}" did not run. ` +
        "Turn it back on in Settings when you are ready.",
    };
  }

  const configured = policy.modes?.[action];

  if (configured && !spec.supports.includes(configured)) {
    /* Reported, not rounded off. A config asking to "hold" a lead creation is somebody's
       misunderstanding, and answering it silently with the default would hide that they
       believe something untrue about the system. */
    return {
      mode: spec.today,
      reason:
        `"${configured}" is not a mode "${spec.label}" can be in (it supports ` +
        `${spec.supports.join(", ")}), so the current default "${spec.today}" was used — ` +
        "fix the setting",
    };
  }

  if (configured) {
    return { mode: configured, reason: `set to "${configured}" for this workspace` };
  }

  return {
    mode: spec.today,
    reason: `no setting for this action, so its default "${spec.today}" applies`,
  };
}

/** Convenience for the common question. Never true when the kill switch is on. */
export function mayActUnattended(action: AiAction, policy: AutonomyPolicy): boolean {
  return resolveAutonomy(action, policy).mode === "auto";
}

/* ─── THE INVERSION, NAMED AND TESTED ──────────────────────────────────────
   The screen shows a switch labelled "Automation is on". The database stores
   `ai_kill_switch`. Those are OPPOSITES, and the first version of the page got both
   halves of that backwards — caught 23 Aug 2026 by clicking the switch in a browser:
   turning automation OFF popped a dialog reading "Turn automation back on?", and would
   then have written `killSwitch: false`, leaving automation running.

   A kill switch that silently does nothing is worse than no kill switch, because
   somebody will believe they stopped the mail. Two one-line functions, so the mapping
   is asserted instead of re-derived at a call site. */

/** UI "automation is on" → the value the `ai_kill_switch` column stores. */
export function killSwitchFor(automationOn: boolean): boolean {
  return !automationOn;
}

/**
 * Which direction needs confirming: turning automation back ON.
 *
 * Off is the safe move and asking would slow down the emergency the switch exists for.
 * On resumes mail to real customers, which is the half that cannot be taken back.
 */
export function needsConfirmation(automationOn: boolean): boolean {
  return automationOn;
}

/**
 * Ek dial badalne par log me kya likha jaye.
 *
 * ─── YE ALAG FUNCTION KYUN HAI ──────────────────────────────────────────────
 * Ye line route ke andar inline ban sakti thi, aur tab iska koi test na hota — 28 Aug 2026
 * ko isi shakl ki do galtiyan pakdi ja chuki hain (card ka faisla page me inline tha,
 * expired-sync-token ki pehchan listConnections me inline thi; dono ke test khokhle nikle).
 *
 * ─── AUR ISME `from` KYUN HAI ───────────────────────────────────────────────
 * "ab auto hai" adhoora jawab hai. Ek hafte baad log padhne wale ka sawaal ye hota hai ki
 * "us quote ke jane se pehle kya badla tha" — aur uska jawab `hold → auto` hai, `auto` nahi.
 */
export function autonomyChangeReason(
  label: string,
  previous: AutonomyMode,
  next: AutonomyMode,
): string {
  /* Dobara wahi value save karna galti nahi hai (screen par do baar click), par use "badla"
     likhna jhooth hoga — log me ek aisa badlav dikhta jo hua hi nahi. */
  return previous === next
    ? `a person re-saved "${label}" as ${next} — it was already ${next}`
    : `a person changed "${label}" from ${previous} to ${next}`;
}
