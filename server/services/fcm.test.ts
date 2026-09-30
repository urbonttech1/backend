import { describe, it, expect, vi } from 'vitest';

// fcm.ts pulls in the Supabase admin client at import time; the delivery-option
// builder under test touches neither, so a stub keeps this a pure unit test.
vi.mock('../db/client', () => ({ supabaseAdmin: {} }));
vi.mock('./driverRideHistory', () => ({ recordRideOffers: vi.fn() }));

import { deliveryOptions } from './fcm';

const base = { title: 'T', body: 'B' };

describe('deliveryOptions', () => {
  it('always asks iOS for an alert, so it shows with the app backgrounded', () => {
    // Without apns-push-type: alert, iOS can treat the payload as a silent
    // background wake and never display anything.
    for (const type of ['new_ride', 'chat_message', 'weekly_earnings']) {
      const o = deliveryOptions({ ...base, data: { type } });
      expect(o.apns.headers['apns-push-type']).toBe('alert');
    }
  });

  it('sends a ride offer immediately and lets it die after a minute', () => {
    const o = deliveryOptions({ ...base, data: { type: 'new_ride', ride_id: 'r1' } });

    expect(o.android.priority).toBe('high');
    expect(o.android.ttl).toBe(60_000);
    expect(o.apns.headers['apns-priority']).toBe('10');
    expect(o.apns.payload.aps['interruption-level']).toBe('time-sensitive');

    const delta = Number(o.apns.headers['apns-expiration']) - Math.floor(Date.now() / 1000);
    expect(delta).toBeGreaterThan(50);
    expect(delta).toBeLessThanOrEqual(60);
  });

  it('delivers chat instantly but never expires it', () => {
    // A ride offer from ten minutes ago is useless; a message is still worth
    // reading. Priority and lifetime are separate decisions.
    const o = deliveryOptions({ ...base, data: { type: 'chat_message', ride_id: 'r1' } });

    expect(o.android.priority).toBe('high');
    expect(o.android.ttl).toBeUndefined();
    expect(o.apns.headers['apns-expiration']).toBeUndefined();
    // Chat should not punch through Do Not Disturb.
    expect(o.apns.payload.aps['interruption-level']).toBeUndefined();
  });

  it('lets a non-urgent notification travel power-considerately', () => {
    const o = deliveryOptions({ ...base, data: { type: 'weekly_earnings' } });

    expect(o.android.priority).toBe('normal');
    expect(o.android.ttl).toBeUndefined();
    expect(o.apns.headers['apns-priority']).toBe('5');
    expect(o.apns.payload.aps['interruption-level']).toBeUndefined();
  });

  it('keeps chat and ride-status collapsing in separate groups', () => {
    // Sharing one key per ride would make an arrival notice erase an unread
    // message, and vice versa.
    const ride = deliveryOptions({ ...base, data: { type: 'driver_arrived', ride_id: 'r1' } });
    const chat = deliveryOptions({ ...base, data: { type: 'chat_message', ride_id: 'r1' } });

    expect(ride.android.collapseKey).toBe('ride_r1');
    expect(chat.android.collapseKey).toBe('chat_r1');
    expect(ride.apns.headers['apns-collapse-id']).toBe('ride_r1');
    expect(chat.apns.headers['apns-collapse-id']).toBe('chat_r1');
  });

  it('never collapses ride offers, so a driver sees every one', () => {
    // FCM only keeps 4 pending collapse keys per device; collapsing offers would
    // silently drop work a driver could have taken.
    const o = deliveryOptions({ ...base, data: { type: 'new_ride', ride_id: 'r1' } });

    expect(o.android.collapseKey).toBeUndefined();
    expect(o.apns.headers['apns-collapse-id']).toBeUndefined();
  });

  it('threads every notification of a ride together', () => {
    const o = deliveryOptions({ ...base, data: { type: 'ride_completed', ride_id: 'r9' } });
    expect(o.apns.payload.aps.threadId).toBe('r9');
  });

  it('sets no badge, so the icon stops carrying a permanent 1', () => {
    const o = deliveryOptions({ ...base, data: { type: 'ride_completed' } });
    // Checked by key rather than by value: the field is gone from the type too,
    // so reading `.aps.badge` would not even compile.
    expect('badge' in o.apns.payload.aps).toBe(false);
  });

  it('survives a payload with no data at all', () => {
    const o = deliveryOptions(base);

    expect(o.android.priority).toBe('normal');
    expect(o.android.collapseKey).toBeUndefined();
    expect(o.apns.payload.aps.threadId).toBeUndefined();
    expect(o.android.notification.channelId).toBe('urbont_rides');
  });
});
