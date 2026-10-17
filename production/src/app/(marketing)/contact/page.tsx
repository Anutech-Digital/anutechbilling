/**
 * Support and contact for customers of Anutech Digital (30 Sep 2026). It lives at /contact
 * because /support and /help are staff pages inside the app, and the middleware treats any
 * path STARTING with those as signed-in only. DMS's old /contact link lands here too.
 */
import type { Metadata } from "next";
import { SupportBody } from "@/site/components/support/SupportBody";

export const metadata: Metadata = {
  title: "Support",
  description: "Ask anything about a domain, hosting, email or a bill. A person answers, by email.",
};

export default function ContactPage() {
  return (
    <section className="section rise">
      <div className="wrap">
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>Support</h1>
        <p className="body-lg" style={{ margin: "0 0 30px", maxWidth: 640 }}>
          Ask anything about a domain, hosting, email or a bill. A person answers, by email.
        </p>
        <SupportBody />
      </div>
    </section>
  );
}
