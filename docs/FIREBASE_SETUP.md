# URBONT — Firebase Setup Guide

This document details every Firebase feature integrated into URBONT and the steps required to activate each one.

---

## 🔑 Environment Variables

### Client (`.env` — Vite frontend)

| Variable | Where to get it | Required |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_PROJECT_ID` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_APP_ID` | Firebase Console → Project Settings → General | ✅ |
| `VITE_FIREBASE_MEASUREMENT_ID` | Firebase Console → Project Settings → General | Optional |
| `VITE_FIREBASE_VAPID_KEY` | Firebase Console → Project Settings → Cloud Messaging → Web configuration → **Generate key pair** | ✅ for web push |
| `VITE_RECAPTCHA_V3_SITE_KEY` | [console.firebase.google.com](https://console.firebase.google.com) → App Check → reCAPTCHA v3 | Optional (App Check) |

> **Important:** The Firebase public config values (`apiKey`, `appId`, etc.) are **not secrets** — they identify your project and are safe to commit. Only `FIREBASE_SERVICE_ACCOUNT` on the server is sensitive.

### Server (`.env` — Node.js backend)

| Variable | Where to get it | Required |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service accounts → **Generate new private key** → paste the entire JSON as a single-line string | ✅ for push delivery |

#### Generating the service account key

1. Go to **Firebase Console → Project Settings → Service accounts**
2. Click **"Generate new private key"** → **Generate key**
3. Open the downloaded JSON file
4. Copy the entire file contents
5. Paste it as a single line in your `.env`:
   ```
   FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"urbonttech-e182d",...}
   ```
   > Tip: `cat service-account.json | tr -d '\n'` gives you a single-line version.

---

## 📦 Features Integrated

### 1. Push Notifications (FCM)

**Files:**
- `src/lib/firebase.ts` — `getFcmToken`, `onForegroundMessage`, `onFcmTokenRefresh`
- `src/lib/pushRegistration.ts` — register for push on login
- `src/hooks/usePushNotifications.ts` — React hook for push state
- `public/firebase-messaging-sw.js` — background notification handler
- `server/services/fcm.ts` — server-side send via Firebase Admin
- `server/api/notifications.ts` — token registration, broadcast, stats

**How it works:**
- On login: `registerPushNotifications(accessToken)` is called
- Web: requests permission → gets FCM token → POSTs to `/api/notifications/token`
- Android/iOS: Capacitor registers with FCM → native token → POSTs to `/api/notifications/token`
- Server events (ride accepted, driver arrived, etc.) trigger `notifyUser(userId, payload)`
- Background messages handled by the Service Worker with action buttons

**Admin broadcast:**
```http
POST /api/notifications/broadcast
Cookie: urbont_admin_session=...

{
  "title": "New promotion!",
  "body": "Book your ride and get 20% off this weekend.",
  "audience": "passengers",   // "all" | "passengers" | "drivers" | "valets"
  "platform": "all"           // "all" | "ios" | "android" | "web"
}
```

**Send to one user:**
```http
POST /api/notifications/send-to-user
Cookie: urbont_admin_session=...

{ "user_id": "uuid", "title": "...", "body": "..." }
```

**Push token stats:**
```http
GET /api/notifications/stats
Cookie: urbont_admin_session=...
```

---

### 2. Phone Authentication

**Files:**
- `src/lib/firebasePhoneAuth.ts` — client OTP send/verify
- `server/services/firebasePhoneAuth.ts` — server-side ID token verification
- `server/api/auth/otp.ts` — `/api/otp/firebase/verify` endpoint

**Setup in Firebase Console:**
1. Authentication → Sign-in method → Phone → **Enable**
2. Authentication → Settings → Authorized domains → add your production domain
3. For testing: Authentication → Phone numbers → Add test phone number

---

### 3. Analytics

**Files:**
- `src/lib/firebaseAnalytics.ts` — all typed event functions
- `src/lib/firebase.ts` — `logAnalyticsEvent`, `getFirebaseAnalytics`

**Events tracked:**
- Auth: login, signup, logout
- Booking: booking started, vehicle selected, ride requested, ride completed, cancellation
- Payments: purchase, tip given, promo applied, payment method added
- Driver: online/offline, ride accepted/rejected, streak milestone, earnings viewed
- Features: Gift Ride, Split Fare, Airport Pickup, SmartChat, SOS
- UX: screen views, language changed, theme toggle, PWA install

**Usage in your components:**
```ts
import { analyticsEvents } from '../lib/firebaseAnalytics';

analyticsEvents.rideRequested({
  vehicle_type: 'Business Class',
  fare: 45.00,
  ride_type: 'immediate',
  promo_applied: true,
});
```

**View in Firebase Console:** Analytics → Events (data appears after ~24h)

---

### 4. Remote Config

**Files:**
- `src/lib/firebaseRemoteConfig.ts` — fetch, cache, typed getters
- `src/hooks/useRemoteConfig.ts` — React hook with reactive updates

**Setup in Firebase Console:**
1. Remote Config → **Add parameter**
2. Set key exactly as listed below → set value → **Publish**

**Available parameters:**

| Key | Type | Default | Purpose |
|---|---|---|---|
| `maintenance_mode` | boolean | false | Shows maintenance banner, blocks booking |
| `maintenance_message` | string | "" | Custom maintenance message |
| `min_app_version` | string | "1.0.0" | Force-update gate |
| `surge_multiplier` | number | 1.0 | Current pricing multiplier |
| `surge_reason` | string | "" | Label shown to passengers ("High demand") |
| `new_ride_timeout_sec` | number | 30 | Driver offer countdown |
| `driver_search_radius_km` | number | 15 | Broadcast radius for new rides |
| `feature_giftrride` | boolean | true | Gift Ride feature flag |
| `feature_splitfare` | boolean | true | Split Fare feature flag |
| `feature_airport_tracking` | boolean | true | Flight tracking feature flag |
| `feature_smartchat_ai` | boolean | true | AI translation in SmartChat |
| `feature_loyalty_program` | boolean | true | Loyalty program tab |
| `promo_banner_text` | string | "" | Promotional banner (empty = hidden) |
| `promo_banner_url` | string | "" | Deep-link URL for promo banner |
| `support_phone_number` | string | "" | Displayed in support screen |
| `tip_percentages` | string | "15,18,20,25" | CSV tip options |

**Usage in your components:**
```ts
import { useRemoteConfig, useFeatureFlags, useSurge } from '../hooks/useRemoteConfig';

const { maintenanceMode, promoBannerText } = useRemoteConfig();
const features = useFeatureFlags();
const { surgeMultiplier, surgeReason } = useSurge();
```

---

### 5. Performance Monitoring

**Files:**
- `src/lib/firebasePerformance.ts` — `startTrace`, `recordTrace`, `recordApiTrace`
- `src/lib/firebase.ts` — `initFirebasePerformance`

**Automatic monitoring (enabled on init):**
- Page load time
- Time to first contentful paint
- Network request durations (XHR/fetch)

**Custom traces (add to key operations):**
```ts
import { recordTrace, recordApiTrace } from '../lib/firebasePerformance';

// Wrap any async operation
const fare = await recordTrace('fare_calculation', () => calculateFare(pickup, dropoff));

// Wrap API calls
const ride = await recordApiTrace('POST /api/rides', () => createRide(payload));
```

**View in Firebase Console:** Performance → Custom traces (after 24h)

---

### 6. App Check

**Files:**
- `src/lib/firebaseAppCheck.ts` — reCAPTCHA v3 provider, debug mode
- `src/lib/firebase.ts` — `initFirebaseAppCheck`

**Setup:**
1. Firebase Console → **App Check** → Register your web app
2. Choose **reCAPTCHA v3**
3. Get site key from [Google reCAPTCHA Admin](https://www.google.com/recaptcha/admin)
4. Set `VITE_RECAPTCHA_V3_SITE_KEY` in `.env`
5. (Optional) Enforce per-service: App Check → APIs → toggle enforcement

**Debug tokens (development):**
In dev mode (`import.meta.env.DEV`), App Check prints a debug token to the console.
Register that token in: Firebase Console → App Check → Apps → Manage debug tokens.

---

## 🚀 Initialization (App.tsx)

All Firebase services are initialized once on app startup:

```ts
import { initFirebaseAll } from './lib/firebase';
import { initRemoteConfig } from './lib/firebaseRemoteConfig';

useEffect(() => {
  // Initialize Analytics + Performance + App Check
  initFirebaseAll().catch(() => {});
  // Fetch Remote Config values
  initRemoteConfig().catch(() => {});
}, []);
```

---

## 🔧 Testing Push Notifications Locally

1. Set `VITE_FIREBASE_VAPID_KEY` in `.env`
2. Run `npm run dev` (HTTPS is required for service workers — use `vite --https` or a tunnel)
3. Login as a passenger or driver
4. Accept the notification permission prompt
5. Your token will be registered at `/api/notifications/token`
6. Test from admin panel: send a test notification via `POST /api/notifications/send-to-user`

---

## 📊 Firebase Console Links

- [Project Overview](https://console.firebase.google.com/project/urbonttech-e182d)
- [Analytics Events](https://console.firebase.google.com/project/urbonttech-e182d/analytics/events)
- [Remote Config](https://console.firebase.google.com/project/urbonttech-e182d/config)
- [Performance Monitoring](https://console.firebase.google.com/project/urbonttech-e182d/performance)
- [App Check](https://console.firebase.google.com/project/urbonttech-e182d/appcheck)
- [Cloud Messaging](https://console.firebase.google.com/project/urbonttech-e182d/messaging)
- [Authentication](https://console.firebase.google.com/project/urbonttech-e182d/authentication/users)
