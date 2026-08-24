import { Resend } from 'resend';
import { logger } from '../lib/logger';

const RESEND_KEY = process.env.RESEND_API_KEY || '';
let resend: Resend | null = null;
if (RESEND_KEY) {
  resend = new Resend(RESEND_KEY);
}
const FROM = process.env.EMAIL_FROM || 'URBONT <receipts@urbont.app>';

export interface RideReceiptData {
  passengerEmail: string;
  passengerName: string;
  driverName: string;
  vehicleType: string;
  pickupAddress: string;
  dropoffAddress: string;
  distanceMiles: number;
  durationMin: number;
  fare: number;
  tip?: number;
  discount?: number;
  paymentMethod: string;
  rideDate: string;
  rideId: string;
  stops?: string[];
}

function receiptHtml(d: RideReceiptData): string {
  const total = d.fare + (d.tip || 0) - (d.discount || 0);
  const stopRows = (d.stops || []).map((s, i) =>
    `<tr><td style="padding:6px 0;color:#5A6B79;font-size:13px;">Stop ${i + 1}</td><td style="padding:6px 0;font-size:13px;text-align:right;">${s}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#E9EEF0;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E9EEF0;padding:32px 16px;">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      
      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#0A2438,#1A5A7F);padding:32px;text-align:center;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:rgba(212,160,85,0.85);letter-spacing:0.22em;text-transform:uppercase;">Trip Receipt</p>
        <h1 style="margin:0;font-size:28px;font-weight:200;color:#FFFFFF;letter-spacing:-0.02em;">URBONT</h1>
        <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.5);">${d.rideDate}</p>
      </td></tr>

      <!-- Route card -->
      <tr><td style="padding:24px 28px 0;">
        <div style="background:#F4F7F9;border-radius:14px;padding:18px;">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;">
            <div style="width:10px;height:10px;border-radius:50%;background:#4ADE80;border:2px solid #4ADE80;margin-top:3px;flex-shrink:0;"></div>
            <p style="margin:0;font-size:14px;color:#0A2438;line-height:1.4;">${d.pickupAddress}</p>
          </div>
          ${stopRows ? `<div style="margin-left:5px;border-left:2px dashed #D4A055;padding-left:15px;margin-bottom:12px;">${stopRows.replace(/<tr><td[^>]*>/g,'<div style="padding:4px 0;color:#5A6B79;font-size:12px;">').replace(/<\/td><td[^>]*>/g,' → ').replace(/<\/td><\/tr>/g,'</div>')}</div>` : ''}
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="width:10px;height:10px;border-radius:50%;background:#1A5A7F;border:2px solid #1A5A7F;margin-top:3px;flex-shrink:0;"></div>
            <p style="margin:0;font-size:14px;color:#0A2438;line-height:1.4;">${d.dropoffAddress}</p>
          </div>
        </div>
      </td></tr>

      <!-- Trip details -->
      <tr><td style="padding:20px 28px 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Chauffeur</td>
            <td style="padding:6px 0;font-size:13px;color:#0A2438;text-align:right;font-weight:500;">${d.driverName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Vehicle</td>
            <td style="padding:6px 0;font-size:13px;color:#0A2438;text-align:right;">${d.vehicleType}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Distance</td>
            <td style="padding:6px 0;font-size:13px;color:#0A2438;text-align:right;">${d.distanceMiles.toFixed(1)} mi</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Duration</td>
            <td style="padding:6px 0;font-size:13px;color:#0A2438;text-align:right;">${d.durationMin} min</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Payment</td>
            <td style="padding:6px 0;font-size:13px;color:#0A2438;text-align:right;">${d.paymentMethod}</td>
          </tr>
        </table>
      </td></tr>

      <!-- Divider -->
      <tr><td style="padding:16px 28px;"><hr style="border:none;border-top:1px solid #E9EEF0;margin:0;"></td></tr>

      <!-- Fare breakdown -->
      <tr><td style="padding:0 28px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 0;color:#5A6B79;font-size:13px;">Ride fare</td>
            <td style="padding:6px 0;font-size:13px;text-align:right;">$${d.fare.toFixed(2)}</td>
          </tr>
          ${d.discount ? `<tr><td style="padding:6px 0;color:#4ADE80;font-size:13px;">Promo discount</td><td style="padding:6px 0;font-size:13px;color:#4ADE80;text-align:right;">-$${d.discount.toFixed(2)}</td></tr>` : ''}
          ${d.tip ? `<tr><td style="padding:6px 0;color:#5A6B79;font-size:13px;">Tip</td><td style="padding:6px 0;font-size:13px;text-align:right;">$${d.tip.toFixed(2)}</td></tr>` : ''}
          <tr>
            <td style="padding:12px 0 6px;color:#0A2438;font-size:16px;font-weight:700;border-top:1px solid #E9EEF0;">Total charged</td>
            <td style="padding:12px 0 6px;font-size:16px;font-weight:700;color:#0A2438;text-align:right;border-top:1px solid #E9EEF0;">$${total.toFixed(2)}</td>
          </tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:24px 28px 32px;text-align:center;">
        <p style="margin:0 0 8px;font-size:11px;color:#9BAAB5;">Ride ID: ${d.rideId}</p>
        <p style="margin:0;font-size:11px;color:#9BAAB5;">Thank you for choosing URBONT — Premium Chauffeur Service in Miami</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export async function sendRideReceipt(data: RideReceiptData): Promise<boolean> {
  if (!resend) {
    logger.warn('[EMAIL] RESEND_API_KEY not set — receipt not sent');
    return false;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to: data.passengerEmail,
      subject: `Your URBONT trip receipt — $${(data.fare + (data.tip || 0) - (data.discount || 0)).toFixed(2)}`,
      html: receiptHtml(data),
    });
    return true;
  } catch (err: any) {
    logger.error(`[EMAIL] Failed to send receipt: ${err.message}`);
    return false;
  }
}
