import { describe, it, expect } from "vitest";
import {
  kindReadiness, defaultParamMap, mappingProblem, isStarterReminderName, logStatus, skipReasonText,
  SKIP_REASON_TEXT, REMINDER_KIND_ORDER, type KindInput, type KnownTemplate,
} from "./whatsapp-reminders-settings";
import { REMINDER_KINDS, STARTER_REMINDER_TEMPLATES, type SkipReason } from "./whatsapp-reminders";

const BODY_5 = "Hi {{1}}, invoice {{2}} for {{3}} is due on {{4}}.\n\n— {{5}}";
const APPROVED: KnownTemplate = { name: "invoice_due_v1", language: "en", status: "approved", body: BODY_5 };
const MAP = { kind: "invoice_due", template_name: "invoice_due_v1", language: "en",
  param_map: ["customer_name", "invoice_id", "amount", "due_date", "seller_name"], enabled: true };

const base = (o: Partial<KindInput> = {}): KindInput => ({
  kind: "invoice_due", switchOn: true, connected: true, dialMode: "auto", killSwitch: false,
  mapping: MAP, templates: [APPROVED], ...o,
});

describe("kindReadiness — the screen says what the cron would do", () => {
  it("ready only when switch ON, template approved, dial auto, WhatsApp connected", () => {
    expect(kindReadiness(base()).state).toBe("ready");
  });

  it("no mapping → no_template, whatever else is set", () => {
    expect(kindReadiness(base({ mapping: null })).state).toBe("no_template");
  });

  it("a mapped name Meta has not approved is NOT ready — and says the status it has", () => {
    const r = kindReadiness(base({ templates: [{ ...APPROVED, status: "submitted" }] }));
    expect(r.state).toBe("not_approved");
    expect(r.text).toContain("submitted");
    expect(r.text).toMatch(/Sync from Meta/);
  });

  it("a name the app has never seen is not approved, and says to submit + sync", () => {
    const r = kindReadiness(base({ templates: [] }));
    expect(r.state).toBe("not_approved");
    expect(r.text).toMatch(/not in the app's templates/);
  });

  it("the language must match too — en approved does not approve hi", () => {
    expect(kindReadiness(base({ mapping: { ...MAP, language: "hi" } })).state).toBe("not_approved");
  });

  it("a disabled mapping is reported as such", () => {
    expect(kindReadiness(base({ mapping: { ...MAP, enabled: false } })).state).toBe("template_disabled");
  });

  it("the automation dial on hold or off blocks, and so does the kill switch", () => {
    expect(kindReadiness(base({ dialMode: "hold" })).state).toBe("dial_blocks");
    expect(kindReadiness(base({ dialMode: "off" })).text).toMatch(/\/automation/);
    const k = kindReadiness(base({ killSwitch: true }));
    expect(k.state).toBe("dial_blocks");
    expect(k.text).toMatch(/master switch/);
  });

  it("not connected is said up front", () => {
    expect(kindReadiness(base({ connected: false })).state).toBe("not_connected");
  });

  it("switch OFF with everything else fine reads as 'taiyaar', not as ready", () => {
    const r = kindReadiness(base({ switchOn: false }));
    expect(r.state).toBe("switch_off");
    expect(r.tone).not.toBe("success");
  });

  it("template problems are shown even while the switch is OFF (set up first, flip last)", () => {
    expect(kindReadiness(base({ switchOn: false, mapping: null })).state).toBe("no_template");
  });
});

describe("defaultParamMap", () => {
  it("keeps what the owner saved when it still fits the body", () => {
    const saved = ["seller_name", "invoice_id", "amount", "due_date", "customer_name"] as const;
    expect(defaultParamMap("invoice_due", "invoice_due_v1", BODY_5, [...saved])).toEqual(saved);
  });

  it("a starter name with nothing saved gets the starter's own map", () => {
    const s = STARTER_REMINDER_TEMPLATES.find((x) => x.kind === "renewal_upcoming")!;
    expect(defaultParamMap("renewal_upcoming", s.name, s.body)).toEqual(s.param_map);
    expect(defaultParamMap("renewal_upcoming", s.name, null)).toEqual(s.param_map);
  });

  it("pads to the body's slot count with customer_name (never a guessed money field)", () => {
    expect(defaultParamMap("invoice_due", "custom_x", "Hi {{1}} {{2}}", ["amount"])).toEqual(["amount", "customer_name"]);
    expect(defaultParamMap("invoice_due", "custom_x", "Hi {{1}}", ["amount", "days"])).toEqual(["amount"]);
  });

  it("unknown body and no starter: keeps the saved list as is", () => {
    expect(defaultParamMap("invoice_due", "custom_x", null, ["days"])).toEqual(["days"]);
    expect(defaultParamMap("invoice_due", "custom_x", null)).toEqual([]);
  });

  it("isStarterReminderName knows the six starters", () => {
    for (const s of STARTER_REMINDER_TEMPLATES) expect(isStarterReminderName(s.name)).toBe(true);
    expect(isStarterReminderName("festival_offer")).toBe(false);
  });
});

describe("mappingProblem — refused before save, with what to do", () => {
  it("accepts a valid mapping", () => {
    expect(mappingProblem("invoice_due_v1", "en", MAP.param_map, BODY_5)).toBeNull();
    expect(mappingProblem("invoice_due_v1", "en", ["amount"], null)).toBeNull();
  });
  it("refuses a name Meta would not have (capitals, spaces)", () => {
    expect(mappingProblem("Invoice Due", "en", [], null)).toMatch(/a-z/);
  });
  it("refuses a bad language", () => {
    expect(mappingProblem("x", "e", [], null)).toMatch(/Language/);
  });
  it("refuses a field the sender does not know", () => {
    expect(mappingProblem("x", "en", ["first_name"], null)).toMatch(/Pick a field/);
  });
  it("refuses a slot count that does not match the known body", () => {
    expect(mappingProblem("invoice_due_v1", "en", ["customer_name"], BODY_5)).toMatch(/5 slots/);
  });
});

describe("log labels", () => {
  it("names all five log statuses, and survives an unknown one", () => {
    for (const s of ["sent", "delivered", "read", "failed", "skipped"]) expect(logStatus(s).label).not.toBe(s);
    expect(logStatus("weird")).toEqual({ label: "weird", tone: "muted" });
    expect(logStatus("failed").tone).toBe("danger");
  });

  it("has words for every skip reason the sender can write", () => {
    const reasons: SkipReason[] = [
      "disabled", "automation_off", "no_template", "template_disabled", "template_not_approved",
      "bad_param_map", "no_phone", "opted_out", "already_sent", "missing_value", "not_configured",
    ];
    expect(Object.keys(SKIP_REASON_TEXT).sort()).toEqual([...reasons].sort());
    expect(skipReasonText("opted_out")).toMatch(/STOP/);
    expect(skipReasonText(null)).toBeNull();
    expect(skipReasonText("new_reason")).toBe("new_reason");
  });

  it("lists every reminder kind the schema allows, in order", () => {
    expect(REMINDER_KIND_ORDER).toEqual(Object.keys(REMINDER_KINDS));
    expect(REMINDER_KIND_ORDER).toHaveLength(6);
  });
});
