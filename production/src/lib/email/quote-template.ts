/**
 * Quotation Email Template Helper — generates rich HTML emails with 1-click
 * Accept Quotation CTA buttons for customers and Sales Team Acknowledgement alerts.
 */

import { rupee } from "@/lib/utils";

export interface QuoteEmailData {
  quoteId: string;
  customerName: string;
  tenantName: string;
  tenantEmail?: string | null;
  tenantPhone?: string | null;
  totalAmount: number;
  expiresDate?: string | null;
  acceptUrl: string;
  lineItems?: Array<{ name: string; qty: number; rate: number }>;
}

export function buildCustomerQuoteHtml(data: QuoteEmailData): string {
  const itemsHtml = (data.lineItems ?? [])
    .map(
      (item) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #111827;">${item.name}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #111827; text-align: center;">${item.qty}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #111827; text-align: right;">${rupee(item.rate)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; font-weight: bold; color: #111827; text-align: right;">${rupee(item.qty * item.rate)}</td>
      </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { border-bottom: 2px solid #6366f1; padding-bottom: 16px; margin-bottom: 24px; }
    .title { font-size: 22px; font-weight: 800; color: #1e1b4b; margin: 0 0 4px 0; }
    .subtitle { font-size: 14px; color: #6b7280; margin: 0; }
    .cta-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0; }
    .btn-accept { display: inline-block; background-color: #16a34a; color: #ffffff !important; font-weight: bold; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; box-shadow: 0 2px 4px rgba(22,163,74,0.3); }
    .btn-accept:hover { background-color: #15803d; }
    .summary-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .footer { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 32px; border-top: 1px solid #f3f4f6; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">${data.tenantName}</h1>
      <p class="subtitle">Official Commercial Quotation #${data.quoteId}</p>
    </div>

    <p style="font-size: 15px; color: #374151;">Dear <strong>${data.customerName}</strong>,</p>
    <p style="font-size: 14px; color: #4b5563; line-height: 1.5;">
      Thank you for considering <strong>${data.tenantName}</strong> for your technology and licensing needs. Below is the summary of your customized quotation.
    </p>

    <!-- Call To Action Box -->
    <div class="cta-box">
      <div style="font-size: 18px; font-weight: bold; color: #15803d; margin-bottom: 8px;">
        Total Investment: ${rupee(data.totalAmount)}
      </div>
      <p style="font-size: 12px; color: #166534; margin: 0 0 16px 0;">
        Valid until: ${data.expiresDate ? data.expiresDate : "30 days from issue"}
      </p>
      <a href="${data.acceptUrl}" class="btn-accept" target="_blank">
        ✅ View & Accept Quotation Online
      </a>
    </div>

    ${
      data.lineItems && data.lineItems.length > 0
        ? `
    <h3 style="font-size: 14px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.05em; margin-bottom: 8px;">Product & Service Line Items</h3>
    <table class="summary-table">
      <thead>
        <tr style="background: #f9fafb;">
          <th style="padding: 8px 10px; text-align: left; font-size: 12px; color: #6b7280;">Item</th>
          <th style="padding: 8px 10px; text-align: center; font-size: 12px; color: #6b7280;">Qty</th>
          <th style="padding: 8px 10px; text-align: right; font-size: 12px; color: #6b7280;">Rate</th>
          <th style="padding: 8px 10px; text-align: right; font-size: 12px; color: #6b7280;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    `
        : ""
    }

    <p style="font-size: 13px; color: #6b7280; margin-top: 24px;">
      Direct Access Link: <br/>
      <a href="${data.acceptUrl}" style="color: #4f46e5; word-break: break-all;">${data.acceptUrl}</a>
    </p>

    <div class="footer">
      <p>Questions? Reply directly to this email or call ${data.tenantPhone || "our sales desk"}.</p>
      <p>© ${new Date().getFullYear()} ${data.tenantName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
}

export function buildSalesAcknowledgementHtml(data: {
  quoteId: string;
  customerName: string;
  tenantName: string;
  totalAmount: number;
  acceptedAt: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { border-bottom: 2px solid #16a34a; padding-bottom: 16px; margin-bottom: 24px; }
    .title { font-size: 22px; font-weight: 800; color: #14532d; margin: 0 0 4px 0; }
    .alert-box { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 20px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">🎉 Sales Alert: Quotation Accepted!</h1>
      <p style="font-size: 14px; color: #6b7280; margin: 0;">${data.tenantName} Sales Portal Notification</p>
    </div>

    <p style="font-size: 15px; color: #374151;">Great news! Customer <strong>${data.customerName}</strong> has accepted quotation <strong>#${data.quoteId}</strong>.</p>

    <div class="alert-box">
      <div style="font-size: 16px; font-weight: bold; color: #047857; margin-bottom: 6px;">
        Deal Value: ${rupee(data.totalAmount)}
      </div>
      <div style="font-size: 13px; color: #065f46;">
        Accepted At: ${data.acceptedAt}
      </div>
    </div>

    <p style="font-size: 14px; color: #4b5563;">
      <strong>Automated Pipeline Triggered:</strong><br/>
      • Lead converted to active customer (Stage: Won).<br/>
      • Purchase Order & Tax Invoice draft ready in ResellerOS ERP.
    </p>

    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f3f4f6; font-size: 12px; color: #9ca3af; text-align: center;">
      ResellerOS Automated Sales Acknowledgement Engine
    </div>
  </div>
</body>
</html>
`;
}
