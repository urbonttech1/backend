// ── Firebase Phone Auth — server-side ID token verification ──────────────────
// Verifies Firebase Phone Auth ID tokens issued by the client after signInWithPhoneNumber.
// Firebase Admin SDK is shared with FCM (fcm.ts) — the default app is reused if already
// initialized, so no double-initialization occurs.
//
// Required env vars (same credential already used for push notifications):
//   FIREBASE_SERVICE_ACCOUNT — Firebase service account JSON as a single-line string

import { createContextLogger } from '../lib/logger';

const log = createContextLogger('FIREBASE_PHONE_AUTH');

let _adminApp: unknown = null;
let _initialized = false;

async function getAdminApp(): Promise<unknown> {
  if (_initialized) return _adminApp;
  _initialized = true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    log.warn('FIREBASE_SERVICE_ACCOUNT not set — Firebase Phone Auth verification disabled');
    return null;
  }

  try {
    const admin = await import('firebase-admin');

    // Reuse existing default app initialized by fcm.ts if present
    if (admin.default.apps.length > 0) {
      _adminApp = admin.default.apps[0];
      log.info('Reusing existing Firebase Admin app for Phone Auth');
      return _adminApp;
    }

    const serviceAccount = JSON.parse(serviceAccountJson);
    _adminApp = admin.default.initializeApp({
      credential: admin.default.credential.cert(serviceAccount),
    });
    log.info('Firebase Admin initialized for Phone Auth');
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to initialize Firebase Admin for Phone Auth');
    _adminApp = null;
  }

  return _adminApp;
}

export function isFirebasePhoneAuthConfigured(): boolean {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

/**
 * Verifies a Firebase Phone Auth ID token and returns the verified E.164 phone number.
 * Throws if the token is invalid, expired, or does not belong to a phone auth user.
 */
export async function verifyFirebasePhoneToken(idToken: string): Promise<string> {
  const app = await getAdminApp();
  if (!app) {
    throw new Error('Firebase Phone Auth is not configured. Set FIREBASE_SERVICE_ACCOUNT.');
  }

  const admin = await import('firebase-admin');

  let decodedToken: unknown;
  try {
    // checkRevoked=true ensures tokens from signed-out users are rejected
    decodedToken = await admin.default.auth(app as import('firebase-admin/app').App).verifyIdToken(idToken, true);
  } catch (err: any) {
    const code: string = err.code || '';
    if (code === 'auth/id-token-expired') throw new Error('Firebase token has expired. Please re-authenticate.');
    if (code === 'auth/id-token-revoked') throw new Error('Firebase token has been revoked. Please re-authenticate.');
    if (code === 'auth/argument-error') throw new Error('Invalid Firebase token format.');
    log.warn({ err: err.message, code }, 'Firebase ID token verification failed');
    throw new Error(`Firebase token verification failed: ${err.message}`);
  }

  const phone = (decodedToken as { phone_number?: string })?.phone_number;
  if (!phone) {
    throw new Error('Firebase token does not contain a verified phone number. Ensure Phone Authentication was used.');
  }

  // Log with masked phone for privacy
  log.info({ phone: phone.slice(0, 3) + '***' + phone.slice(-4) }, 'Firebase phone token verified');
  return phone;
}
