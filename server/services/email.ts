// Ride receipt — the single source of truth for its layout.
// `receiptHtml` is exported so the manual resend endpoint
// (POST /api/rides/:id/send-receipt) renders the very same template instead of
// keeping a second copy of it, which is what it used to do.
import { sendEmail } from './mailer';
import { emailShell, section, row, totalRow, brand, FONT } from './emailLayout';

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

export function receiptHtml(d: RideReceiptData): string {
  const total = d.fare + (d.tip || 0) - (d.discount || 0);
  const money = (n: number) => `$${n.toFixed(2)}`;

  const stopsBlock = (d.stops || []).length
    ? `<div style="margin:12px 0 12px 5px;padding-left:15px;border-left:2px dashed ${brand.gold};">
         ${(d.stops || []).map((s, i) => `<div style="font-family:${FONT};font-size:12px;color:${brand.slate};padding:3px 0;">Stop ${i + 1} — ${s}</div>`).join('')}
       </div>`
    : '';

  const content = `
    ${section(`
      <div style="background:${brand.panel};border-radius:14px;padding:18px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="22" valign="top" style="padding-top:4px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${brand.green};"></div></td>
          <td style="font-family:${FONT};font-size:14px;color:${brand.navyDeep};line-height:1.45;">${d.pickupAddress}</td>
        </tr></table>
        ${stopsBlock}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:${(d.stops || []).length ? '0' : '14px'};"><tr>
          <td width="22" valign="top" style="padding-top:4px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${brand.navyMid};"></div></td>
          <td style="font-family:${FONT};font-size:14px;color:${brand.navyDeep};line-height:1.45;">${d.dropoffAddress}</td>
        </tr></table>
      </div>`)}

    ${section(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('Chauffeur', d.driverName, { strong: true })}
        ${row('Vehicle', d.vehicleType)}
        ${row('Distance', `${d.distanceMiles.toFixed(1)} mi`)}
        ${row('Duration', `${d.durationMin} min`)}
        ${row('Payment', d.paymentMethod)}
      </table>`, '20px 30px 0')}

    ${section(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('Ride fare', money(d.fare))}
        ${d.discount ? row('Promo discount', `-${money(d.discount)}`, { color: brand.green }) : ''}
        ${d.tip ? row('Tip', money(d.tip)) : ''}
        ${totalRow('Total charged', money(total))}
      </table>`, '18px 30px 6px')}
  `;

  return emailShell({
    eyebrow:  'Trip Receipt',
    subtitle: d.rideDate,
    content,
    footerNote: `Ride ID: ${d.rideId}`,
  });
}

export async function sendRideReceipt(data: RideReceiptData): Promise<boolean> {
  const total = data.fare + (data.tip || 0) - (data.discount || 0);
  return sendEmail({
    to:       data.passengerEmail,
    subject:  `Your URBONT trip receipt — $${total.toFixed(2)}`,
    html:     receiptHtml(data),
    category: 'ride_receipt',
  });
}
