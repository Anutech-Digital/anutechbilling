import { describe, it, expect } from "vitest";
import { isValidReviewLink, tooSoon, daysSince, reviewEmail, reviewWhatsAppText, whatsAppLink } from "./review-request";

describe("review requests", () => {
  it("accepts only an absolute https link", () => {
    expect(isValidReviewLink("https://g.page/r/CabcXYZ/review")).toBe(true);
    expect(isValidReviewLink("http://g.page/r/x")).toBe(false);
    expect(isValidReviewLink("g.page/r/x")).toBe(false);
    expect(isValidReviewLink("")).toBe(false);
    expect(isValidReviewLink(null)).toBe(false);
  });

  it("does not ask again within 30 days", () => {
    const now = new Date("2026-09-26T10:00:00Z");
    expect(tooSoon("2026-09-10T10:00:00Z", now)).toBe(true);
    expect(tooSoon("2026-08-20T10:00:00Z", now)).toBe(false);
    expect(tooSoon(null, now)).toBe(false);
    expect(daysSince("2026-09-25T10:00:00Z", now)).toBe(1);
  });

  it("email carries the link in text and html, first name only, and escapes", () => {
    const m = reviewEmail({ contactName: "Deepak Sharma", company: "Demo <Co>", sender: "Anutech", link: "https://g.page/r/abc/review" });
    expect(m.subject).toBe("A quick favour, Deepak?");
    expect(m.text).toContain("https://g.page/r/abc/review");
    expect(m.html).toContain('href="https://g.page/r/abc/review"');
    expect(m.html).not.toContain("<Co>");
    expect(reviewEmail({ contactName: null, company: null, sender: "A", link: "https://x.y" }).subject).toBe("A quick favour, there?");
  });

  it("WhatsApp link: Indian 10-digit gets 91, none without a number", () => {
    const t = reviewWhatsAppText({ contactName: "Deepak", company: null, sender: "Anutech", link: "https://g.page/r/abc" });
    expect(t).toContain("https://g.page/r/abc");
    expect(whatsAppLink("98990 65121", t)).toMatch(/^https:\/\/wa\.me\/919899065121\?text=/);
    expect(whatsAppLink("+91 98990 65121", t)).toMatch(/^https:\/\/wa\.me\/919899065121\?/);
    expect(whatsAppLink("12345", t)).toBeNull();
    expect(whatsAppLink(null, t)).toBeNull();
  });
});
