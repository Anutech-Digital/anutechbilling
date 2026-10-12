import { describe, it, expect } from "vitest";
import { isBounce, bouncedAddress } from "./bounce";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, live screen. Four of the seventeen mails in ANUTECH's Inbox were
   bounces, badged with the raw word "ignored", each offering a "Send quote" button
   aimed at mailer-daemon@googlemail.com.

   The body below is the REAL one, copied out of `inbound_emails` — including the
   RFC 3464 delivery-status block, which is what makes the failed address readable
   rather than guessable.
   ───────────────────────────────────────────────────────────────────────────── */

const REAL_BODY = [
  "** Address not found **",
  "",
  "Your message wasn't delivered to darshan@anutech.in because the address couldn't be found, or is unable to receive mail.",
  "",
  "Learn more here: https://support.google.com/mail/?p=NoSuchUser",
  "",
  "The response was:",
  "",
  "The email account that you tried to reach does not exist.",
  "",
  "Final-Recipient: rfc822; darshan@anutech.in",
  "Action: failed",
  "Status: 5.1.3",
].join("\n");

const REAL: Parameters<typeof isBounce>[0] = {
  from_email: "mailer-daemon@googlemail.com",
  subject:    "Delivery Status Notification (Failure)",
  body_text:  REAL_BODY,
};

describe("isBounce — the live case", () => {
  it("ANUTECH ka asli bounce pakadta hai", () => {
    expect(isBounce(REAL)).toBe(true);
  });

  it("sender se pehchanta hai, chahe subject kuch bhi ho", () => {
    for (const from of [
      "mailer-daemon@googlemail.com", "MAILER-DAEMON@x.in",
      "postmaster@outlook.com", "bounces@sendgrid.net", "bounce@mailgun.org",
    ]) {
      expect(isBounce({ from_email: from, subject: "anything at all" })).toBe(true);
    }
  });

  it("subject se pehchanta hai, chahe sender aam pata ho", () => {
    for (const subject of [
      "Delivery Status Notification (Failure)",
      "Undeliverable: Quote for 40 seats",
      "Mail delivery failed: returning message to sender",
      "Message blocked",
      "Address not found",
      "Returned mail: see transcript for details",
    ]) {
      expect(isBounce({ from_email: "mail@somehost.com", subject })).toBe(true);
    }
  });
});

describe("isBounce — jo bounce NAHI hai", () => {
  it("out-of-office bounce NAHI hai — mail pahunch gaya, insaan Monday ko padhega", () => {
    /* Yahi wo farq hai jiske liye ye file alag likhi gayi. `follow-up.ts` ki
       AUTO_SUBJECTS jaan-boojhkar chaudi hai — wahan OOO aur bounce ka jawab ek hi
       hai ("koi intezaar nahi kar raha"). Yahan wo ulte hain. */
    for (const subject of [
      "Automatic reply: Out of office",
      "Auto Reply: I am on leave",
      "Out of Office — back on Monday",
    ]) {
      expect(isBounce({ from_email: "deepak@customer.in", subject })).toBe(false);
    }
  });

  it("asli enquiry bounce nahi hai", () => {
    expect(isBounce({
      from_email: "deepakandideepak@gmail.com",
      subject: "mujhe 40 email account google workspace business starter chahiye",
    })).toBe(false);
  });

  it("no-reply wala security alert bounce nahi hai — wo bhi 'ignored' hota hai", () => {
    /* Dono ka status `ignored` hai. Ek par kuch karna hai, doosre par kuch nahi.
       Isi liye status se pehchanna kaafi nahi tha. */
    expect(isBounce({
      from_email: "no-reply@accounts.google.com",
      subject: "Security alert",
    })).toBe(false);
  });

  it("khaali / null par crash nahi, aur 'haan' bhi nahi", () => {
    expect(isBounce(null)).toBe(false);
    expect(isBounce(undefined)).toBe(false);
    expect(isBounce({ from_email: null, subject: null })).toBe(false);
  });
});

describe("bouncedAddress — kaunsa pata refuse hua", () => {
  it("asli bounce se sahi pata nikalta hai", () => {
    expect(bouncedAddress(REAL)).toBe("darshan@anutech.in");
  });

  it("Final-Recipient akela bhi kaafi hai — prose na ho tab bhi", () => {
    expect(bouncedAddress({
      from_email: "mailer-daemon@x.in", subject: "Undeliverable",
      body_text: "Final-Recipient: rfc822; user1@bigcorp.co.in\nAction: failed",
    })).toBe("user1@bigcorp.co.in");
  });

  it("prose akela bhi kaafi hai — delivery-status block na ho tab bhi", () => {
    expect(bouncedAddress({
      from_email: "mailer-daemon@x.in", subject: "Undeliverable",
      body_text: "Your message wasn't delivered to raj@example.com because the address couldn't be found.",
    })).toBe("raj@example.com");
  });

  it("vaakya ka viraam pate ka hissa nahi hai", () => {
    expect(bouncedAddress({
      from_email: "mailer-daemon@x.in", subject: "Undeliverable",
      body_text: "Your message wasn't delivered to raj@example.com.",
    })).toBe("raj@example.com");
  });

  it("na mile to NULL — andaza nahi", () => {
    /* Bounce ke matn me kai pate hote hain: jo fail hua, humara apna, aur reporting
       server ka. "Pehla email jaisa dikhne wala" uthana aksar HAMARA apna pata
       lauta deta — aur rep ek aisi entry theek karne chala jata jo pehle se sahi hai. */
    expect(bouncedAddress({
      from_email: "mailer-daemon@x.in", subject: "Delivery Status Notification (Failure)",
      body_text: "Something went wrong. Contact support@googlemail.com for help.",
    })).toBeNull();
    expect(bouncedAddress({ from_email: "a@b.c", subject: "x", body_text: "" })).toBeNull();
    expect(bouncedAddress(null)).toBeNull();
  });
});
