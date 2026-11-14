import { describe, expect, it } from "vitest";
import { editorStaffNote, joinEditorNotes, splitNotesForEditor } from "./editor-notes";
import { customerQuoteNotes, STAFF_NOTE_MARKER } from "./customer-notes";
import { openRenewalQuoteMap } from "@/app/(app)/renewals/open-renewal-quotes";

const SUB = "c2458000-0000-4000-8000-000000000311";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const lines = [{ name: "Google Workspace Business Starter", commitment: "annual" }];
const ctx = { plan: "Google Workspace Business Starter", extensionMonths: null };
const linked = (notes: string | null) => openRenewalQuoteMap([{ id: "Q-1", notes }]).get(SUB);

describe("R-2754 editor Notes box — no internal id, link kept", () => {
  const stored = `Renewal quote (operator-generated) for subscription ${SUB}`;

  it("the box shows what the customer reads, never the uuid sentence", () => {
    const p = splitNotesForEditor(stored, lines, ctx);
    expect(p.customer).toBe(customerQuoteNotes(stored, lines, ctx));
    expect(p.customer).not.toMatch(UUID);
    expect(p.customer).not.toMatch(/operator-generated|subscription/i);
    expect(p.hidden).toBe(stored);
    expect(editorStaffNote(p)).not.toMatch(UUID);
  });

  it("untouched notes are saved back exactly as stored (no data rewrite)", () => {
    const p = splitNotesForEditor(stored, lines, ctx);
    expect(joinEditorNotes(p, p.customer)).toBe(stored);
    expect(joinEditorNotes(p, `${p.customer}\n`)).toBe(stored);
  });

  it("editing the note keeps the quote ↔ subscription link and the customer sees only the typed text", () => {
    const p = splitNotesForEditor(stored, lines, ctx);
    const saved = joinEditorNotes(p, "Renewal for 12 months. Thank you for your business.");
    expect(linked(saved)).toBe("Q-1");
    expect(customerQuoteNotes(saved, lines, ctx)).toBe("Renewal for 12 months. Thank you for your business.");
    expect(saved).toContain(STAFF_NOTE_MARKER);
  });

  it("clearing the box keeps the link and shows the customer nothing", () => {
    const p = splitNotesForEditor(stored, lines, ctx);
    const saved = joinEditorNotes(p, "  ");
    expect(linked(saved)).toBe("Q-1");
    expect(customerQuoteNotes(saved, lines, ctx)).toBeNull();
  });

  it("cron, create-renewal, extension and domain forms are all held back", () => {
    for (const s of [
      `Auto-generated renewal quote for subscription ${SUB}`,
      `Renewal quote for subscription ${SUB}`,
      `3-month extension for subscription ${SUB}. On payment the renewal date advances by 3 months (to 30 Jun 2027).`,
      `Domain renewal for example.in (subscription ${SUB}), at ResellerClub's live renewal price of ₹799 + GST.`,
    ]) {
      const p = splitNotesForEditor(s, lines, ctx);
      expect(p.customer).not.toMatch(UUID);
      expect(p.customer.length).toBeGreaterThan(0);
      expect(linked(joinEditorNotes(p, "Edited."))).toBe("Q-1");
    }
  });

  it("staff text typed after the system sentence stays in the box; staff-only part stays hidden", () => {
    const s = `Renewal quote for subscription ${SUB}. Includes priority support.\n\n${STAFF_NOTE_MARKER}\nCut: 2 seats removed.`;
    const p = splitNotesForEditor(s, lines, ctx);
    expect(p.customer).toContain("Includes priority support.");
    expect(p.customer).not.toContain("Cut:");
    expect(p.hidden).toContain("Cut: 2 seats removed.");
    const saved = joinEditorNotes(p, "Renewal for 12 months.")!;
    expect(saved).toContain("Cut: 2 seats removed.");
    expect(linked(saved)).toBe("Q-1");
  });

  it("composed notes (customer line + staff part with the id) show only the customer line", () => {
    const s = `Additional seats from 1 Oct 2026 (pro-rata).\n\n${STAFF_NOTE_MARKER}\nRaised from Change plan for subscription ${SUB}.`;
    const p = splitNotesForEditor(s, lines, ctx);
    expect(p.customer).toBe("Additional seats from 1 Oct 2026 (pro-rata).");
    expect(joinEditorNotes(p, p.customer)).toBe(s);
    expect(linked(joinEditorNotes(p, "Changed."))).toBe("Q-1");
  });

  it("a hand-typed subscription id is still kept as a link when the note is edited", () => {
    const s = `Please renew. Ref subscription ${SUB}`;
    const p = splitNotesForEditor(s, lines, ctx);
    expect(p.customer).not.toMatch(UUID);
    expect(linked(joinEditorNotes(p, "Please renew."))).toBe("Q-1");
  });

  it("a staff sentence the customer never sees (backdated by …) survives an edit of the box", () => {
    const s = `Renewal quote for subscription ${SUB}. Backdated by Pardeep Sharma on 2026-11-01, confirm with Hitesh. Includes support.`;
    const p = splitNotesForEditor(s, lines, ctx);
    expect(p.customer).toContain("Includes support.");
    expect(p.customer).not.toMatch(/backdated/i);
    const saved = joinEditorNotes(p, "Thank you.")!;
    expect(saved).toContain("Backdated by Pardeep Sharma on 2026-11-01, confirm with Hitesh.");
    expect(customerQuoteNotes(saved, lines, ctx)).toBe("Thank you.");
    expect(linked(saved)).toBe("Q-1");
  });

  it("a 'subscription id: <uuid>' typed by hand is kept as typed — no new Renewals link is made", () => {
    const s = `See subscription id: ${SUB}`;
    const saved = joinEditorNotes(splitNotesForEditor(s, lines, ctx), "See notes.")!;
    expect(saved).toContain(`See subscription id: ${SUB}`);
    expect(saved).not.toContain("Linked to");
    expect(linked(saved)).toBeUndefined();
  });

  it("a normal note is untouched (box = stored text, saved as typed)", () => {
    const p = splitNotesForEditor("Prices valid for 15 days.", lines, ctx);
    expect(p).toEqual({ customer: "Prices valid for 15 days.", hidden: "", original: "Prices valid for 15 days." });
    expect(joinEditorNotes(p, "New text")).toBe("New text");
    expect(joinEditorNotes(p, "")).toBeNull();
    expect(joinEditorNotes(splitNotesForEditor(null), "")).toBeNull();
  });
});
